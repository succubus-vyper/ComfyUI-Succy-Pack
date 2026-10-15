import os
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
        "folder":   "Succy_Utils",
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
        "folder":   "Succy_Utils",
        "py_file":  "Succy_Pick_Combo.py",
        "class":    "Succy_Pick_Combo",
        "display":  "Succy - 🎯Pick Combo",
        "category": "Succy Pack",
    },
    "Succy_Reroute": {
        "folder":   "Succy_Reroute",
        "py_file":  "Succy_Reroute.py",
        "class":    "Succy_Reroute",
        "display":  "Succy - 🔀Reroute",
        "category": "Succy Pack",
    },
    "Succy_X": {
        "folder":   "Succy_X",
        "py_file":  "Succy_X.py",
        "class":    "Succy_X",
        "display":  "Succy - 🧪X Torture",
        "category": "Succy Pack/Test",
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
    }
}

# Usiamo MODULES per il loop per sfruttare i mapping definiti nel file stesso
MODULES = {
    "Succy_Loop": {
        "folder": "Succy_Loop",  # Adesso punta alla sottocartella corretta!
        "py_file": "Succy_Loop.py",
    },
}

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_module(key, info):
    path = os.path.join(HERE, info["folder"], info["py_file"])
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

    return module


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


# Legacy one-class modules
for key, info in NODES.items():
    module = _load_module(key, info)
    if module is None:
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
    module = _load_module(key, info)
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