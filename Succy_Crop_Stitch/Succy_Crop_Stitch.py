import asyncio
import json
import os
import re
import time

import torch
import torch.nn.functional as F
from aiohttp import web

import comfy.model_management
from server import PromptServer

from _succy_common import same_origin, LiveWait, live_touch   # the shared drawer (loaded once by __init__.py)
# the picture helpers moved to the shared picture drawer (D-156): Load & Resize uses them too. Same functions, old names.
from _succy_image import (display_id as _display_id, png_bytes as _png_bytes, snap as _snap, mp_size as _mp_size, resize as _resize,
                          prep_mask as _prep_mask, load_source as _load_source, decode_brush as _decode_brush, runmax as _runmax,
                          hex_rgb as _hex_rgb, grow as _grow, box1 as _box1, blur as _blur, load_mask as _load_mask,
                          send_preview, live_input, live_empty)

# ===================================================
# Succy Crop & Stitch — phase 1 (backend only, native widgets)
#
# Two nodes that live in one file because the pack loads each .py by path (no relative imports):
#   Succy_Crop   : cuts a rectangle (+ context) out of an image, scales it to a working size,
#                  hands out IMAGE / MASK / STITCH.
#   Succy_Stitch : takes the worked crop + STITCH, scales it back on its own (only position and
#                  proportions matter, never the pixels), feathers the seam, optionally matches
#                  colour, and slips it back into the original. Gently. No loose ends.
# STITCH = plain dict (see Succy_Crop.crop). Images are ComfyUI BHWC floats in [0,1].
# Node names live ONLY in __init__.py (D-95).
# ===================================================

_TAG = "[Succy Crop&Stitch]"

# --- phase 2: the hold ("stop on every run" / "reuse the last selection") -------------------------------------
# Same dance as Succy Pause: the node waits in place, the frontend (SurvivalKit.hold, class Succy_Crop) posts
# "stop" / "continue" here. Continue normally RE-QUEUES the graph with run_id "<ts>_continue": the node then skips
# the wait and crops with the x/y/w/h the user just drew. State key = the id SHOWN in the graph.
# __init__.py loads this file ONCE (Crop and Stitch share the module). The state dict and the routes still live on the server instance
# and are created only the first time, so a module reload can't register a second POST route (ComfyUI would refuse to start).
_NODE_STATES = getattr(PromptServer.instance, "_succy_crop_states", None)
_FIRST_LOAD = _NODE_STATES is None
if _FIRST_LOAD:
    _NODE_STATES = {}
    PromptServer.instance._succy_crop_states = _NODE_STATES
    PromptServer.instance._succy_crop_last = {}
# D-115: the outputs of each Crop's LAST run (references, no copy), so the node's ⬇ can hand any of them over as a PNG
_LAST = PromptServer.instance._succy_crop_last
_LAST_MAX = 12               # nodes remembered at once: the oldest one lets go (its tensors) when a new one comes in, so a long session can't hoard RAM


def _remember(did, entry):
    """Keep the last run of node `did`; past _LAST_MAX nodes the least recently run one is forgotten (it just asks for a fresh Run)."""
    _LAST.pop(did, None)                                   # re-insert = most recent goes last
    _LAST[did] = entry
    while len(_LAST) > _LAST_MAX:
        _LAST.pop(next(iter(_LAST)), None)


def _send_preview(did, image, *_box):
    send_preview(did, image, _TAG)


_DOWNLOADS = ("full_img", "cutout", "mask", "crop_img", "crop_mask")


if _FIRST_LOAD:
    @PromptServer.instance.routes.post("/succy/crop/action")
    async def _crop_action(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad JSON"}, status=400)
        if not isinstance(data, dict) or data.get("node_id") is None or data.get("action") not in ("continue", "stop"):
            return web.json_response({"error": "node_id and action ('continue' | 'stop') required"}, status=400)
        _NODE_STATES[str(data["node_id"])] = data["action"]
        return web.json_response({"status": "ok"})

    async def _outs_for(request, nid, need):
        try:
            data = await request.json()
        except Exception:
            data = {}
        return await _outs_from(data, nid, need)

    async def _outs_from(data, nid, need, soft=False):
        # body {widgets, linked, from} = the node AS IT IS NOW -> the outputs of the very same crop() (D-117), or the last Run's when nothing is sent.
        # Returns (outs, None) or (None, error response). The picture: the one loaded on the node, the LIVE one of a Succy node on the
        # wire (D-156), or the one the last Run got through a wire. soft = "not ready" answers 200 {ready: false} (Stitch's live view).
        widgets, linked = data.get("widgets") or {}, set(data.get("linked") or [])
        last = _LAST.get(nid) or {}
        if not widgets:                                    # nothing sent: the last Run, as before
            if last.get(need) is None:
                return None, web.json_response({"error": "nothing to download yet: run the node once"}, status=404)
            return last, None
        got, wait = await asyncio.to_thread(_wired_inputs, data, last)
        if wait:
            if soft:
                return None, web.json_response({"ready": False, "need": wait[0], "why": wait[1]})
            return None, web.json_response({"error": wait[1] + ", then download"}, status=404)
        # EXT doors (D-130): a wired number is known only after a Run; until then the slider's value stands in
        widgets = dict(widgets)
        for inp, key in (("out_mp_in", "out_mp"), ("multiple_in", "multiple")):
            if inp in linked and last.get("in_" + key) is not None:
                widgets[key] = last["in_" + key]
        try:
            outs = await asyncio.to_thread(_crop_now, widgets, got.get("image"), got.get("mask"), nid)
        except Exception as exc:
            return None, web.json_response({"error": str(exc).replace(_TAG, "").strip()}, status=400)
        return outs, None

    @PromptServer.instance.routes.post("/succy/crop/download")
    async def _crop_download(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        # ?node_id=<shown id>&which=<output> -> that output as a PNG. The file carries the way back in (tEXt "succy_crop", D-123).
        nid, which = str(request.query.get("node_id", "")), request.query.get("which", "")
        if which not in _DOWNLOADS:
            return web.json_response({"error": f"unknown output '{which}'"}, status=400)
        outs, err = await _outs_for(request, nid, which)
        if err:
            return err
        try:
            body = await asyncio.to_thread(_png_bytes, outs[which], _stitch_meta(outs.get("stitch")))
        except Exception as exc:
            return web.json_response({"error": f"could not encode {which}: {exc}"}, status=500)
        name = f"{outs.get('stem') or 'crop'}_{which}.png"
        return web.Response(body=body, content_type="image/png", headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @PromptServer.instance.routes.post("/succy/crop/stitch")
    async def _crop_stitch(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        # What Stitch's live preview needs from a Crop, no Queue (D-123). ?node_id=<Crop shown id>&what=
        #   info = JSON {region, selection, orig_size, work_size} · base = the ORIGINAL region as PNG · mask = the crop's mask over the region as PNG
        #   "not yet" (no picture, a wire that fills only at Run) is NOT an error: 200 {ready: false, need, why} keeps the console quiet
        nid, what = str(request.query.get("node_id", "")), request.query.get("what", "")
        try:
            data = await request.json()
        except Exception:
            data = {}
        wait = _stitch_wait(data, _LAST.get(nid) or {})
        if wait:
            return web.json_response({"ready": False, "need": wait[0], "why": wait[1]})
        outs, err = await _outs_from(data, nid, "crop_img", soft=True)
        if err:
            return err
        st = outs.get("stitch")
        if st is None:
            st = (_LAST.get(nid) or {}).get("stitch")
        if st is None:
            return web.json_response({"ready": False, "need": "run", "why": "the Crop has nothing to stitch yet: Run once"})
        try:
            if what == "info":
                return web.json_response(_stitch_meta(st, as_dict=True))
            rx0, ry0, rx1, ry1 = st["region"]
            if what == "base":
                body = await asyncio.to_thread(_png_bytes, st["image"][:1, ry0:ry1, rx0:rx1, :])
            elif what == "mask":
                body = await asyncio.to_thread(_png_bytes, st["mask"][:1])
            else:
                return web.json_response({"error": f"unknown what '{what}'"}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"could not encode {what}: {exc}"}, status=500)
        return web.Response(body=body, content_type="image/png")

    @PromptServer.instance.routes.post("/succy/stitch/render")
    async def _stitch_render(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        # Stitch's Copy / Download (D-124): the FULL-resolution result, no Queue, computed by Succy_Stitch.stitch itself (pixel = Queue).
        # ?node_id=<Stitch shown id> · body {widgets, linked} of the Stitch + crop: {node_id, widgets, linked} of the Crop on its wire.
        nid = str(request.query.get("node_id", ""))
        try:
            data = await request.json()
        except Exception:
            data = {}
        crop = data.get("crop") or {}
        st, outs = None, {}
        if crop.get("node_id") is not None:
            outs, err = await _outs_from(crop, str(crop["node_id"]), "crop_img")
            if err:
                return err
            st = outs.get("stitch") or (_LAST.get(str(crop["node_id"])) or {}).get("stitch")
        widgets, linked = data.get("widgets") or {}, set(data.get("linked") or [])
        last = _LAST.get(nid) or {}
        wired = {}
        for inp, key in (("replacement", "st_image"), ("base_image", "st_base"), ("mask", "st_mask")):
            if inp in linked and not live_empty(data, inp):
                try:                                       # a Succy node on the wire answers live, full size (D-156)
                    v = await asyncio.to_thread(_live_full, data, inp)
                except LiveWait as w:
                    return web.json_response({"error": f"the {inp.replace('_', ' ')}: {w.why}"}, status=404)
                if v is None:
                    v = last.get(key)
                if v is None:
                    return web.json_response({"error": f"the {inp.replace('_', ' ')} comes from a wire: run the node once, then copy / download"}, status=404)
                wired[inp] = v
        try:
            img = await asyncio.to_thread(_stitch_now, st, wired, widgets)
            body = await asyncio.to_thread(_png_bytes, img)
        except Exception as exc:
            return web.json_response({"error": str(exc).replace(_TAG, "").strip()}, status=400)
        name = f"{outs.get('stem') or 'stitch'}_stitched.png"
        return web.Response(body=body, content_type="image/png", headers={"Content-Disposition": f'attachment; filename="{name}"'})


_INT_ARGS = ("x", "y", "w", "h", "context", "multiple", "box_snap", "box_feather", "mask_grow", "mask_feather")
_FLOAT_ARGS = ("workspace_mp", "out_mp")


def _stitch_wait(data, last):
    """Why a Crop can't hand Stitch its region YET (D-143), or None. data = {widgets, linked} of the Crop as it is now, last = its last Run.
    -> ("image" | "run", text the user reads). Not ready is a state, not an error: she just isn't dressed yet."""
    widgets, linked = data.get("widgets") or {}, set(data.get("linked") or [])
    if not widgets:
        return None if last.get("stitch") is not None else ("run", "the Crop has nothing to stitch yet: Run once")
    live = data.get("from") if isinstance(data.get("from"), dict) else {}
    for inp in ("image", "mask"):
        if inp in linked and inp not in live and last.get("in_" + inp) is None:
            return ("run", f"the Crop's {inp} comes from a wire: Run once so it gets there")
    if "image" not in linked and not str(widgets.get("source") or ""):
        return ("image", "the Crop has no picture: load one on it (or wire one and Run)")
    return None


def _live_full(data, inp):
    """Input `inp` from the live chain the browser sent, full size (None = no live source on that wire). Raises LiveWait."""
    with torch.inference_mode():
        return live_input(data, inp)


def _wired_inputs(data, last):
    """The Crop's wired image / mask as they are now: live from a Succy node on the wire (D-156), else the last Run's.
    -> ({image, mask}, None) or (None, (need, why))."""
    linked, got = set(data.get("linked") or []), {}
    for inp in ("image", "mask"):
        if inp not in linked or live_empty(data, inp):        # a live source that hands out nothing (an Any on 0) = no wire (D-172)
            continue
        try:
            v = _live_full(data, inp)
        except LiveWait as w:
            return None, (w.need, f"the Crop's {inp}: {w.why}")
        if v is None:
            v = last.get("in_" + inp)
        if v is None:
            return None, ("run", f"the Crop's {inp} comes from a wire: Run once so it gets there")
        got[inp] = v
    return got, None


def _crop_now(widgets, image, mask, nid):
    """Run Succy_Crop.crop on the widgets the browser sent (D-117). Quiet: no preview, no wait, does not touch _LAST."""
    kw = {k: int(widgets[k]) for k in _INT_ARGS if widgets.get(k) is not None}
    kw.update({k: float(widgets[k]) for k in _FLOAT_ARGS if widgets.get(k) is not None})
    for k in ("alpha", "box"):
        if k in widgets:
            kw[k] = widgets[k] in (True, "true", 1)
    for k in ("solid_color", "source", "brush"):
        if k in widgets:
            kw[k] = str(widgets[k] or "")
    kw.setdefault("x", 0); kw.setdefault("y", 0); kw.setdefault("w", 0); kw.setdefault("h", 0)
    kw.setdefault("context", 0); kw.setdefault("multiple", 1)
    with torch.inference_mode():
        outs = Succy_Crop().crop(**kw, image=image, mask=mask, unique_id=nid, _quiet=True, _all=True)
    outs["stem"] = _stem(kw.get("source", ""))
    return outs


def _stitch_now(st, wired, widgets):
    """Run Succy_Stitch.stitch on the widgets the browser sent (D-124). Quiet: no preview, does not touch _LAST. wired = last Run's wired inputs."""
    kw = {k: widgets[k] for k in ("feather_mode", "feather_curve", "aspect_mismatch", "source", "base_file", "mask_file", "brush", "place") if widgets.get(k) is not None}
    for k, d in (("feather", 24), ("color_match", 0.0), ("opacity", 1.0), ("sharpness_match", 0.0), ("grain_match", 0.0),
                 ("offset_x", 0), ("offset_y", 0), ("scale", 100.0)):
        kw[k] = type(d)(widgets.get(k, d) if widgets.get(k) is not None else d)
    kw.setdefault("feather_mode", "inside"); kw.setdefault("feather_curve", "smooth"); kw.setdefault("aspect_mismatch", "auto")
    with torch.inference_mode():
        return Succy_Stitch().stitch(stitch=st, _quiet=True, **wired, **kw)[0]


def _stem(source):
    st = os.path.splitext(os.path.basename(str(source or "")))[0] if source else ""
    return re.sub(r"[^0-9A-Za-z_-]", "_", st)[:60]


def _stitch_meta(st, as_dict=False):
    """The way back in, as plain numbers: region (selection + context) in ORIGINAL pixels and the original size (D-123).
    Stitch reads it from a PNG that came home with its tEXt intact; many outside services strip it, hence the wire to Crop too."""
    if not st:
        return None
    rx0, ry0, rx1, ry1 = st["region"]
    d = {"v": 1, "x": rx0, "y": ry0, "w": rx1 - rx0, "h": ry1 - ry0, "orig_w": st["orig_size"][0], "orig_h": st["orig_size"][1],
         "work_w": st["work_size"][0], "work_h": st["work_size"][1]}
    return d if as_dict else json.dumps(d)


def _hold(display_id, timeout):
    """Wait for the user. Returns when she continues (or the timeout runs out); a Stop interrupts the whole run."""
    _NODE_STATES[display_id] = "wait"
    t0 = time.time()
    try:
        while True:
            comfy.model_management.throw_exception_if_processing_interrupted()
            st = _NODE_STATES.get(display_id, "wait")
            if st == "stop":
                print(f"{_TAG} node {display_id} stopped by user.")
                comfy.model_management.interrupt_current_processing()
                return
            if st == "continue" or time.time() - t0 >= timeout:
                return
            time.sleep(0.2)
    finally:
        _NODE_STATES.pop(display_id, None)


# --- phase 3 (D-106): picture without a wire, free hand mask, grow + feather of the output mask ----------------------

class Succy_Crop:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "x": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "y": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "w": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1,
                              "tooltip": "Rectangle width (0 = no rectangle drawn yet)"}),
                "h": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1,
                              "tooltip": "Rectangle height (0 = no rectangle drawn yet)"}),
                "context": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1,
                                    "tooltip": "Extra pixels around the selection so the sampler sees the surroundings"}),
                "workspace_mp": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 400.0, "step": 0.1,
                                           "tooltip": "WORKSPACE: resize the whole picture to this many megapixels BEFORE anything else (0 = real size)"}),
                "out_mp": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 400.0, "step": 0.1,
                                     "tooltip": "Resize the cropped area OUTPUT to this many megapixels (0 = real size)"}),
                "multiple": ("INT", {"default": 1, "min": 1, "max": 256, "step": 1,
                                     "tooltip": "Snap the cropped area output to a multiple of this (8 / 64 ...)"}),
                "box_snap": ("INT", {"default": 1, "min": 1, "max": 256, "step": 1,
                                     "tooltip": "Rectangle on the canvas snaps to multiples of this (managed by the node menu)"}),
                "alpha": ("BOOLEAN", {"default": True, "label_on": "Alpha", "label_off": "Solid",
                                      "tooltip": "cutout output: Alpha = RGBA, transparent outside the mask; Solid = RGB, black outside the mask"}),
                "solid_color": ("STRING", {"default": "#000000",
                                           "tooltip": "cutout output in Solid: colour outside the mask (#rrggbb)"}),
                "box": ("BOOLEAN", {"default": True, "tooltip": "Off = no rectangle: only the free hand mask (or the whole picture if both are empty)"}),
                "box_feather": ("INT", {"default": 0, "min": 0, "max": 1024, "step": 1,
                                        "tooltip": "Soft edge of the RECTANGLE only, in original pixels (before the free hand is added)"}),
                "mask_grow": ("INT", {"default": 0, "min": -1024, "max": 1024, "step": 1,
                                      "tooltip": "Grow (+) or shrink (-) the mask in original pixels"}),
                "mask_feather": ("INT", {"default": 0, "min": 0, "max": 1024, "step": 1,
                                         "tooltip": "Soft edge of the output mask in original pixels"}),
                "hold": ("BOOLEAN", {"default": False, "label_on": "Stop every run", "label_off": "Reuse selection",
                                     "tooltip": "On: wait on every Run so you can draw the selection on the real image"}),
                "hold_timeout": ("INT", {"default": 300, "min": 1, "max": 3600, "step": 1,
                                         "tooltip": "Seconds to wait before carrying on with the current selection"}),
                "run_id": ("STRING", {"default": "0_manual", "tooltip": "Managed by the frontend"}),
                "source": ("STRING", {"default": "", "tooltip": "Picture dropped / pasted / loaded on the node (input folder). A connected image wins"}),
                "brush": ("STRING", {"default": "", "tooltip": "Free hand mask drawn on the node (managed by the frontend)"}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "Wins over a picture loaded on the node"}),
                "mask": ("MASK", {"tooltip": "The starting selection: the rectangle and the brush add to it, the eraser takes from it, grow and feather shape it"}),
                # EXT chip doors (D-130): a wire here wins over the slider on the node
                "out_mp_in": ("FLOAT", {"forceInput": True, "tooltip": "Resize crop (megapixels) from a wire: wins over the slider"}),
                "multiple_in": ("INT", {"forceInput": True, "tooltip": "Multiple of, from a wire: wins over the slider"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }

    @classmethod
    def IS_CHANGED(cls, hold=False, run_id="", **kwargs):
        # a node that must stop never comes from the cache (the second Run would skip the wait); a "<ts>_continue" transit may
        if hold and not str(run_id).endswith("_continue"):
            return float("nan")
        return "passthrough"

    # D-118/D-120: six pictures, in the order the user reaches for them. Defaults (megapixels 0, multiple 1) = everything at REAL resolution.
    #   stitch     everything Succy Stitch needs to put the worked crop back
    #   full_img   the whole picture AT WORKSPACE SIZE (workspace_mp; = the input when 0): the canvas, mask and stitch all live here
    #   cutout     crop_img with crop_mask applied (Alpha = transparent outside, Solid = the chosen colour)
    #   mask       the final mask over the WHOLE picture (same size as the input): use it on the original
    #   crop_img   the crop (selection + context), resized only if work size / multiple ask for it
    #   crop_mask  the same mask, cut and sized like crop_img
    # D-128 (the user's call): the graph gets stitch, mask and cutout; ⬇ still hands out every picture (full_img, cutout, mask, crop_img, crop_mask)
    RETURN_TYPES = ("STITCH", "MASK", "IMAGE")
    RETURN_NAMES = ("stitch", "mask", "cutout")
    FUNCTION = "crop"

    # LIVE LINK (D-156): the outputs a Succy node on the other end of the wire sees as they are now, no Queue
    SUCCY_LIVE = ("stitch", "mask", "cutout")

    @classmethod
    def succy_live(cls, widgets, inputs, node_id):
        last = _LAST.get(node_id) or {}
        got = {}
        for inp in ("image", "mask"):
            if not inputs.linked(inp):
                continue
            v = inputs.get(inp)
            if v is None:
                v = last.get("in_" + inp)
            if v is None:
                raise LiveWait("run", f"the Crop's {inp} comes from a wire: Run once so it gets there")
            got[inp] = v
        if "image" not in got and not str(widgets.get("source") or ""):
            raise LiveWait("image", "the Crop has no picture: load one on it")
        widgets = dict(widgets)
        for inp, key in (("out_mp_in", "out_mp"), ("multiple_in", "multiple")):       # EXT: a wired number is known after a Run
            if inputs.linked(inp) and last.get("in_" + key) is not None:
                widgets[key] = last["in_" + key]
        outs = _crop_now(widgets, got.get("image"), got.get("mask"), node_id)
        return {"mask": outs["mask"], "cutout": outs["cutout"], "stitch": outs["stitch"]}

    def crop(self, x, y, w, h, context, workspace_mp, out_mp, multiple, box_snap=1, alpha=True, solid_color="#000000", box=True, box_feather=0, mask_grow=0, mask_feather=0, hold=False, hold_timeout=300,
             run_id="", source="", brush="", image=None, mask=None, out_mp_in=None, multiple_in=None, unique_id=None, dynprompt=None, _quiet=False, _all=False):
        if out_mp_in is not None:                          # EXT (D-130): the wire wins over the slider
            out_mp = max(0.0, float(out_mp_in))
        if multiple_in is not None:
            multiple = max(1, int(multiple_in))
        if image is None:
            image = _load_source(source)
        if image is None:
            raise ValueError(f"{_TAG} no picture: connect an image, or drop / paste / load one on the node.")
        in_image = image                                   # the untouched input: a download re-runs the crop from it
        # --- WORKSPACE (D-120): resize the whole picture first; the canvas, the rectangle, the mask and the stitch all live at this size
        if workspace_mp > 0:
            nw, nh = _mp_size(int(image.shape[2]), int(image.shape[1]), workspace_mp)
            if (nh, nw) != tuple(image.shape[1:3]):
                image = _resize(image.permute(0, 3, 1, 2), nh, nw).permute(0, 2, 3, 1).contiguous()
        B, H, W, _ = image.shape

        # --- phase 2: show the real image in the viewport, then (maybe) wait for the user to draw on it
        did = _display_id(dynprompt, unique_id)
        if not _quiet:                                     # a download (D-117) neither shows nor waits
            _send_preview(did, image, x, y, w, h)
        if hold and not _quiet and not str(run_id).endswith("_continue"):
            print(f"{_TAG} node {did} waiting up to {hold_timeout}s for a selection...")
            _hold(did, hold_timeout)

        # --- selection (full-size [H,W] mask): base = input mask (if it has pixels) ∪ the rectangle (if on and drawn, softened by
        #     box_feather; 0 wide or 0 high = not drawn yet, D-164 — the wired mask is edited by every tool, it no longer silences the box),
        #     then free hand: (base + painted) minus erased, THEN grown/shrunk and feathered: grow and feather shape the eraser's
        #     edge too, like every other edge of the mask (D-112, the user's call).
        #     The node's live preview runs the SAME recipe in the browser: js/NodeStructure/util/mask-math.js (cropMask).
        dev = image.device
        base = None
        if mask is not None:
            m = _prep_mask(mask, H, W).to(dev)
            if bool((m > 0.5).any()):
                base = m
        if box and w > 0 and h > 0:
            x0 = min(x, W - 1)
            y0 = min(y, H - 1)
            x1, y1 = min(W, x0 + w), min(H, y0 + h)
            r = torch.zeros((H, W), device=dev)
            r[y0:y1, x0:x1] = 1.0
            if box_feather > 0:
                r = _blur(r, int(box_feather))                                # the rectangle's own soft edge (D-107), centred on its border
            base = r if base is None else torch.maximum(base, r)
        add, erase = _decode_brush(brush, H, W, dev)
        sel = base
        if add is not None:
            sel = add if sel is None else torch.maximum(sel, add)
        if sel is None or not bool((sel > 0.01).any()):
            sel = torch.ones((H, W), device=dev)                              # nothing chosen: the whole picture
        if erase is not None:
            sel = sel * (1.0 - erase)
        sel = _grow(sel, int(mask_grow))
        ys, xs = torch.nonzero(sel > 0.01, as_tuple=True)
        if ys.numel() == 0:
            raise ValueError(f"{_TAG} the eraser removed the whole selection: nothing left to crop.")
        x0, x1 = int(xs.min()), int(xs.max()) + 1
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        if mask_feather > 0:
            sel = _blur(sel, int(mask_feather))
            # the soft edge spills outside the hard selection: widen the crop so it is not cut off
            pad = int(mask_feather)
            x0, y0, x1, y1 = max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)

        # --- region = selection + context, clamped to the image
        rx0, ry0 = max(0, x0 - context), max(0, y0 - context)
        rx1, ry1 = min(W, x1 + context), min(H, y1 + context)
        rw, rh = rx1 - rx0, ry1 - ry0

        # region-native mask: 1 where the sampler should work, 0 in the context ring
        rmask = sel[ry0:ry1, rx0:rx1].clone()

        # --- output size: out_mp megapixels (same aspect), then snapped to `multiple`
        ow, oh = _mp_size(rw, rh, out_mp) if out_mp > 0 else (rw, rh)
        ow, oh = _snap(ow, multiple), _snap(oh, multiple)

        region = image[:, ry0:ry1, rx0:rx1, :].permute(0, 3, 1, 2)
        out_img = _resize(region, oh, ow).permute(0, 2, 3, 1).contiguous()
        out_mask = _resize(rmask[None, None], oh, ow, "bilinear")[:, 0]

        stitch = {
            "version": 1,
            "image": image,                      # the untouched original (same tensor, no copy)
            "region": (rx0, ry0, rx1, ry1),      # selection + context, in original pixels
            "selection": (x0, y0, x1, y1),
            "orig_size": (W, H),
            "work_size": (ow, oh),
            "mask": rmask[None],                 # [1, rh, rw] at region-native resolution
        }
        # cutout = the crop with the mask APPLIED (to take it out of ComfyUI); `image` stays clean for the sampler.
        # Alpha: the mask becomes the alpha channel. Solid: `solid_color` outside the mask (soft edges fade into it, D-111).
        a = out_mask.to(out_img.device)[..., None].expand(out_img.shape[0], -1, -1, -1)
        rgb = out_img[..., :3]
        if alpha:
            cutout = torch.cat([rgb, a], dim=-1)
        else:
            col = torch.tensor(_hex_rgb(solid_color), device=rgb.device, dtype=rgb.dtype)
            cutout = rgb * a + col * (1.0 - a)
        full_mask = sel.clamp(0.0, 1.0)[None]                                 # [1, H, W]: the whole picture, soft edges and all
        if not _quiet:
            live_touch()
            _remember(did, {"full_img": image, "cutout": cutout, "mask": full_mask, "crop_img": out_img, "crop_mask": out_mask,
                            "stem": _stem(source), "in_image": in_image, "in_mask": mask, "stitch": stitch,
                            "in_out_mp": out_mp_in, "in_multiple": multiple_in})
        if _all:                                   # the downloads (D-117) want every picture
            return {"stitch": stitch, "full_img": image, "cutout": cutout, "mask": full_mask, "crop_img": out_img, "crop_mask": out_mask}
        return (stitch, full_mask, cutout)


# ---------------------------------------------------------------------------
# Stitch helpers (pure torch, testable without ComfyUI)
# ---------------------------------------------------------------------------

def _fit_mode(w, h, rw, rh, mode):
    """auto -> crop_center under 2% difference in proportions, otherwise stretch (with a warning). Same rule in the browser."""
    if mode != "auto":
        return mode
    diff = abs((w / h) / (rw / rh) - 1.0)
    if diff < 0.02:
        return "crop_center"
    print(f"{_TAG} worked image is {w}x{h} but the crop region is {rw}x{rh} "
          f"({diff * 100:.1f}% off in proportions): stretching it. Pick crop_center / fit to change that.")
    return "stretch"


def _fit_to_region(work, rh, rw, mode, base):
    """Bring the worked crop (BCHW) to the region's size. Returns (BCHW, fit_mask or None). mode: stretch | crop_center | fit."""
    h, w = work.shape[-2:]

    if mode == "stretch":
        return _resize(work, rh, rw), None

    if mode == "crop_center":
        if w / h > rw / rh:                       # too wide: trim the sides
            nw = max(1, round(h * rw / rh))
            off = (w - nw) // 2
            work = work[..., :, off:off + nw]
        else:                                      # too tall: trim top and bottom
            nh = max(1, round(w * rh / rw))
            off = (h - nh) // 2
            work = work[..., off:off + nh, :]
        return _resize(work, rh, rw), None

    # fit: keep proportions, centre it, leave the rest of the region as the original
    s = min(rw / w, rh / h)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    small = _resize(work, nh, nw)
    canvas = base.clone()
    fm = torch.zeros((1, 1, rh, rw), device=work.device)
    ox, oy = (rw - nw) // 2, (rh - nh) // 2
    canvas[..., oy:oy + nh, ox:ox + nw] = small
    fm[..., oy:oy + nh, ox:ox + nw] = 1.0
    return canvas, fm


def _feather(m, f, mode, curve, borders):
    """Soften the edges of m ([1,1,rh,rw]) over ~f px. borders = (left, top, right, bottom): region
    sides that sit on the image border (nothing exists beyond them, so no fade there)."""
    m = m.clamp(0.0, 1.0)
    if f <= 0:
        return m
    k = f if mode == "centered" else 2 * f        # inside/outside use half of a wider ramp
    k = int(k)
    if k % 2 == 0:
        k += 1
    p = k // 2
    x = F.pad(m, (p, p, p, p), mode="replicate")
    l, t, r, b = borders
    if not l:
        x[..., :, :p] = 0.0
    if not t:
        x[..., :p, :] = 0.0
    if not r:
        x[..., :, -p:] = 0.0
    if not b:
        x[..., -p:, :] = 0.0
    # separable box blur: a hard edge becomes a LINEAR ramp k px wide
    x = F.avg_pool2d(x, (1, k), stride=1)
    x = F.avg_pool2d(x, (k, 1), stride=1)

    if mode == "inside":
        x = torch.minimum((2.0 * x - 1.0).clamp(0.0, 1.0), m)
    elif mode == "outside":
        x = torch.maximum((2.0 * x).clamp(0.0, 1.0), m)
    if curve == "smooth":
        x = x * x * (3.0 - 2.0 * x)
    return x.clamp(0.0, 1.0)


def _wstats(x, w):
    # weighted per-channel mean/std over the pixels where w > 0 (x: BCHW, w: 1x1HW)
    n = w.sum().clamp_min(1.0)
    mu = (x * w).sum(dim=(2, 3), keepdim=True) / n
    var = (((x - mu) ** 2) * w).sum(dim=(2, 3), keepdim=True) / n
    return mu, (var + 1e-8).sqrt()


def _color_match(work, base, sel, strength):
    """Pull the worked crop's colour toward the original using the pixels AROUND the selection
    (the context ring: the sampler's VAE round trip drifts colour everywhere, the ring shows by how much)."""
    rh, rw = work.shape[-2:]
    ring = (sel < 0.5).float()
    if ring.sum() < 0.01 * rh * rw:               # no context at all: use a thin band along the region edge
        bw = max(4, min(rh, rw) // 16)
        ring = torch.zeros_like(ring)
        ring[..., :bw, :] = 1.0
        ring[..., -bw:, :] = 1.0
        ring[..., :, :bw] = 1.0
        ring[..., :, -bw:] = 1.0
    mu_w, sd_w = _wstats(work, ring)
    mu_o, sd_o = _wstats(base, ring)
    scale = (sd_o / sd_w.clamp_min(1e-4)).clamp(0.5, 2.0)
    matched = (work - mu_w) * scale + mu_o
    return (work + strength * (matched - work)).clamp(0.0, 1.0)


def _box(x, k):
    # separable box mean k x k, replicate padding, same size out (BCHW)
    k = int(k)
    if k <= 1:
        return x
    p = k // 2
    x = F.pad(x, (p, p, p, p), mode="replicate")
    return F.avg_pool2d(F.avg_pool2d(x, (1, k), stride=1), (k, 1), stride=1)


SHARP_K, GRAIN_K = 5, 3          # high-pass scales (region px): detail = x - box5(x), grain = x - box3(x)


def _hp_energy(x, k, ring):
    # std of the luminance high-pass over the weights -> [B,1,1,1]
    lum = x.mean(dim=1, keepdim=True)
    return _wstats(lum - _box(lum, k), ring)[1]


def _detail_area(sel):
    """Where detail is measured (D-130): the selection itself, original vs worked in the same place. The context ring (D-129) is where
    the sampler leaves the original alone, so there the ratio sat at ~1 and the sliders did next to nothing. Tiny selection: the region."""
    rh, rw = sel.shape[-2:]
    area = (sel >= 0.5).float()
    return area if area.sum() >= 0.01 * rh * rw else torch.ones_like(area)


def _detail_match(work, base, sel, sharp, grain, seed=0x5CC):
    """Sharpness / grain match (D-129, D-130): the worked crop's fine detail scaled to the original's (measured on the selection: a soft
    upscale gets sharpened, an over-crisp one calmed), then the grain it still lacks added as monochrome noise. sharp 1 = the original's
    detail energy for real (one secant step corrects the unsharp gain). Both 0..1 (D-130: a percentage stops at 100)."""
    area = _detail_area(sel)
    if sharp > 0:
        low = _box(work, SHARP_K)
        ew = _hp_energy(work, SHARP_K, area).clamp_min(1e-4)
        ratio = (_hp_energy(base, SHARP_K, area) / ew).clamp(0.25, 4.0)
        e1 = _hp_energy(low + (work - low) * ratio, SHARP_K, area)
        # e1 - ew = what gain `ratio` really moved; scale the push so the target (ratio - 1) * ew is met
        d1 = e1 - ew
        ok = d1.abs() > 1e-6
        gain = torch.where(ok, 1.0 + (ratio - 1.0) * (ratio - 1.0) * ew / torch.where(ok, d1, torch.ones_like(d1)), ratio).clamp(0.0, 8.0)
        work = low + (work - low) * (1.0 + sharp * (gain - 1.0)).clamp_min(0.0)
    if grain > 0:
        gb, gw = _hp_energy(base, GRAIN_K, area), _hp_energy(work, GRAIN_K, area)
        amt = (gb * gb - gw * gw).clamp_min(0.0).sqrt() * grain
        gen = torch.Generator(device="cpu").manual_seed(seed)
        noise = torch.randn((1, 1, *work.shape[-2:]), generator=gen).to(work.device)
        g = noise * amt                                   # colour channels only: an alpha stays clean
        work = torch.cat([work[:, :3] + g, work[:, 3:]], dim=1) if work.shape[1] > 3 else work + g
    return work.clamp(0.0, 1.0)


def _place(work, base, fm, ox, oy, scale):
    """Move / scale the fitted worked crop inside the region (D-129): offset in region px, scale around the centre.
    What it leaves uncovered shows the original (fit mask 0 there). Same geometry as the browser's preview."""
    if ox == 0 and oy == 0 and scale == 1.0:
        return work, fm
    B, _, rh, rw = work.shape
    if fm is None:
        fm = torch.ones((1, 1, rh, rw), device=work.device)
    nh, nw = max(1, round(rh * scale)), max(1, round(rw * scale))
    if (nh, nw) != (rh, rw):
        work, fm = _resize(work, nh, nw), F.interpolate(fm, size=(nh, nw), mode="nearest")
    x0, y0 = (rw - nw) // 2 + int(ox), (rh - nh) // 2 + int(oy)
    canvas = base.expand(B, -1, -1, -1).clone()
    ofm = torch.zeros((1, 1, rh, rw), device=work.device)
    cx0, cy0, cx1, cy1 = max(0, x0), max(0, y0), min(rw, x0 + nw), min(rh, y0 + nh)
    if cx1 > cx0 and cy1 > cy0:
        canvas[..., cy0:cy1, cx0:cx1] = work[..., cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
        ofm[..., cy0:cy1, cx0:cx1] = fm[..., cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
    return canvas, ofm


def _resolve_stitch(st, base, mask):
    """The stitch Stitch works with (D-128): Crop's, with a base image and / or a mask that win over it.
    A mask (whole picture, white = replace) makes the cut its bounding box, no context. Without a stitch both are needed."""
    if base is None and mask is None:
        if st is None:
            raise ValueError(f"{_TAG} nothing to stitch into: wire a Succy Crop (stitch), or give a base image + a mask.")
        return st
    orig = base if base is not None else (st["image"] if st is not None else None)
    if orig is None:
        raise ValueError(f"{_TAG} a mask without a base image: load / connect the base image too (or wire a Succy Crop).")
    H, W = int(orig.shape[1]), int(orig.shape[2])
    if mask is None:                                       # a new base for Crop's cut: it must be the same picture, same size
        oW, oH = st["orig_size"]
        if (W, H) != (oW, oH):
            print(f"{_TAG} base image is {W}x{H}, the Crop worked at {oW}x{oH}: resizing the base to fit the cut.")
            orig = _resize(orig.permute(0, 3, 1, 2), oH, oW).permute(0, 2, 3, 1).contiguous()
        return {**st, "image": orig}
    m = _prep_mask(mask, H, W).to(orig.device)
    ys, xs = torch.nonzero(m > 0.01, as_tuple=True)
    if ys.numel() == 0:
        raise ValueError(f"{_TAG} the mask is empty: nothing to replace.")
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    return {"version": 1, "image": orig, "region": (x0, y0, x1, y1), "selection": (x0, y0, x1, y1), "orig_size": (W, H),
            "work_size": (x1 - x0, y1 - y0), "mask": m[y0:y1, x0:x1][None]}


class Succy_Stitch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "feather": ("INT", {"default": 24, "min": 0, "max": 2048, "step": 1,
                                    "tooltip": "Seam softness in region pixels (0 = hard edge)"}),
                "feather_mode": (["inside", "outside", "centered"], {"default": "inside"}),
                "feather_curve": (["smooth", "linear"], {"default": "smooth"}),
                "color_match": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 1.0,
                                          "tooltip": "% of colour correction taken from the context ring"}),
                "opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "sharpness_match": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 1.0,
                                              "tooltip": "% of the way to the original's fine detail (100 = the same detail as the original)"}),
                "grain_match": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 1.0,
                                          "tooltip": "% of the grain the worked crop lacks, added back as monochrome noise"}),
                "offset_x": ("INT", {"default": 0, "min": -16384, "max": 16384, "step": 1, "tooltip": "Move the replacement inside the cut (px)"}),
                "offset_y": ("INT", {"default": 0, "min": -16384, "max": 16384, "step": 1, "tooltip": "Move the replacement inside the cut (px)"}),
                "scale": ("FLOAT", {"default": 100.0, "min": 10.0, "max": 400.0, "step": 0.1, "tooltip": "Scale the replacement around the cut's centre (%)"}),
                "aspect_mismatch": (["auto", "stretch", "crop_center", "fit"], {"default": "auto",
                                    "tooltip": "auto = crop_center under 2% difference, otherwise warn + stretch"}),
                "source": ("STRING", {"default": "", "tooltip": "REPLACEMENT loaded on the node (input folder). A connected replacement wins"}),
                "base_file": ("STRING", {"default": "", "tooltip": "BASE IMAGE loaded on the node (input folder). Wins over the stitch's picture; a connected base_image wins over it"}),
                "mask_file": ("STRING", {"default": "", "tooltip": "MASK loaded on the node (white = replace). Wins over the stitch's mask; a connected mask wins over it"}),
                "brush": ("STRING", {"default": "", "tooltip": "Retouch of the seam, drawn on the live result over the whole picture (managed by the frontend)"}),
                "place": ("STRING", {"default": "", "tooltip": "Where the dropped PNG says it belongs (tEXt succy_crop, managed by the frontend)"}),
                "hold": ("BOOLEAN", {"default": False, "label_on": "Stop every run", "label_off": "Reuse retouch",
                                     "tooltip": "On: wait on every Run so you can retouch the seam on the fresh result"}),
                "hold_timeout": ("INT", {"default": 300, "min": 1, "max": 3600, "step": 1,
                                         "tooltip": "Seconds to wait before carrying on with the current retouch"}),
                "run_id": ("STRING", {"default": "0_manual", "tooltip": "Managed by the frontend"}),
            },
            "optional": {
                "stitch": ("STITCH", {"tooltip": "From Succy Crop: the base image, where the cut was and its mask"}),
                "base_image": ("IMAGE", {"tooltip": "The picture to stitch INTO. Wins over the stitch's picture"}),
                "mask": ("MASK", {"tooltip": "Where the replacement goes (whole picture, white = replace). Wins over the stitch's mask: the cut becomes its bounding box"}),
                "replacement": ("IMAGE", {"tooltip": "The worked crop. Any size: it is scaled back to the cut by itself. Wins over a picture loaded on the node"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }

    @classmethod
    def IS_CHANGED(cls, hold=False, run_id="", **kwargs):
        # same rule as Crop: a node that must stop never comes from the cache; a "<ts>_continue" transit may
        if hold and not str(run_id).endswith("_continue"):
            return float("nan")
        return "passthrough"

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("composite",)
    FUNCTION = "stitch"

    # LIVE LINK: the composite as it is now, no Queue — what a Succy node wired after this one (Preview, Crop, another Stitch) sees
    SUCCY_LIVE = ("composite",)

    @classmethod
    def succy_live(cls, widgets, inputs, node_id):
        last = _LAST.get(node_id) or {}
        wired = {}
        for inp, key in (("replacement", "st_image"), ("base_image", "st_base"), ("mask", "st_mask")):
            if not inputs.linked(inp):
                continue
            v = inputs.get(inp)
            if v is None:
                v = last.get(key)
            if v is None:
                raise LiveWait("run", f"the Stitch's {inp.replace('_', ' ')} comes from a wire: Run once so it gets there")
            wired[inp] = v
        st = None
        if inputs.linked("stitch"):
            st = inputs.get("stitch")
            if st is None:
                raise LiveWait("run", "the Stitch's stitch comes from a wire that only a Run fills: Run once")
        if "replacement" not in wired and not str(widgets.get("source") or ""):
            raise LiveWait("image", "the Stitch has no replacement: load one on it, or wire one")
        if st is None and not (("base_image" in wired or str(widgets.get("base_file") or "")) and ("mask" in wired or str(widgets.get("mask_file") or ""))):
            raise LiveWait("run", "the Stitch needs a Crop (stitch), or a base image + a mask")
        return {"composite": _stitch_now(st, wired, widgets)}
    OUTPUT_NODE = True             # D-125: the end of a workflow, it runs (and shows the result) even with nothing after it

    def stitch(self, feather, feather_mode, feather_curve, color_match, opacity, aspect_mismatch, sharpness_match=0.0, grain_match=0.0,
               offset_x=0, offset_y=0, scale=100.0, source="", base_file="", mask_file="", brush="", place="",
               hold=False, hold_timeout=300, run_id="", stitch=None, base_image=None, mask=None, replacement=None,
               unique_id=None, dynprompt=None, _quiet=False):
        image = replacement if replacement is not None else _load_source(source)
        if image is None:
            raise ValueError(f"{_TAG} no replacement: connect one, or drop / paste / load it on the node.")
        base_in = base_image if base_image is not None else _load_source(base_file)
        mask_in = mask if mask is not None else _load_mask(mask_file)
        stitch = _resolve_stitch(stitch, base_in, mask_in)
        if not _quiet:                                     # the node shows the replacement that came in; Copy / Download re-run from it (D-124)
            did = _display_id(dynprompt, unique_id)
            _remember(did, {"st_image": image, "st_base": base_image, "st_mask": mask})
            _send_preview(did, image, 0, 0, 0, 0)
            if hold and not str(run_id).endswith("_continue"):            # retouch on the fresh result, then ▶ (same shield as Crop / Pause)
                print(f"{_TAG} node {did} waiting up to {hold_timeout}s for a retouch...")
                _hold(did, hold_timeout)
        orig = stitch["image"]
        B_o, H, W, C = orig.shape
        rx0, ry0, rx1, ry1 = stitch["region"]
        rh, rw = ry1 - ry0, rx1 - rx0
        dev = orig.device

        work = image.to(dev).float()
        B_w = work.shape[0]
        if B_o != B_w and 1 not in (B_o, B_w):
            raise ValueError(f"{_TAG} batch mismatch: original has {B_o} images, worked has {B_w}.")
        B = max(B_o, B_w)

        # channel count follows the original (RGB worked into RGBA original and vice versa)
        cw = work.shape[3]
        if cw > C:
            work = work[..., :C]
        elif cw < C:
            work = torch.cat([work, torch.ones((*work.shape[:3], C - cw), device=dev)], dim=3)

        base = orig[:, ry0:ry1, rx0:rx1, :].permute(0, 3, 1, 2)             # BCHW
        wh, ww = int(work.shape[1]), int(work.shape[2])
        mode = _fit_mode(ww, wh, rw, rh, aspect_mismatch)
        work, fit_mask = _fit_to_region(work.permute(0, 3, 1, 2), rh, rw, mode, base.expand(B, -1, -1, -1))
        work, fit_mask = _place(work, base, fit_mask, offset_x, offset_y, float(scale) / 100.0)
        # the retouch brush is painted on the live result, over the WHOLE picture (D-125): stretched to it, then cut to the region
        add, erase = _decode_brush(brush, H, W, dev)
        if add is not None:
            add, erase = add[ry0:ry1, rx0:rx1].clamp(0, 1), erase[ry0:ry1, rx0:rx1].clamp(0, 1)

        sel = stitch["mask"].to(dev)[None]                                    # [1,1,rh,rw]
        if color_match > 0:
            work = _color_match(work, base, sel, color_match / 100.0)
        if sharpness_match > 0 or grain_match > 0:
            work = _detail_match(work, base, sel, sharpness_match / 100.0, grain_match / 100.0)

        borders = (rx0 == 0, ry0 == 0, rx1 == W, ry1 == H)
        M = _feather(sel, feather, feather_mode, feather_curve, borders)
        # retouch (D-124): painted = the worked picture wins there, erased = the original stays, AFTER the feather (the brush has its own soft tip)
        if add is not None:
            M = torch.maximum(M, add[None, None])
        if erase is not None:
            M = M * (1.0 - erase[None, None])
        if fit_mask is not None:
            M = M * fit_mask
        M = (M * opacity).clamp(0.0, 1.0)

        blended = (base * (1.0 - M) + work * M).clamp(0.0, 1.0)             # broadcasts over the batch
        out = orig.expand(B, -1, -1, -1).clone()
        out[:, ry0:ry1, rx0:rx1, :] = blended.expand(B, -1, -1, -1).permute(0, 2, 3, 1)

        return (out,)
