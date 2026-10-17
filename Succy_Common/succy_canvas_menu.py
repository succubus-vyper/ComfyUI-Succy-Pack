# Succy canvas menu backend v1.0.0 (D-201)
# The routes behind the right-click on the canvas (dev/src/Succy_CanvasMenu.js):
#   GET  /succy/menu/status      -> running / pending / is the worker alive / boot id (the page knows a reboot landed when it changes)
#   POST /succy/menu/free_soft   -> empty the CUDA cache (models stay loaded)
#   POST /succy/menu/force_stop  -> clear the queue, interrupt, and if the job won't listen: an interrupt thrown INSIDE the worker
#   POST /succy/menu/reboot      -> restart ComfyUI WITHOUT auto-launch: no new browser tab, the tab that asked reloads itself
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

from _succy_common import same_origin

BOOT_ID = f"{os.getpid()}-{time.time():.3f}"
_refused = lambda: web.json_response({"error": "cross-origin request refused"}, status=403)


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


@PromptServer.instance.routes.post("/succy/menu/reboot")
async def _menu_reboot(request):
    if not same_origin(request):
        return _refused()
    threading.Thread(target=_restart, name="succy-reboot", daemon=True).start()
    return web.json_response({"ok": True, "boot": BOOT_ID})
