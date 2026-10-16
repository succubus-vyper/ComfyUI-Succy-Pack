"""Succy Pack — the shared drawer for PICTURES (D-156). Torch helpers that more than one node needs, in one copy.

Loaded ONCE by __init__.py right after succy_common and registered as `_succy_image`: nodes do `from _succy_image import ...`.
Moved here word for word from Succy_Crop_Stitch.py (Crop, Stitch and Load share them), plus:
  - load_picture       a file -> (IMAGE [1,H,W,3], MASK [1,H,W] or None): the alpha becomes the mask, like ComfyUI's Load Image
  - send_preview       the picture a node is looking at -> temp JPEG + event `succy-crop-image` (the browser's shot feed)
  - the LIVE routes    /succy/live/types (who can answer live) and /succy/live/view (a node's output as it is now, reduced)
Images are ComfyUI BHWC floats in [0,1]; masks BHW.
"""
import asyncio
import base64
import io
import math
import os
import re
import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

_TAG = "[Succy]"
PREVIEW_MAX = 2048           # longest side of the preview a node's viewport shows (coordinates stay in ORIGINAL pixels)
LIVE_MAX = 1536              # longest side of a live picture the browser gets by default (full size: Run, Copy, Download)
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")


def display_id(dynprompt, unique_id):
    """The id the user sees in the graph (a node cloned by a loop answers with its original's id)."""
    try:
        if dynprompt is not None and hasattr(dynprompt, "get_display_node_id"):
            return str(dynprompt.get_display_node_id(unique_id))
    except Exception:
        pass
    return str(unique_id)


def snap(v, m):
    # nearest multiple of m, never below m (a 0-px crop is a sad crop)
    return max(m, int(round(v / m)) * m)


def mp_size(w, h, mp):
    """Size (w, h) scaled to `mp` megapixels, same aspect, never 0 px. The browser (util/mask-math.js mpSize) uses the very same formula."""
    s = math.sqrt(mp * 1e6 / max(1, w * h))
    return max(1, int(round(w * s))), max(1, int(round(h * s)))


def resize(x, h, w, mode="bicubic"):
    # BCHW resize; antialiased when shrinking, clamped because bicubic loves to overshoot
    if tuple(x.shape[-2:]) == (h, w):
        return x
    if mode == "bicubic":
        return F.interpolate(x, size=(h, w), mode="bicubic", antialias=True, align_corners=False).clamp(0.0, 1.0)
    return F.interpolate(x, size=(h, w), mode="bilinear", align_corners=False).clamp(0.0, 1.0)


def prep_mask(mask, h, w):
    # any MASK shape -> one [h,w] float mask (batch = union), resized to the image if it differs
    m = mask.float()
    if m.dim() == 2:
        m = m[None]
    m = m.amax(dim=0)[None, None]
    m = resize(m, h, w, "bilinear")
    return m[0, 0]


def input_path(name, what="picture"):
    """A file name the node keeps (input folder, maybe a subfolder) -> its real path. Never outside the input folder."""
    import folder_paths
    root = os.path.realpath(folder_paths.get_input_directory())
    path = os.path.realpath(os.path.join(root, name))
    if not path.startswith(root + os.sep) or not os.path.isfile(path):
        raise FileNotFoundError(f"{_TAG} {what} '{name}' not found in the input folder. Load it again on the node.")
    return path


def _open(path):
    im = ImageOps.exif_transpose(Image.open(path))
    if im.mode == "I":                                     # 16-bit greyscale PNG: same scaling as ComfyUI's Load Image
        im = im.point(lambda v: v * (1 / 255))
    return im


def load_source(name):
    """A picture dropped / pasted / loaded on the node: lives in ComfyUI's input folder (native upload). -> [1,H,W,3] or None."""
    if not name:
        return None
    im = _open(input_path(name)).convert("RGB")
    return torch.from_numpy(np.asarray(im).astype(np.float32) / 255.0)[None]


def load_picture(path):
    """Any picture file -> (IMAGE [1,H,W,3], MASK [1,H,W] or None). With transparency the mask is 1 - alpha, like ComfyUI's
    Load Image (transparent = 1 = the part to work on). Without transparency: None."""
    im = _open(path)
    if im.mode == "P" and "transparency" in im.info:      # a palette PNG with a transparent colour: its alpha counts too
        im = im.convert("RGBA")
    mask = None
    if "A" in im.getbands():
        a = np.asarray(im.getchannel("A")).astype(np.float32) / 255.0
        if float(a.min()) < 1.0:
            mask = 1.0 - torch.from_numpy(a)[None]
    rgb = np.asarray(im.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(rgb)[None], mask


def load_mask(name):
    """A mask loaded on a node (input folder): white = replace. Luminance, or the alpha when the file has transparency. -> [1,H,W] or None."""
    if not name:
        return None
    im = ImageOps.exif_transpose(Image.open(input_path(name, "mask")))
    if im.mode in ("RGBA", "LA") and im.getchannel("A").getextrema()[0] < 255:
        arr = np.asarray(im.getchannel("A"))
    else:
        arr = np.asarray(im.convert("L"))
    return torch.from_numpy(arr.astype(np.float32) / 255.0)[None]


def decode_brush(data, h, w, device):
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
    t = resize(t[:, :2], h, w, "bilinear")[0]                               # stretched to the picture, like the browser does
    return t[0], t[1]


def runmax(x, r, dim):
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


def hex_rgb(c):
    # "#rrggbb" / "#rgb" -> [r, g, b] in 0..1; anything else = black (a typo never stops a Run, it just dresses in black)
    h = str(c or "").strip().lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{3}|[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", h):
        return [0.0, 0.0, 0.0]
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    return [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]


def grow(m, px):
    # dilate (px > 0) or erode (px < 0) a [H,W] mask by ~px pixels: square window k = 2|px|+1, done as a row pass then a column
    # pass (a square max IS two 1-D maxes: same numbers as one 2-D max-pool, minus the bill — D-109: 20 s -> a blink).
    # She spreads out on demand, one direction at a time.
    if px == 0:
        return m
    r = abs(px)
    x = m if px > 0 else -m
    x = runmax(runmax(x, r, 1), r, 0)
    return x if px > 0 else -x


def box1(x, r, dim):
    # 1-D mean over 2r+1 samples along `dim` with replicate padding, via a running sum: same cost at any radius (D-109)
    n = x.shape[dim]
    idx = torch.arange(-r, n + r, device=x.device).clamp(0, n - 1)
    p = x.index_select(dim, idx).double()
    c = torch.cumsum(p, dim=dim)
    c = torch.cat([torch.zeros_like(c.narrow(dim, 0, 1)), c], dim=dim)
    k = 2 * r + 1
    return ((c.narrow(dim, k, n) - c.narrow(dim, 0, n)) / k).to(x.dtype)


def blur(m, px):
    # soft edge ~px wide: three box blurs = a near-gaussian. Each box = a row pass then a column pass (separable, replicate edge):
    # the same numbers as the old 2-D avg_pool, without its k*k bill. The browser preview does exactly this (util/mask-math.js).
    if px <= 0:
        return m
    r = max(1, int(round(px / 3)))
    x = m
    for _ in range(3):
        x = box1(box1(x, r, 1), r, 0)
    return x.clamp(0.0, 1.0)


def png_bytes(t, meta=None):
    """IMAGE [B,H,W,3|4] or MASK [B,H,W] -> PNG bytes of the first item (RGB, RGBA or greyscale), fast compression.
    meta (a JSON string) goes into a tEXt chunk called succy_crop."""
    a = t[0] if t.dim() >= 3 else t
    a = (a.detach().float().clamp(0, 1) * 255.0).round().to(torch.uint8).cpu().numpy()
    if a.ndim == 3 and a.shape[-1] not in (3, 4):
        a = a[..., :3]
    buf = io.BytesIO()
    info = None
    if meta:
        from PIL.PngImagePlugin import PngInfo
        info = PngInfo()
        info.add_text("succy_crop", meta)
    Image.fromarray(a).save(buf, format="PNG", compress_level=1, pnginfo=info)          # uint8 HxW / HxWx3 / HxWx4 = L / RGB / RGBA
    return buf.getvalue()


def send_preview(did, image, tag=_TAG):
    """Save a downscaled JPEG of the first image in temp/ and tell the viewport where it is (event succy-crop-image).
    One file per node id: the browser re-reads it with a fresh `v`."""
    try:
        import folder_paths
        from server import PromptServer
        H, W = int(image.shape[1]), int(image.shape[2])
        arr = (image[0, ..., :3].clamp(0, 1) * 255.0).round().to(torch.uint8).cpu().numpy()
        im = Image.fromarray(arr)
        s = min(1.0, PREVIEW_MAX / max(W, H))
        if s < 1.0:
            im = im.resize((max(1, round(W * s)), max(1, round(H * s))), Image.LANCZOS)
        name = "succy_crop_" + re.sub(r"[^0-9A-Za-z_-]", "_", did) + ".jpg"
        im.save(os.path.join(folder_paths.get_temp_directory(), name), quality=88)
        PromptServer.instance.send_sync("succy-crop-image", {
            "node_id": did, "filename": name, "subfolder": "", "type": "temp",
            "width": W, "height": H, "v": int(time.time() * 1000),
        })
    except Exception as exc:
        print(f"{tag} preview failed: {exc}")


def live_picture(t, longest=LIVE_MAX):
    """A live output -> {width, height, data} for the browser: IMAGE as JPEG (PNG when it has alpha), MASK as greyscale PNG,
    downscaled to `longest` on the long side. width/height = the real size."""
    a = t[0] if t.dim() >= 3 else t
    a = (a.detach().float().clamp(0, 1) * 255.0).round().to(torch.uint8).cpu().numpy()
    if a.ndim == 3 and a.shape[-1] not in (3, 4):
        a = a[..., :3]
    H, W = int(a.shape[0]), int(a.shape[1])
    im = Image.fromarray(a)
    s = min(1.0, longest / max(W, H))
    if s < 1.0:
        # a MASK is area-averaged (BOX): Lanczos rings past a hard edge and the browser would see its box a few px too wide (D-163)
        im = im.resize((max(1, round(W * s)), max(1, round(H * s))), Image.BOX if im.mode == "L" else Image.LANCZOS)
    buf = io.BytesIO()
    if im.mode == "RGB":
        im.save(buf, format="JPEG", quality=90)
        kind = "jpeg"
    else:
        im.save(buf, format="PNG", compress_level=1)
        kind = "png"
    return {"width": W, "height": H, "data": f"data:image/{kind};base64," + base64.b64encode(buf.getvalue()).decode("ascii")}


def node_mapping():
    """ComfyUI's registry of node classes (empty outside ComfyUI)."""
    try:
        import nodes
        return nodes.NODE_CLASS_MAPPINGS
    except Exception:
        return {}


def live_empty(spec, name):
    """True when the live source on input `name` chose to hand out nothing (D-172): the consumer treats that wire as absent."""
    from _succy_common import LiveInputs
    return LiveInputs(spec or {}, node_mapping()).empty(name)


def live_input(spec, name):
    """Full-size value of input `name` from the live chain a browser sent ({linked, from}), or None. Raises LiveWait."""
    from _succy_common import LiveInputs
    return LiveInputs(spec or {}, node_mapping()).get(name)


# --- the LIVE routes (D-156): registered once per server, whoever loads this module first -------------------------------
def _install_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return
    srv = getattr(PromptServer, "instance", None)
    if srv is None or getattr(srv, "_succy_live_routes", False):
        return
    srv._succy_live_routes = True
    from _succy_common import LiveWait, live_eval, live_types, same_origin

    @srv.routes.get("/succy/live/types")
    async def _live_types(request):
        # who can answer live: {type: [outputs]} — the browser asks once, then only follows wires to these
        return web.json_response({"types": live_types(node_mapping())})

    def _view(spec, output, longest):
        with torch.inference_mode():
            outs = live_eval(spec, node_mapping())
            t = outs.get(output)
            if t is None and output in (outs.get("_empty") or ()):
                return {"ready": True, "empty": True}           # chosen to give nothing (D-172): a wire that is as good as absent
            if t is None:
                return {"ready": False, "need": "run", "why": f"{spec.get('type', 'the node')} has no live '{output}': Run once"}
            if not isinstance(t, torch.Tensor):
                return {"ready": False, "need": "run", "why": f"{spec.get('type', 'the node')}'s '{output}' is not a picture or a mask"}
            pic = live_picture(t, longest)
        info = outs.get("_info")
        return {"ready": True, **pic, **({"info": info} if isinstance(info, dict) else {})}

    @srv.routes.post("/succy/live/view")
    async def _live_view(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        # ?output=<name>&max=<px> · body = the chain {node_id, type, widgets, linked, from}. Not ready = 200 {ready: false, need, why}
        output = str(request.query.get("output", ""))
        try:
            longest = max(64, min(4096, int(request.query.get("max", LIVE_MAX))))
        except ValueError:
            longest = LIVE_MAX
        try:
            spec = await request.json()
        except Exception:
            return web.json_response({"error": "bad JSON"}, status=400)
        try:
            return web.json_response(await asyncio.to_thread(_view, spec, output, longest))
        except LiveWait as w:
            return web.json_response({"ready": False, "need": w.need, "why": w.why})
        except Exception as exc:
            return web.json_response({"ready": False, "need": "error", "why": str(exc).replace(_TAG, "").strip()})


_install_routes()
