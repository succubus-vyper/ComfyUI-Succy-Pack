import ast
import json
import os
import random

import folder_paths
import numpy as np
import torch
from PIL import Image


class AnyType(str):
    """Legacy ComfyUI trick: behaves like '*' for the type-checker. A master of disguise."""
    def __ne__(self, __value):
        return False


ANY = AnyType("*")

_UI_CONTAINER_TYPES = ("JSON", "DICT", "LIST", "ARRAY")
_UI_LIST_TYPES = ("LIST", "ARRAY")
_UI_DICT_TYPES = ("JSON", "DICT")
_OUTPUT_TYPES = ["STRING", "INT", "FLOAT", "BOOLEAN",
                 "LIST", "DICT", "ARRAY", "JSON", "COMBO",
                 "IMAGE", "MASK"]


# ------------------------------------------------------------------ #
#  Parser helpers (module-level, no state)                           #
# ------------------------------------------------------------------ #
def _parse_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("true", "1", "yes", "on", "y", "t"):
            return True
        if v in ("false", "0", "no", "off", "n", "f", ""):
            return False
    return bool(value)


def _unwrap_scalar(value):
    """Tensor/array/list with a single element -> the single element."""
    if isinstance(value, torch.Tensor) and value.numel() == 1:
        return value.item()
    if isinstance(value, np.ndarray) and value.size == 1:
        return value.item()
    if isinstance(value, (list, tuple)) and len(value) == 1:
        return _unwrap_scalar(value[0])
    return value


def _to_text(value) -> str:
    """Readable text: dict/list as JSON (UTF-8, never crashes on tensors/objects)."""
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, indent=2, ensure_ascii=False, default=str)
    return str(value)


def _parse_int(value) -> int:
    value = _unwrap_scalar(value)
    try:
        return int(round(float(value)))
    except (ValueError, TypeError):
        if isinstance(value, str):
            return 1 if value.strip() else 0
        return 1 if value else 0


def _parse_float(value) -> float:
    value = _unwrap_scalar(value)
    try:
        return float(value)
    except (ValueError, TypeError):
        if isinstance(value, str):
            return 1.0 if value.strip() else 0.0
        return 1.0 if value else 0.0


def _coerce_container(value, output_type):
    """Fits `value` into the requested container (list/dict)."""
    if output_type in _UI_LIST_TYPES:
        if isinstance(value, tuple):
            return list(value)
        return value if isinstance(value, list) else [value]
    if output_type in _UI_DICT_TYPES:
        return value if isinstance(value, dict) else {"value": value}
    return value


def _parse_json_or_literal(source: str, output_type):
    """Pure JSON → Python literal → single-quoted JSON → multiline fallback."""
    if not source.strip():
        return [] if output_type in _UI_LIST_TYPES else {}

    # 1) Valid JSON as is (don't touch the apostrophes inside strings!)
    try:
        return _coerce_container(json.loads(source), output_type)
    except json.JSONDecodeError:
        pass

    # 2) Python literal: {'a': 1}, [1, 2], (1, 2), True/None...
    try:
        parsed = ast.literal_eval(source)
        if isinstance(parsed, tuple):
            parsed = list(parsed)
        return _coerce_container(parsed, output_type)
    except (ValueError, SyntaxError):
        pass

    # 3) Last attempt: "dirty" JSON with single quotes (e.g. {'a': true}) — we don't judge
    try:
        return _coerce_container(json.loads(source.replace("'", '"')), output_type)
    except json.JSONDecodeError:
        pass

    if output_type in _UI_LIST_TYPES:
        lines = [line.strip() for line in source.split("\n") if line.strip()]
        return lines if len(lines) > 1 else [source]
    if output_type in _UI_DICT_TYPES:
        return {"value": source}
    return source


# ------------------------------------------------------------------ #
#  Node                                                              #
# ------------------------------------------------------------------ #
class Succy_Preview_Anything_Convert:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preview": ("BOOLEAN", {
                    "default": True,
                    "label_on": "On",
                    "label_off": "Off",
                }),
                "source": (ANY, {"tooltip": "Attach anything here."}),
                "output_type": (_OUTPUT_TYPES, {"default": "STRING"}),
                # only meaningful with output_type MASK: flips the mask (1 - m). The frontend shows it as the INVERT button.
                "invert_mask": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = (ANY, "INT", "INT", "FLOAT")
    RETURN_NAMES = ("output", "width", "height", "megapixels")
    FUNCTION = "execute"
    OUTPUT_NODE = True

    # -------------------------------------------------------------- #
    def execute(self, preview, source, output_type, invert_mask=False):
        converted = source
        width = height = 0
        megapixels = 0.0
        info_string = ""
        text_output = ""
        ui_images = []

        if source is None:
            return {
                "ui": {"succy_text": ["No input detected."]},
                "result": (converted, width, height, megapixels),
            }

        # ---------- IMAGE / MASK ----------
        if output_type in ("IMAGE", "MASK"):
            if not isinstance(source, torch.Tensor):
                text_output = "Warning: Input is not a valid Tensor."
                info_string = text_output
            else:
                if source.dim() == 2:           # single mask [H, W] -> [1, H, W]
                    source = source.unsqueeze(0)
                shape = source.shape
                dims = len(shape)
                is_mask = dims == 3
                is_image = dims == 4

                if is_mask:
                    batch, height, width = shape
                    channels = 1
                elif is_image:
                    batch, height, width, channels = shape
                else:
                    batch = 1
                    height = width = channels = 0

                val_min = float(torch.min(source))
                val_max = float(torch.max(source))
                megapixels = (width * height) / 1_000_000.0

                info_string = (
                    f"Type: {'MASK' if is_mask else 'IMAGE'}\n"
                    f"Batch: {batch}\n"
                    f"Resolution: {width} x {height}\n"
                    f"Channels: {channels}\n"
                    f"Megapixels: {megapixels:.4f}\n"
                    f"Min Val: {val_min:.3f}\n"
                    f"Max Val: {val_max:.3f}"
                )
                text_output = info_string

                # Tensor conversion
                if is_image and output_type == "MASK":
                    converted = source[:, :, :, 0]
                elif is_mask and output_type == "IMAGE":
                    converted = (
                        source
                        .reshape((-1, 1, source.shape[-2], source.shape[-1]))
                        .movedim(1, -1)
                        .expand(-1, -1, -1, 3)
                    )
                else:
                    converted = source

                # MASK + INVERT: white <-> black. Done on the converted mask, so image -> mask -> invert works in one go.
                invert_shown = bool(invert_mask) and output_type == "MASK"
                if invert_shown:
                    converted = 1.0 - converted

                # PNG preview (always saved, even with preview OFF) — we keep a souvenir
                try:
                    temp_dir = folder_paths.get_temp_directory()
                    filename = f"succy_preview_{random.randint(0, 99999999)}.png"
                    file_path = os.path.join(temp_dir, filename)

                    shown = converted if invert_shown else source      # inverted mask: preview what comes out
                    arr = shown[0].cpu().numpy()
                    arr = np.clip(255.0 * arr, 0, 255).astype(np.uint8)
                    if shown.dim() == 3:
                        pil_img = Image.fromarray(arr, mode="L")
                    else:
                        # handles grayscale (1 channel) and RGBA (4 channels): the alpha is KEPT (D-106: a Crop cutout
                        # previewed as RGB looked uncut). Anything wider than 4 channels keeps its first 3.
                        if arr.shape[-1] == 1:
                            arr = np.repeat(arr, 3, axis=-1)
                        elif arr.shape[-1] > 4:
                            arr = arr[..., :3]
                        pil_img = Image.fromarray(arr, mode="RGBA" if arr.shape[-1] == 4 else "RGB")
                    pil_img.save(file_path, compress_level=4)

                    ui_images = [{
                        "filename": filename,
                        "subfolder": "",
                        "type": "temp",
                    }]
                except Exception as e:
                    print(f"[PreviewAny] Image preview error: {e}")

        # ---------- TEXT ----------
        else:
            try:
                if output_type in ("STRING", "COMBO"):
                    converted = _to_text(source)
                elif output_type == "INT":
                    converted = _parse_int(source)
                elif output_type == "FLOAT":
                    converted = _parse_float(source)
                elif output_type == "BOOLEAN":
                    converted = _parse_bool(source)
                elif output_type in _UI_CONTAINER_TYPES:
                    if isinstance(source, str):
                        converted = _parse_json_or_literal(source, output_type)
                    else:
                        converted = _coerce_container(source, output_type)
            except Exception as e:
                print(f"[PreviewAny] Conversion error for {output_type}: {e}")

            text_output = _to_text(converted)

        # ---------- UI RESPONSE ----------
        # "succy_*" keys: custom, handled by the dedicated JS (not by the native UI).
        # We ALWAYS send them, even when preview=False, so the client caches them.
        ui_res = {}
        if ui_images:
            ui_res["succy_images"] = ui_images
            ui_res["succy_info"] = [
                f"Width: {width}   Height: {height}   Megapixels: {megapixels:.2f}"
            ]
            if preview:
                print("\n" + "=" * 40)
                print("PreviewAny [IMAGE]:")
                print(info_string)
                print("=" * 40 + "\n")
        elif output_type not in ("IMAGE", "MASK") or text_output:
            # sent even when empty: the frontend refreshes the content anyway
            ui_res["succy_text"] = [text_output]
            if preview:
                print("\n" + "=" * 40)
                print(f"PreviewAny [{output_type}]:")
                print(text_output)
                print("=" * 40 + "\n")

        return {
            "ui": ui_res,
            "result": (converted, width, height, megapixels),
        }

# Node names (and the class mapping) live ONLY in the pack's __init__.py (NODES). Nobody gets to name herself here, honey.
