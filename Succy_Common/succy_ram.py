# Succy Pack — RAM keeper (D-308). Three things, zero work while nothing runs:
#   1. ComfyUI's "free" (Free model and node cache) now also empties OUR memos and last-Run pictures: PromptExecutor.reset is wrapped.
#   2. The RAM ceiling (setting "RAM ceiling (GB)", 0 = off) is checked ONCE at the end of each Run: over it, steps until under:
#      our memos + last-Run pictures -> ComfyUI's cache lightened (Loop pass clones; RAM pressure cache: its biggest outputs first)
#      -> only if she chose "Models": ComfyUI's whole node cache + the models (its own free, after the Run; the next Run reloads them).
#   3. GET /succy/ram/stats (the Monitor's RAM row) · POST /succy/ram/config {ceiling_gb, memo_gb, models} (the settings, from the page).
# The value memos live under one budget in GB (succy_common.set_memo_budget). She keeps what she needs, and lets go when told.
import gc
import os
import threading
import time

from _succy_common import forget_ours, ours_ram, refused, same_origin, set_memo_budget

try:
    import psutil
except Exception:          # ComfyUI ships it; without it the ceiling can't measure and stays off
    psutil = None

CONFIG = {"ceiling_gb": 0.0, "memo_gb": 2.0, "models": False}
STATE = {"hooked": False, "why": "", "frees": 0, "runs": 0, "last": None}
_lock = threading.Lock()


def rss():
    """Bytes this process holds in RAM (Windows: its working set), None without psutil."""
    if psutil is None:
        return None
    try:
        return int(psutil.Process(os.getpid()).memory_info().rss)
    except Exception:
        return None


def configure(ceiling_gb=None, memo_gb=None, models=None):
    with _lock:
        if ceiling_gb is not None:
            CONFIG["ceiling_gb"] = max(0.0, float(ceiling_gb))
        if models is not None:
            CONFIG["models"] = bool(models)
        if memo_gb is not None:
            CONFIG["memo_gb"] = max(0.0, float(memo_gb))
    if memo_gb is not None:
        set_memo_budget(CONFIG["memo_gb"])
    return dict(CONFIG)


def _queue():
    try:
        from server import PromptServer
        return PromptServer.instance.prompt_queue
    except Exception:
        return None


def _available():
    try:
        return int(psutil.virtual_memory().available)
    except Exception:
        return None


def drop_clones(executor, over=0, avail=_available):
    """Step 2: lighten ComfyUI's cache without emptying it. Returns (entries that went, the cache kind it found).
    - Classic cache (HierarchicalCache): the outputs kept for the clones of expanded nodes (every pass of a Loop / While); the
      expanding node's own result lives in the main cache, so a cached Loop End still answers at once.
    - RAM pressure cache (ComfyUI's default since 0.4x, D-308c): its own ram_release, asked to free `over` bytes, this Run's entries
      included, the biggest first (her Loop's full pictures): small things like the loaders stay."""
    out = getattr(getattr(executor, "caches", None), "outputs", None)
    kind = type(out).__name__ if out is not None else "no cache"
    rel = getattr(out, "ram_release", None)
    if callable(rel) and over > 0:
        now = avail()
        if now is None:
            return 0, kind + " (no psutil)"
        before = len(getattr(out, "cache", {}) or {})
        try:
            rel(now + over, free_active=True)
        except Exception as e:                             # another ComfyUI, other arguments: say it, the full free still comes
            return 0, kind + " (ram_release: " + str(e)[:80] + ")"
        return max(0, before - len(getattr(out, "cache", {}) or {})), kind
    subs = getattr(out, "subcaches", None)
    if kind != "HierarchicalCache" or not isinstance(subs, dict):
        return 0, kind
    n = len(subs)
    subs.clear()
    return n, kind


def after_run(executor=None, read=rss, queue=_queue, avail=_available):
    """End of a Run: under the ceiling = nothing. Over: ours first, then ComfyUI's cache lightened, then (only with "Models" on)
    the whole cache + the models through ComfyUI's own free flags, which its worker applies right after this Run. Returns what was done (also kept in STATE["last"])."""
    STATE["runs"] += 1
    ceil = CONFIG["ceiling_gb"]
    if ceil <= 0:
        return None
    limit = int(ceil * 1024 ** 3)
    before = read()
    if before is None or before <= limit:
        return None
    rec = {"at": time.time(), "before": before, "limit": limit, "steps": []}
    n = forget_ours()
    gc.collect()
    after = read()
    rec["steps"].append({"step": "ours", "entries": n, "after": after})
    if after is not None and after > limit and executor is not None:
        n, kind = drop_clones(executor, after - limit, avail)
        if n:
            gc.collect()
            after = read()
        rec["steps"].append({"step": "biggest outputs" if "Pressure" in kind else "loop clones", "entries": n, "cache": kind, "after": after})
    if after is not None and after > limit and not CONFIG["models"]:
        # D-308d: what is left is mostly the models (dynamic VRAM keeps the weights in RAM inside the loaders' cached outputs, and
        # ram_release leaves them on purpose): emptying the whole cache would reload them from disk, which "Models" off forbids
        rec["steps"].append({"step": "stop: the rest is models / loaders (setting Models off)", "after": after})
    elif after is not None and after > limit:
        q = queue()
        if q is not None and hasattr(q, "set_flag"):
            q.set_flag("unload_models", True)                      # set first: the worker reads both at once, after this Run
            q.set_flag("free_memory", True)
            rec["steps"].append({"step": "comfy cache + models", "after": None})
        else:
            rec["steps"].append({"step": "comfy cache", "error": "no prompt queue"})
    STATE["last"] = rec
    return rec


def _wrap_reset(orig):
    def reset(self, *a, **k):
        res = orig(self, *a, **k)
        try:
            if forget_ours():
                STATE["frees"] += 1
        except Exception:
            pass
        return res
    reset._succy_ram = True
    return reset


def _wrap_execute(orig):
    def execute(self, *a, **k):
        try:
            return orig(self, *a, **k)
        finally:
            try:
                after_run(self)
            except Exception as e:
                STATE["last"] = {"at": time.time(), "error": str(e)[:200]}
    execute._succy_ram = True
    return execute


def install(module=None):
    """Wraps PromptExecutor.reset and .execute once. Any surprise = not hooked, with the reason; nothing else changes."""
    try:
        if module is None:
            import execution as module
        pe = getattr(module, "PromptExecutor", None)
        if pe is None or not callable(getattr(pe, "reset", None)) or not callable(getattr(pe, "execute", None)):
            raise LookupError("execution.PromptExecutor.reset / execute are gone")
        if not getattr(pe.reset, "_succy_ram", False):
            pe.reset = _wrap_reset(pe.reset)
        if not getattr(pe.execute, "_succy_ram", False):
            pe.execute = _wrap_execute(pe.execute)
        STATE.update(hooked=True, why="")
    except Exception as e:
        STATE.update(hooked=False, why=str(e)[:200])
    return STATE["hooked"]


def stats():
    models = 0
    try:
        import sys
        mon = sys.modules.get("_succy_monitor")
        if mon is not None:
            models = sum(m[2] for m in mon.loaded_models())
    except Exception:
        models = 0
    return {"process": rss(), "models": models, "ours": ours_ram(), "config": dict(CONFIG), "hooked": STATE["hooked"],
            "why": STATE["why"], "frees": STATE["frees"], "runs": STATE["runs"], "last": STATE["last"], "psutil": psutil is not None}


def _routes():
    from aiohttp import web
    from server import PromptServer
    R = PromptServer.instance.routes

    @R.get("/succy/ram/stats")
    async def _stats(request):
        return web.json_response(stats())

    @R.post("/succy/ram/config")
    async def _config(request):
        if not same_origin(request):
            return refused()
        try:
            body = await request.json()
            cfg = configure(body.get("ceiling_gb"), body.get("memo_gb"), body.get("models"))
        except Exception as e:
            return web.json_response({"error": str(e)[:200]}, status=400)
        return web.json_response({"ok": True, "config": cfg})


def setup():
    install()
    try:
        _routes()
    except Exception as e:
        print(f"[Succy Pack] RAM routes not installed: {e}")
