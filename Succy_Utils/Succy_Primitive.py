import json
import math
import re

import torch
import comfy.model_management

from _succy_common import ANY, LiveWait, coerce_widgets, convert_text, door_values, parse_bool, parse_float, parse_int   # the shared drawer (loaded once by __init__.py)

# ====================================================================== #
#  Succy_Primitive — "the ultimate madafacca primitive"                   #
#  Born small and undecided: you pick what she becomes (INT, FLOAT,       #
#  SEED, BOOL, TEXT, MULTILINE, LIST, COLOR, RESOLUTION, IMAGE, MASK,     #
#  LATENT, or a COMBO copied from the widget you wire her to), and she    #
#  stays that, no going back. A real node: subgraphs and API love her.    #
#  The settings arrive packed in ONE hidden widget `data` (JSON, only     #
#  what differs from the default). The VALUES are real widgets (D-226):   #
#  a wire on a value's own socket makes her a bridge. `seed` is real too, #
#  so ComfyUI's own control_after_generate rolls it before/after a run.   #
#  Outputs (LIVE order, the frontend shows only the ones the kind uses):  #
#     value · value2 · value3 · value4                                    #
# ====================================================================== #

KINDS = ("INT", "FLOAT", "SEED", "BOOL", "TEXT", "MULTILINE", "COMBO", "LIST", "COLOR", "RESOLUTION", "IMAGE", "MASK", "LATENT")
SIZE_KINDS = ("RESOLUTION", "IMAGE", "MASK", "LATENT")
MAX_SIDE = 16384
MAX_BATCH = 64
MAX_MP = 64                 # the megapixels buttons stop at 8, a wire may bring more; past this the side cap bites anyway
LIST_FORMATS = ("STRINGS", "NUMBERS")
MAX_DEC = 6                 # same ceiling as the frontend slider (past 6 its step turns into 1e-7)
SEED_MAX = 0xFFFFFFFFFFFFFFFF
LATENT_CHANNELS = {"sd": 4, "sd3": 16}
TAG = "Succy Primitive"

# same defaults as the frontend (dev/src/Succy_Primitive.js, packed defaults): a missing key means "untouched"
DEFAULTS = {
    "kind": "", "int_v": 0, "float_v": 0.0, "precise": False, "decimals": 4, "bool_v": True, "text_v": "",
    "ml_v": "", "trim": True, "ml_out": "STRING", "combo_v": "", "list_v": "",
    "color_v": "#ff4fa3ff", "w": 1024, "h": 1024, "mult": 8, "scale": 1.0, "batch": 1, "fill": "#000000",
    "mask_v": 1.0, "latent_family": "sd", "swap": False, "list_fmt": "STRINGS",
}


BIG = 9007199254740991       # the browser's last exact integer (Number.MAX_SAFE_INTEGER)
# the VALUES are real widgets since D-226 (their own socket = the EXT door). Same defaults as the frontend (VALS); optional, so an API
# prompt written before them still validates and its packed `data` keys count.
VALUES = {
    "int_v": ("INT", {"default": 0, "min": -BIG, "max": BIG}),
    "float_v": ("FLOAT", {"default": 0.0, "min": -1e15, "max": 1e15, "step": 0.000001, "round": False}),
    "bool_v": ("BOOLEAN", {"default": True}),
    "text_v": ("STRING", {"default": ""}),
    "ml_v": ("STRING", {"default": "", "multiline": True}),
    "combo_v": ("STRING", {"default": ""}),
    "list_v": ("STRING", {"default": "", "multiline": True}),
    "color_v": ("STRING", {"default": "#ff4fa3ff"}),
    "w": ("INT", {"default": 1024, "min": 1, "max": MAX_SIDE}),
    "h": ("INT", {"default": 1024, "min": 1, "max": MAX_SIDE}),
    "scale": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 16.0, "step": 0.01}),
    "batch": ("INT", {"default": 1, "min": 1, "max": MAX_BATCH}),
    "fill": ("STRING", {"default": "#000000"}),
    "mask_v": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
    "mp": ("INT", {"default": 0, "min": 0, "max": MAX_MP}),     # D-247: megapixels (whole), 0 = off: the W x H shape, resized to that area
    "mult": ("INT", {"default": 8, "min": 1, "max": 256}),   # D-249: Multiple of, a real widget (its own dot)
}


def _merge(d, kw):
    """The packed settings + the values from their own widgets (or the wires on them). A widget beats an old packed key."""
    return {**d, **{k: kw[k] for k in VALUES if kw.get(k) is not None}}


def _data(raw):
    """JSON of the `data` widget -> full dict (defaults filled in). Unreadable = all defaults, with a word in the console."""
    try:
        d = json.loads(raw) if isinstance(raw, str) and raw.strip() else {}
    except (json.JSONDecodeError, TypeError):
        print(f"[{TAG}] data JSON unreadable -> defaults")
        d = {}
    if not isinstance(d, dict):
        d = {}
    return {**DEFAULTS, **d}


def _hex_rgb(s, fallback=(0, 0, 0)):
    s = str(s or "").strip().lstrip("#")
    if len(s) in (6, 8):
        try:
            return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return fallback


def _size(d, scaled=True):
    """Width / height (swapped while Swap is on, wires included), then the Megapixels area if one is set (same shape, that many
    pixels), times Scale, snapped to the chosen multiple, never under one step nor over MAX_SIDE (D-247)."""
    m = max(1, min(256, parse_int(d.get("mult"), tag=TAG) or 8))
    k = max(0.01, min(16.0, parse_float(d.get("scale"), tag=TAG) or 1.0)) if scaled else 1.0
    w, h = max(1.0, parse_float(d.get("w"), tag=TAG)), max(1.0, parse_float(d.get("h"), tag=TAG))
    if parse_bool(d.get("swap")):
        w, h = h, w
    mp = max(0, min(MAX_MP, parse_int(d.get("mp"), tag=TAG)))
    if mp:
        r = math.sqrt(mp * 1e6 / (w * h))
        w, h = w * r, h * r
    def snap(v):
        v = max(1, min(MAX_SIDE, v * k))
        return max(m, min(MAX_SIDE // m * m, int(round(v / m)) * m))
    return snap(w), snap(h)


def _mp(w, h):
    return round(w * h / 1e6, 4)


_INT_RE = re.compile(r"^[+-]?\d+$")


def _as_number(x):
    """One item as a number: whole = int, with decimals / exponent = float. Not a number = it stays as typed, with a word in the console."""
    if isinstance(x, bool):
        return int(x)
    if isinstance(x, (int, float)):
        return x
    s = str(x).strip()
    try:
        if _INT_RE.match(s):
            return int(s)
        f = float(s)
        if math.isfinite(f):
            return f
    except ValueError:
        pass
    print(f"[{TAG}] list item {s!r} is not a number -> kept as text")
    return x


def _list_items(d):
    """LIST kind: the text read the pack's one LIST way (a [literal] is used as is, otherwise one item per non-empty line), then
    every item written the picked way (D-247): List of Strings = all text, List of Numbers = all numbers. The output is a LIST either way."""
    v = d.get("list_v")
    if isinstance(v, (list, tuple)):                  # a wire brought a real list (a bridge): it goes on as it is
        return list(v)
    items = convert_text(v or "", "LIST", tag=TAG)
    if str(d.get("list_fmt") or "STRINGS").upper() == "NUMBERS":
        return [_as_number(x) for x in items]
    return [x if isinstance(x, str) else str(x) for x in items]


def _value(d, seed):
    """-> (value, value2, value3, value4) for the chosen kind, in the order the frontend shows them."""
    kind = str(d.get("kind") or "")
    if kind == "INT":
        return parse_int(d["int_v"], tag=TAG), None, None, None
    if kind == "FLOAT":
        dec = max(0, min(MAX_DEC, parse_int(d["decimals"]))) if parse_bool(d["precise"]) else 2
        return round(parse_float(d["float_v"], tag=TAG), dec), None, None, None
    if kind == "SEED":
        return max(0, min(SEED_MAX, parse_int(seed))), None, None, None
    if kind == "BOOL":
        return parse_bool(d["bool_v"]), None, None, None
    if kind == "TEXT":
        return str(d["text_v"] or ""), None, None, None
    if kind == "MULTILINE":
        text = d["ml_v"]
        if not isinstance(text, str):                 # a bridge: a wire brought something already made, it goes on as it is
            return text, None, None, None
        text = text or ""
        if parse_bool(d["trim"]):
            text = text.strip()
        return convert_text(text, d["ml_out"], tag=TAG), None, None, None
    if kind == "COMBO":
        v = d["combo_v"]
        return (v if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v or "")), None, None, None
    if kind == "LIST":
        items = _list_items(d)
        return items, len(items), None, None
    if kind == "COLOR":
        return str(d["color_v"] or "#000000ff"), None, None, None
    if kind in SIZE_KINDS:
        w, h = _size(d)
        if kind == "RESOLUTION":
            return w, h, _mp(w, h), None
        batch = max(1, min(MAX_BATCH, parse_int(d["batch"])))
        if kind == "IMAGE":
            r, g, b = _hex_rgb(d["fill"])
            img = torch.empty((batch, h, w, 3), dtype=torch.float32)
            img[..., 0], img[..., 1], img[..., 2] = r / 255.0, g / 255.0, b / 255.0
            return img, w, h, _mp(w, h)
        if kind == "MASK":
            v = max(0.0, min(1.0, parse_float(d["mask_v"])))
            return torch.full((batch, h, w), v, dtype=torch.float32), w, h, _mp(w, h)
        ch = LATENT_CHANNELS.get(str(d["latent_family"]), 4)
        lat = torch.zeros([batch, ch, h // 8, w // 8], device=comfy.model_management.intermediate_device())
        return {"samples": lat}, w, h, None
    # still undecided: nothing to give yet
    return None, None, None, None


class Succy_Primitive:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "data": ("STRING", {"default": ""}),
                # real widget: ComfyUI adds its own control_after_generate next to it (the frontend keeps it on "fixed" unless kind = SEED)
                "seed": ("INT", {"default": 0, "min": 0, "max": SEED_MAX, "control_after_generate": True}),
            },
            "optional": dict(VALUES),
        }

    @classmethod
    def VALIDATE_INPUTS(cls, input_types=None, **kwargs):
        # `input_types` named here = ComfyUI skips its type check: Combo's door is "*" (a sampler list, a STRING, an INT...) (D-226)
        return True

    RETURN_TYPES = (ANY, ANY, ANY, ANY)
    RETURN_NAMES = ("value", "value2", "value3", "value4")
    FUNCTION = "run"
    SUCCY_CACHE = "pure"  # SmartCache (D-213): values precomputed; pictures and masks are left to ComfyUI (succy_cache_pure)

    @classmethod
    def succy_cache_pure(cls, kw):
        """SmartCache asks before precomputing: a picture or a mask is heavy and has no exact text form, so ComfyUI keeps those."""
        return str(_merge(_data(kw.get("data", "")), kw).get("kind") or "") not in ("IMAGE", "MASK")
    CATEGORY = "Succy Pack"

    def run(self, data="", seed=0, **kwargs):
        d = _merge(_data(data), kwargs)
        out = _value(d, seed)
        if d.get("kind") == "SEED":
            return {"ui": {"seed": [out[0]]}, "result": out}
        return out

    # ---- LIVE (D-172): the picture / mask she makes, as it is NOW, without a Queue (IMAGE and MASK kinds; the rest has no picture to show) ----
    SUCCY_LIVE = ("value",)

    @classmethod
    def succy_live(cls, widgets, inputs, node_id):
        # her values on a wire (D-228, the kit's one reader): live from a Succy source, else "Run once" (she keeps no last Run)
        widgets, _ = door_values(widgets, inputs, {}, [(k, (k,), ()) for k in VALUES], "the Primitive")
        w = coerce_widgets(cls, widgets)
        d = _merge(_data(w.get("data", "")), w)
        if str(d.get("kind") or "") not in ("IMAGE", "MASK"):
            raise LiveWait("run", "the Primitive is not a picture or a mask")
        with torch.inference_mode():
            return {"value": _value(d, w.get("seed", 0))[0]}

