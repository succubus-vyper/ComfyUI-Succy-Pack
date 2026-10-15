import asyncio
import base64
import io
import os
import math
import re
import time

import numpy as np
import torch
import torch.nn.functional as F
from aiohttp import web
from PIL import Image, ImageOps

import comfy.model_management
import folder_paths
from server import PromptServer

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
# __init__.py loads this file ONCE PER NODE (Crop and Stitch share it), so the module body runs twice: the state dict and the
# route live on the server instance and are created only the first time (a second POST route = ComfyUI refuses to start).
_NODE_STATES = getattr(PromptServer.instance, "_succy_crop_states", None)
_FIRST_LOAD = _NODE_STATES is None
if _FIRST_LOAD:
    _NODE_STATES = {}
    PromptServer.instance._succy_crop_states = _NODE_STATES
    PromptServer.instance._succy_crop_last = {}
# D-115: the outputs of each Crop's LAST run (references, no copy), so the node's ⬇ can hand any of them over as a PNG
_LAST = PromptServer.instance._succy_crop_last
_DOWNLOADS = ("full_img", "cutout", "mask", "crop_img", "crop_mask")
_PREVIEW_MAX = 2048          # longest side of the preview the viewport shows (selection coords stay in ORIGINAL pixels)


def _display_id(dynprompt, unique_id):
    try:
        if dynprompt is not None and hasattr(dynprompt, "get_display_node_id"):
            return str(dynprompt.get_display_node_id(unique_id))
    except Exception:
        pass
    return str(unique_id)


if _FIRST_LOAD:
    @PromptServer.instance.routes.post("/succy/crop/action")
    async def _crop_action(request):
        data = await request.json()
        if data.get("node_id") is not None:
            _NODE_STATES[str(data["node_id"])] = data.get("action")
        return web.json_response({"status": "ok"})

    @PromptServer.instance.routes.post("/succy/crop/download")
    async def _crop_download(request):
        # ?node_id=<shown id>&which=<output>, body {widgets, linked} = the node AS IT IS NOW -> that output as a PNG.
        # D-117: no Queue needed. The very same crop() runs on the current widgets, so the file is exactly what a Run would give.
        # The picture: the one loaded on the node, or — when it comes from a wire — the one the last Run received.
        nid, which = str(request.query.get("node_id", "")), request.query.get("which", "")
        if which not in _DOWNLOADS:
            return web.json_response({"error": f"unknown output '{which}'"}, status=400)
        try:
            data = await request.json()
        except Exception:
            data = {}
        widgets, linked = data.get("widgets") or {}, set(data.get("linked") or [])
        last = _LAST.get(nid) or {}
        if not widgets:                                    # nothing sent: the last Run, as before
            if last.get(which) is None:
                return web.json_response({"error": "nothing to download yet: run the node once"}, status=404)
            outs = last
        else:
            for inp in ("image", "mask"):
                if inp in linked and last.get("in_" + inp) is None:
                    return web.json_response({"error": f"the {inp} comes from a wire: run the node once, then download"}, status=404)
            try:
                outs = await asyncio.to_thread(_crop_now, widgets, last.get("in_image") if "image" in linked else None,
                                               last.get("in_mask") if "mask" in linked else None, nid)
            except Exception as exc:
                return web.json_response({"error": str(exc).replace(_TAG, "").strip()}, status=400)
        try:
            body = await asyncio.to_thread(_png_bytes, outs[which])
        except Exception as exc:
            return web.json_response({"error": f"could not encode {which}: {exc}"}, status=500)
        name = f"{outs.get('stem') or 'crop'}_{which}.png"
        return web.Response(body=body, content_type="image/png", headers={"Content-Disposition": f'attachment; filename="{name}"'})


_INT_ARGS = ("x", "y", "w", "h", "context", "multiple", "box_snap", "box_feather", "mask_grow", "mask_feather")
_FLOAT_ARGS = ("workspace_mp", "out_mp")


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
        res = Succy_Crop().crop(**kw, image=image, mask=mask, unique_id=nid, _quiet=True)
    outs = dict(zip(Succy_Crop.RETURN_NAMES, res))
    outs["stem"] = _stem(kw.get("source", ""))
    return outs


def _stem(source):
    st = os.path.splitext(os.path.basename(str(source or "")))[0] if source else ""
    return re.sub(r"[^0-9A-Za-z_-]", "_", st)[:60]


def _png_bytes(t):
    """IMAGE [B,H,W,3|4] or MASK [B,H,W] -> PNG bytes of the first item (RGB, RGBA or greyscale), fast compression."""
    a = t[0] if t.dim() >= 3 else t
    a = (a.detach().float().clamp(0, 1) * 255.0).round().to(torch.uint8).cpu().numpy()
    if a.ndim == 3 and a.shape[-1] not in (3, 4):
        a = a[..., :3]
    buf = io.BytesIO()
    Image.fromarray(a).save(buf, format="PNG", compress_level=1)          # uint8 HxW / HxWx3 / HxWx4 = L / RGB / RGBA
    return buf.getvalue()


def _send_preview(display_id, image, x, y, w, h):
    """Save a downscaled JPEG of the first image in temp/ and tell the viewport where it is (event succy-crop-image)."""
    try:
        H, W = int(image.shape[1]), int(image.shape[2])
        arr = (image[0, ..., :3].clamp(0, 1) * 255.0).round().to(torch.uint8).cpu().numpy()
        im = Image.fromarray(arr)
        s = min(1.0, _PREVIEW_MAX / max(W, H))
        if s < 1.0:
            im = im.resize((max(1, round(W * s)), max(1, round(H * s))), Image.LANCZOS)
        name = "succy_crop_" + re.sub(r"[^0-9A-Za-z_-]", "_", display_id) + ".jpg"
        im.save(os.path.join(folder_paths.get_temp_directory(), name), quality=88)
        PromptServer.instance.send_sync("succy-crop-image", {
            "node_id": display_id, "filename": name, "subfolder": "", "type": "temp",
            "width": W, "height": H, "v": int(time.time() * 1000),
        })
    except Exception as exc:
        print(f"{_TAG} preview failed: {exc}")


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


def _snap(v, m):
    # nearest multiple of m, never below m (a 0-px crop is a sad crop)
    return max(m, int(round(v / m)) * m)


def _mp_size(w, h, mp):
    """Size (w, h) scaled to `mp` megapixels, same aspect, never 0 px. The browser (shot_system) uses the very same formula."""
    s = math.sqrt(mp * 1e6 / max(1, w * h))
    return max(1, int(round(w * s))), max(1, int(round(h * s)))


def _resize(x, h, w, mode="bicubic"):
    # BCHW resize; antialiased when shrinking, clamped because bicubic loves to overshoot
    if tuple(x.shape[-2:]) == (h, w):
        return x
    if mode == "bicubic":
        return F.interpolate(x, size=(h, w), mode="bicubic", antialias=True, align_corners=False).clamp(0.0, 1.0)
    return F.interpolate(x, size=(h, w), mode="bilinear", align_corners=False).clamp(0.0, 1.0)


def _prep_mask(mask, h, w):
    # any MASK shape -> one [h,w] float mask (batch = union), resized to the image if it differs
    m = mask.float()
    if m.dim() == 2:
        m = m[None]
    m = m.amax(dim=0)[None, None]
    m = _resize(m, h, w, "bilinear")
    return m[0, 0]


# --- phase 3 (D-106): picture without a wire, free hand mask, grow + feather of the output mask ----------------------

def _load_source(name):
    """A picture dropped / pasted / loaded on the node: lives in ComfyUI's input folder (native upload). -> [1,H,W,3] or None."""
    if not name:
        return None
    root = os.path.realpath(folder_paths.get_input_directory())
    path = os.path.realpath(os.path.join(root, name))
    if not path.startswith(root + os.sep) or not os.path.isfile(path):
        raise FileNotFoundError(f"{_TAG} picture '{name}' not found in the input folder. Load it again on the node.")
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return torch.from_numpy(np.asarray(im).astype(np.float32) / 255.0)[None]


def _decode_brush(data, h, w, device):
    """The node's free hand PNG (data URL): R = painted, G = erased. -> (add, erase) [h,w] floats, or (None, None) when empty."""
    if not data or "," not in data:
        return None, None
    try:
        raw = base64.b64decode(data.split(",", 1)[1])
        arr = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB")).astype(np.float32) / 255.0
    except Exception as exc:
        print(f"{_TAG} free hand mask unreadable, ignored: {exc}")
        return None, None
    t = torch.from_numpy(arr).to(device).permute(2, 0, 1)[None]            # 1,3,mh,mw
    t = _resize(t[:, :2], h, w, "bilinear")[0]                              # stretched to the picture, like the browser does
    return t[0], t[1]


def _runmax(x, r, dim):
    # 1-D max over [i-r, i+r] along `dim`, outside the picture ignored (padding -inf, like max_pool2d). Doubling trick: maxima over
    # 1, 2, 4... samples, then two overlapping ones cover the window: log2(k) cheap passes whatever the radius (D-109).
    n, k = x.shape[dim], 2 * r + 1
    pad = torch.full_like(x.narrow(dim, 0, 1), float("-inf")).expand(*[r if d == dim % x.dim() else -1 for d in range(x.dim())])
    M = torch.cat([pad, x, pad], dim=dim)
    L = 1
    while 2 * L <= k:
        M = torch.maximum(M.narrow(dim, 0, M.shape[dim] - L), M.narrow(dim, L, M.shape[dim] - L))
        L *= 2
    return torch.maximum(M.narrow(dim, 0, n), M.narrow(dim, k - L, n))


def _hex_rgb(c):
    # "#rrggbb" / "#rgb" -> [r, g, b] in 0..1; anything else = black (a typo never stops a Run, it just dresses in black)
    h = str(c or "").strip().lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{3}|[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", h):
        return [0.0, 0.0, 0.0]
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    return [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]


def _grow(m, px):
    # dilate (px > 0) or erode (px < 0) a [H,W] mask by ~px pixels: square window k = 2|px|+1, done as a row pass then a column
    # pass (a square max IS two 1-D maxes: same numbers as one 2-D max-pool, minus the bill — D-109: 20 s -> a blink).
    # She spreads out on demand, one direction at a time.
    if px == 0:
        return m
    r = abs(px)
    x = m if px > 0 else -m
    x = _runmax(_runmax(x, r, 1), r, 0)
    return x if px > 0 else -x


def _box1(x, r, dim):
    # 1-D mean over 2r+1 samples along `dim` with replicate padding, via a running sum: same cost at any radius (D-109)
    n = x.shape[dim]
    idx = torch.arange(-r, n + r, device=x.device).clamp(0, n - 1)
    p = x.index_select(dim, idx).double()
    c = torch.cumsum(p, dim=dim)
    c = torch.cat([torch.zeros_like(c.narrow(dim, 0, 1)), c], dim=dim)
    k = 2 * r + 1
    return ((c.narrow(dim, k, n) - c.narrow(dim, 0, n)) / k).to(x.dtype)


def _blur(m, px):
    # soft edge ~px wide: three box blurs = a near-gaussian. Each box = a row pass then a column pass (separable, replicate edge):
    # the same numbers as the old 2-D avg_pool, without its k*k bill. The browser preview does exactly this (util/mask-math.js).
    if px <= 0:
        return m
    r = max(1, int(round(px / 3)))
    x = m
    for _ in range(3):
        x = _box1(_box1(x, r, 1), r, 0)
    return x.clamp(0.0, 1.0)


class Succy_Crop:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "x": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "y": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "w": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1,
                              "tooltip": "0 = up to the right edge"}),
                "h": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1,
                              "tooltip": "0 = down to the bottom edge"}),
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
                "mask": ("MASK", {"tooltip": "If connected, the selection is its bounding box and the output mask keeps its shape"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }

    @classmethod
    def IS_CHANGED(cls, hold=False, run_id="", **kwargs):
        # a node that must stop never comes from the cache (the second Run would skip the wait); a "<ts>_continue" transit may
        if hold and not str(run_id).endswith("_continue"):
            return float("nan")
        return "passthrough"

    # D-118/D-120: six outputs, in the order the user reaches for them. Defaults (megapixels 0, multiple 1) = everything at REAL resolution.
    #   stitch     everything Succy Stitch needs to put the worked crop back
    #   full_img   the whole picture AT WORKSPACE SIZE (workspace_mp; = the input when 0): the canvas, mask and stitch all live here
    #   cutout     crop_img with crop_mask applied (Alpha = transparent outside, Solid = the chosen colour)
    #   mask       the final mask over the WHOLE picture (same size as the input): use it on the original
    #   crop_img   the crop (selection + context), resized only if work size / multiple ask for it
    #   crop_mask  the same mask, cut and sized like crop_img
    RETURN_TYPES = ("STITCH", "IMAGE", "IMAGE", "MASK", "IMAGE", "MASK")
    RETURN_NAMES = ("stitch", "full_img", "cutout", "mask", "crop_img", "crop_mask")
    FUNCTION = "crop"

    def crop(self, x, y, w, h, context, workspace_mp, out_mp, multiple, box_snap=1, alpha=False, solid_color="#000000", box=True, box_feather=0, mask_grow=0, mask_feather=0, hold=False, hold_timeout=300,
             run_id="", source="", brush="", image=None, mask=None, unique_id=None, dynprompt=None, _quiet=False):
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

        # --- selection (full-size [H,W] mask): base = input mask (if it has pixels) or the rectangle (if on, softened by box_feather),
        #     then free hand: (base + painted) minus erased, THEN grown/shrunk and feathered: grow and feather shape the eraser's
        #     edge too, like every other edge of the mask (D-112, the user's call).
        #     The node's live preview runs the SAME recipe in the browser: js/NodeStructure/util/mask-math.js (cropMask).
        dev = image.device
        base = None
        if mask is not None:
            m = _prep_mask(mask, H, W).to(dev)
            if bool((m > 0.5).any()):
                base = m
        if base is None and box:
            x0 = min(x, W - 1)
            y0 = min(y, H - 1)
            x1 = W if w == 0 else min(W, x0 + w)
            y1 = H if h == 0 else min(H, y0 + h)
            base = torch.zeros((H, W), device=dev)
            base[y0:y1, x0:x1] = 1.0
            if box_feather > 0:
                base = _blur(base, int(box_feather))                          # the rectangle's own soft edge (D-107), centred on its border
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
            _LAST[did] = {"full_img": image, "cutout": cutout, "mask": full_mask, "crop_img": out_img, "crop_mask": out_mask,
                          "stem": _stem(source), "in_image": in_image, "in_mask": mask}
        return (stitch, image, cutout, full_mask, out_img, out_mask)


# ---------------------------------------------------------------------------
# Stitch helpers (pure torch, testable without ComfyUI)
# ---------------------------------------------------------------------------

def _fit_to_region(work, rh, rw, mode, base):
    """Bring the worked crop (BCHW) to the region's size. Returns (BCHW, fit_mask or None)."""
    h, w = work.shape[-2:]
    diff = abs((w / h) / (rw / rh) - 1.0)
    if mode == "auto":
        if diff < 0.02:
            mode = "crop_center"
        else:
            print(f"{_TAG} worked image is {w}x{h} but the crop region is {rw}x{rh} "
                  f"({diff * 100:.1f}% off in proportions): stretching it. Pick crop_center / fit to change that.")
            mode = "stretch"

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


class Succy_Stitch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "stitch": ("STITCH",),
                "image": ("IMAGE", {"tooltip": "The worked crop. Any size: it is scaled back to the crop region by itself"}),
                "feather": ("INT", {"default": 24, "min": 0, "max": 2048, "step": 1,
                                    "tooltip": "Seam softness in region pixels (0 = hard edge)"}),
                "feather_mode": (["inside", "outside", "centered"], {"default": "inside"}),
                "feather_curve": (["smooth", "linear"], {"default": "smooth"}),
                "color_match": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 1.0,
                                          "tooltip": "% of colour correction taken from the context ring"}),
                "opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "aspect_mismatch": (["auto", "stretch", "crop_center", "fit"], {"default": "auto",
                                    "tooltip": "auto = crop_center under 2% difference, otherwise warn + stretch"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "stitch"

    def stitch(self, stitch, image, feather, feather_mode, feather_curve, color_match, opacity, aspect_mismatch):
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
        work, fit_mask = _fit_to_region(work.permute(0, 3, 1, 2), rh, rw, aspect_mismatch, base.expand(B, -1, -1, -1))

        sel = stitch["mask"].to(dev)[None]                                    # [1,1,rh,rw]
        if color_match > 0:
            work = _color_match(work, base, sel, color_match / 100.0)

        borders = (rx0 == 0, ry0 == 0, rx1 == W, ry1 == H)
        M = _feather(sel, feather, feather_mode, feather_curve, borders)
        if fit_mask is not None:
            M = M * fit_mask
        M = (M * opacity).clamp(0.0, 1.0)

        blended = (base * (1.0 - M) + work * M).clamp(0.0, 1.0)             # broadcasts over the batch
        out = orig.expand(B, -1, -1, -1).clone()
        out[:, ry0:ry1, rx0:rx1, :] = blended.expand(B, -1, -1, -1).permute(0, 2, 3, 1)

        full = torch.zeros((1, H, W), device=dev)
        full[0, ry0:ry1, rx0:rx1] = M[0, 0]
        return (out, full)
