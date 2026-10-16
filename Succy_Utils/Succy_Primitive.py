import json

import torch
import comfy.model_management

from _succy_common import ANY, convert_text, parse_bool, parse_float, parse_int   # the shared drawer (loaded once by __init__.py)

# ====================================================================== #
#  Succy_Primitive — "the ultimate madafacca primitive"                   #
#  Born small and undecided: you pick what she becomes (INT, FLOAT,       #
#  SEED, BOOL, TEXT, MULTILINE, LIST, COLOR, RESOLUTION, IMAGE, MASK,     #
#  LATENT, or a COMBO copied from the widget you wire her to), and she    #
#  stays that, no going back. A real node: subgraphs and API love her.    #
#  Everything the UI sets arrives packed in ONE hidden widget `data`      #
#  (JSON, only what differs from the default). `seed` is a real widget    #
#  so ComfyUI's own control_after_generate rolls it before/after a run.   #
#  Outputs (LIVE order, the frontend shows only the ones the kind uses):  #
#     value · value2 · value3 · value4                                    #
# ====================================================================== #

KINDS = ("INT", "FLOAT", "SEED", "BOOL", "TEXT", "MULTILINE", "COMBO", "LIST", "COLOR", "RESOLUTION", "IMAGE", "MASK", "LATENT")
SIZE_KINDS = ("RESOLUTION", "IMAGE", "MASK", "LATENT")
MAX_SIDE = 16384
MAX_BATCH = 64
MAX_DEC = 6                 # same ceiling as the frontend slider (past 6 its step turns into 1e-7)
SEED_MAX = 0xFFFFFFFFFFFFFFFF
LATENT_CHANNELS = {"sd": 4, "sd3": 16}
TAG = "Succy Primitive"

# same defaults as the frontend (dev/src/Succy_Primitive.js, packed defaults): a missing key means "untouched"
DEFAULTS = {
    "kind": "", "int_v": 0, "float_v": 0.0, "precise": False, "decimals": 4, "bool_v": True, "text_v": "",
    "ml_v": "", "trim": True, "ml_out": "STRING", "combo_v": "", "list_v": "",
    "color_v": "#ff4fa3ff", "w": 1024, "h": 1024, "mult": 8, "scale": 1.0, "batch": 1, "fill": "#000000",
    "mask_v": 1.0, "latent_family": "sd",
}


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
    """Width / height times Scale, snapped to the chosen multiple, never under one step nor over MAX_SIDE."""
    m = max(1, min(256, parse_int(d.get("mult"), tag=TAG) or 8))
    k = max(0.01, min(16.0, parse_float(d.get("scale"), tag=TAG) or 1.0)) if scaled else 1.0
    def snap(v):
        v = max(1, min(MAX_SIDE, parse_float(v, tag=TAG) * k))
        return max(m, min(MAX_SIDE // m * m, int(round(v / m)) * m))
    return snap(d.get("w")), snap(d.get("h"))


def _mp(w, h):
    return round(w * h / 1e6, 4)


def _list_items(d):
    """LIST kind: the text read the pack's one LIST way (a [literal] is used as is, otherwise one item per non-empty line)."""
    return convert_text(d.get("list_v") or "", "LIST", tag=TAG)


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
        text = str(d["ml_v"] or "")
        if parse_bool(d["trim"]):
            text = text.strip()
        return convert_text(text, d["ml_out"], tag=TAG), None, None, None
    if kind == "COMBO":
        return str(d["combo_v"] or ""), None, None, None
    if kind == "LIST":
        items = _list_items(d)
        return items, len(items), None, None
    if kind == "COLOR":
        return str(d["color_v"] or "#000000ff"), None, None, None
    if kind in SIZE_KINDS:
        w, h = _size(d, scaled=kind != "LATENT")
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
        }

    RETURN_TYPES = (ANY, ANY, ANY, ANY)
    RETURN_NAMES = ("value", "value2", "value3", "value4")
    FUNCTION = "run"
    CATEGORY = "Succy Pack"

    def run(self, data="", seed=0, **kwargs):
        d = _data(data)
        out = _value(d, seed)
        if d.get("kind") == "SEED":
            return {"ui": {"seed": [out[0]]}, "result": out}
        return out

