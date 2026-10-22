import collections
import json
import math
import re

import torch
import comfy.utils

from _succy_common import ANY, LiveWait, coerce_widgets, door_values, live_touch, parse_bool, parse_int   # the shared drawer (loaded once by __init__.py)

# ====================================================================== #
#  Succy_Any — switch, batch and list in one body                        #
#  Plug anything into in_1: every socket locks onto that type, and more   #
#  sockets open as you plug. Out of her:                                  #
#     picked · the ONE input chosen (by index, by a boolean, or the       #
#              first that really shows up: auto). Sockets keep their    #
#              number: a hole never promotes the ones below it        #
#     list   · every item, one by one (ComfyUI runs what follows once     #
#              per item) — works for ANY type, even models                #
#     batch  · every item glued into one batch (IMAGE, MASK, LATENT,      #
#              CONDITIONING, AUDIO only: the frontend drops it otherwise) #
#     count  · how many items                                             #
#  LIVE (D-172): `picked` and `batch` reach the Succy nodes on their wires without a Queue (SUCCY_LIVE), pictures and masks.
#  Lazy: only the inputs an output really needs get computed. Only        #
#  `picked` wired = the branches not chosen never run.                    #
#  Everything the UI sets arrives packed in ONE hidden widget `data`      #
#  (JSON, only what differs from the default). The frontend also writes   #
#  there what it knows: wired sockets, locked type, outputs in use.       #
# ====================================================================== #

MAX_INPUTS = 32
IN_NAMES = tuple(f"in_{i}" for i in range(1, MAX_INPUTS + 1))
BATCHABLE = ("IMAGE", "MASK", "LATENT", "CONDITIONING", "AUDIO")
MAX_TOKENS = 77 * 64              # conditionings of different length are repeated up to their least common multiple, not beyond
TAG = "Succy Any"

# same defaults as the frontend (dev/src/Succy_Any.js, packed defaults): a missing key means "untouched"
DEFAULTS = {
    "mode": "index", "index": 0, "flag": True, "range": "clamp",
    "empty": "none", "type": "", "wired": "", "outs": "picked,list,batch,count", "uses": "*",
}


def _data(raw):
    """JSON of the `data` widget -> full dict (defaults filled in). Unreadable = all defaults, with a word in the console."""
    try:
        d = json.loads(raw) if isinstance(raw, str) and raw.strip() else {}
    except (json.JSONDecodeError, TypeError):
        print(f"[{TAG}] data JSON unreadable -> defaults")
        d = {}
    return {**DEFAULTS, **(d if isinstance(d, dict) else {})}


def _csv(s):
    return [x.strip() for x in str(s or "").split(",") if x.strip()]


def _wired(d, kw):
    """Sockets in play, top to bottom. The frontend tells which are plugged; without it (API) = the ones in the prompt."""
    w = [n for n in _csv(d.get("wired")) if n in IN_NAMES]
    return sorted(w, key=IN_NAMES.index) if w else [n for n in IN_NAMES if n in kw]


def _uses(d):
    u = _csv(d.get("uses"))
    return {"picked", "list", "batch", "count"} if not u or "*" in u else set(u)


def _norm_index(i, top, mode):
    """Index -> socket number for `picked` (1 = in_1). The index counts from 0 like the Pick Combo (D-214): 0 = the first socket,
    1 = the second... `top` = the highest plugged socket. The sockets in play are the first `top` plus the free one after them
    (index `top`, empty on purpose: it hands out nothing — the way to choose nothing). Positive: clamp (stick to the edge) or wrap
    (go round) over those. Negative counts back from the last PLUGGED socket: -1 = it. Nothing plugged = just socket 1 (empty)."""
    slots = min(len(IN_NAMES), top + 1)
    i = parse_int(i, tag=TAG)
    if i < 0:
        i = top + i
    if mode == "wrap":
        return i % slots + 1
    return max(0, min(slots - 1, i)) + 1


def _nothing(d):
    """What an empty choice hands out. "none": None, which a downstream node with that input OPTIONAL reads as "no cable" (an unplugged
    wire); "block": ExecutionBlocker, the downstream nodes that depend on it quietly do nothing (no error, no run). The cable is
    there or it isn't, darling."""
    if str(d.get("empty") or "none") == "block":
        try:
            try:
                from comfy_execution.graph_utils import ExecutionBlocker      # where ComfyUI keeps it
            except ImportError:
                from comfy_execution.graph import ExecutionBlocker            # older / re-exported
            return ExecutionBlocker(None)
        except Exception:
            print(f"[{TAG}] ExecutionBlocker not available in this ComfyUI: handing out None")
    return None


DOORS = ("index", "flag")       # real widgets since D-226 (their own socket = the EXT door). From / To / Every left with D-227: list = every item


def _arg(d, kw, key):
    """A value a wire can bring: the old `<key>_in` socket of an API prompt from before D-226, then the widget (or the wire on its
    own socket, ComfyUI hands both under the same name), then the old packed `data` key. First come, first served, darling."""
    for v in (kw.get(key + "_in"), kw.get(key)):
        if v is not None:
            return v
    return d.get(key)


def _target(d, kw, wired):
    """Name of the socket `picked` gives, or None (auto: decided in run, among what really arrived).
    Sockets keep their number (D-154): unplug 1 and 2 and the 3 is still the 3 — a hole is a hole, never a promotion."""
    mode = str(d.get("mode") or "index")
    if mode == "bool":
        return IN_NAMES[0] if parse_bool(_arg(d, kw, "flag")) else IN_NAMES[1]
    if mode == "auto":
        return None
    top = IN_NAMES.index(wired[-1]) + 1 if wired else 0
    k = _norm_index(_arg(d, kw, "index"), top, str(d.get("range") or "clamp"))
    return IN_NAMES[k - 1] if k else None


# ---------------- what a value is, and its single items ----------------
def kind_of(v, hint=""):
    hint = str(hint or "").upper()
    if hint:
        return hint
    if isinstance(v, torch.Tensor):
        return "IMAGE" if v.ndim == 4 else "MASK" if v.ndim in (2, 3) else ""
    if isinstance(v, dict):
        return "LATENT" if "samples" in v else "AUDIO" if "waveform" in v else ""
    if isinstance(v, list) and v and isinstance(v[0], (list, tuple)) and len(v[0]) == 2 and isinstance(v[0][1], dict):
        return "CONDITIONING"
    return ""


def _rows(t):
    return t.shape[0] if isinstance(t, torch.Tensor) and t.ndim > 0 else None


def _slice_dict(dd, i, b):
    """A conditioning/latent side dict cut to row i: tensors with the same batch go along, the rest is kept as is."""
    return {k: (v[i:i + 1] if _rows(v) == b else v) for k, v in dd.items()}


def split(v, kind):
    """One input -> its single items (an image batch of 4 = 4 items; a model = 1 item)."""
    if kind in ("IMAGE", "MASK") and isinstance(v, torch.Tensor):
        if v.ndim == 2:
            v = v.unsqueeze(0)
        return [v[i:i + 1] for i in range(v.shape[0])]
    if kind == "LATENT" and isinstance(v, dict) and isinstance(v.get("samples"), torch.Tensor):
        s = v["samples"]
        b = s.shape[0]
        out = []
        for i in range(b):
            it = {"samples": s[i:i + 1]}
            nm = v.get("noise_mask")
            if isinstance(nm, torch.Tensor):
                it["noise_mask"] = nm[i:i + 1] if _rows(nm) == b else nm[:1]
            bi = v.get("batch_index")
            if isinstance(bi, (list, tuple)) and len(bi) == b:
                it["batch_index"] = [bi[i]]
            out.append(it)
        return out
    if kind == "CONDITIONING" and isinstance(v, list) and v:
        b = _rows(v[0][0]) or 1
        return [[[c[0][i:i + 1] if _rows(c[0]) == b else c[0], _slice_dict(c[1], i, b)] for c in v] for i in range(b)]
    if kind == "AUDIO" and isinstance(v, dict) and isinstance(v.get("waveform"), torch.Tensor):
        w = v["waveform"]
        return [{**v, "waveform": w[i:i + 1]} for i in range(w.shape[0])]
    return [v]


# ---------------- gluing items into one batch ----------------
def _target_size(sizes, how):
    """sizes = [(h, w)]: the first, the largest or the smallest (by area)."""
    if how == "largest":
        return max(sizes, key=lambda s: s[0] * s[1])
    if how == "smallest":
        return min(sizes, key=lambda s: s[0] * s[1])
    return sizes[0]


def _fit(x, h, w, fit):
    """x [B,C,H,W] -> [B,C,h,w]. stretch = squash to size · crop = fill and cut the centre · pad = fit inside, black around."""
    if x.shape[-2] == h and x.shape[-1] == w:
        return x
    if fit == "crop":
        return comfy.utils.common_upscale(x, w, h, "bilinear", "center")
    if fit == "pad":
        k = min(w / x.shape[-1], h / x.shape[-2])
        nw, nh = max(1, round(x.shape[-1] * k)), max(1, round(x.shape[-2] * k))
        y = comfy.utils.common_upscale(x, nw, nh, "bilinear", "disabled")
        out = torch.zeros((x.shape[0], x.shape[1], h, w), dtype=x.dtype, device=x.device)
        top, left = (h - nh) // 2, (w - nw) // 2
        out[:, :, top:top + nh, left:left + nw] = y
        return out
    return comfy.utils.common_upscale(x, w, h, "bilinear", "disabled")


def _batch_pixels(items, kind, fit, size):
    if kind == "MASK":
        xs = [(t if t.ndim == 3 else t.unsqueeze(0)).unsqueeze(1) for t in items]            # [B,1,H,W]
    else:
        xs = [t.movedim(-1, 1) for t in items]                                               # [B,C,H,W]
        c = max(x.shape[1] for x in xs)                                                      # RGB + RGBA = RGBA, alpha 1 where missing
        xs = [x if x.shape[1] == c else torch.cat([x, torch.ones_like(x[:, :1]).expand(-1, c - x.shape[1], -1, -1)], 1) for x in xs]
    h, w = _target_size([(x.shape[-2], x.shape[-1]) for x in xs], size)
    dev = xs[0].device
    out = torch.cat([_fit(x.to(dev), h, w, fit) for x in xs], 0)
    return out.squeeze(1) if kind == "MASK" else out.movedim(1, -1)


def _batch_latent(items, fit, size):
    ss = [it["samples"] for it in items]
    if len({s.shape[1] for s in ss}) > 1:
        raise ValueError(f"{TAG}: latents with different channels ({sorted({s.shape[1] for s in ss})}) come from different models and can't share a batch")
    dev = ss[0].device
    if ss[0].ndim == 5:                                                                      # video latents [B,C,T,H,W]
        if len({(s.shape[-2], s.shape[-1]) for s in ss}) > 1:
            raise ValueError(f"{TAG}: video latents of different sizes can't share a batch")
        t = min(s.shape[2] for s in ss)                                                      # the shortest clip sets the length
        return {"samples": torch.cat([s[:, :, :t].to(dev) for s in ss], 0)}
    h, w = _target_size([(s.shape[-2], s.shape[-1]) for s in ss], size)
    out = {"samples": torch.cat([_fit(s.to(dev), h, w, fit) for s in ss], 0)}
    masks = [it.get("noise_mask") for it in items]
    if any(isinstance(m, torch.Tensor) for m in masks):                                      # one has a mask: everybody gets one (all ones = no mask)
        ref = next(m for m in masks if isinstance(m, torch.Tensor))
        mh, mw = ref.shape[-2], ref.shape[-1]
        norm = lambda m: m.reshape(-1, 1, m.shape[-2], m.shape[-1])[:1]
        out["noise_mask"] = torch.cat([_fit(norm(m).to(dev), mh, mw, "stretch") if isinstance(m, torch.Tensor)
                                       else torch.ones((1, 1, mh, mw), device=dev) for m in masks], 0)
    bis = [it.get("batch_index") for it in items]
    if all(isinstance(b, list) for b in bis):
        out["batch_index"] = [x for b in bis for x in b]
    return out


def _lcm_tokens(ts):
    n = 1
    for t in ts:
        n = n * t.shape[1] // math.gcd(n, t.shape[1])
    if n > MAX_TOKENS:
        raise ValueError(f"{TAG}: these conditionings are too different in length to share a batch")
    return [t.repeat(1, n // t.shape[1], 1) if t.shape[1] != n else t for t in ts]


def _batch_cond(items):
    parts = {len(c) for c in items}
    if len(parts) > 1:
        raise ValueError(f"{TAG}: conditionings made of a different number of parts (Conditioning Combine?) can't share a batch")
    out = []
    for j in range(len(items[0])):
        ts = [c[j][0] for c in items]
        if len({t.shape[-1] for t in ts}) > 1:
            raise ValueError(f"{TAG}: conditionings from different text encoders can't share a batch")
        dev = ts[0].device
        cond = torch.cat([t.to(dev) for t in _lcm_tokens(ts)], 0)
        first = items[0][j][1]
        extra = {}
        for k, v in first.items():
            vs = [c[j][1].get(k) for c in items]
            if all(isinstance(x, torch.Tensor) and x.ndim > 0 and x.shape[0] == 1 for x in vs) and len({x.shape[1:] for x in vs}) == 1:
                extra[k] = torch.cat([x.to(dev) for x in vs], 0)
            else:
                extra[k] = v
        out.append([cond, extra])
    return out


def _batch_audio(items):
    rates = {it.get("sample_rate") for it in items}
    if len(rates) > 1:
        raise ValueError(f"{TAG}: audio with different sample rates ({sorted(rates)}) can't share a batch")
    ws = [it["waveform"] for it in items]
    c, n = max(w.shape[1] for w in ws), max(w.shape[-1] for w in ws)
    dev = ws[0].device
    fix = lambda w: torch.nn.functional.pad(w.to(dev).expand(-1, c, -1) if w.shape[1] == 1 else w.to(dev), (0, n - w.shape[-1]))
    return {**items[0], "waveform": torch.cat([fix(w) for w in ws], 0)}


def batch(items, kind, fit="stretch", size="first"):
    """Items -> one batch of `kind`, or None when there's nothing to glue (or the kind doesn't batch)."""
    if not items or kind not in BATCHABLE:
        return None
    if kind in ("IMAGE", "MASK"):
        return _batch_pixels(items, kind, fit, size)
    if kind == "LATENT":
        return _batch_latent(items, fit, size)
    if kind == "CONDITIONING":
        return _batch_cond(items)
    return _batch_audio(items)


class Succy_Any:
    @classmethod
    def INPUT_TYPES(cls):
        # EXT v2 (D-226): index / flag / From / To / Every are real widgets (hidden, drawn by the frontend); a wire on their own socket
        # is the EXT door. index / flag come FIRST (D-214): the door that chooses sits on top of what it chooses from. Optional: an API prompt that doesn't name them still validates (the old `data` keys count).
        optional = {"index": ("INT", {"default": 0, "min": -9999, "max": 9999}), "flag": ("BOOLEAN", {"default": True})}
        optional.update({n: (ANY, {"lazy": True, "forceInput": True}) for n in IN_NAMES})
        return {"required": {"data": ("STRING", {"default": ""})}, "optional": optional, "hidden": {"unique_id": "UNIQUE_ID"}}

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    RETURN_TYPES = (ANY, ANY, ANY, "INT")
    RETURN_NAMES = ("picked", "list", "batch", "count")
    # `list` stays at position 1 whatever happens (the frontend drops `batch` only, after it): ComfyUI reads this by position
    OUTPUT_IS_LIST = (False, True, False, False)
    FUNCTION = "run"
    SUCCY_CACHE = "route"  # SmartCache (D-213): `picked` hands an input out untouched: consumers go straight to it
    CATEGORY = "Succy Pack"

    def check_lazy_status(self, data="", **kw):
        """Ask ComfyUI only for what an output in use really needs: one socket for `picked`, all of them for list/batch/count."""
        d = _data(data)
        wired = _wired(d, kw)
        present = [n for n in wired if n in kw]                            # muted / bypassed upstream = not in the prompt at all
        if _uses(d) & {"list", "batch", "count"}:
            return [n for n in present if kw.get(n) is None]
        t = _target(d, kw, wired) if str(d.get("mode")) != "auto" else (present[0] if present else None)
        return [t] if t in present and kw.get(t) is None else []

    def run(self, data="", unique_id=None, **kw):
        d = _data(data)
        uses = _uses(d)
        wired = _wired(d, kw)
        present = [n for n in wired if n in kw]
        if str(d.get("mode")) == "auto":
            name = next((n for n in present if kw.get(n) is not None), None)
        else:
            name = _target(d, kw, wired)
        picked = kw.get(name) if name else None
        if picked is None:                                 # a hole, the free socket, a muted branch: no value, and that is a feature (D-170)
            picked = _nothing(d)

        items, count, glued = [], 0, None
        kind = ""
        if uses & {"list", "batch", "count"}:
            vals = [kw[n] for n in present if kw.get(n) is not None]
            kind = kind_of(vals[0] if vals else None, d.get("type"))
            items = [it for v in vals for it in split(v, kind)]     # every item, in order (D-227: no From / To / Every)
            count = len(items)
            if "batch" in uses:
                glued = batch(items, kind)

        if unique_id is not None:                          # what the live view falls back to for a wire only a Run fills
            _keep(unique_id, {k: v for k, v in kw.items() if k in IN_NAMES or k in DOORS or k.endswith("_in")})
            live_touch()

        # outputs follow the frontend's layout (batch may be gone, then count slides into its place)
        by = {"picked": picked, "list": items if "list" in uses else [], "batch": glued, "count": count}
        layout = [o for o in _csv(d.get("outs")) if o in by] or ["picked", "list", "batch", "count"]
        result = tuple(by[o] for o in layout) + (None,) * (4 - len(layout))
        ui = {"picked": [IN_NAMES.index(name) + 1 if name in IN_NAMES else 0], "count": [count]}
        return {"ui": ui, "result": result}

    @classmethod
    def succy_cache_route(cls, kw, linked):
        """SmartCache (D-213, route): which input `picked` hands out untouched, when the settings alone tell — index / bool written
        on the node or wired from a node already precomputed (a Pick Combo's index). kw = the values known before the Run, linked =
        the wired inputs. Auto (decided by what arrives), an EXT wire nobody knows yet, a hole, or Empty = Block (a None from upstream
        would become a blocker here) -> None: the switch stays in the prompt as it is. Same _target() as run(): one way to choose."""
        d = _data(kw.get("data", ""))
        mode = str(d.get("mode") or "index")
        if mode == "auto" or str(d.get("empty") or "none") != "none":
            return None
        ext = "flag" if mode == "bool" else "index"
        if any(e in linked and e not in kw for e in (ext, ext.replace("flag", "bool") + "_in")):
            return None
        name = _target(d, kw, _wired(d, {n: True for n in linked}))
        layout = [o for o in _csv(d.get("outs")) if o in ("picked", "list", "batch", "count")] or ["picked", "list", "batch", "count"]
        if name is None or name not in linked or "picked" not in layout:
            return None
        return {"routes": {layout.index("picked"): name}, "ui": {"picked": [IN_NAMES.index(name) + 1]}}

    # ---- LIVE (D-172): picked / batch as they are NOW, from the live wires (or the last Run's), no Queue ----
    SUCCY_LIVE = ("picked", "batch")

    @classmethod
    def succy_live(cls, widgets, inputs, node_id):
        w = coerce_widgets(cls, widgets)
        d = _data(w.get("data", ""))
        last = _LAST.get(node_id) or {}
        wired = [n for n in _csv(d.get("wired")) if n in IN_NAMES]
        vals, missing = {}, []
        for n in wired:
            if not inputs.linked(n):                       # unplugged, or a live source that gives nothing: a hole
                continue
            v = inputs.get(n)
            if v is None:
                v = last.get(n)
            if v is None:
                missing.append(n)
            else:
                vals[n] = v
        # the rings (D-228, the kit's one reader): now, else the last Run's; a wire nobody can read yet is not a 0, it is `unknown`
        rings, unknown = door_values({n: w[n] for n in DOORS if n in w}, inputs, last, [(n, (n, n + "_in"), (n, n + "_in")) for n in DOORS], "the Any", wait=False)
        vals.update({n: v for n, v in rings.items() if n not in unknown})
        mode = str(d.get("mode") or "index")
        if (mode == "index" and "index" in unknown) or (mode == "bool" and "flag" in unknown):
            raise LiveWait("run", "the Any's choice comes from a wire that only a Run fills: Run once so it gets there")
        outs = {}
        have = [n for n in wired if n in vals]
        if mode == "auto":
            name = next(iter(have), None)
        else:
            name = _target(d, vals, wired)
        if name in vals:
            outs["picked"] = vals[name]
        elif name is None or name not in wired or not inputs.linked(name):
            outs["_empty"] = ["picked"]                     # the choice is a hole: as good as no wire at all
        if not missing and have:
            try:
                kind = kind_of(vals[have[0]], d.get("type"))
                if kind in ("IMAGE", "MASK"):               # only pictures travel live
                    items = [it for n in have for it in split(vals[n], kind)]
                    if items:
                        outs["batch"] = batch(items, kind)
            except Exception as exc:
                print(f"[{TAG}] live batch skipped: {exc}")
        if "picked" not in outs and "_empty" not in outs:
            raise LiveWait("run", "the Any's choice comes from a wire that only a Run fills: Run once so it gets there")
        return outs


_LAST = collections.OrderedDict()
_LAST_MAX = 12


def _keep(key, value):
    """What the last Run got, per node (the live view falls back on it); past _LAST_MAX nodes the oldest goes."""
    _LAST.pop(key, None)
    _LAST[key] = value
    while len(_LAST) > _LAST_MAX:
        _LAST.popitem(last=False)
