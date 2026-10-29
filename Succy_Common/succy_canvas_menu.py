# Succy canvas menu backend v1.0.0 (D-201)
# The routes behind the right-click on the canvas (dev/src/Succy_CanvasMenu.js):
#   GET  /succy/menu/status      -> running / pending / is the worker alive / boot id (the page knows a reboot landed when it changes)
#   POST /succy/menu/free_soft   -> empty the CUDA cache (models stay loaded)
#   POST /succy/menu/force_stop  -> clear the queue, interrupt, and if the job won't listen: an interrupt thrown INSIDE the worker
#   POST /succy/menu/reboot      -> restart ComfyUI WITHOUT auto-launch: no new browser tab, the tab that asked reloads itself
#   GET/POST /succy/console      -> may the nodes talk in ComfyUI's console (D-311, the page sends its setting at boot and on change)
# Hard VRAM, Clear Queue and Interrupt use ComfyUI's own routes (/free, /queue, /interrupt) from the page.
# She says when to stop, and she means it.
import ctypes
import gc
import os
import sys
import threading
import time

from aiohttp import web
from server import PromptServer

from _succy_common import TALK, refused as _refused, same_origin, set_talk

BOOT_ID = f"{os.getpid()}-{time.time():.3f}"


def _queue_counts():
    """(running, pending) jobs; (0, 0) when the queue can't be read."""
    try:
        running, pending = PromptServer.instance.prompt_queue.get_current_queue()
        return len(running), len(pending)
    except Exception:
        return 0, 0


def _worker_thread():
    """The thread that runs the prompts (main.py starts it with target=prompt_worker)."""
    for t in threading.enumerate():
        if "prompt_worker" in (t.name or ""):
            return t
    return None


def _status():
    running, pending = _queue_counts()
    w = _worker_thread()
    return {"boot": BOOT_ID, "running": running, "pending": pending,
            "worker": None if w is None else w.is_alive()}


@PromptServer.instance.routes.get("/succy/menu/status")
async def _menu_status(request):
    return web.json_response(_status())


@PromptServer.instance.routes.post("/succy/menu/free_soft")
async def _menu_free_soft(request):
    if not same_origin(request):
        return _refused()
    try:
        import comfy.model_management as mm
        gc.collect()
        mm.soft_empty_cache()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"ok": True})


def _throw_into_worker():
    """Raise InterruptProcessingException inside the worker thread, at its next Python line. For a node that never checks
    the interrupt flag (a loop in some custom node): ComfyUI's executor treats it like a normal interrupt. A C call in
    progress (one CUDA kernel) still has to return first. True when the exception was planted."""
    w = _worker_thread()
    if w is None or not w.is_alive() or w.ident is None:
        return False
    try:
        import comfy.model_management as mm
        exc = mm.InterruptProcessingException
    except Exception:
        return False
    n = ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(w.ident), ctypes.py_object(exc))
    if n > 1:                                   # never more than one thread: take it back
        ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(w.ident), None)
        return False
    return n == 1


@PromptServer.instance.routes.post("/succy/menu/force_stop")
async def _menu_force_stop(request):
    """step "throw": only when a job is STILL running after the page's normal interrupt had its chance."""
    if not same_origin(request):
        return _refused()
    try:
        data = await request.json()
    except Exception:
        data = {}
    thrown = False
    if isinstance(data, dict) and data.get("step") == "throw" and _queue_counts()[0] > 0:
        thrown = _throw_into_worker()
    return web.json_response({**_status(), "thrown": thrown})


def _restart_args():
    """sys.argv for the new process, with the browser auto-launch switched off: that is what opened a NEW tab on every
    reboot (--windows-standalone-build turns --auto-launch on). The tab that asked for the reboot reloads by itself."""
    args = [a for a in sys.argv if a != "--auto-launch"]
    try:
        from comfy.cli_args import parser
        if "--disable-auto-launch" in getattr(parser, "_option_string_actions", {}) and "--disable-auto-launch" not in args:
            args.append("--disable-auto-launch")
    except Exception:
        pass
    return args


def _restart():
    time.sleep(0.5)                             # the answer reaches the page first
    args = _restart_args()
    print("[Succy Pack] Rebooting ComfyUI (no auto-launch)...")
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    if "__COMFY_CLI_SESSION__" in os.environ:   # comfy-cli restarts it on its own
        os._exit(0)
    if sys.platform.startswith("win32"):
        q = lambda a: f'"{a}"' if (" " in a or "\t" in a) and not a.startswith('"') else a
        os.execv(sys.executable, [q(sys.executable)] + [q(a) for a in args])
    else:
        os.execv(sys.executable, [sys.executable] + args)


@PromptServer.instance.routes.get("/succy/console")
async def _console_get(request):
    return web.json_response({"talk": TALK["on"]})


@PromptServer.instance.routes.post("/succy/console")
async def _console_set(request):
    if not same_origin(request):
        return _refused()
    try:
        body = await request.json()
    except Exception:
        body = {}
    return web.json_response({"talk": set_talk(body.get("talk"))})


@PromptServer.instance.routes.post("/succy/menu/reboot")
async def _menu_reboot(request):
    if not same_origin(request):
        return _refused()
    threading.Thread(target=_restart, name="succy-reboot", daemon=True).start()
    return web.json_response({"ok": True, "boot": BOOT_ID})


# The top-bar resource monitor's route (D-262) rides along with this file: __init__.py loads us, we load it.
def _load_monitor():
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "succy_monitor.py")
    try:
        spec = importlib.util.spec_from_file_location("_succy_monitor", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        sys.modules["_succy_monitor"] = mod
    except Exception as e:
        print(f"[Succy Pack] Resource monitor route not installed: {e}")


_load_monitor()


# The global pause gate (D-263, the ⏸ of the top bar) rides along the same way.
def _load_pause_gate():
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "succy_pause_gate.py")
    try:
        spec = importlib.util.spec_from_file_location("_succy_pause_gate", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        sys.modules["_succy_pause_gate"] = mod
        mod.setup()
    except Exception as e:
        print(f"[Succy Pack] Global pause not installed: {e}")


_load_pause_gate()


# The RAM keeper (D-308: ComfyUI's free empties our memos too, the RAM ceiling at the end of a Run) rides along the same way.
def _load_ram():
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "succy_ram.py")
    try:
        spec = importlib.util.spec_from_file_location("_succy_ram", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        sys.modules["_succy_ram"] = mod
        mod.setup()
    except Exception as e:
        print(f"[Succy Pack] RAM keeper not installed: {e}")


_load_ram()
