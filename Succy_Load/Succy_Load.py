import asyncio
import io
import os
import re
from collections import OrderedDict

import torch
import torch.nn.functional as F
from aiohttp import web
from PIL import Image, ImageOps

import folder_paths
from server import PromptServer

from _succy_common import LiveWait, coerce_widgets, door_values, live_touch, same_origin, value_memo
from _succy_image import (IMAGE_EXT, blur, decode_brush, display_id, file_stamp, grow, hex_rgb, input_path, load_picture, mp_size, send_preview,
                          snap, parse_warp, quad_mask)

# ===================================================
# Succy Load Image & Resize (D-156)
#
# One node, two ways in:
#   image   a picture dropped / pasted / 📂 loaded on the node (or wired in), with a mask you draw on it (box + free hand, like
#           Succy Crop) — on top of a wired mask, if any (the base every tool edits, D-166). The picture's transparency is a mask too, like ComfyUI's Load Image.
#   folder  the pictures of a folder: `next` hands out the following one at every execution (every Run, every lap of a Succy
#           Loop / While, every ▶ of a Pause), `index` picks one. is_last says when the folder is over (a While stops on it).
# Then ONE resize for picture and mask together, so they always match: custom (width x height: fit / fill / pad / stretch,
# anchored, pad can be an outpaint mask) or scale (megapixels, then scale by), snapped to a multiple.
# LIVE (D-156): what this node outputs right now reaches every Succy node on its wires without a Queue (SUCCY_LIVE).
# Node names live ONLY in __init__.py (D-95). Images are ComfyUI BHWC floats in [0,1], masks BHW.
# ===================================================

_TAG = "[Succy Load]"
_ANCHORS = {"top-left": (0, 0), "top": (0.5, 0), "top-right": (1, 0), "left": (0, 0.5), "center": (0.5, 0.5), "right": (1, 0.5),
            "bottom-left": (0, 1), "bottom": (0.5, 1), "bottom-right": (1, 1)}
_INTERP = ["lanczos", "bicubic", "bilinear", "area", "nearest-exact"]

# State per node id SHOWN in the graph, on the server instance so a module reload can't register the routes twice.
# _STATE: the folder counter (plain numbers, no tensors) · _LAST: the wired inputs of the last Run (the live view falls back on them)
_STATE = getattr(PromptServer.instance, "_succy_load_state", None)
_FIRST_LOAD = _STATE is None
if _FIRST_LOAD:
    _STATE = OrderedDict()
    PromptServer.instance._succy_load_state = _STATE
    PromptServer.instance._succy_load_last = OrderedDict()
    PromptServer.instance._succy_load_lists = OrderedDict()
    PromptServer.instance._succy_load_thumbs = OrderedDict()
_LAST = PromptServer.instance._succy_load_last
_LISTS = PromptServer.instance._succy_load_lists       # folder -> (mtime, [files]): a big folder is read once per change
_THUMBS = PromptServer.instance._succy_load_thumbs     # (path, mtime, size) -> JPEG bytes, the strip under the picture
_STATE_MAX, _LAST_MAX, _LISTS_MAX, _THUMBS_MAX = 64, 12, 16, 256
_MEMO = value_memo("load", _LAST_MAX)                  # D-210: same values in = the last result out, no file read nor resize


def _keep(d, k, v, cap):
    """Insert as most recent; past `cap` entries the oldest one goes (every module-level cache here has a ceiling)."""
    d.pop(k, None)
    d[k] = v
    while len(d) > cap:
        d.popitem(last=False)


# --- folders ------------------------------------------------------------------------------------------------------------------

def resolve_folder(folder):
    """'' = ComfyUI's input folder · a relative path = a subfolder of it (never outside) · an absolute path = any folder on this
    computer, like the other folder loaders do. -> the real path; raises when it isn't a folder."""
    root = os.path.realpath(folder_paths.get_input_directory())
    f = str(folder or "").strip().strip('"').strip("'")
    if not f:
        path = root
    elif os.path.isabs(f):
        path = os.path.realpath(f)
    else:
        path = os.path.realpath(os.path.join(root, f))
        if path != root and not path.startswith(root + os.sep):
            raise ValueError(f"{_TAG} '{f}' leaves the input folder: write the full path instead.")
    if not os.path.isdir(path):
        raise FileNotFoundError(f"{_TAG} folder '{f or 'input'}' not found.")
    return path


def _natural(name):
    # img2 before img10, the way a person counts
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def list_pictures(path):
    """The pictures directly inside `path` (no subfolders), in natural order. Cached until the folder changes."""
    try:
        mt = os.stat(path).st_mtime_ns
    except OSError:
        return []
    hit = _LISTS.get(path)
    if hit and hit[0] == mt:
        return hit[1]
    files = sorted((n for n in os.listdir(path) if n.lower().endswith(IMAGE_EXT) and os.path.isfile(os.path.join(path, n))), key=_natural)
    _keep(_LISTS, path, (mt, files), _LISTS_MAX)
    return files


def _counter(did, path):
    """The folder counter of node `did`: {path, next, last}. A different folder starts from the top."""
    st = _STATE.get(did)
    if not st or st.get("path") != path:
        st = {"path": path, "next": 0, "last": None}
    _keep(_STATE, did, st, _STATE_MAX)
    return st


def folder_pick(did, folder, pick, index, advance):
    """-> (path of the folder, files, index of the picture to use). `next` + advance moves the counter (an execution);
    without advance it reads the picture the node is on (the last one handed out, or the one that comes next)."""
    path = resolve_folder(folder)
    files = list_pictures(path)
    if not files:
        raise LiveWait("image", f"the folder '{folder or 'input'}' has no pictures")
    n = len(files)
    if pick == "index":
        return path, files, max(0, min(n - 1, int(index)))
    st = _counter(did, path)
    if advance:
        i = st["next"] % n
        st["last"], st["next"] = i, (i + 1) % n
        return path, files, i
    return path, files, (st["last"] if st["last"] is not None else st["next"]) % n


# EXT v2 (D-225): the widgets a wire can drive (their own socket); the live view takes their last Run value while wired
_EXT = ("index", "width", "height", "interpolation", "megapixels", "scale_by", "multiple")


# --- resize ---------------------------------------------------------------------------------------------------------------------

def resize_plan(w, h, resize, width, height, fit, anchor, megapixels, scale_by, multiple):
    """Where a w x h picture goes. -> (sw, sh, cw, ch, ox, oy): resized to sw x sh, placed at (ox, oy) on a cw x ch canvas
    (ox/oy < 0 = fill trims, > 0 = pad borders). Pure numbers; the browser mirrors it (util/mask-math.js resizePlan).
    Who has the last word (her rule, 22/10): width x height < megapixels < scale < multiple. Custom: the box (W x H + fit) makes the
    shape, megapixels (0 = off) takes that shape to its size, scale multiplies it, multiple snaps it. Scale: the same, from the picture."""
    m = max(1, int(multiple))
    sn = (lambda v: snap(v, m)) if m > 1 else (lambda v: max(1, int(v)))

    def size(ow, oh):                                      # megapixels, then scale, then the multiple
        if megapixels > 0:
            ow, oh = mp_size(ow, oh, megapixels)
        return sn(max(1, int(round(ow * scale_by)))), sn(max(1, int(round(oh * scale_by))))

    if resize == "custom":
        W, H = int(width), int(height)
        if W <= 0 and H <= 0:
            W, H = w, h
        elif W <= 0:
            W = max(1, int(round(w * H / h)))
        elif H <= 0:
            H = max(1, int(round(h * W / w)))
        if fit == "fit":
            s = min(W / w, H / h)
            sw, sh = size(max(1, int(round(w * s))), max(1, int(round(h * s))))
            return sw, sh, sw, sh, 0, 0
        cw, ch = size(W, H)
        if fit == "stretch":
            return cw, ch, cw, ch, 0, 0
        if fit == "pad":
            s = min(cw / w, ch / h)
            sw, sh = min(cw, max(1, int(round(w * s)))), min(ch, max(1, int(round(h * s))))
        else:                                              # fill: cover the canvas, the anchor says what stays
            s = max(cw / w, ch / h)
            sw, sh = max(cw, int(round(w * s))), max(ch, int(round(h * s)))
        ax, ay = _ANCHORS.get(anchor, (0.5, 0.5))
        return sw, sh, cw, ch, int(round((cw - sw) * ax)), int(round((ch - sh) * ay))
    sw, sh = size(w, h) if resize == "scale" else (sn(w), sn(h))     # "off" (old workflows / API prompts): only the multiple
    return sw, sh, sw, sh, 0, 0


def apply_resize(img, mask, plan, interp, pad_color, outpaint):
    """Picture [B,H,W,C] and mask [B?,H,W] through the plan, together: same scale, same place, same canvas."""
    sw, sh, cw, ch, ox, oy = plan
    B, H, W, C = img.shape
    x = img.movedim(-1, 1)
    if (sh, sw) != (H, W):
        import comfy.utils
        x = comfy.utils.common_upscale(x, sw, sh, interp, "disabled").clamp(0.0, 1.0)
    m = mask.float()[:, None]
    if tuple(m.shape[-2:]) != (sh, sw):
        if interp == "nearest-exact":
            m = F.interpolate(m, size=(sh, sw), mode="nearest-exact")
        else:
            m = F.interpolate(m, size=(sh, sw), mode="bilinear", align_corners=False, antialias=sh < m.shape[-2] or sw < m.shape[-1])
        m = m.clamp(0.0, 1.0)
    if (cw, ch, ox, oy) != (sw, sh, 0, 0):
        col = torch.tensor((hex_rgb(pad_color) + [1.0] * C)[:C], dtype=x.dtype, device=x.device)
        canvas = col.view(1, C, 1, 1).expand(B, C, ch, cw).clone()
        mc = torch.full((m.shape[0], 1, ch, cw), 1.0 if outpaint else 0.0, dtype=m.dtype, device=m.device)
        sx, sy, dx, dy = max(0, -ox), max(0, -oy), max(0, ox), max(0, oy)
        w, h = min(sw - sx, cw - dx), min(sh - sy, ch - dy)
        if w > 0 and h > 0:
            canvas[..., dy:dy + h, dx:dx + w] = x[..., sy:sy + h, sx:sx + w]
            mc[..., dy:dy + h, dx:dx + w] = m[..., sy:sy + h, sx:sx + w]
        x, m = canvas, mc
    return x.movedim(1, -1).contiguous(), m[:, 0]


# --- mask -----------------------------------------------------------------------------------------------------------------------

def fit_mask(mask, H, W):
    """A wired mask -> [B,H,W] at the picture's size, every item kept (a resize in mid-workflow keeps a batch of masks)."""
    m = mask.float()
    if m.dim() == 2:
        m = m[None]
    if tuple(m.shape[-2:]) != (H, W):
        m = F.interpolate(m[:, None], size=(H, W), mode="bilinear", align_corners=False).clamp(0.0, 1.0)[:, 0]
    return m


def drawn_mask(H, W, base, kw, device):
    """The mask drawn on the node: (base ∪ box ∪ painted) minus erased, then grown and feathered — the Crop's recipe, except that
    nothing drawn means NOTHING (a zero mask, like ComfyUI's Load Image), not the whole picture. base = the picture's own transparency
    or a wired mask (D-166: the wire is the base every tool edits, as in the Crop). base [H,W] or [B,H,W] -> [B,H,W]."""
    sel = base.to(device).float() if base is not None else None
    if sel is not None and sel.dim() == 2:
        sel = sel[None]
    bw, bh = int(kw.get("w", 0)), int(kw.get("h", 0))
    r = None
    if kw.get("box") and bw > 0 and bh > 0:                 # 0 wide or 0 high = no rectangle drawn yet (D-164)
        x0, y0 = min(int(kw.get("x", 0)), W - 1), min(int(kw.get("y", 0)), H - 1)
        x1, y1 = min(W, x0 + bw), min(H, y0 + bh)
        qd = parse_warp(kw.get("quad", ""))
        if qd is not None:                                  # the box's corners dragged (D-178): the same quad as the Crop's
            r = quad_mask(W, H, (int(kw.get("x", 0)), int(kw.get("y", 0)), bw, bh), qd, device)
        else:
            r = torch.zeros((H, W), device=device)
            r[y0:y1, x0:x1] = 1.0
        if int(kw.get("box_feather", 0)) > 0:
            r = blur(r, int(kw["box_feather"]))
    add, erase = decode_brush(kw.get("brush", ""), H, W, device)
    for piece in (r, add):                                   # the drawn pieces are one picture's worth: they join EVERY item of a batch
        if piece is not None:
            sel = piece[None] if sel is None else torch.maximum(sel, piece[None])
    if sel is None:
        return torch.zeros((1, H, W), device=device)
    if erase is not None:
        sel = sel * (1.0 - erase[None])
    g, f = int(kw.get("mask_grow", 0)), int(kw.get("mask_feather", 0))
    if g or f:
        sel = torch.stack([blur(grow(m, g), f) for m in sel])   # blur(m, 0) hands the mask back untouched
    return sel.clamp(0.0, 1.0)


# --- the work, shared by the Run and the live view -----------------------------------------------------------------------------

def produce(kw, image, mask, did, advance):
    """-> (picture, mask, info, source picture). kw = coerced widgets; image / mask = what came on the wires (or None)."""
    info = {"filename": "", "index": 0, "count": 1, "is_last": True, "mode": kw.get("mode", "image")}
    alpha = None
    folder_mode = image is None and kw.get("mode") == "folder"
    if image is not None:
        pic = image
    elif folder_mode:
        path, files, i = folder_pick(did, kw.get("folder", ""), kw.get("pick", "next"), kw.get("index", 0), advance)
        pic, alpha = load_picture(os.path.join(path, files[i]))
        info.update(filename=files[i], index=i, count=len(files), is_last=i == len(files) - 1, next=_STATE.get(did, {}).get("next"))
    else:
        name = str(kw.get("source") or "")
        if not name:
            raise LiveWait("image", "no picture: drop / paste / 📂 load one on the node, or wire one")
        pic, alpha = load_picture(input_path(name))
        info["filename"] = os.path.basename(name)
    B, H, W, _ = pic.shape
    dev = pic.device
    if mask is not None:                                   # a wired mask is the base the tools edit (D-166); every item kept
        m = drawn_mask(H, W, fit_mask(mask.to(dev), H, W), kw, dev)
    elif folder_mode:                                      # folder: only the pictures' own transparency
        m = alpha.to(dev) if alpha is not None else torch.zeros((1, H, W), device=dev)
    else:
        m = drawn_mask(H, W, alpha[0] if alpha is not None else None, kw, dev)
    plan = resize_plan(W, H, kw.get("resize", "off"), kw.get("width", 0), kw.get("height", 0), kw.get("fit", "fit"), kw.get("anchor", "center"),
                       kw.get("megapixels", 0), kw.get("scale_by", 1.0), kw.get("multiple", 1))
    out, om = apply_resize(pic, m, plan, kw.get("interpolation", "lanczos"), kw.get("pad_color", "#000000"), bool(kw.get("outpaint")))
    info.update(width=int(out.shape[2]), height=int(out.shape[1]))
    return out, om, info, pic


if _FIRST_LOAD:
    def _fetch_ok(request):
        # a GET for a picture: only our own page may ask (a stranger's tab can't even embed it): Sec-Fetch-Site + Origin
        site = request.headers.get("Sec-Fetch-Site")
        return same_origin(request) and site in (None, "same-origin", "none")

    @PromptServer.instance.routes.post("/succy/load/list")
    async def _load_list(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        # body {node_id, folder} -> {files, count, next, last} or {error}: the strip of thumbnails under the picture
        try:
            data = await request.json()
            nid, folder = str(data.get("node_id", "")), str(data.get("folder") or "")
        except Exception:
            return web.json_response({"error": "bad JSON"}, status=400)
        try:
            path = await asyncio.to_thread(resolve_folder, folder)
            files = await asyncio.to_thread(list_pictures, path)
        except Exception as exc:
            return web.json_response({"error": str(exc).replace(_TAG, "").strip()})
        st = _STATE.get(nid) if (_STATE.get(nid) or {}).get("path") == path else None
        return web.json_response({"files": files, "count": len(files), "next": (st or {}).get("next", 0), "last": (st or {}).get("last")})

    def _ask_folder(start):
        # a folder dialog on THIS computer (ComfyUI runs on it): PowerShell's on Windows, tkinter elsewhere. "" = cancelled, raises = no dialog possible.
        import subprocess
        import sys
        env = dict(os.environ, SUCCY_START=start or "")
        if os.name == "nt":
            ps = ("Add-Type -AssemblyName System.Windows.Forms; $o = New-Object System.Windows.Forms.Form; $o.TopMost = $true; "
                  "$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Succy Load: pick the folder'; "
                  "if ($env:SUCCY_START -and (Test-Path -LiteralPath $env:SUCCY_START)) { $d.SelectedPath = $env:SUCCY_START }; "
                  "if ($d.ShowDialog($o) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write($d.SelectedPath) }")
            cmd = ["powershell", "-NoProfile", "-STA", "-Command", ps]
        else:
            py = ("import os, tkinter\nfrom tkinter import filedialog\nr = tkinter.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
                  "print(filedialog.askdirectory(initialdir=os.environ.get('SUCCY_START') or None) or '', end='')")
            cmd = [sys.executable, "-c", py]
        out = subprocess.run(cmd, capture_output=True, env=env, timeout=600)
        if out.returncode != 0 and not out.stdout:
            raise RuntimeError((out.stderr or b"no folder dialog on this machine").decode("utf-8", "replace").strip()[:200])
        return out.stdout.decode("utf-8", "replace").strip()

    @PromptServer.instance.routes.post("/succy/load/pickfolder")
    async def _load_pickfolder(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        try:
            start = str((await request.json()).get("start") or "")
            path = await asyncio.to_thread(_ask_folder, start)
        except Exception as exc:
            return web.json_response({"error": str(exc).replace(_TAG, "").strip() or "no folder dialog"})
        return web.json_response({"path": path})

    def _thumb(path, size):
        mt = os.stat(path).st_mtime_ns
        key = (path, mt, size)
        hit = _THUMBS.get(key)
        if hit is not None:
            return hit
        im = Image.open(path)
        im.draft("RGB", (size, size))                    # JPEGs decode straight at the small size
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((size, size), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=82 if size <= 256 else 90)
        body = buf.getvalue()
        if size <= 256:                                  # only the small ones are kept: the big view one changes with the picture
            _keep(_THUMBS, key, body, _THUMBS_MAX)
        return body

    @PromptServer.instance.routes.get("/succy/load/thumb")
    async def _load_thumb(request):
        if not _fetch_ok(request):
            return web.Response(status=403, text="refused")
        # ?folder=<as written on the node>&file=<name>&s=<px>: a picture of that folder, small. Only picture files, only one
        # that the folder listing has (no separators, no ..): this route can't read anything else.
        folder, name = request.query.get("folder", ""), request.query.get("file", "")
        try:
            size = max(32, min(2048, int(request.query.get("s", 160))))
        except ValueError:
            size = 160
        try:
            path = await asyncio.to_thread(resolve_folder, folder)
            if not name or name != os.path.basename(name) or name not in await asyncio.to_thread(list_pictures, path):
                return web.Response(status=404, text="not a picture of that folder")
            body = await asyncio.to_thread(_thumb, os.path.join(path, name), size)
        except Exception as exc:
            return web.Response(status=404, text=str(exc).replace(_TAG, "").strip())
        return web.Response(body=body, content_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})

    @PromptServer.instance.routes.post("/succy/load/seek")
    async def _load_seek(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        # body {node_id, folder, pos}: `next` goes on from picture `pos` (a click on the strip); pos -1 = back to the top (↺)
        try:
            data = await request.json()
            nid, folder, pos = str(data["node_id"]), str(data.get("folder") or ""), int(data.get("pos", -1))
            path = await asyncio.to_thread(resolve_folder, folder)
        except Exception as exc:
            return web.json_response({"error": str(exc).replace(_TAG, "").strip()}, status=400)
        st = _counter(nid, path)
        st["next"], st["last"] = max(0, pos), None
        live_touch()
        return web.json_response({"status": "ok"})


class Succy_Load_Image_Resize:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["image", "folder"], {"default": "image", "tooltip": "image = one picture with a mask you draw · folder = the pictures of a folder"}),
                "source": ("STRING", {"default": "", "tooltip": "Picture dropped / pasted / loaded on the node (input folder). A connected image wins"}),
                "folder": ("STRING", {"default": "", "tooltip": "Empty = the input folder · a name = a subfolder of input · a full path = any folder on this computer"}),
                "pick": (["index", "next"], {"default": "index", "tooltip": "next = the following picture at every execution (Run, Loop lap, Pause ▶) · index = that one"}),
                "index": ("INT", {"default": 0, "min": 0, "max": 99999, "step": 1, "tooltip": "Which picture of the folder (0 = the first)"}),
                "resize": (["scale", "custom", "off"], {"default": "scale", "tooltip": "scale = megapixels, then scale by, then multiple · custom = width × height, then the same · off = old workflows (real size)"}),
                "width": ("INT", {"default": 1024, "min": 0, "max": 16384, "step": 1, "tooltip": "custom: width (0 = from the height, same proportions)"}),
                "height": ("INT", {"default": 1024, "min": 0, "max": 16384, "step": 1, "tooltip": "custom: height (0 = from the width, same proportions)"}),
                "fit": (["fit", "fill", "pad", "stretch"], {"default": "fit", "tooltip": "fit = inside the box · fill = cover it, trim the rest · pad = inside + borders · stretch = exactly"}),
                "anchor": (list(_ANCHORS), {"default": "center", "tooltip": "fill / pad: which side stays"}),
                "pad_color": ("STRING", {"default": "#000000", "tooltip": "pad: colour of the borders (#rrggbb)"}),
                "outpaint": ("BOOLEAN", {"default": False, "tooltip": "pad: the borders are 1 in the mask (ready for an outpaint)"}),
                "megapixels": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 400.0, "step": 0.01, "tooltip": "scale: first to this many megapixels (0 = as it is)"}),
                "scale_by": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 16.0, "step": 0.01, "tooltip": "scale: then times this, on each side"}),
                "multiple": ("INT", {"default": 1, "min": 1, "max": 256, "step": 1, "tooltip": "Snap the sides to a multiple of this (1 = untouched)"}),
                "interpolation": (_INTERP, {"default": "lanczos"}),
                "x": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "y": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "w": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1, "tooltip": "Box width (0 = no box drawn yet)"}),
                "h": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1, "tooltip": "Box height (0 = no box drawn yet)"}),
                "box": ("BOOLEAN", {"default": False, "tooltip": "The box drawn on the picture is part of the mask"}),
                "box_feather": ("INT", {"default": 0, "min": 0, "max": 1024, "step": 1, "tooltip": "Soft edge of the box only"}),
                "mask_grow": ("INT", {"default": 0, "min": -1024, "max": 1024, "step": 1, "tooltip": "Grow (+) or shrink (-) the drawn mask"}),
                "mask_feather": ("INT", {"default": 0, "min": 0, "max": 1024, "step": 1, "tooltip": "Soft edge of the drawn mask"}),
                "brush": ("STRING", {"default": "", "tooltip": "Free hand mask drawn on the node (managed by the frontend)"}),
                # last on purpose (D-178): old workflows keep their widget values in line
                "quad": ("STRING", {"default": "", "tooltip": "The box's corners dragged: Ctrl + corner / rotate (managed by the frontend)"}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "Resize this picture instead (the folder steps aside)"}),
                "mask": ("MASK", {"tooltip": "The starting mask, resized with the picture: the box, the brush, grow and feather edit it (like Succy Crop)"}),
                # EXT v2 (D-225): no `_in` sockets any more, a wire on a widget's own socket arrives under the widget's name
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "STRING", "INT", "BOOLEAN")
    RETURN_NAMES = ("image", "mask", "width", "height", "filename", "index", "is_last")
    FUNCTION = "load"
    SUCCY_CACHE = "memo"  # SmartCache (D-213): pictures: the value memo (D-210)
    SUCCY_LIVE = ("image", "mask")

    @classmethod
    def IS_CHANGED(cls, mode="image", source="", folder="", pick="index", index=0, **kwargs):
        # folder + next: a new picture at every execution, never from the cache. Otherwise the file itself decides (same name, new pixels)
        try:
            if mode == "folder":
                if pick == "next":
                    return float("nan")
                path = resolve_folder(folder)
                files = list_pictures(path)
                if files:
                    f = os.path.join(path, files[max(0, min(len(files) - 1, int(index)))])
                    return f"{f}|{os.stat(f).st_mtime_ns}"
                return "empty"
            if source:
                p = input_path(source)
                return f"{p}|{os.stat(p).st_mtime_ns}"
        except Exception:
            pass
        return ""

    @staticmethod
    def _ext(kw, index_in, width_in, height_in):           # EXT before D-225 (an old API prompt): the `_in` wire wins over the widget
        if index_in is not None:
            kw["index"] = max(0, int(index_in))
        if width_in is not None:
            kw["width"] = max(0, int(width_in))
        if height_in is not None:
            kw["height"] = max(0, int(height_in))
        return kw

    def load(self, image=None, mask=None, index_in=None, width_in=None, height_in=None, unique_id=None, dynprompt=None, **widgets):
        did = display_id(dynprompt, unique_id)
        kw = self._ext(dict(widgets), index_in, width_in, height_in)
        # D-210: the key = the values that really came in. folder + next hands out a new picture at every execution: never remembered
        stamp = "" if image is not None else self.IS_CHANGED(**{**kw, "index": kw.get("index", 0)})
        key = None if isinstance(stamp, float) else {"kw": kw, "image": image, "mask": mask, "file": stamp}
        hit = _MEMO.get(did, key) if key is not None else _MEMO.skip(did)
        if hit is not None:
            out, om, info, pic = hit
        else:
            try:
                out, om, info, pic = produce(kw, image, mask, did, advance=True)
            except LiveWait as w:
                raise ValueError(f"{_TAG} {w.why}")
            if key is not None:
                _MEMO.put(did, key, (out, om, info, pic))
        _keep(_LAST, did, {"in_image": image, "in_mask": mask, "in_kw": {k: kw[k] for k in _EXT if k in kw}}, _LAST_MAX)
        live_touch()                                       # hit or not, the last Run changed: the live views ask again (D-228)
        send_preview(did, pic, _TAG)                       # the view shows the picture it draws on: before the resize
        return (out, om, info["width"], info["height"], os.path.splitext(info["filename"])[0], info["index"], bool(info["is_last"]))

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
                raise LiveWait("run", f"the Load's {inp} comes from a wire: Run once so it gets there")
            got[inp] = v
        # the rings (D-225 on the widget's own socket, read the kit's one way D-228): now, else the last Run, else "Run once"
        lk = last.get("in_kw") or {}
        widgets, _ = door_values(widgets, inputs, {("kw:" + k): v for k, v in lk.items()}, [(k, (k, k + "_in"), ("kw:" + k,)) for k in _EXT], "the Load")
        kw = coerce_widgets(cls, widgets)
        out, om, info, _ = produce(kw, got.get("image"), got.get("mask"), node_id, advance=False)
        return {"image": out, "mask": om, "_info": info}
