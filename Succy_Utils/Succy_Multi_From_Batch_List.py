import torch

from _succy_common import ANY, parse_int   # the shared drawer (loaded once by __init__.py)

# ===================================================
# Succy Multi From Batch/List (D-319)
#
# A few items out of every batch or list you plug, all with the SAME Index and Length: in_1 -> out_1, in_2 -> out_2...
# Index counts from 0 (0 = the first item, D-323: like the Loop's iteration_index, the Any and ComfyUI's batch_index), Length = how many from there. A batch stays a batch (a slice of it), a list stays a
# list (the items picked, untouched); Length 1 = one item. Past the end = clamped: there is always at least one item out.
# What a batch is: IMAGE [B,H,W,C], MASK [B,H,W], LATENT (samples + noise_mask + batch_index), AUDIO (waveform [B,C,T]),
# CONDITIONING (every prompt tensor and its pooled output), and a LIST value (one value that is a list: numbers, text).
# Anything else (a model, a string...) is ONE item: it goes through as it is.
# INPUT_IS_LIST: a batch arrives as a list of one, a ComfyUI list as many; every output is a list (a list of one = a single value).
# The frontend types each out_N like its in_N (Succy_Multi_From_Batch_List.js). Node names live ONLY in __init__.py (D-95).
# She takes only what you ask for: from where you say, as much as you say, never a crumb more.
# ===================================================

_TAG = "[Succy Multi From Batch/List]"
MAX_INPUTS = 16                                         # same as MAX_IN in the JS
IN_NAMES = [f"in_{i + 1}" for i in range(MAX_INPUTS)]
OUT_NAMES = tuple(f"out_{i + 1}" for i in range(MAX_INPUTS))


def window(n, index, length):
    """n items, Index from 0, Length -> (start, stop) clamped: never empty, never past the end.
    D-323: it counted from 1 and read 0 as 1 — a Loop's index (0, 1, 2...) took the first item twice and never the last one."""
    if n <= 0:
        return 0, 0
    a = min(max(0, int(index)), n - 1)
    return a, min(n, a + max(1, int(length)))


def _cut(t, a, b, B):
    """A tensor's batch slice when its first side is the batch (B items), else the tensor as it is."""
    return t[a:b] if isinstance(t, torch.Tensor) and t.dim() >= 1 and int(t.shape[0]) == B else t


def _is_cond(v):
    return isinstance(v, list) and len(v) > 0 and all(isinstance(c, (list, tuple)) and len(c) == 2 and isinstance(c[0], torch.Tensor)
                                                      and isinstance(c[1], dict) for c in v)


def batch_size(v):
    """How many items ONE value holds as a batch, or None when it is not a batch (one item)."""
    if isinstance(v, torch.Tensor):
        return int(v.shape[0]) if v.dim() >= 3 else None              # a 2D mask [H,W] = one picture
    if isinstance(v, dict) and isinstance(v.get("samples"), torch.Tensor):
        return int(v["samples"].shape[0])
    if isinstance(v, dict) and isinstance(v.get("waveform"), torch.Tensor) and v["waveform"].dim() == 3:
        return int(v["waveform"].shape[0])
    if _is_cond(v):
        return int(v[0][0].shape[0])
    if isinstance(v, (list, tuple)):
        return len(v)
    return None


def cut_batch(v, a, b):
    """ONE batch value -> its items a..b-1, same kind of value."""
    n = batch_size(v)
    if isinstance(v, torch.Tensor):
        return v[a:b]
    if isinstance(v, dict) and "samples" in v:
        out = dict(v)
        out["samples"] = v["samples"][a:b]
        if isinstance(v.get("noise_mask"), torch.Tensor):
            out["noise_mask"] = _cut(v["noise_mask"], a, b, n)
        if isinstance(v.get("batch_index"), list) and len(v["batch_index"]) == n:
            out["batch_index"] = v["batch_index"][a:b]
        return out
    if isinstance(v, dict) and "waveform" in v:
        return dict(v, waveform=v["waveform"][a:b])
    if _is_cond(v):
        out = []
        for t, d in v:
            d2 = {k: _cut(x, a, b, n) for k, x in d.items()}
            out.append([_cut(t, a, b, n), d2])
        return out
    return list(v)[a:b] if isinstance(v, (list, tuple)) else v


def pick(values, index, length):
    """What one input brought (a list, INPUT_IS_LIST) -> (what goes out: a list, how many items there were, how many went out).
    Several items = a ComfyUI list: the items picked. One item = its batch, if it has one: the slice. Otherwise it goes through."""
    if not isinstance(values, list) or not values:
        return [], 0, 0
    if len(values) > 1:
        a, b = window(len(values), index, length)
        return values[a:b], len(values), b - a
    n = batch_size(values[0])
    if n is None:
        return list(values), 1, 1
    a, b = window(n, index, length)
    return [cut_batch(values[0], a, b)], n, b - a


class Succy_Multi_From_Batch_List:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "index": ("INT", {"default": 0, "min": 0, "max": 99999, "tooltip": "The first item to take, counted from 0 (0 = the first one), like a Loop's iteration_index"}),
                "length": ("INT", {"default": 1, "min": 1, "max": 99999, "tooltip": "How many items from Index on (1 = one item)"}),
            },
            "optional": {n: (ANY, {"forceInput": True, "tooltip": "A batch or a list: out with the same number gives the items picked"}) for n in IN_NAMES},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True                                     # "*" sockets: the frontend types them, the backend takes anything

    RETURN_TYPES = (ANY,) * MAX_INPUTS
    RETURN_NAMES = OUT_NAMES
    OUTPUT_IS_LIST = (True,) * MAX_INPUTS
    OUTPUT_TOOLTIPS = tuple(f"The items picked from in_{i + 1}: a batch stays a batch, a list stays a list" for i in range(MAX_INPUTS))
    INPUT_IS_LIST = True
    FUNCTION = "run"
    SUCCY_CACHE = "none"  # SmartCache (D-213): a slice of what came in, nothing to precompute or remember
    CATEGORY = "Succy Pack"

    def run(self, index=(0,), length=(1,), unique_id=None, **kw):
        first = lambda v, d: (v[0] if v else d) if isinstance(v, list) else (d if v is None else v)
        i, n = parse_int(first(index, 0)), parse_int(first(length, 1))   # garbage = 0: the first item, length 1
        outs, said = [], []
        for k, name in enumerate(IN_NAMES):
            got = kw.get(name)
            if got is None:
                outs.append([None])                     # an unplugged input: an empty output (nobody should be wired to it)
                continue
            items, total, took = pick(got if isinstance(got, list) else [got], i, n)
            outs.append(items if items else [None])
            said.append(f"{k + 1}: {took} of {total}")
        return {"ui": {"succy_taken": [" · ".join(said)]}, "result": tuple(outs)}
