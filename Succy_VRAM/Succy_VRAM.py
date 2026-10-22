# Succy Clean VRAM backend v3.1.0 (D-82, D-231b)
# Passes anything through while emptying the VRAM. The frontend (js/Succy_VRAM.js) is pure glue now.
# Succubus was here: she knows how to make room, and she never asks twice.
import gc

import torch
import comfy.model_management
from aiohttp import web
from server import PromptServer


from _succy_common import ANY as any_type   # the shared drawer (loaded once by __init__.py)


_CLASS = "Succy_CleanVram"
_MODES = ("soft", "hard", "nuke")


def _free_gb():
    if torch.cuda.is_available():
        free, _total = torch.cuda.mem_get_info()
        return free / (1024 ** 3)
    return None


def _clean(min_free_vram_gb=0.0, clean_mode="hard", when=""):
    """The cleaning itself, shared by the node's Run and the cached-node path (D-231b). Returns (short line for the node, report)."""
    free_before = _free_gb()

    # Threshold check: enough room already, nothing to do
    if min_free_vram_gb > 0 and free_before is not None and free_before > min_free_vram_gb:
        report = f"Cleanup skipped{when}. Free VRAM ({free_before:.2f} GB) > threshold ({min_free_vram_gb:.2f} GB)."
        print(f"[Succy Pack] {report}")
        return f"skipped{when} · {free_before:.2f} GB free > {min_free_vram_gb:.2f} GB", report

    report_lines = [f"[Succy Pack] VRAM cleanup ({clean_mode}){when}..."]

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

    free_after = _free_gb()
    short = f"{clean_mode}{when} · done"
    if free_before is not None and free_after is not None:
        freed = free_after - free_before
        report_lines.append(f"  - VRAM freed: {freed:.2f} GB (from {free_before:.2f} GB to {free_after:.2f} GB free).")
        short = f"{clean_mode}{when} · freed {freed:.2f} GB ({free_before:.2f} → {free_after:.2f} GB free)"

    final_report = "\n".join(report_lines)
    print(final_report)
    return short, final_report


# --- D-231b: a cleaner in the cache still cleans when the phase after it runs ---------------------------------------------------
# ComfyUI puts every ancestor's fingerprint in the cache key of the nodes after it, so a cleaner that RUNS makes the next phase run
# again. Instead: right before the first node runs, ComfyUI announces which nodes come from the cache ("execution_cached", sent from
# the worker). A cleaner in that list whose phase after it is NOT in it cleans right there: nothing is running yet and the phase
# before it won't run, so it is the same as cleaning in the middle, and no cache key changes. Anything unexpected = no cleaning
# (the D-231 behaviour), never a broken Run.
HOOK = {"on": False, "wakes": 0, "last": ""}                     # what the Monitor reads through /succy/vram/stats


def cleaners_to_wake(prompt, cached):
    """[(node_id, min_free, mode)] for every cleaner that comes from the cache (her rule, D-231c: if there is something to clean, it
    cleans at every Run, even when nothing after it runs again; the threshold still says "enough room, skip")."""
    cached = {str(c) for c in cached or ()}
    out = []
    for nid, n in (prompt or {}).items():
        nid = str(nid)
        if n.get("class_type") != _CLASS or nid not in cached:
            continue
        inp = n.get("inputs") or {}
        mf = inp.get("min_free_vram_gb", 0.0)
        mf = float(mf) if isinstance(mf, (int, float)) else 0.0          # a wired threshold: only a Run knows it -> always clean
        mode = inp.get("clean_mode", "hard")
        out.append((nid, mf, mode if mode in _MODES else "hard"))
    return out


def _running_prompt(server, prompt_id):
    try:
        q = server.prompt_queue
        for item in (q.get_current_queue_volatile() if hasattr(q, "get_current_queue_volatile") else q.get_current_queue())[0]:
            if str(item[1]) == str(prompt_id):
                return item[2]
    except Exception:
        pass
    return None


def install_cached_cleaner(server):
    """Wraps server.send_sync once: on "execution_cached" the cached cleaners with work after them clean (D-231b)."""
    orig = getattr(server, "send_sync", None)
    if orig is None or getattr(orig, "__succy_vram__", False):
        return False

    def send_sync(event, data, sid=None):
        orig(event, data, sid)
        if event != "execution_cached":
            return
        try:
            pid = (data or {}).get("prompt_id")
            for nid, mf, mode in cleaners_to_wake(_running_prompt(server, pid), (data or {}).get("nodes")):
                short, _report = _clean(mf, mode, " (cached)")
                HOOK["wakes"] += 1
                HOOK["last"] = f"#{nid} {short}"
                orig("executed", {"node": nid, "display_node": nid, "output": {"vram_report": [short]}, "prompt_id": pid}, sid)
        except Exception as e:                                       # a cleaner never breaks a Run
            HOOK["last"] = f"error: {type(e).__name__}: {e}"
            print(f"[Succy Pack] Clean VRAM (cached): skipped, {type(e).__name__}: {e}")

    send_sync.__succy_vram__ = True
    server.send_sync = send_sync
    HOOK["on"] = True
    return True


try:
    install_cached_cleaner(PromptServer.instance)
except Exception as _e:
    print(f"[Succy Pack] Clean VRAM: cached cleaning not installed ({_e})")


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
            "cached_cleaner": dict(HOOK),
        })
    return web.json_response({"total": 0, "free": 0, "used": 0, "cached_cleaner": dict(HOOK)})


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
    SUCCY_CACHE = "none"  # SmartCache (D-231): cached by its inputs like any node: it cleans only when something before it ran again
    CATEGORY = "Succy Pack"
    OUTPUT_NODE = True

    # No IS_CHANGED (D-231): a NaN here made every node after the cleaner run again on every Queue (the second KSampler resampled
    # for nothing). Cached by its inputs, it wakes up exactly when what comes before it ran again, and so does the phase after it.
    # A cleaner with manners: she only tidies up after a party.

    def clean_it(self, any_input, min_free_vram_gb=0.0, clean_mode="hard"):
        short, report = _clean(min_free_vram_gb, clean_mode)
        return {"ui": {"vram_report": [short]}, "result": (any_input, report)}


# Node names (and the class mapping) live ONLY in the pack's __init__.py (NODES). Nobody gets to name herself here, honey.
