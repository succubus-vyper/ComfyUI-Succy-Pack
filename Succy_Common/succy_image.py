"""Succy Pack — the shared drawer for PICTURES (D-156). Torch helpers that more than one node needs, in one copy.

Loaded ONCE by __init__.py right after succy_common and registered as `_succy_image`: nodes do `from _succy_image import ...`.
Moved here word for word from Succy_Crop_Stitch.py (Crop, Stitch and Load share them), plus:
  - load_picture       a file -> (IMAGE [1,H,W,3], MASK [1,H,W] or None): the alpha becomes the mask, like ComfyUI's Load Image
  - send_preview       the picture a node is looking at -> temp JPEG + event `succy-crop-image` (the browser's shot feed)
  - the LIVE routes    /succy/live/types (who can answer live), /succy/live/view (a node's output as it is now, reduced),
                       /succy/live/stats (the one live queue, D-336)
  - file_stamp         a file kept on a node -> 'path|mtime': the value memo's word for "the same file" (D-210)
  - /succy/memo/stats  the value memo's hits / misses / skips per node (the Monitor's row, D-210)
Images are ComfyUI BHWC floats in [0,1]; masks BHW.
"""
import asyncio
import base64
import io
import json
import math
import os
import re
import time

import numpy as np
import torch

from _succy_common import say   # quiet unless the nodes may talk (D-311)
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


def file_stamp(name):
    """A file kept on a node -> 'path|mtime' (same name, new pixels = a new stamp); '' without a file, 'missing:<name>' when it's gone."""
    if not name:
        return ""
    try:
        p = input_path(name)
        return f"{p}|{os.stat(p).st_mtime_ns}"
    except Exception:
        return "missing:" + str(name)


def _open(path):
    im = ImageOps.exif_transpose(Image.open(path))
    if im.mode == "I":                                     # 16-bit greyscale PNG: same scaling as ComfyUI's Load Image
        im = im.point(lambda v: v * (1 / 255))
    return im


def load_source(name, alpha=False):
    """A picture dropped / pasted / loaded on the node: lives in ComfyUI's input folder (native upload). -> [1,H,W,3] or None.
    alpha=True: a picture with real transparency comes back [1,H,W,4] (Stitch's replacement, D-189: transparent = nothing there)."""
    if not name:
        return None
    im = _open(input_path(name))
    if alpha:
        if im.mode == "P" and "transparency" in im.info:
            im = im.convert("RGBA")
        if "A" in im.getbands() and im.getchannel("A").getextrema()[0] < 255:
            return torch.from_numpy(np.asarray(im.convert("RGBA")).astype(np.float32) / 255.0)[None]
    return torch.from_numpy(np.asarray(im.convert("RGB")).astype(np.float32) / 255.0)[None]


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
        say(f"{_TAG} free hand mask unreadable, ignored: {exc}")
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
    if m.dim() == 2 and min(m.shape) > 64:
        # D-336: only the part that is not zero (+ the blur's reach) is worked: a box on a 3072x5504 photo blurred 1.6 s, the box
        # alone a blink. Same numbers: outside that window the input is zero all around, the three boxes reach 3r, the margin 3r+2
        ys, xs = torch.nonzero(m.amax(1) != 0, as_tuple=True)[0], torch.nonzero(m.amax(0) != 0, as_tuple=True)[0]
        if ys.numel() == 0:
            return m.clamp(0.0, 1.0)
        H, W, pad = m.shape[0], m.shape[1], 3 * r + 2
        y0, y1 = max(0, int(ys[0]) - pad), min(H, int(ys[-1]) + 1 + pad)
        x0, x1 = max(0, int(xs[0]) - pad), min(W, int(xs[-1]) + 1 + pad)
        if (y1 - y0) * (x1 - x0) < 0.7 * H * W:
            out = torch.zeros_like(m)
            out[y0:y1, x0:x1] = blur(m[y0:y1, x0:x1].contiguous(), px)
            return out
    x = m
    for _ in range(3):
        x = box1(box1(x, r, 1), r, 0)
    return x.clamp(0.0, 1.0)


# ---------------- Free Edit (D-176): four corners, one homography ----------------
# The browser runs the very same formulas (NodeStructure/util/blend-math.js homography / warpQuad): what you drag is what you get.

def parse_warp(s):
    """The `warp` native -> 8 floats (dx, dy of the corners top-left, top-right, bottom-right, bottom-left, in region px), or None.
    Empty, unreadable or all zero = no Free Edit: old workflows stay exactly as they were."""
    try:
        v = json.loads(s) if isinstance(s, str) else s
        v = [float(x) for x in v]
    except (TypeError, ValueError):
        return None
    if len(v) != 8 or not all(math.isfinite(x) for x in v) or all(abs(x) < 1e-9 for x in v):
        return None
    return v


def homography(src, dst):
    """3x3 (row-major list, h33 = 1) that sends the 4 points src -> dst. Plain Gaussian elimination with partial pivoting,
    written exactly like the browser's, so both sides land on the same numbers. None when the four points are degenerate."""
    a = []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u])
        a.append([0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v])
    for c in range(8):
        p = max(range(c, 8), key=lambda r: abs(a[r][c]))
        if abs(a[p][c]) < 1e-12:
            return None
        a[c], a[p] = a[p], a[c]
        for r in range(8):
            if r != c and a[r][c] != 0.0:
                f = a[r][c] / a[c][c]
                a[r] = [a[r][k] - f * a[c][k] for k in range(9)]
    h = [a[i][8] / a[i][i] for i in range(8)] + [1.0]
    # D-188: h33 = 1 fixes the scale, not its SIGN. With the picture's origin beyond the horizon the denominator went negative inside
    # the shape itself and `project` threw every pixel away (the rhombus whose mask came and went). Positive at src's centre.
    cx, cy = sum(p[0] for p in src) / 4.0, sum(p[1] for p in src) / 4.0
    return [-v for v in h] if h[6] * cx + h[7] * cy + 1.0 < 0 else h


def warp_corners(rect, d):
    """rect (x, y, w, h) + the 8 deltas -> the 4 corners (TL, TR, BR, BL) where they were and where they are now."""
    x, y, w, h = rect
    src = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    return src, [(px + d[2 * i], py + d[2 * i + 1]) for i, (px, py) in enumerate(src)]


def project(hm, x, y):
    """A point through a homography, or None when it falls behind the horizon. Same test as the browser's `project`."""
    den = hm[6] * x + hm[7] * y + hm[8]
    if den <= 1e-9:
        return None
    return ((hm[0] * x + hm[1] * y + hm[2]) / den, (hm[3] * x + hm[4] * y + hm[5]) / den)


def rect_pts(x, y, w, h):
    """The 4 corners of a rectangle, TL TR BR BL: the order every Free Edit list uses."""
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]


def remap(img, fm, hm, ow, oh, mode="bilinear"):
    """Sample img (BCHW, or None) and fm ([1,1,H,W] = where it is really there, None = everywhere) at ow x oh through hm
    (3x3: OUTPUT pixel -> SOURCE pixel, pixel centres). Colour: border padding; fm: zero outside the source, so what the
    output sees beyond the picture (or behind the horizon) is 0. Bilinear, grid_sample(align_corners=False) — the browser's `remap`.
    mode = "bicubic" for the colour only (Rotate, D-313: a free angle resamples twice, it wants the better filter); fm stays bilinear.
    -> (img or None, fm). The one door every Free Edit goes through: warp, straighten, put back."""
    ref = img if img is not None else fm
    H, W = int(ref.shape[-2]), int(ref.shape[-1])
    dev = ref.device
    ys, xs = torch.meshgrid(torch.arange(oh, device=dev, dtype=torch.float64) + 0.5,
                            torch.arange(ow, device=dev, dtype=torch.float64) + 0.5, indexing="ij")
    den = hm[6] * xs + hm[7] * ys + hm[8]
    ok = den > 1e-9
    den = torch.where(ok, den, torch.ones_like(den))
    sx = (hm[0] * xs + hm[1] * ys + hm[2]) / den
    sy = (hm[3] * xs + hm[4] * ys + hm[5]) / den
    sx = torch.where(ok, sx, torch.full_like(sx, -4.0 * W))
    grid = torch.stack([2.0 * sx / W - 1.0, 2.0 * sy / H - 1.0], dim=-1).float()[None]
    out = None
    if img is not None:
        out = F.grid_sample(img, grid.expand(img.shape[0], -1, -1, -1), mode=mode, padding_mode="border", align_corners=False)
        if mode == "bicubic":
            out = out.clamp(0.0, 1.0)                     # bicubic loves to overshoot
    m = fm if fm is not None else torch.ones((1, 1, H, W), device=dev)
    om = F.grid_sample(m.float(), grid.expand(m.shape[0], -1, -1, -1), mode="bilinear", padding_mode="zeros", align_corners=False)
    return out, om.clamp(0.0, 1.0)


def warp_quad(img, fm, rect, d):
    """Free Edit (D-176): the picture inside `rect` (region px) goes where its 4 corners were dragged.
    img BCHW (region size, or None: only fm), fm [1,1,H,W] = where it is really there (None = everywhere). Returns (img, fm): outside the
    new quad fm is 0, so the blend shows the original there. Bilinear, pixel centres (align_corners=False). Corners folded over = nothing there.
    She bends, she tilts, she leans into perspective — and never leaves a seam where you can see it."""
    if d is None:
        return img, fm
    src, dst = warp_corners(rect, d)
    hi = homography(dst, src)                              # every output pixel asks where it came from
    ref = img if img is not None else fm
    H, W = int(ref.shape[-2]), int(ref.shape[-1])
    if hi is None:
        return img, torch.zeros((1, 1, H, W), device=ref.device)
    return remap(img, fm, hi, W, H)


def bend_quad(img, fm, src, d):
    """Free Edit Mask on a slanted cut (D-189): the four points `src` (TL TR BR BL, region px — the shape's own corners, not the box's)
    moved by the 8 deltas `d`; the picture / mask bends with them. warp_quad is the same with src = a rectangle's corners."""
    if d is None:
        return img, fm
    dst = [(px + d[2 * i], py + d[2 * i + 1]) for i, (px, py) in enumerate(src)]
    hi = homography(dst, src)
    ref = img if img is not None else fm
    H, W = int(ref.shape[-2]), int(ref.shape[-1])
    if hi is None:
        return img, torch.zeros((1, 1, H, W), device=ref.device)
    return remap(img, fm, hi, W, H)


def quad_size(q):
    """The straight size (w, h) of a quad TL TR BR BL: the mean of its opposite sides, like Photoshop's perspective crop. Never 0."""
    d = lambda a, b: math.hypot(b[0] - a[0], b[1] - a[1])
    return (max(1, round((d(q[0], q[1]) + d(q[3], q[2])) / 2)), max(1, round((d(q[0], q[3]) + d(q[1], q[2])) / 2)))


def quad_mask(W, H, rect, d, device=None):
    """Free Edit Selection of the Crop (D-178): the rectangle `rect` with its corners dragged by `d`, as a [H, W] mask with an
    anti-aliased edge (each pixel centre measured in the rectangle's own frame). Folded / degenerate corners = an empty mask.
    The browser's `quadMask`, number for number."""
    src, dst = warp_corners(rect, d)
    hi = homography(dst, src)
    if hi is None:
        return torch.zeros((H, W), device=device)
    x, y, w, h = rect
    ys, xs = torch.meshgrid(torch.arange(H, device=device, dtype=torch.float64) + 0.5,
                            torch.arange(W, device=device, dtype=torch.float64) + 0.5, indexing="ij")
    den = hi[6] * xs + hi[7] * ys + hi[8]
    ok = den > 1e-9
    den = torch.where(ok, den, torch.ones_like(den))
    sx = (hi[0] * xs + hi[1] * ys + hi[2]) / den
    sy = (hi[3] * xs + hi[4] * ys + hi[5]) / den
    cx = (torch.minimum(sx - x, x + w - sx) + 0.5).clamp(0.0, 1.0)
    cy = (torch.minimum(sy - y, y + h - sy) + 0.5).clamp(0.0, 1.0)
    return torch.where(ok, cx * cy, torch.zeros_like(cx)).float()


def quad_region(rect, d, pad):
    """The perspective crop's geometry (D-178): the dragged quad straightened, `pad` straight px around it (context, grow, feather).
    -> (region quad TL TR BR BL in picture px, straight w, straight h), or None when the corners are degenerate."""
    _, q = warp_corners(rect, d)
    sw, sh = quad_size(q)
    hs = homography(rect_pts(0, 0, sw, sh), q)
    if hs is None:
        return None
    rq = [project(hs, px, py) for px, py in rect_pts(-pad, -pad, sw + 2 * pad, sh + 2 * pad)]
    if any(p is None for p in rq):
        return None
    return rq, sw + 2 * pad, sh + 2 * pad


# ---------------- Fill (D-313): the kit's ONE way to fill where there is no picture ----------------
# Rotate's new corners, the Load's pad borders, the Any's pad, the Crop's Solid cutout: all through here (broken for all or for none).
FILL_MODES = ("blur", "color")


def _smooth3(x):
    # 3x3 mean, replicate edge: takes the staircase off each bilinear step up the pyramid
    return F.avg_pool2d(F.pad(x, (1, 1, 1, 1), mode="replicate"), 3, stride=1)


def _pushpull(x, w):
    """x BCHW, w [B|1,1,H,W] in 0..1 = how much of each pixel is really there -> x with the gaps filled: the picture's own edge stretched
    inwards and blurred, coarser the further it goes (a pull-push pyramid: no shapes, no clones). Where w is 1 the pixel stays exactly.
    Costs ~1.3x the picture whatever the size of the gap: an 8k is tenths of a second."""
    H, W = int(x.shape[-2]), int(x.shape[-1])
    w = w.to(x.dtype).clamp(0.0, 1.0).expand(x.shape[0], 1, H, W)
    xs, ws = [x * w], [w]
    while min(int(xs[-1].shape[-2]), int(xs[-1].shape[-1])) > 2:
        sz = ((int(xs[-1].shape[-2]) + 1) // 2, (int(xs[-1].shape[-1]) + 1) // 2)
        xs.append(F.interpolate(xs[-1], size=sz, mode="area"))
        ws.append(F.interpolate(ws[-1], size=sz, mode="area"))
    top = ws[-1]
    mean = xs[-1].sum(dim=(2, 3), keepdim=True) / top.sum(dim=(2, 3), keepdim=True).clamp_min(1e-8)
    est = torch.where(top > 1e-6, xs[-1] / top.clamp_min(1e-6), mean)
    for lx, lw in zip(reversed(xs[:-1]), reversed(ws[:-1])):
        up = _smooth3(F.interpolate(est, size=tuple(lx.shape[-2:]), mode="bilinear", align_corners=False))
        est = lx + up * (1.0 - lw)                     # lx = the real pixels' share (premultiplied), the gap takes the coarser guess
    return est.clamp(0.0, 1.0)


def fill(x, hole, mode="blur", color="#000000"):
    """D-313, the ONE Fill. x BCHW, hole [B|1,1,H,W] in 0..1 (1 = nothing there, soft edges welcome) -> BCHW.
    color = a flat colour (black is just a colour) · blur = the picture's own edge stretched in and blurred hard, no shapes, no clones
    (a mirror was turned down: the sampler sees the copy and draws it twice). Where hole is 0 nothing changes.
    She covers what is missing so well that nobody asks what was there."""
    hole = hole.to(x.dtype).clamp(0.0, 1.0)
    if not bool((hole > 0).any()):
        return x
    if mode == "blur":
        return _pushpull(x, 1.0 - hole)
    C = int(x.shape[1])
    col = torch.tensor((hex_rgb(color) + [1.0] * C)[:C], dtype=x.dtype, device=x.device).view(1, C, 1, 1)
    return x * (1.0 - hole) + col * hole


# ---------------- Rotate / Flip (D-313): turn a picture, and turn it back (Stitch) ----------------
# Order: flip first (exact), then turn `angle` degrees CLOCKWISE around the centre, on a canvas grown to hold all of it.
# Quarter turns move pixels (no resampling, no loss); a free angle samples bicubic. Stitch's way back is unturn().

def quarter(angle):
    """The number of quarter turns (0..3) when `angle` is one, else None."""
    a = float(angle) % 360.0
    q = round(a / 90.0)
    return q % 4 if abs(a - 90.0 * q) < 1e-6 else None


def turn_size(W, H, angle):
    """(OW, OH): the canvas a W x H picture needs once turned by `angle` degrees — the box around it. The browser does the same sum."""
    q = quarter(angle)
    if q is not None:
        return (H, W) if q % 2 else (W, H)
    r = math.radians(float(angle))
    c, s = abs(math.cos(r)), abs(math.sin(r))
    # ceil = nothing cut, minus 0.05 px: a hair off a quarter turn (90.0001°) must not grow a whole row of fill
    return max(1, int(math.ceil(W * c + H * s - 0.05))), max(1, int(math.ceil(W * s + H * c - 0.05)))


def turn_hm(W, H, OW, OH, angle):
    """3x3 for remap: a pixel of the OW x OH canvas -> where it comes from in the W x H picture (clockwise on screen, y down:
    out = R (src - centre) + canvas centre, so src = R^T (out - canvas centre) + centre)."""
    r = math.radians(float(angle))
    c, s = math.cos(r), math.sin(r)
    ox, oy, cx, cy = OW / 2.0, OH / 2.0, W / 2.0, H / 2.0
    return [c, s, cx - c * ox - s * oy, -s, c, cy + s * ox - c * oy, 0.0, 0.0, 1.0]


def _flip(t, flip_h, flip_v):
    dims = [d for d, on in ((-1, flip_h), (-2, flip_v)) if on]
    return t if t is None or not dims else torch.flip(t, dims)


def _batch_as_channels(m, fn):
    # a batch of masks [B,1,H,W] through a one-item sampler: the batch rides as channels, then comes back
    return fn(m.permute(1, 0, 2, 3)).permute(1, 0, 2, 3)


def turn(x, m, angle, flip_h=False, flip_v=False):
    """x BCHW (or None), m [B,1,H,W] (or None) -> (x, m, cover). cover [1,1,OH,OW] = where the picture really is (1) and the new
    corners (0): what Fill fills and the mask marks. Outside the picture the mask is 0."""
    ref = x if x is not None else m
    H, W = int(ref.shape[-2]), int(ref.shape[-1])
    x, m = _flip(x, flip_h, flip_v), _flip(m, flip_h, flip_v)
    q = quarter(angle)
    if q is not None:
        if q:
            x = None if x is None else torch.rot90(x, -q, (-2, -1))          # rot90 with k > 0 turns counter-clockwise on screen
            m = None if m is None else torch.rot90(m, -q, (-2, -1))
        OW, OH = turn_size(W, H, angle)
        return x, m, torch.ones((1, 1, OH, OW), device=ref.device)
    OW, OH = turn_size(W, H, angle)
    hm = turn_hm(W, H, OW, OH, angle)
    if x is not None:
        x, cover = remap(x.float(), None, hm, OW, OH, "bicubic")
    else:
        _, cover = remap(None, None if m is None else torch.ones_like(m[:1]), hm, OW, OH)
    if m is not None:
        m = _batch_as_channels(m.float(), lambda t: remap(None, t, hm, OW, OH)[1])
    return x, m, cover


def unturn(x, size, angle, flip_h=False, flip_v=False):
    """Stitch's way back (D-313). x BCHW shaped like turn()'s canvas, at any scale (an upscale x2 comes home too: measured, never
    asked) -> the W x H frame it was turned from (`size`), at that same scale, then un-flipped. -> BCHW."""
    W, H = int(size[0]), int(size[1])
    OW, OH = turn_size(W, H, angle)
    h, w = int(x.shape[-2]), int(x.shape[-1])
    k = (w / OW + h / OH) / 2.0
    TW, TH = max(1, int(round(W * k))), max(1, int(round(H * k)))
    q = quarter(angle)
    if q is not None:
        y = torch.rot90(x, q, (-2, -1)) if q else x
        y = resize(y, TH, TW) if tuple(y.shape[-2:]) != (TH, TW) else y
    else:
        r = math.radians(float(angle))
        c, s = math.cos(r), math.sin(r)
        fx, fy, ax, ay = W / TW, H / TH, w / OW, h / OH
        hm = [ax * c * fx, -ax * s * fy, ax * (-c * W / 2.0 + s * H / 2.0 + OW / 2.0),
              ay * s * fx, ay * c * fy, ay * (-s * W / 2.0 - c * H / 2.0 + OH / 2.0), 0.0, 0.0, 1.0]
        y, _ = remap(x.float(), None, hm, TW, TH, "bicubic")
    return _flip(y, flip_h, flip_v)


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


def send_preview(did, image, tag=_TAG, info=None, mask=None):
    """Save a downscaled JPEG of the first image in temp/ and tell the viewport where it is (event succy-crop-image).
    One file per node id: the browser re-reads it with a fresh `v`. info = what the node wants its view to say about it (JSON,
    D-316: the Tile Split's grid, the Merge's measured scale) — the browser hands it on as shot_system.info.
    D-331: mask = [H, W] (the picture's size) a wire brought (SAM...): saved beside it as a grey PNG (`mask_file`), the view shows it."""
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
        mname = None
        if mask is not None:
            m = (mask.detach().float().reshape(-1, *mask.shape[-2:])[0].clamp(0, 1) * 255.0).round().to(torch.uint8).cpu().numpy()
            mi = Image.fromarray(m, "L")
            if mi.size != im.size:                         # area average: a hard edge stays where it is (D-163)
                mi = mi.resize(im.size, Image.BOX)
            mname = name[:-4] + "_mask.png"
            mi.save(os.path.join(folder_paths.get_temp_directory(), mname), compress_level=1)
        PromptServer.instance.send_sync("succy-crop-image", {
            "node_id": did, "filename": name, "subfolder": "", "type": "temp",
            "width": W, "height": H, "v": int(time.time() * 1000), **({"info": info} if info is not None else {}),
            **({"mask_file": mname} if mname else {}),
        })
    except Exception as exc:
        print(f"{tag} preview failed: {exc}")


def live_picture(t, longest=LIVE_MAX):
    """A live output -> {width, height, count, data} for the browser: IMAGE as JPEG (PNG when it has alpha), MASK as greyscale PNG,
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
    n = int(t.shape[0]) if t.dim() >= 3 else 1             # D-244b: how many frames the live value holds (only the first travels)
    return {"width": W, "height": H, "count": n, "data": f"data:image/{kind};base64," + base64.b64encode(buf.getvalue()).decode("ascii")}


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


def live_inputs(spec):
    """The LiveInputs of a chain a browser POSTed ({linked, from}): what door_values (D-228) reads in a route."""
    from _succy_common import LiveInputs
    return LiveInputs(spec or {}, node_mapping())


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
    from _succy_common import LIVE_STATS, LiveStale, LiveWait, live_drop, live_eval, live_job, live_question, live_stale, live_types, memo_stats, refused, same_origin

    @srv.routes.get("/succy/memo/stats")
    async def _memo_stats(request):
        # D-210: {memo name: {hits, misses, skips, kept, nodes: {id: {hits, misses, skips, last}}}} — counters only, no pictures
        return web.json_response({"memos": memo_stats()})

    @srv.routes.get("/succy/live/stats")
    async def _live_stats(request):
        # D-336: the ONE live queue: jobs done, ms busy, the slowest job, the longest wait, how many wait now (SUCCY_LIVE reads it)
        return web.json_response({**LIVE_STATS, "nodes": {k: dict(v) for k, v in LIVE_STATS["nodes"].items()}})

    @srv.routes.post("/succy/live/drop")
    async def _live_drop(request):
        # D-339: {slot, seq}: that view has a newer question, its older ones still in the queue step aside (no torch here)
        if not same_origin(request):
            return refused()
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "bad JSON"}, status=400)
        return web.json_response({"ok": live_drop((body or {}).get("slot"), (body or {}).get("seq"))})

    @srv.routes.get("/succy/live/types")
    async def _live_types(request):
        # who can answer live: {type: [outputs]} — the browser asks once, then only follows wires to these
        return web.json_response({"types": live_types(node_mapping())})

    def _view(spec, output, longest):
        with torch.inference_mode():
            outs = live_eval(spec, node_mapping(), show=longest)
            t = outs.get(output)
            if t is None and output in (outs.get("_empty") or ()):
                return {"ready": True, "empty": True}           # chosen to give nothing (D-172): a wire that is as good as absent
            if t is None:
                return {"ready": False, "need": "run", "why": f"{spec.get('type', 'the node')} has no live '{output}': Run once"}
            if not isinstance(t, torch.Tensor):
                return {"ready": False, "need": "run", "why": f"{spec.get('type', 'the node')}'s '{output}' is not a picture or a mask"}
            pic = live_picture(t, longest)
            real = (outs.get("_real") or {}).get(output)       # D-314: worked on a smaller copy -> the sizes the Run will have
            if real:
                pic["width"], pic["height"] = int(real[0]), int(real[1])
        info = outs.get("_info")
        return {"ready": True, **pic, **({"info": info} if isinstance(info, dict) else {})}

    @srv.routes.post("/succy/live/view")
    async def _live_view(request):
        if not same_origin(request):
            return refused()
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
        slot, seq = str(request.query.get("slot", "")), request.query.get("seq")

        def _turn():
            with live_question(slot, seq):                     # D-340: dropped mid-chain = stops before the next node
                if live_stale(slot, seq):                      # D-339: she moved on while it waited in the queue
                    raise LiveStale()
                return _view(spec, output, longest)
        try:
            return web.json_response(await asyncio.to_thread(live_job, _turn))
        except LiveStale:
            return web.json_response({"ready": False, "need": "stale", "why": "a newer question took its place"})
        except LiveWait as w:
            return web.json_response({"ready": False, "need": w.need, "why": w.why})
        except Exception as exc:
            return web.json_response({"ready": False, "need": "error", "why": str(exc).replace(_TAG, "").strip()})

    def _full(body, name):
        # D-325: the live picture on input `name` at FULL size, as a PNG (alpha / mask kept): the ⧉ / ⬇ of a box showing it live.
        # No workflow here: the browser writes the graph as it is now into the file before saving it.
        spec = ((body or {}).get("from") or {}).get(name)
        if not isinstance(spec, dict):
            raise LiveWait("run", f"nothing live on '{name}'")
        with torch.inference_mode():
            t = live_eval(spec, node_mapping()).get(str(spec.get("output", "")))
            if not isinstance(t, torch.Tensor):
                raise LiveWait("run", f"{spec.get('type', 'the node')} has no live picture: Run once")
            return png_bytes(t)

    @srv.routes.post("/succy/live/full")
    async def _live_full(request):
        if not same_origin(request):
            return refused()
        name = str(request.query.get("input", "source"))
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "bad JSON"}, status=400)
        try:
            data = await asyncio.to_thread(live_job, _full, body, name)
        except LiveWait as w:
            return web.json_response({"error": w.why}, status=409)
        except Exception as exc:
            return web.json_response({"error": str(exc).replace(_TAG, "").strip()}, status=500)
        return web.Response(body=data, content_type="image/png", headers={"Content-Disposition": 'attachment; filename="succy_live.png"'})


def png_meta(prompt=None, extra_pnginfo=None):
    """ComfyUI's own PNG metadata (like SaveImage / PreviewImage): `prompt` + every extra_pnginfo key (`workflow`), so the file
    dropped on ComfyUI opens the graph that made it. None with --disable-metadata or nothing to write."""
    try:
        from comfy.cli_args import args
        if getattr(args, "disable_metadata", False):
            return None
    except Exception:
        pass
    extra = extra_pnginfo if isinstance(extra_pnginfo, dict) else {}
    if prompt is None and not extra:
        return None
    from PIL.PngImagePlugin import PngInfo
    meta = PngInfo()
    if prompt is not None:
        meta.add_text("prompt", json.dumps(prompt))
    for k, v in extra.items():
        meta.add_text(str(k), json.dumps(v))
    return meta


_install_routes()
