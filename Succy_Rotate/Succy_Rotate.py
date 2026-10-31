import math
import os
from collections import OrderedDict

import torch
import torch.nn.functional as F

from server import PromptServer

from _succy_common import LiveWait, coerce_widgets, fresh_values, gate_hold, live_touch, ram_holder, say, stop_key, stop_route, value_memo, wait_here
from _succy_image import (FILL_MODES, display_id, file_stamp, fill, homography, input_path, load_picture, rect_pts, remap, resize,
                          quarter, send_preview, turn, turn_size)

# ===================================================
# Succy Rotate & Flip (D-313)
#
# Flip (H / V, exact) then turn by `rotation` degrees CLOCKWISE around the centre. A free angle grows the canvas to hold the whole
# picture; the new corners are filled by the kit's one Fill (blur = the edge stretched and blurred · color) and marked in the mask.
# Quarter turns move pixels: no resampling, no loss.
# The STITCH wire is a PILE (D-304): a Crop says "I cut here", this node adds "I turned it". Succy Stitch undoes the pile last
# first (straightens, then puts the cut back). With nothing on `stitch` the pile starts here: Stitch puts the work back into the
# very picture that came in. Picture: the `image` wire, else what the `stitch` hands out (the Crop's crop), else a file loaded on the node.
# LIVE (D-156): what it outputs reaches every Succy node on its wires without a Queue (SUCCY_LIVE).
# Node names live ONLY in __init__.py (D-95). Images are ComfyUI BHWC floats in [0,1], masks BHW.
# ===================================================

_TAG = "[Succy Rotate]"

_LAST = getattr(PromptServer.instance, "_succy_rotate_last", None)
if _LAST is None:
    _LAST = PromptServer.instance._succy_rotate_last = OrderedDict()
_LAST_MAX = 12                                         # nodes remembered at once: the oldest lets go of its tensors
_MEMO = value_memo("rotate", _LAST_MAX)                # D-210: same values in = the last result out, nothing turned twice
ram_holder("rotate last run", _LAST.clear, lambda: list(_LAST.values()))   # D-308: counted in the RAM row, let go by ComfyUI's free


def _keep(did, entry):
    """Remember what node `did`'s last Run got on its wires. -> True when that is something new for the live view (D-333: the gate's
    run again after ▶ brings the very same picture: no live_touch then, or every live view downstream works it all out again)."""
    old = _LAST.pop(did, None)
    _LAST[did] = entry
    while len(_LAST) > _LAST_MAX:
        _LAST.pop(next(iter(_LAST)), None)
    return not isinstance(old, dict) or old.keys() != entry.keys() or any(old[k] is not v for k, v in entry.items())


# ---------------- D-333: Stop / Reuse, like Crop / Stitch / Tile Split ----------------
# A native Load Image, a SAM mask, a sampler: nothing live, they exist only inside a Run. With Stop the Run waits here with what came
# in (the global pause gate holds it right after this node: ▶ runs it again with her angle, nothing before it redone); without the
# gate, or when it is the last node, the old wait in the node (▶ goes on in place with her values). ■ ends the Run.
_HOLDS = getattr(PromptServer.instance, "_succy_rotate_holds", None)
if _HOLDS is None:
    _HOLDS = PromptServer.instance._succy_rotate_holds = {}

    @PromptServer.instance.routes.post("/succy/rotate/action")
    async def _rotate_action(request):
        return await stop_route(request, _HOLDS)


_SMALL = OrderedDict()                                 # D-314: (what came in, view size) -> its smaller copy for the live view
_SMALL_MAX = 4


def _small(src, ident, show, make):
    """The live view's copy of a big picture, made once per (picture, size): a drag of the bar asks again and again, the 6k is decoded
    and shrunk only the first time. src = the objects it was made from (kept, compared by identity: an id can't be reused under us)."""
    key = (ident, int(show))
    hit = _SMALL.get(key)
    if hit is not None and len(hit[0]) == len(src) and all(a is b for a, b in zip(hit[0], src)):
        _SMALL.move_to_end(key)
        return hit[1]
    val = make()
    _SMALL[key] = (src, val)
    while len(_SMALL) > _SMALL_MAX:
        _SMALL.popitem(last=False)
    return val


def _shrink(image, mask, show):
    """IMAGE [B,H,W,C] (+ any MASK) -> both with the long side = show (area average: a big step down without aliasing)."""
    H, W = int(image.shape[1]), int(image.shape[2])
    mask = None if mask is None else _bhw(mask.to(image.device), H, W)
    k = float(show) / max(W, H)
    h, w = max(1, round(H * k)), max(1, round(W * k))
    img = F.interpolate(image.permute(0, 3, 1, 2).float(), size=(h, w), mode="area").permute(0, 2, 3, 1).contiguous()
    m = None if mask is None else F.interpolate(mask.float()[:, None], size=(h, w), mode="area")[:, 0].contiguous()
    return img, m


def _bhw(m, H, W):
    """Any MASK -> [B,H,W] float at H x W, every item kept."""
    m = m.float()
    if m.dim() == 2:
        m = m[None]
    if tuple(m.shape[-2:]) != (H, W):
        m = F.interpolate(m[:, None], size=(H, W), mode="bilinear", align_corners=False)[:, 0].clamp(0.0, 1.0)
    return m


def stitch_view(st):
    """What a pile hands out as picture + mask, in its last step's own frame: a Crop = its crop (selection + context at work size)
    and the crop's mask; a turn = the turned picture. -> (IMAGE [B,H,W,C], MASK [B,H,W] or None)."""
    if st.get("op") == "turn":
        prev = st.get("prev")
        img, m = stitch_view(prev) if prev is not None else (st["image"], st.get("mask"))
        return turned(img, m, st["angle"], st["flip_h"], st["flip_v"], st.get("fill", "blur"), st.get("fill_color", "#000000"))[:2]
    rx0, ry0, rx1, ry1 = st["region"]
    img = st["image"]
    if st.get("quad"):                                 # a perspective cut (D-178): its straightened frame, as the Crop handed it out
        rw, rh = st["straight"]
        x = remap(img.permute(0, 3, 1, 2), None, homography(rect_pts(0, 0, rw, rh), st["quad"]), rw, rh)[0]
    else:
        x = img[:, ry0:ry1, rx0:rx1, :].permute(0, 3, 1, 2)
    ow, oh = st["work_size"]
    x = resize(x, oh, ow).permute(0, 2, 3, 1).contiguous()
    m = F.interpolate(st["mask"].float()[:, None], size=(oh, ow), mode="bilinear", align_corners=False)[:, 0].clamp(0.0, 1.0)
    return x, m


def turned(image, mask, angle, flip_h, flip_v, how, color):
    """The work: IMAGE [B,H,W,C] + MASK [B,H,W] or None -> (IMAGE, MASK, cover [1,1,OH,OW]). Mask out = the turned mask, alone
    (D-337, her Crop -> Rotate -> Tile: the corners added to a leg made "only masked" tile the whole picture; Stitch throws them away
    when it turns back). No mask in = the filled corners (1): what an inpaint should redo."""
    x, m, cover = turn(image.permute(0, 3, 1, 2).float(), None if mask is None else mask.float()[:, None], angle, flip_h, flip_v)
    hole = 1.0 - cover
    x = fill(x, hole, how, color)
    mo = hole if m is None else m * cover          # the turned mask's own edge stops where the picture does
    return x.permute(0, 2, 3, 1).contiguous(), mo[:, 0].contiguous(), cover


def produce(kw, image, mask, stitch, did, show=None):
    """-> (stitch, image, mask, info, the picture that came in, real sizes or None). kw = coerced widgets; image / mask / stitch = the
    wires (or None). show = the live view's long side (D-314): a bigger picture is turned as a copy that size — the pile then is only
    good for the view; info and the real sizes stay those of the Run."""
    if show:                                           # a free angle grows the canvas up to x1.41: the copy is that much smaller, so
        q = quarter(float(kw.get("rotation", 0.0) or 0.0))   # what comes out is ~the size the view asked (quarter turns: as asked)
        show = int(show) if q is not None else max(64, int(round(show / math.sqrt(2))))
    real_in, keep = None, True                         # keep = the picture lives on anyway (a wire, a file): worth a small copy
    if stitch is not None and (image is None or mask is None):
        keep = image is not None
        simg, smask = stitch_view(stitch)
        if image is None:
            image = simg
        if mask is None:                               # D-304: no mask wire = the stitch's (resized to the picture below)
            mask = smask
    if image is None:
        name = str(kw.get("source") or "")
        if not name:
            raise LiveWait("image", "no picture: drop / paste / 📂 load one on the node, or wire an image (or a Crop's stitch)")
        path = input_path(name)
        if show:                                       # the view: the big file is decoded and shrunk once, not at every tick
            image, alpha, W0, H0 = _small((), ("file", file_stamp(name)), show, lambda: _file_small(path, show))
            real_in = (W0, H0) if (W0, H0) != (int(image.shape[2]), int(image.shape[1])) else None
        else:
            image, alpha = load_picture(path)
        if mask is None and alpha is not None:         # the picture's own transparency is a mask, like ComfyUI's Load Image
            mask = alpha
    B, H, W, _ = image.shape
    if show and max(W, H) > show:                      # D-314: a big picture on a wire -> the view turns a copy its own size
        real_in, src = (W, H), (image, mask)
        image, mask = _small(src, ("t", id(image), id(mask)), show, lambda: _shrink(*src, show)) if keep else _shrink(image, mask, show)
        B, H, W, _ = image.shape
    m = None if mask is None else _bhw(mask.to(image.device), H, W)
    angle = float(kw.get("rotation", 0.0) or 0.0)
    fh, fv = bool(kw.get("flip_h")), bool(kw.get("flip_v"))
    how = kw.get("fill", "blur") if kw.get("fill") in FILL_MODES else "blur"
    color = str(kw.get("fill_color") or "#000000")
    out, om, _ = turned(image, m, angle, fh, fv, how, color)
    pile = {"version": 1, "op": "turn", "angle": angle, "flip_h": fh, "flip_v": fv, "fill": how, "fill_color": color,
            "in_size": (W, H), "out_size": (int(out.shape[2]), int(out.shape[1])), "prev": stitch,
            "image": image, "mask": m}               # references, no copy: Stitch's base when nothing is under this step
    info = {"in_w": W, "in_h": H, "width": int(out.shape[2]), "height": int(out.shape[1]), "rotation": angle, "flip_h": fh, "flip_v": fv,
            "fill": how, "pile": _depth(pile)}
    real = None
    if real_in is not None:                            # a smaller copy was turned: say what the Run will really make
        rw, rh = turn_size(real_in[0], real_in[1], angle)
        info.update(in_w=int(real_in[0]), in_h=int(real_in[1]), width=int(rw), height=int(rh), shrunk=[int(W), int(H)])
        real = {"image": (rw, rh), "mask": (rw, rh)}
    return pile, out, om, info, image, real


def _hands_out(st):
    """(W, H) of what a pile hands out as its picture: a turn = its turned canvas, a Crop = its crop at work size."""
    return tuple(st["out_size"]) if st.get("op") == "turn" else tuple(st["work_size"])


def plan(kw, image, mask, stitch):
    """D-314: the pile ONLY, nothing turned — what Stitch's live preview needs to put a turned picture back (the steps + the picture
    under them). Same rules as produce() for the picture; on a stitch without an image wire not even that: the size is in the pile."""
    angle = float(kw.get("rotation", 0.0) or 0.0)
    fh, fv = bool(kw.get("flip_h")), bool(kw.get("flip_v"))
    m = None
    if image is None and stitch is not None:
        W, H = _hands_out(stitch)
    else:
        if image is None:
            name = str(kw.get("source") or "")
            if not name:
                raise LiveWait("image", "no picture: drop / paste / 📂 load one on the node, or wire an image (or a Crop's stitch)")
            image, alpha = load_picture(input_path(name))
            mask = alpha if mask is None else mask
        H, W = int(image.shape[1]), int(image.shape[2])
        m = None if mask is None else _bhw(mask.to(image.device), H, W)
    OW, OH = turn_size(W, H, angle)
    return {"version": 1, "op": "turn", "angle": angle, "flip_h": fh, "flip_v": fv, "fill": kw.get("fill", "blur"),
            "fill_color": str(kw.get("fill_color") or "#000000"), "in_size": (W, H), "out_size": (OW, OH), "prev": stitch,
            "image": image, "mask": m}


def _file_small(path, show):
    """A file on the node, for the view: decoded once, shrunk if bigger than the view -> (IMAGE, its alpha MASK or None, real W, H)."""
    image, alpha = load_picture(path)
    H, W = int(image.shape[1]), int(image.shape[2])
    if max(W, H) > show:
        image, alpha = _shrink(image, alpha, show)
    return image, alpha, W, H


def _depth(st):
    n = 0
    while isinstance(st, dict):
        n += 1
        st = st.get("prev") if st.get("op") == "turn" else None
    return n


class Succy_Rotate:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "rotation": ("FLOAT", {"default": 0.0, "min": -360.0, "max": 360.0, "step": 0.1,
                                       "tooltip": "Degrees, clockwise (negative = the other way). A free angle grows the canvas: the corners are filled (marked in the mask only when no mask comes in)"}),
                "flip_h": ("BOOLEAN", {"default": False, "tooltip": "Mirror left <-> right (before the turn)"}),
                "flip_v": ("BOOLEAN", {"default": False, "tooltip": "Mirror top <-> bottom (before the turn)"}),
                "fill": (list(FILL_MODES), {"default": "blur", "tooltip": "The new corners: blur = the picture's edge stretched and blurred (no shapes, no clones) · color = a flat colour"}),
                "fill_color": ("STRING", {"default": "#000000", "tooltip": "fill = color: the colour of the corners (#rrggbb)"}),
                "source": ("STRING", {"default": "", "tooltip": "Picture dropped / pasted / loaded on the node (input folder). A wired image (or stitch) wins"}),
                # D-333, last on purpose: an old workflow's widget values still line up, the missing ones take their default
                "hold": ("BOOLEAN", {"default": False, "label_on": "Stop every run", "label_off": "Reuse",
                                     "tooltip": "On: every Run waits here with the picture that came in, so you turn it on that (▶ goes on)"}),
                "hold_timeout": ("INT", {"default": 300, "min": 1, "max": 3600, "step": 1,
                                         "tooltip": "Seconds to wait before carrying on with the turn as it is"}),
                "run_id": ("STRING", {"default": "0_manual", "tooltip": "Managed by the frontend"}),
            },
            "optional": {
                "stitch": ("STITCH", {"tooltip": "From a Succy Crop (or another Rotate): the turn joins the pile, Succy Stitch undoes it. Without an image wire its picture is the crop"}),
                "image": ("IMAGE", {"tooltip": "The picture to turn. Wins over the stitch's picture and a file loaded on the node"}),
                "mask": ("MASK", {"tooltip": "Turned with the picture (from the stitch when not wired)"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }

    RETURN_TYPES = ("STITCH", "IMAGE", "MASK")
    RETURN_NAMES = ("stitch", "image", "mask")
    FUNCTION = "rotate"
    SUCCY_CACHE = "memo"  # SmartCache (D-213): pictures: the value memo (D-210)
    SUCCY_LIVE = ("stitch", "image", "mask")
    SUCCY_LIVE_SHOW = True   # D-336: its live answer depends on the size the view asks (the memo keeps one per size)

    @classmethod
    def IS_CHANGED(cls, source="", hold=False, run_id="", **kwargs):
        # a picture loaded on the node: the file decides (same name, new pixels). Wires: ComfyUI's own rule.
        # D-333: + Stop / Reuse (stop_key): Stop = it runs on EVERY Run (with the gate a stable key the gate runs anyway; NaN without)
        stop = stop_key(cls, hold, run_id)
        if isinstance(stop, float):                    # NaN: never equal, the file does not matter
            return stop
        f = ""
        try:
            if source:
                p = input_path(source)
                f = f"{p}|{os.stat(p).st_mtime_ns}"
        except Exception:
            pass
        return f if stop == "passthrough" else f"{f}|{stop}"

    def rotate(self, rotation=0.0, flip_h=False, flip_v=False, fill="blur", fill_color="#000000", source="", hold=False, hold_timeout=300,
               run_id="", stitch=None, image=None, mask=None, unique_id=None, dynprompt=None):
        args = {k: v for k, v in locals().items() if k != "self"}          # ▶ of the node's own wait goes on with her values
        did = display_id(dynprompt, unique_id)
        kw = {"rotation": rotation, "flip_h": flip_h, "flip_v": flip_v, "fill": fill, "fill_color": fill_color, "source": source}
        key = {"kw": kw, "image": image, "mask": mask, "stitch": stitch,
               "file": file_stamp(source) if image is None and stitch is None else ""}
        hit = _MEMO.get(did, key)
        if hit is not None:
            pile, out, om, pic = hit
        else:
            try:
                pile, out, om, _, pic, _ = produce(kw, image, mask, stitch, did)
            except LiveWait as w:
                raise ValueError(f"{_TAG} {w.why}")
            _MEMO.put(did, key, (pile, out, om, pic))
        if _keep(did, {"in_image": image, "in_mask": mask, "in_stitch": stitch}):
            live_touch()                               # something new came in: the live views ask again (▶'s run again: the same)
        send_preview(did, pic, _TAG)                   # the node's shot = the picture that came in (before the turn)
        if hold and not str(run_id).endswith("_continue"):
            # D-333: the gate holds the Run right after this node (▶ runs it again with her angle, Load / SAM untouched);
            # without it (or as the last node) the old wait here, ▶ = her values of now, in place
            if not gate_hold(did, int(hold_timeout), "succy-rotate-info", dynprompt, unique_id):
                say(f"{_TAG} node {did} waiting up to {hold_timeout}s for the turn...")
                wait_here(_HOLDS, did, int(hold_timeout), _TAG)
                new = fresh_values(did, unique_id, args)
                if new:
                    return self.rotate(**{**args, **new, "run_id": str(run_id) + "_continue"})
        return (pile, out, om)

    @classmethod
    def _wired(cls, inputs, node_id):
        last = _LAST.get(node_id) or {}
        got = {}
        for inp in ("image", "mask", "stitch"):
            if not inputs.linked(inp):
                continue
            v = inputs.get(inp)
            if v is None:
                v = last.get("in_" + inp)
            if v is None:
                raise LiveWait("run", f"the Rotate's {inp} comes from a wire: Run once so it gets there")
            got[inp] = v
        return got

    @classmethod
    def succy_live(cls, widgets, inputs, node_id):
        got = cls._wired(inputs, node_id)
        kw = coerce_widgets(cls, widgets)
        show = getattr(inputs, "show", None)           # D-314: only this node's own view: downstream gets the full picture
        pile, out, om, info, _, real = produce(kw, got.get("image"), got.get("mask"), got.get("stitch"), node_id, show)
        outs = {"stitch": pile, "image": out, "mask": om, "_info": info}
        if real:
            outs["_real"] = real
        return outs

    @classmethod
    def succy_plan(cls, widgets, inputs, node_id):
        # D-314: Stitch's live preview asks only the pile (a 6k is not turned to learn how to turn it back)
        got = cls._wired(inputs, node_id)
        return plan(coerce_widgets(cls, widgets), got.get("image"), got.get("mask"), got.get("stitch"))
