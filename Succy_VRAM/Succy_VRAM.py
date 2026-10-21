# Succy Clean VRAM backend v3.0.0 (D-82)
# Passes anything through while emptying the VRAM. The frontend (js/Succy_VRAM.js) is pure glue now.
# Succubus was here: she knows how to make room, and she never asks twice.
import gc

import torch
import comfy.model_management
from aiohttp import web
from server import PromptServer


from _succy_common import ANY as any_type   # the shared drawer (loaded once by __init__.py)


# --- API endpoint for the live reading (one shared poller on the frontend) ---
@PromptServer.instance.routes.get("/succy/vram/stats")
async def get_vram_stats(request):
    if torch.cuda.is_available():
        free, total = torch.cuda.mem_get_info()
        used = total - free
        return web.json_response({
            "total": round(total / (1024 ** 3), 2),
            "free": round(free / (1024 ** 3), 2),
            "used": round(used / (1024 ** 3), 2),
        })
    return web.json_response({"total": 0, "free": 0, "used": 0})


class Succy_CleanVram_Madafacca:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "any_input": (any_type,),
                "min_free_vram_gb": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 128.0, "step": 0.1}),
                "clean_mode": (["soft", "hard", "nuke"], {"default": "hard"}),
            }
        }

    RETURN_TYPES = (any_type, "STRING")
    RETURN_NAMES = ("any_output", "status_report")
    FUNCTION = "clean_it"
    SUCCY_CACHE = "never"  # SmartCache (D-213): it exists to act every Run (frees memory)
    CATEGORY = "Succy Pack"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        # A cleaner that the cache can skip is a cleaner that never cleans: same inputs, new run, new mess.
        return float("nan")

    def clean_it(self, any_input, min_free_vram_gb=0.0, clean_mode="hard"):
        free_before = self._get_free_vram()

        # Threshold check: enough room already, nothing to do
        if min_free_vram_gb > 0 and free_before is not None and free_before > min_free_vram_gb:
            report = (f"Cleanup skipped. Free VRAM ({free_before:.2f} GB) > threshold ({min_free_vram_gb:.2f} GB).")
            print(f"[Succy Pack] {report}")
            return {"ui": {"vram_report": [f"skipped · {free_before:.2f} GB free > {min_free_vram_gb:.2f} GB"]},
                    "result": (any_input, report)}

        report_lines = [f"[Succy Pack] VRAM cleanup ({clean_mode})..."]

        # Sync the CUDA threads so pending work doesn't hold the VRAM hostage
        if torch.cuda.is_available():
            torch.cuda.synchronize()

        if clean_mode in ("hard", "nuke"):
            comfy.model_management.unload_all_models()
            report_lines.append("  - All models unloaded (hard/nuke).")

        if clean_mode == "nuke":
            # Extreme measures for the leftovers of heavy transformers
            comfy.model_management.cleanup_models()
            report_lines.append("  - NUKE: deep cleanup forced.")

        # Multi-pass garbage collection (breaks complicated reference cycles — some relationships need a firm hand)
        gc.collect()
        gc.collect()

        comfy.model_management.soft_empty_cache()

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
            # Reset PyTorch's allocation stats
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.reset_accumulated_memory_stats()

        report_lines.append("  - CUDA cache, IPC and multi-pass GC done.")

        free_after = self._get_free_vram()
        short = f"{clean_mode} · done"
        if free_before is not None and free_after is not None:
            freed = free_after - free_before
            report_lines.append(f"  - VRAM freed: {freed:.2f} GB (from {free_before:.2f} GB to {free_after:.2f} GB free).")
            short = f"{clean_mode} · freed {freed:.2f} GB ({free_before:.2f} → {free_after:.2f} GB free)"

        final_report = "\n".join(report_lines)
        print(final_report)

        return {"ui": {"vram_report": [short]}, "result": (any_input, final_report)}

    def _get_free_vram(self):
        if torch.cuda.is_available():
            free, _total = torch.cuda.mem_get_info()
            return free / (1024 ** 3)
        return None


# Node names (and the class mapping) live ONLY in the pack's __init__.py (NODES). Nobody gets to name herself here, honey.
