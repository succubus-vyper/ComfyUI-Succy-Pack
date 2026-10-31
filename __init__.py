import os
import sys
import importlib.util

# ---------------------------------------------------------------------------
# Succy Pack node registry
# ---------------------------------------------------------------------------

NODES = {
    "Succy_Preview_Anything_&_Convert": {
        "folder":   "Succy_Preview_Anything_&_Convert",
        "py_file":  "Succy_Preview_Anything_&_Convert.py",
        "class":    "Succy_Preview_Anything_Convert",
        "display":  "Succy - 📄Preview Anything & Convert",
        "category": "Succy Pack",
    },
    "Succy_Multi_Math": {
        "folder":   "Succy_Multi_Math",
        "py_file":  "Succy_Multi_Math.py",
        "class":    "Succy_Multi_Math",
        "display":  "Succy - 🧮Multi Math",
        "category": "Succy Pack",
    },
    "Succy_CleanVram": {
        "folder":   "Succy_VRAM",
        "py_file":  "Succy_VRAM.py",
        "class":    "Succy_CleanVram_Madafacca",
        "display":  "Succy - 🧹Clean Vram",
        "category": "Succy Pack",
    },
    "Succy_PauseExecution": {
        "folder":   "Succy_Pause",
        "py_file":  "Succy_Pause.py",
        "class":    "Succy_PauseExecution",
        "display":  "Succy - ⏸Pause Execution",
        "category": "Succy Pack",
    },
    "Succy_Multi_Parse": {
        "folder":   "Succy_Multi_Parse",
        "py_file":  "Succy_Multi_Parse.py",
        "class":    "Succy_Multi_Parse",
        "display":  "Succy - 📝Multi Parse",
        "category": "Succy Pack",
    },
        "Succy_Label": {
        "folder":   "Succy_Label",
        "py_file":  "Succy_Label.py",
        "class":    "Succy_Label",
        "display":  "Succy - 🏷️Label / Note",
        "category": "Succy Pack",
    },
    "Succy_Pick_Combo": {
        "folder":   "Succy_Pick_Combo",
        "py_file":  "Succy_Pick_Combo.py",
        "class":    "Succy_Pick_Combo",
        "display":  "Succy - 🎯Pick Combo",
        "category": "Succy Pack",
    },
    # Route-only entry ("class": None): the module is loaded for the effects route it serves, no node is registered.
    "Succy_Reroute": {
        "folder":   "Succy_Reroute",
        "py_file":  "Succy_Reroute.py",
        "class":    None,
    },
    "Succy_Crop": {
        "folder":   "Succy_Crop_Stitch",
        "py_file":  "Succy_Crop_Stitch.py",
        "class":    "Succy_Crop",
        "display":  "Succy - ✂️Crop",
        "category": "Succy Pack",
    },
    "Succy_Stitch": {
        "folder":   "Succy_Crop_Stitch",
        "py_file":  "Succy_Crop_Stitch.py",
        "class":    "Succy_Stitch",
        "display":  "Succy - 🧵Stitch",
        "category": "Succy Pack",
    },
    "Succy_Primitive": {
        "folder":   "Succy_Utils",
        "py_file":  "Succy_Primitive.py",
        "class":    "Succy_Primitive",
        "display":  "Succy - 💎Primitive",
        "category": "Succy Pack",
    },
    "Succy_Any": {
        "folder":   "Succy_Utils",
        "py_file":  "Succy_Any.py",
        "class":    "Succy_Any",
        "display":  "Succy - 🕵Any",
        "category": "Succy Pack",
    },
    "Succy_Load_Image_Resize": {
        "folder":   "Succy_Load",
        "py_file":  "Succy_Load.py",
        "class":    "Succy_Load_Image_Resize",
        "display":  "Succy - 🖼️Load Image & Resize",
        "category": "Succy Pack",
    },
    # SmartCache (D-213): the hidden constant a wire goes through at Run time (deprecated flag = never in search or menus)
    "Succy_Value": {
        "folder":   "Succy_Common",
        "py_file":  "succy_cache.py",
        "class":    "Succy_Value",
        "display":  "Succy - Value (internal)",
        "category": "Succy Pack/hidden",
    },
        "Succy_Rotate": {
        "folder":   "Succy_Rotate",
        "py_file":  "Succy_Rotate.py",
        "class":    "Succy_Rotate",
        "display":  "Succy - 🔄Rotate & Flip",
        "category": "Succy Pack",
    },
        "Succy_Tile_Split": {
        "folder":   "Succy_Tile",
        "py_file":  "Succy_Tile.py",
        "class":    "Succy_Tile_Split",
        "display":  "Succy - 🧩Tile Split",
        "category": "Succy Pack",
    },
    "Succy_Tile_Merge": {
        "folder":   "Succy_Tile",
        "py_file":  "Succy_Tile.py",
        "class":    "Succy_Tile_Merge",
        "display":  "Succy - 🧩Tile Merge",
        "category": "Succy Pack",
    },
        "Succy_Multi_From_Batch_List": {
        "folder":   "Succy_Utils",
        "py_file":  "Succy_Multi_From_Batch_List.py",
        "class":    "Succy_Multi_From_Batch_List",
        "display":  "Succy - 🍒Multi From Batch/List",
        "category": "Succy Pack",
    },
}

# Usiamo MODULES per il loop per sfruttare i mapping definiti nel file stesso
MODULES = {
    "Succy_Loop": {
        "folder": "Succy_Loop",  # Adesso punta alla sottocartella corretta!
        "py_file": "Succy_Loop.py",
    },
}

HERE = os.path.dirname(os.path.abspath(__file__))

_LOADED = {}   # path -> module: a file shared by two nodes (Crop + Stitch) runs ONCE, both classes come from the same module


def _load_module(key, info):
    path = os.path.join(HERE, info["folder"], info["py_file"])
    if path in _LOADED:
        return _LOADED[path]
    if not os.path.isfile(path):
        print(f"[Succy Pack] File not found for '{key}': {path}")
        return None

    spec = importlib.util.spec_from_file_location(
        f"_succy_{key}", path
    )
    module = importlib.util.module_from_spec(spec)

    try:
        spec.loader.exec_module(module)
    except Exception as e:
        import traceback
        print(f"[Succy Pack] Error loading '{key}': {e}")
        print(traceback.format_exc())
        return None

    _LOADED[path] = module
    return module


# The shared drawer (parsers, AnyType, route bouncer): loaded FIRST and registered as `_succy_common`,
# so every node file can simply `from _succy_common import ...`. Without it nothing else is worth loading.
_common = _load_module("Succy_Common", {"folder": "Succy_Common", "py_file": "succy_common.py"})
if _common is not None:
    sys.modules["_succy_common"] = _common
    _common.DISPLAY.update({k: v["display"] for k, v in NODES.items() if v.get("display")})
    # the shared drawer for pictures (torch helpers + the live routes, D-156): `from _succy_image import ...`
    _image = _load_module("Succy_Image", {"folder": "Succy_Common", "py_file": "succy_image.py"})
    if _image is not None:
        sys.modules["_succy_image"] = _image
    # SmartCache (D-213): precompute + the Succy_Value constant + its routes: `from _succy_cache import ...` (Pick Combo registers its type)
    _cache = _load_module("Succy_Value", {"folder": "Succy_Common", "py_file": "succy_cache.py"})
    if _cache is not None:
        sys.modules["_succy_cache"] = _cache
    # the right-click canvas menu's routes (free VRAM, force stop, reboot in the same tab, D-201)
    _load_module("Succy_CanvasMenu", {"folder": "Succy_Common", "py_file": "succy_canvas_menu.py"})


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


# Legacy one-class modules
for key, info in NODES.items():
    module = _load_module(key, info) if _common is not None else None
    if module is None or info.get("class") is None:
        continue

    cls = getattr(module, info["class"], None)
    if cls is None:
        print(
            f"[Succy Pack] Class '{info['class']}' "
            f"not found in {os.path.join(HERE, info['folder'], info['py_file'])}"
        )
        continue

    cls.CATEGORY = info["category"]
    NODE_CLASS_MAPPINGS[key] = cls
    NODE_DISPLAY_NAME_MAPPINGS[key] = info["display"]


# Modules that expose their own mapping (Il nuovo Loop System)
for key, info in MODULES.items():
    module = _load_module(key, info) if _common is not None else None
    if module is None:
        continue

    module_mappings = getattr(module, "NODE_CLASS_MAPPINGS", {})
    module_display = getattr(module, "NODE_DISPLAY_NAME_MAPPINGS", {})

    for node_key, cls in module_mappings.items():
        cls.CATEGORY = getattr(cls, "CATEGORY", "Succy Pack/Loop")
        NODE_CLASS_MAPPINGS[node_key] = cls
        NODE_DISPLAY_NAME_MAPPINGS[node_key] = module_display.get(
            node_key,
            node_key,
        )


WEB_DIRECTORY = "./js"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]