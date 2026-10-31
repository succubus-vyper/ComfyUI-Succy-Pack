import hashlib
import math
import threading
import time
import weakref
from collections import OrderedDict

import numpy as np
import torch
import torch.nn.functional as F

from server import PromptServer

from _succy_common import LIVE_STATS, LiveWait, coerce_widgets, door_values, after_wait, gate_hold, is_link, live_touch, ram_holder, say, stop_key, stop_route, value_memo, wait_here
from _succy_image import FILL_MODES, display_id, fill, resize, send_preview, snap

# ===================================================
# Succy Tile Split + Tile Merge (D-315, plan D-304)
#
# Split cuts a picture into a grid of same-size tiles that overlap; the TILES wire carries the grid to Merge (like `stitch`).
# Between them anything that works one picture at a time: a sampler, an upscaler... Merge MEASURES every tile that comes back
# and finds the scale from it (x1.5, x2, a VAE that hands back 960 for 954: nobody has to say), then sews the tiles with soft
# seams inside the overlap, back to the exact size of the picture that came in (times that scale).
# Grid: n = ceil((L - overlap) / (tile - overlap)) per side, the tiles spread to touch both edges -> the real overlap is the one
# asked or a bit more, never less; W and H each get their own step. A side SHORTER than the tile is the only case that needs `fit`.
# Output `image` is a LIST (OUTPUT_IS_LIST): list mode = one tile per item (ComfyUI runs the sampler once per tile, no loop
# needed, one tile in VRAM at a time); batch mode = one item holding every tile as a batch. Order: rows top to bottom, each left
# to right; a batch of B pictures gives B frames per tile, tile after tile.
# Overlap is a SHARE of the tile (0.15 = 15 % of its side, D-316b): each side gets its own px from its own tile side.
# Outputs also `count` (tiles per picture: a Loop's max iterations) and `report` (the same numbers as text).
# LIVE (D-156, T2 = D-316): Split answers "as it is now" without a Queue: the picture (a smaller copy for the view, D-314) and the
# grid in the picture's own px, so the node draws its tiles while you drag. Merge: the tiles come back from the work (only a Run brings
# them), so it keeps the last Run's tiles and sews them again live when only Feather changes (D-316c): a Preview after it follows.
# FIT HINT (D-317): a tile size near the one asked that cuts the picture into FEWER tiles is only SUGGESTED (the line + a click),
# never taken on its own: she decides. MASK (T3, D-318): wire one and `tile only masked` lays the grid on the masked part only and
# drops the tiles that do not touch it (grown by an overlap); Merge sews back only those, faded at their edges, the rest = the original.
# Every tile also goes out with its own piece of the mask (inpainting). `pass only` = every tile, the mask only rides along.
# Node names live ONLY in __init__.py (D-95). Images are ComfyUI BHWC floats in [0,1].
# ===================================================

_TAG = "[Succy Tile]"

ASPECTS = ("square", "picture", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16")
# D-315, checked in ComfyUI's code: a DiT pads its latent up to the patch with a CIRCULAR pad (comfy/ldm/common_dit.py), so a tile
# that is not a multiple of latent ratio x patch gets the opposite edge glued on; a UNet (SD 1.5 / SDXL) takes any latent size.
MULTIPLES = ("auto", "8 (SD 1.5, SDXL)", "16 (Flux, SD3, Qwen, Wan 2.1, HiDream, Lumina, Chroma)",
             "32 (Flux 2, Wan 2.2 5B, Hunyuan Image 2.1, LTXV)", "1 (pixels: upscale models)", "custom")
AUTO_FALLBACK = 16                                     # auto with no MODEL wired: 16 suits every model above but the 32 ones
FITS = ("resize", "pad", "crop")
RINGS = ("tile_size", "overlap")                       # widgets with an EXT dot: a wire may bring them (D-316b)
OUTPUTS = ("batch", "list")                            # D-318e, her call: batch first (the default), list second
MASK_USES = ("tile only masked", "pass only")
MASK_DEFAULT = "pass only"                             # D-327, her call: every tile is the default; only masked = experimental
MASK_MIN = 0.01                                        # a mask value above this counts as "masked" (a soft edge still counts)
GRID_KEYS = ("tile_size", "aspect", "overlap", "fit", "mask_use")   # D-333: every value plan_grid reads (the multiple comes in as a number)
HINT_RANGE = (0.75, 1.25)                              # D-317: the fit hint looks this far around the tile size asked

_MEMO_S = value_memo("tile split", 12)                 # D-210: same values in = the last result out, nothing cut twice
_MEMO_M = value_memo("tile merge", 12)

_LAST = getattr(PromptServer.instance, "_succy_tile_last", None)
if _LAST is None:
    _LAST = PromptServer.instance._succy_tile_last = OrderedDict()
_LAST_MAX = 12
_LET_GO = [0.0]                                        # D-328: when ComfyUI's free / the RAM ceiling last emptied _LAST (the live says it)


def _let_go():
    _LAST.clear()
    _LET_GO[0] = time.time()


ram_holder("tile last run", _let_go, lambda: [{k: v for k, v in e.items() if k != "ready"} for e in _LAST.values()])   # D-308: counted in the RAM row, let go by ComfyUI's free


def _keep(did, entry):
    """Remember node `did`'s last Run. -> True when the live view would read something else now (D-333: the gate running the
    Split again after ▶ brings the SAME picture and mask: no live_touch then, or every live view in the graph worked it all out again)."""
    old = _LAST.pop(did, None)
    _LAST[did] = entry
    while len(_LAST) > _LAST_MAX:
        _LAST.pop(next(iter(_LAST)), None)
    return not _same(old, entry)


def _same(o, v):
    """Pictures: the very same tensor; plain values (and dicts / lists of them): equal."""
    if o is v:
        return True
    if isinstance(o, torch.Tensor) or isinstance(v, torch.Tensor):
        return False
    if isinstance(o, dict) and isinstance(v, dict):
        return o.keys() == v.keys() and all(_same(o[k], v[k]) for k in o)
    if isinstance(o, (list, tuple)) and isinstance(v, (list, tuple)):
        return len(o) == len(v) and all(_same(a, b) for a, b in zip(o, v))
    try:
        return bool(o == v)
    except Exception:
        return False


def _ring_kw(dynprompt, unique_id, tile_size, overlap):
    """The rings' values the live view reads from the last Run: only those a wire brings (her own drags come from the page).
    Can't tell = both, as before. D-333: so the gate's run again after ▶ with her new Tile is not "something new" for the live views."""
    kw = {"tile_size": tile_size, "overlap": overlap}
    try:
        ins = (dynprompt.get_node(str(unique_id)) or {}).get("inputs") or {}
    except Exception:
        return kw
    return {k: v for k, v in kw.items() if is_link(ins.get(k))}


# ---------------- D-329: Stop / Reuse (the Crop's shield): the Run waits here with the picture and the mask that came in ----------------
# A native Load Image, a SAM mask: nothing live, they exist only inside a Run. With Stop the Split shows the grid on them and waits:
# she drags Tile / Overlap (the live view reads them from _LAST), ▶ re-queues with run_id "<ts>_continue" and the cut uses her values.
_HOLDS = getattr(PromptServer.instance, "_succy_tile_holds", None)
if _HOLDS is None:
    _HOLDS = PromptServer.instance._succy_tile_holds = {}

    @PromptServer.instance.routes.post("/succy/tile/action")
    async def _tile_action(request):
        return await stop_route(request, _HOLDS)


def _hold(did, timeout):
    """Wait for her: ▶ (or the timeout) = go on, ■ = the whole Run stops."""
    wait_here(_HOLDS, did, timeout, _TAG)


# ---------------- the mask: where it is, asked in O(1) per rectangle ----------------

class Cover:
    """The masked pixels of a picture (any frame of the batch), as a summed-area table: `any(x0, y0, x1, y1)` = does that rectangle
    touch the mask, `box` = the rectangle around all of it (None = an empty mask). Built once per mask, asked a few hundred times."""

    def __init__(self, on):
        H, W = int(on.shape[0]), int(on.shape[1])
        self.size = (W, H)
        sat = torch.zeros((H + 1, W + 1), dtype=torch.int32)
        sat[1:, 1:] = on.to(torch.int32).cumsum(0, dtype=torch.int32).cumsum(1, dtype=torch.int32)
        self.sat = sat
        self.total = int(sat[H, W])
        self.layouts = OrderedDict()                       # (tile, overlap) -> its free layout: a drag and the hint ask the same ones
        self.hints = OrderedDict()                         # D-333: (size, values) -> the fit hint: the Run takes the live view's (seconds each)
        self._satT = None
        if self.total:
            rows, cols = torch.nonzero(on.any(1)).flatten(), torch.nonzero(on.any(0)).flatten()
            self.box = (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1)
        else:
            self.box = None

    @property
    def satT(self):
        """The table turned on its side (numpy, contiguous) for the column shelves: ~0.3 s on a 4k mask, made once (D-333)."""
        if self._satT is None:
            self._satT = np.ascontiguousarray(self.sat.numpy().T)
        return self._satT

    def any(self, x0, y0, x1, y1):
        W, H = self.size
        x0, y0, x1, y1 = max(0, int(math.floor(x0))), max(0, int(math.floor(y0))), min(W, int(math.ceil(x1))), min(H, int(math.ceil(y1)))
        if x1 <= x0 or y1 <= y0:
            return False
        s = self.sat
        return int(s[y1, x1]) - int(s[y0, x1]) - int(s[y1, x0]) + int(s[y0, x0]) > 0


def mask_misfit(mask, W, H):
    """D-318d: a mask of ANOTHER shape is another picture's mask (a Crop's `mask` is the whole photo, the crop is a part of it):
    stretched over this one it lands on the wrong pixels. -> the reason in words, or None (same shape, any scale: fine)."""
    m = mask if mask.dim() >= 2 else None
    if m is None:
        return "the mask is not a picture"
    mh, mw = (int(m.shape[-2]), int(m.shape[-1])) if not (m.dim() == 4 and int(m.shape[-1]) == 1) else (int(m.shape[1]), int(m.shape[2]))
    if abs((mw / float(max(1, mh))) / (W / float(max(1, H))) - 1.0) <= 0.01:
        return None
    return (f"the mask is {mw}x{mh}, the picture {W}x{H}: not this picture's mask (a Crop's `mask` is the WHOLE photo: "
            f"wire the Crop's `crop_mask` with its `crop`)")


def mask_frames(mask, W, H):
    """A MASK ([H,W] or [B,H,W], any size) -> [B, H, W] floats at the picture's size (bilinear when it differs)."""
    m = mask.float()
    if m.dim() == 2:
        m = m[None]
    if m.dim() == 4:                                   # [B,H,W,1] or [B,1,H,W] sneaking in
        m = m[..., 0] if int(m.shape[-1]) == 1 else m[:, 0]
    if (int(m.shape[1]), int(m.shape[2])) != (H, W):
        m = F.interpolate(m[:, None], size=(H, W), mode="bilinear", align_corners=False)[:, 0]
    return m.clamp(0.0, 1.0)


_COVER = OrderedDict()                                 # (what the mask holds, picture size) -> its Cover: a drag asks again and again
_COVER_ID = OrderedDict()                              # (id, size) -> (weak ref to the mask, its key): the same tensor again skips the hash
_COVER_MAX = 2
# D-333 (her: "Recalculating lasts forever, and again after ▶"): the Run, the live view and the live view after the Run each got
# the SAME mask as another tensor (the Crop's crop_mask of the Run, of the live chain, of the live chain after live_touch), so the
# identity key missed every time and the free layout + the hint (seconds on a 4k mask) were worked out three times over, two of
# them at once. Now the key is what the mask holds: the Run takes what the live view already found, and the other way round.
# One lock: the live view and the Run asking the same layout at once = one works it out, the other reads it.
_PLAN_LOCK = threading.RLock()
ram_holder("tile mask cover", _COVER.clear, lambda: [t for c in _COVER.values() for t in (c.sat, torch.from_numpy(c._satT) if c._satT is not None else None) if t is not None])


def mask_digest(mask):
    """What a mask holds, as a short key (shape + every value): two tensors with the same values = the same key (~0.1 s on 4k)."""
    t = mask.detach()
    if t.device.type != "cpu":
        t = t.cpu()
    if t.dtype not in (torch.float32, torch.float16, torch.float64, torch.uint8, torch.bool):
        t = t.float()
    a = t.contiguous().numpy()
    h = hashlib.blake2b(digest_size=16)
    h.update(repr((tuple(a.shape), str(a.dtype))).encode())
    h.update(memoryview(a).cast("B"))
    return h.hexdigest()


def cover_of(mask, W, H):
    """The Cover of a mask at the picture's size, made once per (what the mask holds, size)."""
    if mask is None:
        return None
    bad = mask_misfit(mask, W, H)
    if bad:
        raise ValueError(f"{_TAG} {bad}")
    with _PLAN_LOCK:
        ik = (id(mask), int(W), int(H))
        seen = _COVER_ID.get(ik)
        key = seen[1] if seen is not None and seen[0]() is mask else (mask_digest(mask), int(W), int(H))
        _COVER_ID[ik] = (weakref.ref(mask), key)       # never keeps a mask alive (a 4k one is 70 MB)
        _COVER_ID.move_to_end(ik)
        while len(_COVER_ID) > 4 * _COVER_MAX:
            _COVER_ID.popitem(last=False)
        c = _COVER.get(key)
        if c is not None:
            _COVER.move_to_end(key)
            return c
        c = Cover(mask_frames(mask, W, H).amax(0) > MASK_MIN)
        _COVER[key] = c
        while len(_COVER) > _COVER_MAX:
            _COVER.popitem(last=False)
        return c


def mask_area(box, L0, L1, size, T, o):
    """One side of the masked rectangle [L0, L1) -> the side the grid covers: grown by an overlap (the fade lands outside the mask),
    then up to a whole tile when the picture has room (a tile with real picture around it, never a pad), inside [0, size)."""
    a, b = max(0, L0 - o), min(size, L1 + o)
    if size <= T:
        return 0, size
    if b - a < T:
        a = min(max(0, (a + b - T) // 2), size - T)
        b = a + T
    return a, b


# ---------------- the grid: pure numbers, no torch (the live preview asks the same sums) ----------------

def model_parts(model):
    """A MODEL wire -> (multiple, words): the VAE's downscale x the DiT's patch (1 for a UNet) and how it was read, else (None, "")."""
    try:
        m = getattr(model, "model", model)
        r = int(getattr(getattr(m, "latent_format", None), "spacial_downscale_ratio", 8) or 8)
        dm = getattr(m, "diffusion_model", None)
        dm = getattr(dm, "_orig_mod", dm)                  # torch.compile wraps it: the real net sits inside
        # D-324: Cosmos / Anima call it patch_spatial, Krea2 just `patch` (2 on a /8 VAE = 16, read as 8 before: her line said
        # "Krea2: VAE /8 x patch 1"); LTXV patches 1 = no attribute, right
        p = getattr(dm, "patch_size", None) or getattr(dm, "patch_spatial", None) or getattr(dm, "patch", None) or 1
        if isinstance(p, (tuple, list)):
            p = p[-1] if p else 1
        p = int(p) if isinstance(p, (int, float)) and p >= 1 else 1
        return max(1, r * p), f"{type(m).__name__}: VAE /{r} x patch {p}"
    except Exception:
        return None, ""


def model_multiple(model):
    """A MODEL wire -> the pixel multiple its tiles want, else None."""
    return model_parts(model)[0]


def pick_multiple(kw, model=None):
    """-> (multiple, why): the tendina, the custom number, or the MODEL wire."""
    choice = str(kw.get("multiple") or "auto")
    if choice == "custom":
        return max(1, min(512, int(kw.get("multiple_px") or 16))), "custom"
    if choice == "auto":
        got, how = model_parts(model) if model is not None else (None, "")
        return (got, "model " + how) if got else (AUTO_FALLBACK, "no model: 16")      # D-320: the line says how it was read
    try:
        return max(1, int(choice.split()[0])), "list"
    except Exception:
        return AUTO_FALLBACK, "unknown: 16"


def aspect_ratio(aspect, W, H):
    """w / h of a tile."""
    if aspect == "picture":
        return max(1, W) / max(1, H)
    if isinstance(aspect, str) and ":" in aspect:
        a, b = aspect.split(":", 1)
        try:
            return max(0.05, float(a)) / max(0.05, float(b))
        except ValueError:
            return 1.0
    return 1.0


def tile_dims(size, ratio, mult):
    """The long side = size, the other by the ratio; both rounded to the multiple (never below it)."""
    size = max(1, int(size))
    tw, th = (size, size / ratio) if ratio >= 1 else (size * ratio, size)
    return snap(tw, mult), snap(th, mult)


def fit_axis(L, T, mult, how):
    """One side of L px against a tile of T: -> (tile, plan). Only a side shorter than the tile changes anything:
    resize = the tile shrinks to the nearest multiple of the side, the picture stretches those few px (Merge puts them back) ·
    pad = the tile stays, the picture is filled up to it, centred (Merge cuts it off) · crop = the tile shrinks to the multiple
    below, the few px over it are cut, centred (Merge puts the original ones back)."""
    if L >= T:
        return T, {"mode": "none", "c0": 0, "c1": L, "lr": L, "p0": 0, "work": L}
    if how == "pad" or (how == "crop" and L < mult):
        return T, {"mode": "pad", "c0": 0, "c1": L, "lr": L, "p0": (T - L) // 2, "work": T}
    if how == "crop":
        t = (L // mult) * mult
        c0 = (L - t) // 2
        return t, {"mode": "crop" if t != L else "none", "c0": c0, "c1": c0 + t, "lr": t, "p0": 0, "work": t}
    t = snap(L, mult)
    return t, {"mode": "resize" if t != L else "none", "c0": 0, "c1": L, "lr": t, "p0": 0, "work": t}


def positions(L, T, O):
    """Tile starts on a side of L px: n = ceil((L - O) / (T - O)), spread so the first touches 0 and the last touches L.
    Every gap is <= T - O, so the real overlap is >= O."""
    if L <= T:
        return [0]
    n = max(2, int(math.ceil((L - O) / float(T - O))))
    return [int(round(i * (L - T) / float(n - 1))) for i in range(n)]


def _real(pos, T):
    gaps = [pos[i] + T - pos[i + 1] for i in range(len(pos) - 1)]
    return [min(gaps), max(gaps)] if gaps else [0, 0]


def _box_sum(a, kh, kw):
    """Sum of every kh x kw window of a 2D tensor (top-left corner indexing): [H-kh+1, W-kw+1]."""
    c = torch.zeros((a.shape[0] + 1, a.shape[1] + 1), dtype=torch.float32)
    c[1:, 1:] = a.float().cumsum(0).cumsum(1)
    return c[kh:, kw:] - c[:-kh, kw:] - c[kh:, :-kw] + c[:-kh, :-kw]


_ORDERS = (lambda j, i: (j, i), lambda j, i: (i, j), lambda j, i: (-j, i), lambda j, i: (-i, j),
           lambda j, i: (i + j, j), lambda j, i: (i - j, j), lambda j, i: (-(i + j), j), lambda j, i: (j - i, j))


def _cover_tries(need, kw, kh):
    """Ways to cover the needed cells with kw x kh cores (yields lists of (i, j) top-left cells). (1) greedy: the core with the most
    still uncovered, anywhere. (2) anchored, in 8 orders (top down, left to right, bottom up, right to left, the 4 diagonals): the
    first uncovered cell in that order, then of the cores that hold it the one that covers the most. Chains follow an arm, blocks
    fill a body: the caller keeps the try with the fewest tiles."""
    cells = [tuple(c) for c in torch.nonzero(need).tolist()]
    sh, sw = int(need.shape[0]) - kh + 1, int(need.shape[1]) - kw + 1
    for order in (None,) + _ORDERS:
        left, picks = need.clone(), []
        seq = None if order is None else sorted(cells, key=lambda c: order(*c))
        open_ = set(cells)                         # the same cells as `left`, for the anchor's quick look
        at = 0
        while True:
            if order is None:
                if not bool(left.any()):
                    break
                score = _box_sum(left, kh, kw)
                k = int(torch.argmax(score))
                j, i = divmod(k, sw)
            else:
                while at < len(seq) and seq[at] not in open_:
                    at += 1
                if at >= len(seq):
                    break
                cj, ci = seq[at]
                score = _box_sum(left, kh, kw)
                j0, i0 = max(0, cj - kh + 1), max(0, ci - kw + 1)
                win = score[j0:min(cj, sh - 1) + 1, i0:min(ci, sw - 1) + 1]
                k = int(torch.argmax(win))
                j, i = j0 + k // int(win.shape[1]), i0 + k % int(win.shape[1])
            picks.append((i, j))
            left[j:j + kh, i:i + kw] = False
            open_.difference_update((y, x) for y in range(j, j + kh) for x in range(i, i + kw))
        yield picks


def _prune(picks, need, kw, kh):
    """The cores another one already covers go (the last picked first: the late, small helpers)."""
    cnt = torch.zeros(need.shape, dtype=torch.int32)
    for i, j in picks:
        cnt[j:j + kh, i:i + kw] += 1
    keep = []
    for i, j in reversed(picks):
        sl = (slice(j, j + kh), slice(i, i + kw))
        if bool((cnt[sl][need[sl]] > 1).all()):
            cnt[sl] -= 1
        else:
            keep.append((i, j))
    return keep


def _relax(picks, need, kw, kh, passes=4):
    """D-320: the cover counts tiles, not where they sit: two cores could land almost on top of each other (her head: tiles 1 and 2).
    Each core in turn slides, as far as the cells ONLY it covers allow, to where it overlaps the others least (ties: centred on
    those cells). Same count, every needed cell still covered. -> (picks, overlap = cells covered twice or more, counted per extra)."""
    H, W = int(need.shape[0]), int(need.shape[1])
    sh, sw = H - kh + 1, W - kw + 1
    cnt = torch.zeros((H, W), dtype=torch.int32)
    picks = [list(p) for p in picks]
    for i, j in picks:
        cnt[j:j + kh, i:i + kw] += 1
    jj = torch.arange(sh, dtype=torch.float32)[:, None]
    ii = torch.arange(sw, dtype=torch.float32)[None, :]
    for _ in range(passes):
        moved = False
        for p in picks:
            i, j = p
            cnt[j:j + kh, i:i + kw] -= 1
            only = need & (cnt == 0)                           # what nobody else covers: this core's job
            ys, xs = torch.nonzero(only, as_tuple=True)
            if len(ys) == 0:
                cnt[j:j + kh, i:i + kw] += 1
                continue
            y0, y1, x0, x1 = int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max())
            ja, jb = max(0, y1 - kh + 1), min(sh - 1, y0)
            ia, ib = max(0, x1 - kw + 1), min(sw - 1, x0)
            if ja > jb or ia > ib:                              # cannot happen (it covered them): stay
                cnt[j:j + kh, i:i + kw] += 1
                continue
            ov = _box_sum((cnt > 0).float(), kh, kw)[ja:jb + 1, ia:ib + 1]
            cy, cx = (y0 + y1 - kh + 1) / 2.0, (x0 + x1 - kw + 1) / 2.0     # the window centred on its job
            dist = ((jj[ja:jb + 1] - cy) ** 2 + (ii[:, ia:ib + 1] - cx) ** 2).sqrt()
            score = ov * 1000.0 + dist
            k = int(torch.argmin(score))
            nj, ni = ja + k // int(score.shape[1]), ia + k % int(score.shape[1])
            if (ni, nj) != (i, j):
                moved = True
            p[0], p[1] = ni, nj
            cnt[nj:nj + kh, ni:ni + kw] += 1
        if not moved:
            break
    return [tuple(p) for p in picks], int((cnt - 1).clamp(min=0).sum())


EXACT_POSITIONS = 6000                                 # D-324b: the exact search tries at most this many places for a tile
EXACT_MOST = 12                                        # ... only when the cell search needs this many tiles or fewer (big tiles:
                                                       # where a head or an arm cut in two shows; more = a solve that can take 30 s)
EXACT_STEPS = (24, 16, 36)                             # its steps (a core / n): the best of the first two, the third only when both
                                                       # gave up (the tidy layout stays if all do)
EXACT_BUDGET = 1.5                                     # seconds for all of them together (her drag waits for it, D-324c)


def _reach(ps, T, L, mg, a0, a1):
    """For each block [a0, a1) of a side: the first and last tile place whose CORE holds it (the core = the tile minus mg on each
    side that is not the picture's edge). The places that do are always one run. -> (first, last) index tensors, -1 = none."""
    lo = torch.where(ps > 0, ps + mg, torch.zeros_like(ps))
    hi = torch.where(ps + T < L, ps + T - mg, torch.full_like(ps, L))
    ok = (lo[None, :] <= a0[:, None]) & (a1[:, None] <= hi[None, :])
    idx = torch.arange(len(ps))
    first = torch.where(ok, idx, len(ps)).min(1).values
    last = torch.where(ok, idx, -1).max(1).values
    return torch.where(first < len(ps), first, -1), last


def _exact_layout(W, H, TW, TH, ox, oy, cover, most):
    """Fewer tiles than `most` (the tidy layout's count), if the exact search finds them on one of a few steps (each solves on its
    own grid of places: a coarser one sometimes fits better). -> rects | None (`most` is already the fewest it can see)"""
    best = None
    if most > EXACT_MOST:
        return None
    end = time.monotonic() + EXACT_BUDGET
    for k, div in enumerate(EXACT_STEPS):
        secs = end - time.monotonic()
        if (k == len(EXACT_STEPS) - 1 and best is not None) or secs < 0.15:
            break
        got = _exact_step(W, H, TW, TH, ox, oy, cover, most if best is None else len(best[0]), div, secs)
        if got is not None and (best is None or got[1] < best[1]):
            best = got
    return best[0] if best is not None else None


def _exact_step(W, H, TW, TH, ox, oy, cover, most, div, secs):
    """D-324b (her head cut in two, an arm cut off: the cell search is greedy and its cells are coarse, a core only counted a WHOLE
    cell): the fewest tiles there really are, then the fewest masked px under a seam. Tiles anywhere on a fine step (~ a core / 36);
    every masked px must lie in some tile's core (= the same rule as the cells: half an overlap + 1 px
    of every inner edge). An integer program (scipy, it comes with ComfyUI), at most `most` tiles. -> rects, or None (no scipy,
    nothing better, too big / too slow: the cell search's layout stays). -> (rects, price) | None"""
    try:
        import numpy as np
        from scipy.optimize import Bounds, LinearConstraint, milp
        from scipy.sparse import csr_matrix
    except Exception:
        return None
    d = max(8, min(TW - ox, TH - oy) // div)
    # D-342 (probe B: 4-5 s on a full mask, budget 1.5): HiGHS overshoots its time_limit on big programs (0.43 s asked, 2.3 s
    # taken at ~5000 places). The places allowed shrink with the time left (~3000 per second): a late step stays small or quits.
    cap = min(EXACT_POSITIONS, int(3000 * secs))
    while ((W - TW) // d + 2) * ((H - TH) // d + 2) > cap:
        d *= 2
    xs = torch.tensor(sorted(set(range(0, W - TW + 1, d)) | {W - TW}))
    ys = torch.tensor(sorted(set(range(0, H - TH + 1, d)) | {H - TH}))
    # the blocks: the pieces between every core's edges, so a block is wholly in or wholly out of each core (a block astride two
    # cores that meet must not count as uncovered: exact to the pixel, for these places)
    def cuts(ps, T, L, mg):
        lo = torch.where(ps > 0, ps + mg, torch.zeros_like(ps))
        hi = torch.where(ps + T < L, ps + T - mg, torch.full_like(ps, L))
        return torch.unique(torch.cat([torch.tensor([0, L]), lo.clamp(0, L), hi.clamp(0, L)]))
    ex = cuts(xs, TW, W, (ox + 1) // 2 + 1)
    ey = cuts(ys, TH, H, (oy + 1) // 2 + 1)
    t = cover.sat[ey][:, ex]
    blk = (t[1:, 1:] - t[:-1, 1:] - t[1:, :-1] + t[:-1, :-1]) > 0
    fx, lx = _reach(xs, TW, W, (ox + 1) // 2 + 1, ex[:-1], ex[1:])
    fy, ly = _reach(ys, TH, H, (oy + 1) // 2 + 1, ey[:-1], ey[1:])
    bj, bi = torch.nonzero(blk, as_tuple=True)
    if not len(bj) or bool((fx[bi] < 0).any()) or bool((fy[bj] < 0).any()):
        return None
    # every block = a rectangle of places; the same rectangle twice, or one holding another (implied by it), says nothing new
    R = torch.unique(torch.stack([fx[bi], lx[bi], fy[bj], ly[bj]], 1), dim=0)
    keep = torch.ones(len(R), dtype=torch.bool)
    for k in range(len(R)):
        inner = (R[:, 0] >= R[k, 0]) & (R[:, 1] <= R[k, 1]) & (R[:, 2] >= R[k, 2]) & (R[:, 3] <= R[k, 3]) & keep
        inner[k] = False
        if bool(inner.any()):
            keep[k] = False
    R = R[keep].tolist()
    nx, n = len(xs), len(xs) * len(ys)
    rows, cols = [], []
    for r, (x0, x1, y0, y1) in enumerate(R):
        q = (np.arange(y0, y1 + 1)[:, None] * nx + np.arange(x0, x1 + 1)[None, :]).ravel()
        rows.append(np.full(len(q), r))
        cols.append(q)
    A = csr_matrix((np.ones(sum(len(c) for c in cols)), (np.concatenate(rows), np.concatenate(cols))), shape=(len(R), n))
    # the price of a place: 1 tile + a little for the mask in its outer ring (where it fades: a seam on the subject), never enough
    # to buy a tile back: `most` tiles' rings together stay under 1
    s = cover.sat.double()
    X, Y = xs[None, :].expand(len(ys), -1), ys[:, None].expand(-1, nx)
    box = lambda x0, y0, x1, y1: s[y1, x1] - s[y0, x1] - s[y1, x0] + s[y0, x0]
    mgx, mgy = (ox + 1) // 2 + 1, (oy + 1) // 2 + 1
    cx0 = torch.where(X > 0, X + mgx, X); cx1 = torch.where(X + TW < W, X + TW - mgx, X + TW)
    cy0 = torch.where(Y > 0, Y + mgy, Y); cy1 = torch.where(Y + TH < H, Y + TH - mgy, Y + TH)
    ring = box(X, Y, X + TW, Y + TH) - box(cx0, cy0, cx1, cy1)
    cost = (1.0 + ring / ((cover.total + 1.0) * (most + 1.0))).flatten().numpy()
    try:
        # D-324c: the LP first (~0.01-0.5 s, and on these covers it is tight): when even it cannot go under `most`, nothing can
        t0 = time.monotonic()
        lp = milp(cost, constraints=LinearConstraint(A, lb=1), bounds=Bounds(0, 1), options={"time_limit": secs})
        if lp.x is None or lp.fun >= most:
            return None
        secs -= time.monotonic() - t0
        if secs < 0.1:
            return None
        res = milp(cost, constraints=LinearConstraint(A, lb=1), integrality=np.ones(n), bounds=Bounds(0, 1),
                   options={"time_limit": secs})
    except Exception:
        return None
    if res.x is None or res.status != 0:
        return None
    pick = np.flatnonzero(res.x > 0.5)
    if len(pick) >= most:                                  # only to save a tile: a tie stays tidy
        return None
    return sorted([[int(xs[q % nx]), int(ys[q // nx])] for q in pick], key=lambda r: (r[1], r[0])), float(res.fun)


def _pack_line(ix, L, T, mg):
    """The left-packed tile starts over sorted masked columns `ix` (greedy = the fewest on a line)."""
    out, k, n = [], 0, len(ix)
    while k < n:
        x = min(max(0, int(ix[k]) - mg), L - T)
        out.append(x)
        k = int(np.searchsorted(ix, x + T - (mg if x + T < L else 0)))
    return out


def _cover_line(cols, L, T, mg):
    """1D: masked columns (bool numpy [L]) -> the fewest tile starts whose cores hold them all (greedy = exact on a line), then
    spread: half way between the left-packed and the right-packed answer when that still holds them (no tile piled on its
    neighbour at the end of a row). A core = the tile minus mg on a side that is not the picture's edge."""
    idx = np.flatnonzero(cols)
    left = _pack_line(idx, L, T, mg)
    right = [L - T - x for x in reversed(_pack_line((L - 1 - idx)[::-1], L, T, mg))]   # already sorted: reversed, no sort (D-333)
    if len(right) != len(left) or not left:
        return left
    mid = [(a + b) // 2 for a, b in zip(left, right)]
    held = np.zeros(len(idx), dtype=bool)
    for x in mid:
        held |= (idx >= (x + mg if x > 0 else 0)) & (idx < (x + T - mg if x + T < L else L))
    return mid if bool(held.all()) else left


def _shelves(sat, W, H, TW, TH, mx, my, d):
    """Rows of tiles over a mask's summed-area table (int numpy [H+1, W+1]): row places on a step of d, consecutive rows' cores
    meet, a row covers (fewest tiles, on its line) the masked columns of the band only IT holds. Dynamic programming over the row
    places = the fewest tiles of any such layout; a tie = the least the rows' cores overlap (no row piled on the one before).
    -> (count, [[x, y]...]) | None"""
    rows = np.flatnonzero(sat[1:, W] - sat[:-1, W])
    if not len(rows):
        return None
    first, last = int(rows[0]), int(rows[-1]) + 1
    ys = sorted(set(range(0, H - TH + 1, d)) | {H - TH})
    top = lambda y: y + my if y > 0 else 0
    bot = lambda y: y + TH - my if y + TH < H else H
    band = lambda a, b: np.diff(sat[b] - sat[a]) > 0
    line, many = {}, {}
    def cost(a, b):                                        # the row's tiles, spread (only the rows of the answer ask)
        if (a, b) not in line:
            line[(a, b)] = _cover_line(band(a, b), W, TW, mx) if b > a else []
        return line[(a, b)]
    def count(a, b):                                       # D-333: the search only counts: the left pack has the same count, no spread
        if (a, b) not in many:
            many[(a, b)] = len(_pack_line(np.flatnonzero(band(a, b)), W, TW, mx)) if b > a else 0
        return many[(a, b)]
    best = {}                                              # y -> (tiles, overlap of the rows' cores, the row before)
    for y in ys:                                           # the first row holds the mask's top
        if top(y) <= first:
            best[y] = (count(first, min(bot(y), last)), 0, None)
    for y in ys:
        if y not in best or bot(y) >= last:
            continue
        for y2 in ys:
            if y2 <= y or top(y2) > bot(y) or bot(y2) <= bot(y):
                continue
            c = (best[y][0] + count(bot(y), min(bot(y2), last)), best[y][1] + bot(y) - top(y2))
            if y2 not in best or c < best[y2][:2]:
                best[y2] = (c[0], c[1], y)
    ends = [(v[0], v[1], y) for y, v in best.items() if bot(y) >= last]
    if not ends:
        return None
    n, _, y = min(ends)
    out = []
    while y is not None:
        p = best[y][2]
        out += [[x, y] for x in cost(first if p is None else bot(p), min(bot(y), last))]
        y = p
    return n, out


def _shelf_layout(W, H, TW, TH, ox, oy, cover):
    """D-324c: the tidy layout, rows or columns of tiles (the fewer; a tie = rows). -> rects sorted | None"""
    sat = cover.sat.numpy()
    mx, my = (ox + 1) // 2 + 1, (oy + 1) // 2 + 1
    d = max(8, min(TW - ox, TH - oy) // 32)
    a = _shelves(sat, W, H, TW, TH, mx, my, d)
    b = _shelves(cover.satT, H, W, TH, TW, my, mx, d)
    if b is not None and (a is None or b[0] < a[0]):
        a = (b[0], [[x, y] for y, x in b[1]])
    return sorted(a[1], key=lambda r: (r[1], r[0])) if a is not None else None


def free_layout(W, H, TW, TH, ox, oy, cover, exact=True):
    key = (W, H, TW, TH, ox, oy, exact)
    with _PLAN_LOCK:                                   # D-333: the live view and the Run asking at once = worked out once
        hit = cover.layouts.get(key)
        if hit is None:
            hit = cover.layouts[key] = _free_layout(W, H, TW, TH, ox, oy, cover, exact)
            while len(cover.layouts) > 256:
                cover.layouts.popitem(last=False)
    return [list(r) for r in hit]


def _lattice(L, T, o, s):
    """D-324, one side of the free layout: cells of s px laid from the FIRST tile's core, not from the picture's corner. A core at
    cell n has its tile at n * s; cells 0..m reach every place up to L - T (the last one stops exactly there, a step < s back).
    k = cells per core: the tile keeps at least half an overlap + 1 px on each side outside it (pixel rounding), so two cores that
    touch = tiles sharing > overlap. -> (k, pad, m, n0, n1, edges): cell n spans px [edges[n - n0], edges[n - n0 + 1])."""
    m = 0 if L <= T else int(math.ceil((L - T) / float(s)))
    k = max(1, (T - 2 * ((o + 1) // 2 + 1)) // s)
    pad = (T - k * s) / 2.0
    n0 = -int(math.ceil(pad / s))                              # the cells left of core 0: the first tile's ring, on the picture's edge
    n1 = max(m + k, int(math.ceil((L - pad) / s)))             # one past the last cell (cores at m may run past L: empty there)
    edges = [min(L, max(0, int(math.floor(pad + n * s)))) for n in range(n0, n1)] + [min(L, max(0, int(math.ceil(pad + n1 * s))))]
    return k, pad, m, n0, n1, edges


def _free_layout(W, H, TW, TH, ox, oy, cover, exact=True):
    """D-324c (her: "it looks random, a smart tiler should not"), fewest tiles first, then TIDY: rows (or columns) of tiles that
    line up, each only where the mask is (_shelf_layout, exact among such layouts, ~0.1 s); the exact search (_exact_layout) only
    to save a tile more (its LP says first if it can; a tie stays tidy). Without scipy the old cell search competes instead.
    exact=False: the tidy layout alone (the 💡 ranks sizes with it)."""
    tidy = _shelf_layout(W, H, TW, TH, ox, oy, cover)
    if tidy is None:
        return []
    if not exact:
        return tidy
    if _has_milp():
        got = _exact_layout(W, H, TW, TH, ox, oy, cover, len(tidy))
        return got if got is not None else tidy
    cells = _cell_layout(W, H, TW, TH, ox, oy, cover)
    return cells if len(cells) < len(tidy) else tidy


def _has_milp():
    try:
        from scipy.optimize import milp  # noqa: F401
        return True
    except Exception:
        return False


def _cell_layout(W, H, TW, TH, ox, oy, cover):
    """D-318c, `tile only masked` that looks at the SHAPE: no rows, no columns, tiles go wherever the mask is (a diagonal arm = a
    chain of tiles along it, a compact body = a block). Every tile has a CORE (the tile minus half an overlap on each side); the
    cores together cover the mask, so two tiles that meet always share at least an overlap, and the fade into the original lives
    in the outer ring, never on the mask. On a coarse grid of cells several ways of covering are tried (_cover_tries) and the one
    with the fewest tiles wins, then the one whose tiles pile up least once spread (_relax, D-320). -> rects [[x, y]...] top to
    bottom, then left to right.
    D-324 (proved by brute force): the cells used to start at the picture's corner, so the first / last tile could stop up to a
    cell short of the edge (1000 px, tile 512: tiles at 32 .. 976) and a mask touching the edge was left out of every tile. Now the
    cells start from the first tile's core and the last place is the edge itself: the mask between a core and the picture's edge
    lies in the ring of a tile that TOUCHES that edge (flat there, never faded)."""
    s = max(4, min(TW - ox, TH - oy) // 12)                    # cell side: a core is ~12 cells
    kw_, px, mx, i0, i1, ex = _lattice(W, TW, ox, s)
    kh_, py, my, j0, j1, ey = _lattice(H, TH, oy, s)
    xs, ys = torch.tensor(ex), torch.tensor(ey)               # a cell is needed when any mask pixel is in it: the table, all at once
    t = cover.sat[ys][:, xs]
    need = (t[1:, 1:] - t[:-1, 1:] - t[1:, :-1] + t[:-1, :-1]) > 0
    # what lies past the last cell a core can reach (and before the first) is folded onto it: that tile's ring covers it
    a0, a1, b0, b1 = -i0, mx + kw_ - 1 - i0, -j0, my + kh_ - 1 - j0
    fold = need.clone()
    fold[:, a0] |= fold[:, :a0 + 1].any(1)
    fold[:, a1] |= fold[:, a1:].any(1)
    fold[b0, :] |= fold[:b0 + 1, :].any(0)
    fold[b1, :] |= fold[b1:, :].any(0)
    sub = fold[b0:b1 + 1, a0:a1 + 1]
    if not bool(sub.any()):
        return []
    keep, best = None, None
    for picks in _cover_tries(sub, kw_, kh_):
        picks, ov = _relax(_prune(picks, sub, kw_, kh_), sub, kw_, kh_)
        if best is None or (len(picks), ov) < best:          # fewest tiles; then the least piled up (D-320)
            keep, best = picks, (len(picks), ov)
    rects, seen = [], set()
    for i, j in keep:                                          # core at cell (i, j) = tile at (i * s, j * s), the last place = the edge
        x, y = min(i * s, W - TW), min(j * s, H - TH)
        if (x, y) not in seen:                                 # belt and braces: one tile per place
            seen.add((x, y))
            rects.append([x, y])
    return sorted(rects, key=lambda r: (r[1], r[0]))


def mask_use(kw):
    return kw.get("mask_use") if kw.get("mask_use") in MASK_USES else MASK_DEFAULT


def plan_grid(W, H, kw, mult, cover=None, exact=True):
    """Everything Split decides, as plain numbers (the TILES wire carries it, the preview shows it).
    cover (a Cover) + mask_use `tile only masked`: the grid lies on the masked rectangle (`area`, picture px) and `active` lists the
    tiles that touch the mask grown by an overlap (rows x columns order); `count` = those. No cover = the whole picture, active None."""
    ratio = aspect_ratio(kw.get("aspect", "square"), W, H)
    TW, TH = tile_dims(kw.get("tile_size", 1024), ratio, mult)
    how = kw.get("fit") if kw.get("fit") in FITS else "resize"
    f = overlap_share(kw.get("overlap", 0))
    masked = cover is not None and mask_use(kw) == MASK_USES[0] and cover.box is not None
    area = [0, 0, W, H]
    if masked:
        b = cover.box
        area[0], area[2] = mask_area(b, b[0], b[2], W, TW, min(int(round(f * TW)), TW // 2))
        area[1], area[3] = mask_area(b, b[1], b[3], H, TH, min(int(round(f * TH)), TH // 2))
    TW, fx = fit_axis(area[2] - area[0], TW, mult, how)
    TH, fy = fit_axis(area[3] - area[1], TH, mult, how)
    for fa, a0 in ((fx, area[0]), (fy, area[1])):     # the cut lives in the picture's px: shifted to the area
        fa["c0"] += a0
        fa["c1"] += a0
    ox, oy = min(int(round(f * TW)), TW // 2), min(int(round(f * TH)), TH // 2)   # more than half a tile = every pixel three times
    xs, ys = positions(fx["work"], TW, ox), positions(fy["work"], TH, oy)
    rx, ry = _real(xs, TW), _real(ys, TH)
    g = {"size": [W, H], "tile": [TW, TH], "work": [fx["work"], fy["work"]], "fit": {"x": fx, "y": fy}, "xs": xs, "ys": ys,
         "cols": len(xs), "rows": len(ys), "count": len(xs) * len(ys), "total": len(xs) * len(ys), "multiple": mult, "overlap": [ox, oy],
         "real": {"x": rx, "y": ry}, "area": area, "active": None, "mask": "none" if cover is None else ("empty" if cover.box is None else mask_use(kw)),
         "real_pct": [round(100.0 * rx[0] / TW, 1) if len(xs) > 1 else 0.0, round(100.0 * ry[0] / TH, 1) if len(ys) > 1 else 0.0]}
    if masked and fx["mode"] == "none" and fy["mode"] == "none" and W >= TW and H >= TH:
        # D-318c: the free layout (the tiles follow the mask's shape); the fixed grid + active stays only for a picture smaller than a tile
        rects = free_layout(W, H, TW, TH, ox, oy, cover, exact)
        # D-327 (her screenshot: a mask over most of the picture, 24 free tiles in crooked rows where the plain grid also has 24):
        # the even grid over the masked rectangle, its tiles touching the mask, wins every tie — same count = the tidiest there is
        # (laid with the free layout's own rule: the cores — a tile minus half an overlap + 1 px — meet, so no fade lands on the mask)
        mx, my = (ox + 1) // 2 + 1, (oy + 1) // 2 + 1
        snap = lambda a, b, L, o: (0 if a < o else a, L if L - b < o else b)          # a sliver left at the picture's edge: up to it
        # D-342 (probe B, overlap 0 / 1 px): the area grows by the overlap, but a core keeps mx px inside its tile and mx > overlap
        # there — the first tile sat ON the mask's edge and the outer fade ate its first row (alpha 0.33). Grow by mx at least.
        bx = cover.box
        e = lambda a, b, b0, b1, L, m: (max(0, min(a, b0 - m)), min(L, max(b, b1 + m)))
        (a0, a1), (b0, b1) = snap(*e(area[0], area[2], bx[0], bx[2], W, mx), W, ox), snap(*e(area[1], area[3], bx[1], bx[3], H, my), H, oy)
        ex = [a0 + p for p in positions(a1 - a0, TW, 2 * mx)]
        ey = [b0 + p for p in positions(b1 - b0, TH, 2 * my)]
        even = [[x, y] for y in ey for x in ex
                if cover.any(x + (mx if x > 0 else 0), y + (my if y > 0 else 0), x + TW - (mx if x + TW < W else 0), y + TH - (my if y + TH < H else 0))]
        if even and len(even) <= len(rects):
            rects = even
        whole = lambda L: {"mode": "none", "c0": 0, "c1": L, "lr": L, "p0": 0, "work": L}
        g.update({"rects": rects, "count": len(rects), "total": len(rects), "cols": len({x for x, _ in rects}), "rows": len({y for _, y in rects}),
                  "area": [0, 0, W, H], "work": [W, H], "fit": {"x": whole(W), "y": whole(H)}, "xs": [], "ys": [],
                  "real": {"x": [ox, ox], "y": [oy, oy]}, "real_pct": [round(100.0 * ox / TW, 1), round(100.0 * oy / TH, 1)]})
        return g
    if masked:
        c = view_cells(g)
        g["active"] = [r * len(xs) + k for r, (y0, y1) in enumerate(c["y"]) for k, (x0, x1) in enumerate(c["x"])
                       if cover.any(x0 - ox, y0 - oy, x1 + ox, y1 + oy)]
        g["count"] = len(g["active"])
    return g


def _axis_share(g, a):
    n, T, r = (g["cols"], g["tile"][0], g["real"]["x"]) if a == "x" else (g["rows"], g["tile"][1], g["real"]["y"])
    return r[0] / float(T) if n > 1 and r[0] else None


def suggest(W, H, kw, mult, cover=None, now=None):
    """D-317, the fit HINT (never applied by itself): a tile size within HINT_RANGE of the one asked, on the widget's step and the
    multiple, that cuts FEWER tiles (the active ones with a mask). Ties: the real overlap nearest the one asked, then the size nearest.
    Never one that brings a fit the picture did not need, never more pixels to work in total. -> {tile_size, count, now, overlap} | None
    D-333: with a mask, kept on its Cover (what the mask holds): the Run and the live view after it read the live view's hint."""
    if cover is None:
        return _suggest(W, H, kw, mult, cover, now)
    key = (W, H, mult) + tuple(str(kw.get(k)) for k in GRID_KEYS)          # what plan_grid reads (the live kw has hold, run_id... too)
    with _PLAN_LOCK:
        if key not in cover.hints:
            cover.hints[key] = _suggest(W, H, kw, mult, cover, now)
            while len(cover.hints) > 64:
                cover.hints.popitem(last=False)
        cover.hints.move_to_end(key)
        hit = cover.hints[key]
    return dict(hit) if hit else hit


def _suggest(W, H, kw, mult, cover=None, now=None):
    g0 = now or plan_grid(W, H, kw, mult, cover)
    T = int(kw.get("tile_size") or 1024)
    step = mult * 8 // math.gcd(mult, 8)               # the widget steps by 8, the tile by the multiple: both
    f = overlap_share(kw.get("overlap", 0))
    fits0 = (g0["fit"]["x"]["mode"], g0["fit"]["y"]["mode"])
    work = lambda g: g["count"] * g["tile"][0] * g["tile"][1]
    best = None
    lo, hi = max(64, int(math.ceil(T * HINT_RANGE[0] / step)) * step), min(8192, int(T * HINT_RANGE[1]))
    sizes = list(range(lo, hi + 1, step))
    if cover is not None and len(sizes) > 12:          # with a mask every size is a search of its own: 12 of them, spread
        sizes = sorted({sizes[round(k * (len(sizes) - 1) / 11.0)] for k in range(12)})
    if cover is not None and cover.box is not None and mask_use(kw) == MASK_USES[0] and g0.get("rects") is not None:
        # D-324b: the exact search costs ~0.1-2 s a size: the tidy layout (~0.1 s) ranks the sizes, the exact one works out the best one
        # (the count promised is still the one a click gives: the same plan_grid)
        quick = sorted((plan_grid(W, H, dict(kw, tile_size=s), mult, cover, exact=False)["count"], abs(s - T), s) for s in sizes)
        sizes = [s for c, _, s in quick if c < g0["count"]][:1]        # the tidy count already saves: the exact one can only do better
    for s in sizes:
        g = plan_grid(W, H, dict(kw, tile_size=s), mult, cover)
        if g["count"] >= g0["count"] or g["tile"] == g0["tile"] or work(g) > work(g0):
            continue
        if any(m != "none" and m != m0 for m, m0 in zip((g["fit"]["x"]["mode"], g["fit"]["y"]["mode"]), fits0)):
            continue
        dev = sum(abs(v - f) for v in (_axis_share(g, "x"), _axis_share(g, "y")) if v is not None)
        key = (g["count"], round(dev, 4), abs(s - T))
        if best is None or key < best[0]:
            best = (key, s, g)
    if best is None:
        return None
    _, s, g = best
    return {"tile_size": s, "count": g["count"], "now": g0["count"], "overlap": real_share(g), "tile": list(g["tile"])}


def overlap_share(v):
    """The overlap widget -> a share of the tile in [0, 0.5] (0.15 = 15 % of the side)."""
    try:
        f = float(v or 0)
    except (TypeError, ValueError):
        return 0.0
    return min(0.5, max(0.0, f)) if math.isfinite(f) else 0.0


def measure(got, want):
    """The scale a tile came back at: got / want, snapped to the nearest quarter when only a rounding apart (a VAE that hands
    back 960 for 954, an upscaler a few px off). An honest 1.37 stays 1.37."""
    k = got / float(want)
    q = round(k * 4.0) / 4.0
    if q > 0 and abs(got - want * q) <= max(8.0, 0.02 * want * q):
        return q
    return k


def ramp_weights(starts, sizes, feather, lead=0.0, tail=0.0):
    """1D seam weights on one side, in the merged canvas: for tile i a vector of sizes[i] that is 1 alone, 0 -> 1 across the
    overlap with the one before and 1 -> 0 across the one after. Two neighbours sum to exactly 1 (a cosine and its mirror).
    feather = the share of the overlap the fade uses, centred (0 = a hard cut in the middle).
    lead / tail = px of fade at the very start of the first tile / end of the last one (a masked area inside the picture: the
    original takes over there, D-318); 0 = a hard edge (the picture's own)."""
    f = min(1.0, max(0.0, float(feather)))
    out = []
    n = len(starts)
    for i, (p, s) in enumerate(zip(starts, sizes)):
        w = torch.ones(s)
        x = torch.arange(s, dtype=torch.float32) + p + 0.5          # pixel centres, canvas coordinates
        for j, rising in ((i - 1, True), (i + 1, False)):
            if j < 0 or j >= n:
                edge = lead if rising else tail
                if edge <= 0:
                    continue
                a, b = (starts[i], starts[i] + edge) if rising else (starts[i] + sizes[i] - edge, starts[i] + sizes[i])
            else:
                a, b = (starts[i], starts[j] + sizes[j]) if rising else (starts[j], starts[i] + sizes[i])
            ol = max(0, b - a)
            r = ol * f
            st = a + (ol - r) / 2.0
            t = ((x - st) / r).clamp(0.0, 1.0) if r > 0 else (x >= st).float()
            up = 0.5 - 0.5 * torch.cos(math.pi * t) if r > 0 else t
            w = w * (up if rising else 1.0 - up)
        out.append(w)
    return out


# ---------------- the work ----------------

def work_canvas(image, grid, how_fill="blur", color="#000000"):
    """IMAGE [B,H,W,C] -> the BCHW canvas the tiles are cut from: the area cut out, the fit done (how_fill None = the pad stays 0)."""
    fx, fy = grid["fit"]["x"], grid["fit"]["y"]
    x = image[:, fy["c0"]:fy["c1"], fx["c0"]:fx["c1"], :].permute(0, 3, 1, 2).float()
    if (fy["lr"], fx["lr"]) != tuple(x.shape[-2:]):
        x = resize(x, fy["lr"], fx["lr"])
    WW, WH = grid["work"]
    if (WH, WW) != tuple(x.shape[-2:]):                 # pad: centred on a canvas the tile's size, the rest filled
        B, C = int(x.shape[0]), int(x.shape[1])
        canvas = torch.zeros((B, C, WH, WW), dtype=x.dtype, device=x.device)
        hole = torch.ones((1, 1, WH, WW), dtype=x.dtype, device=x.device)
        y0, x0 = fy["p0"], fx["p0"]
        canvas[:, :, y0:y0 + fy["lr"], x0:x0 + fx["lr"]] = x
        hole[:, :, y0:y0 + fy["lr"], x0:x0 + fx["lr"]] = 0.0
        x = fill(canvas, hole, how_fill, color) if how_fill else canvas
    return x


def split(image, grid, how_fill="blur", color="#000000"):
    """IMAGE [B,H,W,C] + plan_grid -> list of tiles [B,TH,TW,C], rows top to bottom, each left to right (only the active ones)."""
    x = work_canvas(image, grid, how_fill, color).permute(0, 2, 3, 1)
    TW, TH = grid["tile"]
    if grid.get("rects") is not None:
        return [x[:, ty:ty + TH, tx:tx + TW, :].contiguous() for tx, ty in grid["rects"]]
    act = grid.get("active")
    keep = set(range(grid["cols"] * grid["rows"])) if act is None else set(act)
    return [x[:, ty:ty + TH, tx:tx + TW, :].contiguous() for r, ty in enumerate(grid["ys"]) for c, tx in enumerate(grid["xs"])
            if r * grid["cols"] + c in keep]


def split_mask(mask, grid, batch=1):
    """The mask's piece for every tile that goes out: list of [B, TH, TW] (no mask = zeros, one frame)."""
    TW, TH = grid["tile"]
    if mask is None:
        return [torch.zeros((1, TH, TW)) for _ in range(grid["count"])]
    W, H = grid["size"]
    m = mask_frames(mask, W, H)[..., None]
    return [t[..., 0] for t in split(m, grid, None)]


def _gather(images, count, batch):
    """What came back (a list of tensors, one per tile, or one batch, or anything in between) -> one [count*batch, h, w, C]."""
    items = [t for t in images if t is not None]
    if not items:
        raise ValueError(f"{_TAG} no tiles came back")
    h, w = int(items[0].shape[1]), int(items[0].shape[2])
    items = [t if (int(t.shape[1]), int(t.shape[2])) == (h, w) else
             resize(t.permute(0, 3, 1, 2).float(), h, w).permute(0, 2, 3, 1) for t in items]
    allt = torch.cat([t.float() for t in items], 0) if len(items) > 1 else items[0].float()
    if int(allt.shape[0]) != count * batch:
        raise ValueError(f"{_TAG} {int(allt.shape[0])} tiles came back, the Split made {count}"
                         + (f" x {batch} pictures" if batch > 1 else "")
                         + ": wire the Merge to what the Split's tiles became (one result per tile)")
    return allt


def _box(x, rx, ry):
    """Box average of BCHW over (2ry+1) x (2rx+1), edges repeated (a picture edge never fades): O(pixels) with cumsums."""
    for dim, r in ((-1, int(rx)), (-2, int(ry))):
        if r <= 0:
            continue
        pad = [r, r, 0, 0] if dim == -1 else [0, 0, r, r]
        p = F.pad(x, pad, mode="replicate")
        c = torch.cumsum(p, dim)
        c = torch.cat([torch.zeros_like(c.narrow(dim, 0, 1)), c], dim)
        n = int(x.shape[dim])
        x = (c.narrow(dim, 2 * r + 1, n) - c.narrow(dim, 0, n)) / (2 * r + 1)
    return x


def _edge(size, start, total, o, f):
    """1D window of one tile (size px from `start` on a side of `total`): rises over the first overlap and falls over the last one,
    the share f of it, centred; flat at the picture's own edges. Never 0 (a tile alone still counts)."""
    x = torch.arange(size, dtype=torch.float32) + 0.5
    w = torch.ones(size)
    r = o * f
    for at_edge, d in ((start <= 0, x), (start + size >= total, size - x)):
        if at_edge or o <= 0:
            continue
        st = (o - r) / 2.0
        t = ((d - st) / r).clamp(0.0, 1.0) if r > 0 else (d >= st).float()
        w = w * (0.5 - 0.5 * torch.cos(math.pi * t) if r > 0 else t)
    return w.clamp_min(1e-4)


def _merge_rects(allt, g, B, kx, ky, feather, original):
    """D-318c: the free layout back together. Tiles blended among themselves (each fades over the overlap at its inner edges,
    normalised), then the whole set fades into the original at the OUTER edge of what the tiles cover (an overlap wide: outside
    the mask, which was grown by it). Inside, every pixel is the tiles'."""
    W, H = g["size"]
    TW, TH = g["tile"]
    ox, oy = g["overlap"]
    C = int(allt.shape[3])
    CW, CH = max(1, int(round(W * kx))), max(1, int(round(H * ky)))
    dev = allt.device
    f = min(1.0, max(0.0, float(feather)))
    acc = torch.zeros((B, C, CH, CW), dtype=torch.float32, device=dev)
    wsum = torch.zeros((1, 1, CH, CW), dtype=torch.float32, device=dev)
    cov = torch.zeros((1, 1, CH, CW), dtype=torch.float32, device=dev)
    for i, (x, y) in enumerate(g["rects"]):
        sx, sy = int(round(x * kx)), int(round(y * ky))
        zx, zy = min(CW, int(round((x + TW) * kx))) - sx, min(CH, int(round((y + TH) * ky))) - sy
        t = allt[i * B:(i + 1) * B].permute(0, 3, 1, 2)
        if tuple(t.shape[-2:]) != (zy, zx):
            t = resize(t, zy, zx)
        wt = (_edge(zy, sy, CH, oy * ky, f).to(dev)[:, None] * _edge(zx, sx, CW, ox * kx, f).to(dev)[None, :])[None, None]
        acc[:, :, sy:sy + zy, sx:sx + zx] += t * wt
        wsum[:, :, sy:sy + zy, sx:sx + zx] += wt
        cov[:, :, sy:sy + zy, sx:sx + zx] = 1.0
    if original is None:
        raise ValueError(f"{_TAG} the TILES wire lost its picture: the part outside the tiles can't come back")
    base = _frames(resize(original.permute(0, 3, 1, 2).float().to(dev), CH, CW), B)
    # the fade into the original: inside the outer half-overlap ring of the tiles, outside every core (never on the mask itself)
    alpha = (_box(cov, max(1, round(ox / 2 * kx * max(f, 0.05))), max(1, round(oy / 2 * ky * max(f, 0.05)))) * 2.0 - 1.0).clamp(0.0, 1.0) * cov
    tiles = acc / wsum.clamp_min(1e-8)
    out = base * (1.0 - alpha) + tiles * alpha
    return out.clamp(0.0, 1.0).permute(0, 2, 3, 1).contiguous()


ORDER_THUMB = 16                                       # D-323: a tile seen at 16 x 16 grey is enough to know where it was cut


def _cells_in_order(g):
    """The tiles' rectangles in picture px, in the order they went out (free rects; or the grid rows x columns, active ones only)."""
    c = view_cells(g)
    if "rects" in c:
        return [tuple(r) for r in c["rects"]]
    cols, act = len(c["x"]), g.get("active")
    every = [(x0, y0, x1, y1) for (y0, y1) in c["y"] for (x0, x1) in c["x"]]
    return every if act is None else [every[k] for k in act if 0 <= k < len(every)]


def _thumbs(frames):
    """[N, h, w, C] -> [N, 256] grey, zero mean, unit length (a flat tile = a zero row: it votes for nothing)."""
    x = frames[..., :3].float().mean(-1, keepdim=True).permute(0, 3, 1, 2)
    x = F.interpolate(x, size=(ORDER_THUMB, ORDER_THUMB), mode="area").reshape(int(x.shape[0]), -1)
    x = x - x.mean(1, keepdim=True)
    n = x.norm(dim=1, keepdim=True)
    return torch.where(n > 0.05, x / n.clamp_min(1e-8), torch.zeros_like(x))


def order_fix(allt, tiles, say=None):
    """D-323 (her half hour: a Loop's index 0, 1, 2... into an Index that counted from 1 = tile 1 twice, the last never, every
    other one sewn in its neighbour's place). Each tile that came back is compared with the piece the Split cut there (16 x 16 grey).
    In order (or too changed to tell: a high denoise) = untouched. Clearly out of order = each one goes where it really belongs,
    a place nobody came back to keeps the original, and `say` gets the words. -> the tiles in the Split's order."""
    g, original = tiles["grid"], tiles.get("image")
    B, N = int(tiles.get("batch", 1)), int(tiles["grid"]["count"])
    if original is None or N < 2:
        return allt
    W, H = g["size"]
    cuts = []
    for x0, y0, x1, y1 in _cells_in_order(g):
        a0, b0 = max(0, int(math.floor(x0))), max(0, int(math.floor(y0)))
        a1, b1 = min(W, max(a0 + 1, int(math.ceil(x1)))), min(H, max(b0 + 1, int(math.ceil(y1))))
        cuts.append(original[:1, b0:b1, a0:a1, :].float())
    if len(cuts) != N:
        return allt
    O = _thumbs(torch.cat([F.interpolate(c.permute(0, 3, 1, 2), size=(ORDER_THUMB * 2, ORDER_THUMB * 2), mode="area").permute(0, 2, 3, 1) for c in cuts], 0))
    R = _thumbs(allt[::B][:N].cpu())
    S = R @ O.T                                         # S[i, j]: returned tile i against the Split's piece j
    best = S.argmax(1)
    told = [i for i in range(N) if float(R[i].abs().sum()) > 0 and float(O[i].abs().sum()) > 0]
    wrong = [i for i in told if int(best[i]) != i and float(S[i, best[i]] - S[i, i]) > 0.15]
    if len(wrong) < max(2, len(told) // 4):
        return allt
    # out of order: the surest first, each place taken once
    pairs = sorted(((float(S[i, best[i]]), i, int(best[i])) for i in range(N)), reverse=True)
    place, taken = {}, set()
    for sc, i, j in pairs:
        if j not in taken and sc > 0.5:
            place[j] = i
            taken.add(j)
    h, w = int(allt.shape[1]), int(allt.shape[2])
    out, missing, cut = [], [], None
    for j in range(N):
        if j in place:
            i = place[j]
            out.append(allt[i * B:(i + 1) * B])
        else:                                           # nobody came back for this place: the original, at the tiles' size
            missing.append(j + 1)
            cut = cut if cut is not None else split(original, g, "blur")
            src = cut[j].float()
            src = resize(src.permute(0, 3, 1, 2), h, w).permute(0, 2, 3, 1).to(allt.dtype)
            out.append(_frames(src.permute(0, 3, 1, 2), B).permute(0, 2, 3, 1)[:, :, :, :int(allt.shape[3])].to(allt.device))
    eg = ", ".join(f"{i + 1} looks like the Split's {int(best[i]) + 1}" for i in wrong[:3])
    msg = (f"⚠ The tiles came back OUT OF ORDER ({eg}{'…' if len(wrong) > 3 else ''}): each one sewn where it was cut"
           + (f"; tile{'s' if len(missing) > 1 else ''} {', '.join(map(str, missing[:6]))} never came back (the original is there)" if missing else "")
           + ". Check what sends the tiles in: a Loop's index counts from 0")
    if say is not None:
        say.append(msg)
    print(f"{_TAG} {msg}")
    return torch.cat(out, 0)


def merge(images, tiles, feather=1.0, say=None):
    """Tiles back from the work + the TILES wire -> IMAGE [B, H*ky, W*kx, C]: the scale measured, the seams faded in the overlap,
    the fit undone (the stretch back, the pad cut off, the cut strips put back from the original)."""
    allt, kx, ky = merge_ready(images, tiles, say)
    return sew(allt, tiles, kx, ky, feather)


def merge_ready(images, tiles, say=None, show=None):
    """The tiles gathered, put in order and measured -> (allt, kx, ky). D-328: show = the longest side the browser views: the tiles
    shrink first so the sewn picture is about that big (the live Feather sews a 1536 px view, not a 7k picture, on every drag)."""
    g = tiles["grid"]
    allt = order_fix(_gather(images, g["count"], int(tiles.get("batch", 1))), tiles, say)
    h, w = int(allt.shape[1]), int(allt.shape[2])
    TW, TH = g["tile"]
    kx, ky = measure(w, TW), measure(h, TH)
    W, H = g["size"]
    s = float(show) / max(W * kx, H * ky, 1.0) if show else 1.0
    if s < 1.0:
        nh, nw = max(1, int(round(h * s))), max(1, int(round(w * s)))
        allt = resize(allt.permute(0, 3, 1, 2).float(), nh, nw).permute(0, 2, 3, 1).contiguous()
        kx, ky = kx * s, ky * s
    return allt, kx, ky


def merged_size(tiles, kx, ky):
    """The size the Run's Merge hands out at scale kx, ky (every branch ends at the whole picture times the scale)."""
    W, H = tiles["grid"]["size"]
    return max(1, int(round(W * kx))), max(1, int(round(H * ky)))


def sew(allt, tiles, kx, ky, feather=1.0):
    """Ready tiles (merge_ready) sewn at scale kx, ky with this feather."""
    g = tiles["grid"]
    B = int(tiles.get("batch", 1))
    C = int(allt.shape[3])
    TW, TH = g["tile"]
    if g.get("rects") is not None:
        return _merge_rects(allt, g, B, kx, ky, feather, tiles.get("image"))
    WW, WH = g["work"]
    CW, CH = max(1, int(round(WW * kx))), max(1, int(round(WH * ky)))
    sx = [int(round(p * kx)) for p in g["xs"]]
    sy = [int(round(p * ky)) for p in g["ys"]]
    zx = [min(CW, int(round((p + TW) * kx))) - s for p, s in zip(g["xs"], sx)]
    zy = [min(CH, int(round((p + TH) * ky))) - s for p, s in zip(g["ys"], sy)]
    W, H = g["size"]
    area = g.get("area") or [0, 0, W, H]
    act = g.get("active")
    whole = act is None and list(area) == [0, 0, W, H]
    ox, oy = g["overlap"]
    # a masked area inside the picture fades into the original at its own edges (an overlap wide), the picture's edges stay hard
    lx = (ox * kx if area[0] > 0 else 0, ox * kx if area[2] < W else 0)
    ly = (oy * ky if area[1] > 0 else 0, oy * ky if area[3] < H else 0)
    wx, wy = ramp_weights(sx, zx, feather, *lx), ramp_weights(sy, zy, feather, *ly)
    dev = allt.device
    acc = torch.zeros((B, C, CH, CW), dtype=torch.float32, device=dev)
    wsum = torch.zeros((1, 1, CH, CW), dtype=torch.float32, device=dev)
    slot = {k: i for i, k in enumerate(range(len(sx) * len(sy)) if act is None else act)}
    for r in range(len(sy)):
        for c in range(len(sx)):
            i = slot.get(r * len(sx) + c)
            if i is None:
                continue
            t = allt[i * B:(i + 1) * B].permute(0, 3, 1, 2)
            if tuple(t.shape[-2:]) != (zy[r], zx[c]):
                t = resize(t, zy[r], zx[c])
            wt = (wy[r].to(dev)[:, None] * wx[c].to(dev)[None, :])[None, None]
            acc[:, :, sy[r]:sy[r] + zy[r], sx[c]:sx[c] + zx[c]] += t * wt
            wsum[:, :, sy[r]:sy[r] + zy[r], sx[c]:sx[c] + zx[c]] += wt
    original = tiles.get("image")
    if whole:
        out = acc / wsum.clamp_min(1e-8)
    else:                                               # D-318: where the tiles do not reach (or fade out) the original shows
        if original is None:
            raise ValueError(f"{_TAG} the TILES wire lost its picture: the tiles left out can't come back")
        base = _frames(work_canvas(original.to(dev), g, None), B)
        base = resize(base, CH, CW) if tuple(base.shape[-2:]) != (CH, CW) else base
        # three tiles over one pixel (a real overlap past half a tile) weigh more than 1: normalised there, as without a mask
        out = (acc + base * (1.0 - wsum).clamp_min(0.0)) / wsum.clamp_min(1.0)
    out = _unfit(out, g, kx, ky, original)
    if list(area) != [0, 0, W, H]:                      # the area back in the whole picture, at the same scale
        full = _frames(resize(original.permute(0, 3, 1, 2).float().to(dev), max(1, int(round(H * ky))), max(1, int(round(W * kx)))), B).clone()
        x0, y0 = int(round(area[0] * kx)), int(round(area[1] * ky))
        h, w = min(int(out.shape[-2]), int(full.shape[-2]) - y0), min(int(out.shape[-1]), int(full.shape[-1]) - x0)
        full[:, :, y0:y0 + h, x0:x0 + w] = out[:, :, :h, :w]
        out = full
    return out.clamp(0.0, 1.0).permute(0, 2, 3, 1).contiguous()


def _frames(x, B):
    """BCHW with 1 frame or B -> B frames."""
    return x if int(x.shape[0]) == B else x[:1].expand(B, -1, -1, -1)


def _unfit(x, g, kx, ky, original):
    """BCHW canvas at the measured scale -> the area's own frame at that scale (the whole picture without a mask)."""
    W, H = g["size"]
    area = g.get("area") or [0, 0, W, H]
    W, H = area[2] - area[0], area[3] - area[1]
    FW, FH = max(1, int(round(W * kx))), max(1, int(round(H * ky)))
    fx, fy = g["fit"]["x"], g["fit"]["y"]
    if fx["mode"] == "pad" or fy["mode"] == "pad":     # the fill goes
        x0 = int(round(fx["p0"] * kx)) if fx["mode"] == "pad" else 0
        y0 = int(round(fy["p0"] * ky)) if fy["mode"] == "pad" else 0
        x1 = x0 + (FW if fx["mode"] == "pad" else int(x.shape[-1]))
        y1 = y0 + (FH if fy["mode"] == "pad" else int(x.shape[-2]))
        x = x[:, :, y0:y1, x0:x1]
    tw = FW if fx["mode"] != "crop" else max(1, int(round(fx["lr"] * kx)))
    th = FH if fy["mode"] != "crop" else max(1, int(round(fy["lr"] * ky)))
    if tuple(x.shape[-2:]) != (th, tw):                 # resize: the few px go back (and any rounding of the scale)
        x = resize(x, th, tw)
    if fx["mode"] != "crop" and fy["mode"] != "crop":
        return x
    if original is None:
        raise ValueError(f"{_TAG} the TILES wire lost its picture: the cut edges can't come back")
    o = original[:, area[1]:area[3], area[0]:area[2], :]
    base = _frames(resize(o.permute(0, 3, 1, 2).float().to(x.device), FH, FW), int(x.shape[0])).clone()
    ox = int(round((fx["c0"] - area[0]) * kx)) if fx["mode"] == "crop" else 0
    oy = int(round((fy["c0"] - area[1]) * ky)) if fy["mode"] == "crop" else 0
    th, tw = min(th, FH - oy), min(tw, FW - ox)       # a rounding px over the edge stays out
    base[:, :, oy:oy + th, ox:ox + tw] = x[:, :, :th, :tw]
    return base


def real_share(g):
    """The real overlap as shares of the tile, '0.15' or '0.15 x 0.21' (one tile on a side = 0 there)."""
    a = [round(r[0] / float(t), 3) if n > 1 else 0.0 for r, t, n in ((g["real"]["x"], g["tile"][0], g["cols"]), (g["real"]["y"], g["tile"][1], g["rows"]))]
    return f"{a[0]:g}" if a[0] == a[1] else f"{a[0]:g} x {a[1]:g}"


def report(g, batch=1):
    """The `report` output: the numbers that matter, one per line."""
    rx, ry = g["real"]["x"][0] if g["cols"] > 1 else 0, g["real"]["y"][0] if g["rows"] > 1 else 0
    lines = [f"-Image size: {g['size'][0]}x{g['size'][1]};",
             f"-Tile size: {g['tile'][0]}x{g['tile'][1]};",
             f"-Real overlap: {real_share(g)} ({rx} x {ry} px);",
             f"-Number of Rows: {g['rows']};",
             f"-Number of columns: {g['cols']};",
             f"-Number of total tiles: {g['count']};"]
    if g.get("rects") is not None:
        lines.insert(-1, f"-Masked: {g['count']} tiles laid along the mask's shape (rows / columns = their distinct starts);")
    if g.get("active") is not None:
        lines.insert(-1, f"-Masked: {g['count']} of {g.get('total', g['count'])} tiles touch the mask;")
    if int(batch) > 1:
        lines.append(f"-Pictures in the batch: {int(batch)} (each tile carries all of them);")
    return "\n".join(lines)


def view_cells(g):
    """The grid in the picture's OWN px, what a preview draws: {"x": [[start, end], ...], "y": [...]}. resize = stretched back,
    crop = moved by the cut, pad = the one tile runs past both edges (by the fill). The free layout (D-318c): {"rects": [[x0, y0, x1, y1]...]}."""
    if g.get("rects") is not None:
        TW, TH = g["tile"]
        return {"rects": [[x, y, x + TW, y + TH] for x, y in g["rects"]]}
    def axis(a, pos, T):
        f = g["fit"][a]
        if f["mode"] == "resize":
            k = (f["c1"] - f["c0"]) / float(max(1, f["lr"]))
            return [[round(p * k + f["c0"], 2), round((p + T) * k + f["c0"], 2)] for p in pos]
        o = -f["p0"] if f["mode"] == "pad" else f["c0"]
        return [[p + o, p + T + o] for p in pos]
    return {"x": axis("x", g["xs"], g["tile"][0]), "y": axis("y", g["ys"], g["tile"][1])}


def split_info(g, why="", batch=1, hint=None, warn=""):
    """What the Split's view shows: the line, the cells, the numbers, the fit hint, the warning on its own red box (JSON, the browser reads it)."""
    line = describe(g, why)
    if hint:
        line += f" · 💡 Tile {hint['tile_size']} -> {hint['count']} tiles (now {hint['now']}) · overlap {hint['overlap']}"
    return {"line": line, "cells": view_cells(g), "report": report(g, batch), "count": g["count"], "cols": g["cols"], "rows": g["rows"],
            "tile": list(g["tile"]), "real_pct": list(g["real_pct"]), "multiple": g["multiple"], "why": why,
            "width": g["size"][0], "height": g["size"][1], "batch": int(batch), "active": g.get("active"), "total": g.get("total", g["count"]),
            "area": list(g.get("area") or [0, 0, g["size"][0], g["size"][1]]), "mask": g.get("mask", "none"), "hint": hint, "warn": warn}


def merge_info(meta, out, feather, warn="", size=None):
    """What the Merge's view shows after a Run: the scale it measured, the size it made, the seams where they ended up.
    size = (w, h) the Run makes when `out` is a smaller live copy (D-328)."""
    g = meta["grid"]
    W, H = g["size"]
    ow, oh = (int(size[0]), int(size[1])) if size else (int(out.shape[2]), int(out.shape[1]))
    kx, ky = ow / float(max(1, W)), oh / float(max(1, H))
    c = view_cells(g)
    if "rects" in c:
        cells = {"rects": [[round(a * kx, 2), round(b * ky, 2), round(d * kx, 2), round(e * ky, 2)] for a, b, d, e in c["rects"]]}
    else:
        cells = {"x": [[round(a * kx, 2), round(b * kx, 2)] for a, b in c["x"]], "y": [[round(a * ky, 2), round(b * ky, 2)] for a, b in c["y"]]}
    k = f"x{kx:.3g}" if abs(kx - ky) < 1e-3 else f"x{kx:.3g} / x{ky:.3g}"
    line = f"{g['count']} tiles back · scale {k} · {W}x{H} -> {ow}x{oh} · feather {feather:.2g}"
    return {"line": line, "cells": cells, "count": g["count"], "scale": [round(kx, 4), round(ky, 4)], "width": ow, "height": oh,
            "active": g.get("active"), "warn": warn}


_SMALL = OrderedDict()                                 # D-314: (picture, view size) -> its smaller copy, a drag asks again and again
_SMALL_MAX = 2


def small_copy(image, show):
    """The first frame, its long side = show (area average), made once per (picture, size). Identity compare: no id reuse under us."""
    H, W = int(image.shape[1]), int(image.shape[2])
    if not show or max(W, H) <= show:
        return image[:1]
    key = (id(image), int(show))
    hit = _SMALL.get(key)
    if hit is not None and hit[0] is image:
        _SMALL.move_to_end(key)
        return hit[1]
    k = float(show) / max(W, H)
    x = image[:1].permute(0, 3, 1, 2).float()
    x = F.interpolate(x, size=(max(1, round(H * k)), max(1, round(W * k))), mode="area").permute(0, 2, 3, 1).contiguous()
    _SMALL[key] = (image, x)
    while len(_SMALL) > _SMALL_MAX:
        _SMALL.popitem(last=False)
    return x


def describe(g, why=""):
    """One line for a person: '12 tiles (4 x 3) of 1024x1024 · overlap 136-140 x 128 px (13%) · multiple 16'."""
    rx, ry = g["real"]["x"], g["real"]["y"]
    ov = lambda r: f"{r[0]}" if r[0] == r[1] else f"{r[0]}-{r[1]}"
    n = f"{g['count']} of {g['total']} tiles (masked)" if g.get("active") is not None else f"{g['count']} tiles"
    if g.get("rects") is not None:
        return (f"{g['count']} tiles along the mask of {g['tile'][0]}x{g['tile'][1]} · overlap >= {g['overlap'][0]} x {g['overlap'][1]} px · "
                f"multiple {g['multiple']}" + (f" ({why})" if why and why not in ("list", "custom", "model") else ""))
    s = (f"{n} ({g['cols']} x {g['rows']}) of {g['tile'][0]}x{g['tile'][1]} · overlap {real_share(g)} "
         f"({ov(rx)} x {ov(ry)} px) · multiple {g['multiple']}")
    fits = [f"{a} {g['fit'][a]['mode']}" for a in ("x", "y") if g["fit"][a]["mode"] != "none"]
    s += " · mask empty: every tile" if g.get("mask") == "empty" else ""
    return s + (" · fit " + ", ".join(fits) if fits else "") + (f" ({why})" if why and why not in ("list", "custom", "model") else "")


class Succy_Tile_Split:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "The picture to cut into tiles"}),
                "tile_size": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8,
                                      "tooltip": "The long side of a tile, overlap included (what the model sees). Rounded to the multiple"}),
                "aspect": (list(ASPECTS), {"default": "square",
                                           "tooltip": "Tile shape. square = the safe choice for most models · picture = same shape as the picture (often fewer tiles)"}),
                "overlap": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 0.5, "step": 0.01,
                                      "tooltip": "Share of a tile two neighbours have in common, where the seams fade (0.15 = 15 % of its side). The real one is this or a bit more (the tiles spread to touch both edges); at most 0.5"}),
                "multiple": (list(MULTIPLES), {"default": "auto",
                                               "tooltip": "Tile sides are rounded to this. auto = read from the MODEL wire (16 without it). DiT models pad a tile that is not a multiple by wrapping the opposite edge: keep it right"}),
                "multiple_px": ("INT", {"default": 16, "min": 1, "max": 512, "step": 1, "tooltip": "multiple = custom: the number"}),
                "fit": (list(FITS), {"default": "resize",
                                     "tooltip": "Only when a side of the picture is SHORTER than the tile. resize = the tile shrinks to that side, the picture stretches a few px (Merge puts them back) · pad = the picture is filled up to the tile (Merge cuts it off) · crop = a few px are cut (Merge puts the originals back)"}),
                "fill": (list(FILL_MODES), {"default": "blur", "tooltip": "fit = pad: blur = the picture's edge stretched and blurred · color = a flat colour"}),
                "fill_color": ("STRING", {"default": "#000000", "tooltip": "fit = pad, fill = color: the colour (#rrggbb)"}),
                "output": (list(OUTPUTS), {"default": "batch",
                                           "tooltip": "list = one tile at a time: ComfyUI runs the next nodes once per tile (least RAM / VRAM, no loop needed) · batch = every tile in one batch: one run, all tiles in VRAM together"}),
                "mask_use": (list(MASK_USES), {"default": MASK_DEFAULT,
                                               "tooltip": "Only with a mask wired. pass only (default) = every tile, the mask only rides along (one piece per tile) · tile only masked (experimental) = the grid lies on the masked part, the tiles that do not touch it stay out (Merge puts the original back there)"}),
                # D-329, last on purpose: an old workflow's widget values still line up, the missing ones take their default
                "hold": ("BOOLEAN", {"default": False, "label_on": "Stop every run", "label_off": "Reuse",
                                     "tooltip": "On: every Run waits here with the picture and the mask that came in, so you choose the tiles on them (▶ goes on)"}),
                "hold_timeout": ("INT", {"default": 300, "min": 1, "max": 3600, "step": 1,
                                         "tooltip": "Seconds to wait before carrying on with the tiles as they are"}),
                "run_id": ("STRING", {"default": "0_manual", "tooltip": "Managed by the frontend"}),
            },
            "optional": {
                # D-322 (her order): image, mask, model
                "mask": ("MASK", {"tooltip": "Where to work: the tiles follow its shape (mask_use), each goes out with its own piece of the mask (inpainting). It must be THIS picture's mask: after a Crop wire its `crop_mask`, not `mask` (the whole photo's)"}),
                "model": ("MODEL", {"tooltip": "multiple = auto: the tile multiple is read from this model (VAE downscale x patch)"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }

    # D-320 (her order): tiles, image, mask, count, report — what a sampler takes first, the numbers last
    RETURN_TYPES = ("TILES", "IMAGE", "MASK", "INT", "STRING")
    RETURN_NAMES = ("tiles", "image", "mask", "count", "report")
    OUTPUT_IS_LIST = (False, True, True, False, False)
    OUTPUT_TOOLTIPS = ("To the Tile Merge: how the picture was cut", "The tiles: a list (one per tile) or one batch, see `output`",
                       "Each tile's piece of the mask, same order and list / batch as image (no mask wired = empty)",
                       "How many tiles go out (per picture): e.g. a Loop's max iterations", "Image size, tile size, real overlap, rows, columns, tiles: one per line")
    FUNCTION = "split_tiles"
    SUCCY_CACHE = "memo"  # SmartCache (D-213): pictures: the value memo (D-210)
    SUCCY_LIVE = ("tiles", "count", "report")   # the tiles and their masks are lists: only a Run hands them out
    SUCCY_LIVE_SHOW = True   # D-336: its live answer depends on the size the view asks (the memo keeps one per size)

    @classmethod
    def IS_CHANGED(cls, hold=False, run_id="", **kwargs):
        # D-332: on Stop it runs on EVERY Run (it had no rule: the 2nd Run after a cached Load took it from the cache, no stop)
        return stop_key(cls, hold, run_id)

    def split_tiles(self, image, tile_size=1024, aspect="square", overlap=0.15, multiple="auto", multiple_px=16, fit="resize",
                    fill="blur", fill_color="#000000", output="batch", mask_use=MASK_DEFAULT, hold=False, hold_timeout=300, run_id="",
                    model=None, mask=None, unique_id=None, dynprompt=None):
        args = {k: v for k, v in locals().items() if k != "self"}          # D-332: ▶ of the node's own wait goes on with her values
        did = display_id(dynprompt, unique_id)
        kw = {"tile_size": tile_size, "aspect": aspect, "overlap": overlap, "multiple": multiple, "multiple_px": multiple_px,
              "fit": fit, "fill": fill, "fill_color": fill_color, "output": output, "mask_use": mask_use}
        mult, why = pick_multiple(kw, model)
        if hold and not str(run_id).endswith("_continue"):
            # D-329: what came in is kept FIRST (the live view draws the grid on it while she chooses), the grid of now shown, then wait
            if _keep(did, {"image": image, "mask": mask, "model_mult": model_multiple(model) if model is not None else None, "model_why": why,
                              "kw": _ring_kw(dynprompt, unique_id, tile_size, overlap)}):
                live_touch()
            B, H, W, _ = image.shape
            g = plan_grid(int(W), int(H), kw, mult, cover_of(mask, int(W), int(H)))
            send_preview(did, image, _TAG, info=split_info(g, why, int(B)))
            # D-330: the gate holds the Run right after this node (▶ runs it again with her values, Load / SAM untouched);
            # without it the old wait here, ▶ = a new queue
            if not gate_hold(did, int(hold_timeout), "succy-tile-info", dynprompt, unique_id):
                say(f"{_TAG} node {did} waiting up to {hold_timeout}s for the tiles...")
                _hold(did, int(hold_timeout))
                new = after_wait(did, unique_id, args)          # D-355: changes before it = the chain runs again now
                if new:                                    # D-332: in place with her tiles of now (no new queue)
                    return self.split_tiles(**{**args, **new, "run_id": str(run_id) + "_continue"})
        key = {"kw": kw, "mult": mult, "image": image, "mask": mask}
        hit = _MEMO_S.get(did, key)
        if hit is None:
            B, H, W, _ = image.shape
            cover = cover_of(mask, int(W), int(H))
            grid = plan_grid(int(W), int(H), kw, mult, cover)
            how = fill if fill in FILL_MODES else "blur"
            parts = split(image, grid, how, str(fill_color or "#000000"))
            masks = split_mask(mask, grid)
            items = parts if output != "batch" else [torch.cat(parts, 0)]
            mitems = masks if output != "batch" else [torch.cat(masks, 0)]
            meta = {"version": 1, "op": "tiles", "grid": grid, "batch": int(B), "mode": "batch" if output == "batch" else "list",
                    "why": why, "info": describe(grid, why), "image": image}   # the picture: a reference, for crop's edges and the tiles left out
            hit = (meta, items, mitems, suggest(int(W), int(H), kw, mult, cover, grid))
            _MEMO_S.put(did, key, hit)
        meta, items, mitems, hint = hit
        # the live view reads the picture and the mask (wires only a Run fills), the MODEL's multiple and the rings' values from here
        if _keep(did, {"image": image, "mask": mask, "model_mult": model_multiple(model) if model is not None else None, "model_why": why,
                       "kw": _ring_kw(dynprompt, unique_id, tile_size, overlap)}):
            live_touch()                                   # D-333: only when it brought something new (▶'s run again = the same)
        g = meta["grid"]
        send_preview(did, image, _TAG, info=split_info(g, meta.get("why", ""), meta.get("batch", 1), hint))
        return (meta, items, mitems, int(g["count"]), report(g, meta.get("batch", 1)))

    @classmethod
    def succy_live(cls, widgets, inputs, node_id):
        # D-316: the picture and the grid as they are now. Picture: its live source, else the last Run's; the MODEL is never live:
        # auto reads the multiple the last Run found on it (16 until a Run)
        last = _LAST.get(node_id) or {}
        if not inputs.linked("image"):
            raise LiveWait("image", "wire a picture to image")
        image = inputs.get("image")
        if image is None:
            image = last.get("image")
        if image is None:
            raise LiveWait("run", "the picture comes from a wire only a Run can read: Run once")
        # the rings (EXT dots on tile_size / overlap): their wire now, else the last Run's value, else "Run once" (D-228)
        lk = last.get("kw") or {}
        widgets, _ = door_values(widgets, inputs, {("kw:" + k): v for k, v in lk.items()}, [(k, (k,), ("kw:" + k,)) for k in RINGS], "the Tile Split")
        kw = coerce_widgets(cls, widgets)
        mult, why = pick_multiple(kw)
        if kw.get("multiple", "auto") == "auto" and inputs.linked("model"):
            got = last.get("model_mult")
            mult, why = (got, last.get("model_why") or "model") if got else (AUTO_FALLBACK, "MODEL: Run once to read it, 16 until then")
        # the mask: its live source, else the last Run's; wired but unknown = the grid without it, the line says so
        mask = None
        if inputs.linked("mask"):
            mask = inputs.get("mask")
            if mask is None:
                mask = last.get("mask")
            if mask is None:
                why = (why + " · " if why else "") + "mask: Run once to read it"
        B, H, W = int(image.shape[0]), int(image.shape[1]), int(image.shape[2])
        bad = mask_misfit(mask, W, H) if mask is not None else None
        if bad:                                        # the live view says it in red, on its own, and tiles without it; the Run stops on it
            mask = None
        # D-336: where the Split's own time goes (her PC: 2-5 s a change, the bench 0.1-0.7 s): /succy/live/stats nodes.Succy_Tile_Split.parts
        t, ms = time.perf_counter(), {}

        def lap(k):
            nonlocal t
            now = time.perf_counter()
            ms[k] = int((now - t) * 1000)
            t = now
        cover = cover_of(mask, W, H)
        lap("cover")
        grid = plan_grid(W, H, kw, mult, cover)
        lap("grid")
        pic = small_copy(image, getattr(inputs, "show", None))
        lap("picture")
        hint = suggest(W, H, kw, mult, cover, grid)
        lap("hint")
        LIVE_STATS["parts"] = {**LIVE_STATS.get("parts", {}), "Succy_Tile_Split": ms}
        meta = {"version": 1, "op": "tiles", "grid": grid, "batch": B, "mode": "batch" if kw.get("output") == "batch" else "list",
                "why": why, "info": describe(grid, why), "image": image}
        out = {"tiles": meta, "count": int(grid["count"]), "report": report(grid, B), "picture": pic,
               "_info": split_info(grid, why, B, hint, "⚠ Mask ignored, the tiles cover the whole picture: " + bad if bad else ""), "_real": {"picture": (W, H)}}
        return out


class Succy_Tile_Merge:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "tiles": ("TILES", {"tooltip": "From the Tile Split: how the picture was cut"}),
                "image": ("IMAGE", {"tooltip": "The tiles after the work (sampler, upscaler...), in the Split's order. Any scale: it is measured"}),
                "feather": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                      "tooltip": "How much of the overlap the seam fade uses (1 = all of it, softest · 0 = a hard cut in the middle)"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    INPUT_IS_LIST = True
    FUNCTION = "merge_tiles"
    SUCCY_CACHE = "memo"  # SmartCache (D-213): pictures: the value memo (D-210)
    SUCCY_LIVE = ("image",)
    SUCCY_LIVE_SHOW = True   # D-336: its live answer depends on the size the view asks (the memo keeps one per size)

    @classmethod
    def succy_live(cls, widgets, inputs, node_id):
        # D-316c: the last Run's tiles (what came back from the work) sewn again with the Feather as it is now
        # D-328: sewn at the size the browser views (show), the tiles shrunk ONCE per Run and size: a drag only sews again
        last = _LAST.get(node_id) or {}
        if last.get("meta") is None:
            if _LET_GO[0]:
                raise LiveWait("run", "Feather is live again after a Run: ComfyUI's free (Free model and node cache) let the last Run's tiles go")
            raise LiveWait("run", "the tiles come back from the work: Run once, then Feather is live")
        f = float(coerce_widgets(cls, widgets).get("feather", 1.0))
        show = getattr(inputs, "show", None)
        key = int(show) if show else 0
        ready = last.get("ready")
        if not ready or ready[0] != key:
            said = []
            allt, kx, ky = merge_ready(last["images"], last["meta"], said, show)
            ready = last["ready"] = (key, allt, kx, ky, " ".join(said))
        _key, allt, kx, ky, warn = ready
        meta = last["meta"]
        out = sew(allt, meta, kx, ky, f)
        full = merged_size(meta, *last["k"]) if last.get("k") else None
        o = {"image": out, "_info": merge_info(meta, out, f, warn, full)}
        if full and show:
            o["_real"] = {"image": full}
        return o

    def merge_tiles(self, tiles, image, feather=(1.0,), unique_id=None, dynprompt=None):
        first = lambda v, d=None: (v[0] if v else d) if isinstance(v, list) else (d if v is None else v)
        meta = first(tiles)
        if not isinstance(meta, dict) or meta.get("op") != "tiles":
            raise ValueError(f"{_TAG} the tiles input wants the Tile Split's `tiles` output")
        f = float(first(feather, 1.0))
        did = display_id(first(dynprompt), first(unique_id))
        images = image if isinstance(image, list) else [image]
        key = {"meta": meta, "image": images, "feather": f}
        hit = _MEMO_M.get(did, key)
        if hit is None:
            said = []
            hit = (merge(images, meta, f, said), " ".join(said))
            _MEMO_M.put(did, key, hit)
        out, warn = hit
        W, H = meta["grid"]["size"]
        _keep(did, {"meta": meta, "images": images, "k": (int(out.shape[2]) / float(max(1, W)), int(out.shape[1]) / float(max(1, H)))})  # the live Feather sews these again (they live in ComfyUI's cache anyway)
        live_touch()
        send_preview(did, out, _TAG, info=merge_info(meta, out, f, warn))
        return (out,)
