import json
import os
import random
import re

import folder_paths
import numpy as np
import torch
from PIL import Image


from _succy_common import ANY, parse_bool, parse_float, parse_int, to_container   # the shared drawer (loaded once by __init__.py)

_PREVIEW_FILES = {}     # node key -> the temp PNG it currently shows (so the next run can delete it)


class _SkipPreview(Exception):
    """preview is Off: no picture is written."""

_UI_CONTAINER_TYPES = ("JSON", "DICT", "LIST", "ARRAY")
_UI_LIST_TYPES = ("LIST", "ARRAY")
_UI_DICT_TYPES = ("JSON", "DICT")
_OUTPUT_TYPES = ["STRING", "INT", "FLOAT", "BOOLEAN",
                 "LIST", "DICT", "ARRAY", "JSON", "COMBO",
                 "IMAGE", "MASK"]


# ------------------------------------------------------------------ #
#  Parser helpers (module-level, no state)                           #
# ------------------------------------------------------------------ #
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
    return parse_int(_unwrap_scalar(value), tag="PreviewAny")


def _parse_float(value) -> float:
    return parse_float(_unwrap_scalar(value), tag="PreviewAny")


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
            },
            # the node's id: one picture file per node, the old one goes away when the new one lands (no PNG pile-up in temp/)
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (ANY, "INT", "INT", "FLOAT")
    RETURN_NAMES = ("output", "width", "height", "megapixels")
    FUNCTION = "execute"
    OUTPUT_NODE = True

    # -------------------------------------------------------------- #
    def execute(self, preview, source, output_type, invert_mask=False, unique_id=None):
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

                # PNG preview: only with preview ON (the pane is hidden otherwise, so nobody would look at it).
                # One live file per node: the previous one is deleted as soon as the new one is written.
                try:
                    if not preview:
                        raise _SkipPreview()
                    temp_dir = folder_paths.get_temp_directory()
                    node_key = re.sub(r"[^A-Za-z0-9_-]", "_", str(unique_id)) if unique_id is not None else "x"
                    filename = f"succy_preview_{node_key}_{random.randint(0, 99999999)}.png"
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
                    old = _PREVIEW_FILES.get(node_key)
                    _PREVIEW_FILES[node_key] = filename
                    if old and old != filename:
                        try:
                            os.remove(os.path.join(temp_dir, old))
                        except OSError:
                            pass

                    ui_images = [{
                        "filename": filename,
                        "subfolder": "",
                        "type": "temp",
                    }]
                except _SkipPreview:
                    pass
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
                    converted = parse_bool(source)
                elif output_type in _UI_CONTAINER_TYPES:
                    if isinstance(source, str):
                        converted = to_container(source, output_type)
                    else:
                        converted = to_container(source, output_type)
            except Exception as e:
                print(f"[PreviewAny] Conversion error for {output_type}: {e}")

            text_output = _to_text(converted)

        # ---------- UI RESPONSE ----------
        # "succy_*" keys: custom, handled by the dedicated JS (not by the native UI).
        # Text always goes out; the picture only with preview ON (see above).
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
