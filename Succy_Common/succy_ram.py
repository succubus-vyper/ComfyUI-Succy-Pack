# Succy Pack — RAM keeper (D-308). Three things, zero work while nothing runs:
#   1. ComfyUI's "free" (Free model and node cache) now also empties OUR memos and last-Run pictures: PromptExecutor.reset is wrapped.
#   2. The RAM ceiling (setting "RAM ceiling (GB)", 0 = off) is checked ONCE at the end of each Run: over it, steps until under
#      (D-362: when the loaded models alone are over the ceiling, ComfyUI's cache is left alone: emptying it could never get there):
#      our memos (D-328: not the last-Run pictures, the live views and ⧉ / ⬇ read them) -> ComfyUI's cache lightened (Loop pass clones; RAM pressure cache: its biggest outputs first,
#      D-379: never the outputs of the workflow's own nodes, or SAM ran again at every Run)
#      -> only if she chose "Models": ComfyUI's whole node cache + the models (its own free, after the Run; the next Run reloads them).
#   3. GET /succy/ram/stats (the Monitor's RAM row) · POST /succy/ram/config {ceiling_gb, memo_gb, models} (the settings, from the page).
# The value memos live under one budget in GB (succy_common.set_memo_budget). She keeps what she needs, and lets go when told.
import gc
import inspect
import os
import threading
import time

from _succy_common import forget_ours, ours_ram, refused, same_origin, say, set_memo_budget

try:
    import psutil
except Exception:          # ComfyUI ships it; without it the ceiling can't measure and stays off
    psutil = None

CONFIG = {"ceiling_gb": 0.0, "memo_gb": 2.0, "models": False, "loop_free": True}   # loop_free: D-381
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


def configure(ceiling_gb=None, memo_gb=None, models=None, loop_free=None):
    with _lock:
        if loop_free is not None:
            CONFIG["loop_free"] = bool(loop_free)
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
    - RAM pressure cache (ComfyUI's default since 0.4x, D-308c): its own ram_release, asked to free `over` bytes, the biggest first
      (her Loop's full pictures). D-379: NEVER the outputs of the workflow's own nodes (SAM went at the end of every Run and ran again
      at the next one): only the clones (Loop passes) and old entries can go. Can't tell which are hers = nothing goes."""
    out = getattr(getattr(executor, "caches", None), "outputs", None)
    kind = type(out).__name__ if out is not None else "no cache"
    rel = getattr(out, "ram_release", None)
    if callable(rel) and over > 0:
        now = avail()
        if now is None:
            return 0, kind + " (no psutil)"
        keep = workflow_keys(out)
        gen, used = getattr(out, "generation", None), getattr(out, "used_generation", None)
        if keep is None or not isinstance(gen, int) or not isinstance(used, dict):
            return 0, kind + " (workflow outputs unknown: cache kept)"
        # ram_release(free_active=False) leaves every entry used in this Run: the clones of this Run are marked one Run older for the
        # call (so they can go, biggest first), and given back their mark if they stay. The workflow's own outputs keep theirs.
        older = [k for k in list(getattr(out, "cache", {}) or {}) if k not in keep and used.get(k) == gen]
        for k in older:
            used[k] = gen - 1
        before = len(getattr(out, "cache", {}) or {})
        try:
            rel(now + over, free_active=False)
        except Exception as e:                             # another ComfyUI, other arguments: say it, the full free still comes
            return 0, kind + " (ram_release: " + str(e)[:80] + ")"
        finally:
            for k in older:
                if k in used:
                    used[k] = gen
        return max(0, before - len(getattr(out, "cache", {}) or {})), kind
    subs = getattr(out, "subcaches", None)
    if kind != "HierarchicalCache" or not isinstance(subs, dict):
        return 0, kind
    n = len(subs)
    subs.clear()
    return n, kind


def workflow_keys(out):
    """D-379: the cache keys of the nodes of the prompt that just ran (not the clones a Loop made): their outputs are what the next Run
    takes from the cache. None = can't tell."""
    try:
        prompt = getattr(getattr(out, "dynprompt", None), "original_prompt", None)
        ks = getattr(out, "cache_key_set", None)
        if not isinstance(prompt, dict) or ks is None:
            return None
        return {k for k in (ks.get_data_key(n) for n in prompt) if k is not None}
    except Exception:
        return None


def _models_bytes():
    """D-362: bytes of every model ComfyUI holds (on the GPU + offloaded): with dynamic VRAM the weights stay in RAM too, so this
    is the floor the process cannot go under without unloading them. 0 when unknown (then the ceiling behaves as before)."""
    try:
        import sys
        mon = sys.modules.get("_succy_monitor")
        return sum(int(m[1]) + int(m[2]) for m in mon.loaded_models()) if mon is not None else 0
    except Exception:
        return 0


# --- D-386: one console line at the end of every Run: what stays on the GPU between Runs, and who holds it ---------------------
# Her case: two Runs of 15 tiles fine, the third stuck at step 0 (VRAM full): something stays from one Run to the next. The line
# splits the card: driver "used" (everything, ComfyUI's dynamic loading included) / torch tensors alive in Python / the part of
# them reachable from ComfyUI's output cache / the pack's own. A gc walk of 1-2 s at the END of a Run only, never during it.
CENSUS = {"runs": 0, "last": None, "history": []}
_WALK_MAX = 3_000_000


def _is_cuda(o):
    try:
        return type(o).__module__.startswith("torch") and getattr(o, "is_cuda", False) is True
    except Exception:
        return False


def _cuda_bytes(objs, seen):
    n = 0
    for t in objs:
        try:
            st = t.untyped_storage()
            k = st.data_ptr()
            if k not in seen:
                seen.add(k)
                n += int(st.nbytes())
        except Exception:
            pass
    return n


def _reach_cuda(roots, limit=_WALK_MAX):
    """CUDA tensors reachable from `roots` (outputs, model patches, conditionings...), walked through gc's referents."""
    import types as _t
    skip = (type, _t.ModuleType, _t.FunctionType, _t.BuiltinFunctionType, str, bytes, int, float)
    seen, out, stack, walked = set(), [], list(roots), 0
    while stack and walked < limit:
        o = stack.pop()
        if id(o) in seen or isinstance(o, skip):
            continue
        seen.add(id(o))
        walked += 1
        if _is_cuda(o):
            out.append(o)
            continue
        try:
            stack.extend(gc.get_referents(o))
        except Exception:
            pass
    return out


def census(executor=None):
    """End-of-Run reading: {used, torch, cache, ours, ram, models, entries} in bytes. Never raises."""
    rec = {"run": CENSUS["runs"] + 1, "at": time.time()}
    try:
        rec.update({k: v for k, v in _vram().items() if k in ("vram_used", "vram_total")})
        everything = [o for o in gc.get_objects() if _is_cuda(o)]
        rec["torch"] = _cuda_bytes(everything, set())
        out = getattr(getattr(executor, "caches", None), "outputs", None)
        roots = []
        for c in [out] + list((getattr(out, "subcaches", None) or {}).values()):
            d = getattr(c, "cache", None)
            if isinstance(d, dict):
                roots.extend(d.values())
        rec["entries"] = len(roots)
        rec["cache"] = _cuda_bytes(_reach_cuda(roots), set())
        held = []
        for _name, (_f, tensors) in list(getattr(__import__("_succy_common"), "_HOLDERS", {}).items()):
            try:
                held.extend(tensors())
            except Exception:
                pass
        rec["ours"] = _cuda_bytes(_reach_cuda(held), set())
        rec["ram"] = rss()
        rec["models"] = _models_vram()[1]
    except Exception as e:
        rec["error"] = f"{type(e).__name__}: {str(e)[:120]}"
    CENSUS["runs"] += 1
    CENSUS["last"] = rec
    CENSUS["history"].append(rec)
    del CENSUS["history"][:-20]
    g = lambda k: f"{(rec.get(k) or 0) / _GB:.2f}"
    print(f"[Succy RAM] run {rec['run']} end · VRAM used {g('vram_used')}/{g('vram_total')} GB · torch {g('torch')} "
          f"(ComfyUI cache {g('cache')}, ours {g('ours')}) · RAM {g('ram')} GB · cache {rec.get('entries', '?')} entries · "
          f"models {rec.get('models', '?')}" + (f" · {rec['error']}" if rec.get("error") else ""))
    return rec


def after_run(executor=None, read=rss, queue=_queue, avail=_available, models=_models_bytes):
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
    n = forget_ours(holders=False)                         # D-328: the memos; the last Runs stay (live views, ⧉ / ⬇)
    gc.collect()
    after = read()
    rec["steps"].append({"step": "ours", "entries": n, "after": after})
    # D-362: the models alone over the ceiling = no emptying of the outputs can reach it: it only threw her cache away every Run
    # (24 GB process, 5 GB ceiling: 19 outputs out for 70 MB, the KSampler redone each time). The cache stays; the Monitor says why.
    floor = models() or 0
    if after is not None and after > limit and floor >= limit:
        rec["steps"].append({"step": "stop: the models alone are over the ceiling (cache kept, raise the ceiling)", "models": floor,
                             "after": after})
        if CONFIG["models"]:
            q = queue()
            if q is not None and hasattr(q, "set_flag"):
                q.set_flag("unload_models", True)
                q.set_flag("free_memory", True)
                rec["steps"].append({"step": "comfy cache + models", "after": None})
        STATE["last"] = rec
        return rec
    if after is not None and after > limit and executor is not None:
        n, kind = drop_clones(executor, after - limit, avail)
        if n:
            gc.collect()
            after = read()
        rec["steps"].append({"step": "biggest outputs" if "Pressure" in kind else "loop clones", "entries": n, "cache": kind, "after": after})
    if after is not None and after > limit and not CONFIG["models"]:
        # D-308d: what is left is mostly the models (dynamic VRAM keeps the weights in RAM inside the loaders' cached outputs, and
        # ram_release leaves them on purpose): emptying the whole cache would reload them from disk, which "Models" off forbids
        rec["steps"].append({"step": "stop: the rest is models / loaders / this workflow's outputs, kept (setting Models off)", "after": after})
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


# --- D-381: a Loop's finished pass lets go of what it made, in the middle of the Run, and leaves its memory reading -----------------
# ComfyUI keeps the outputs of EVERY node of every pass of a Loop (the clones of the body) until the whole Run ends: 14 passes of
# Krea2Edit = 14 patched models, 14 sets of conditionings, latents, pictures, alive at once (and whatever GPU tensors they hold).
# Nothing reads them again: the next pass gets the loop state as a VALUE, not as a link to the pass before, and the Loop End only needs
# its own Recurse result. So when a pass's Loop End runs, the clones of that pass (never the workflow's own nodes, never the Loop
# Ends) leave ComfyUI's output cache and its node objects. Off: POST /succy/ram/config {"loop_free": false}.
# Every pass also writes one reading (seconds, VRAM, torch, RAM, models) in LOOP["passes"]: the SUCCY_LOOPMEM snippet reads it,
# even while the Run is stuck (D-385: read in a thread with a 3 s limit), and ONE console line per pass, always (it survives a kill).
LOOP = {"passes": [], "freed": 0, "why": "", "errors": 0}
RUN = {"executor": None}                                   # the PromptExecutor while it runs (set by the execute wrapper)
_PASSES_MAX = 64
_GB = 1024 ** 3


def _cache_forget(cache, node_id):
    """Drops node_id's entry from one of ComfyUI's caches (classic, hierarchical, LRU, RAM pressure; outputs or objects).
    True = something went. A cache it does not know (no `cache` dict + `cache_key_set`) = False, nothing touched."""
    if cache is None:
        return False
    sub = cache
    finder = getattr(cache, "_get_cache_for", None)           # HierarchicalCache: the sub-cache of the node that expanded it
    if callable(finder):
        sub = finder(node_id)
        if sub is None:
            return False
    store, ks = getattr(sub, "cache", None), getattr(sub, "cache_key_set", None)
    if not isinstance(store, dict) or ks is None:
        return False
    key = ks.get_data_key(node_id)
    if inspect.iscoroutine(key):                               # a ComfyUI with async keys: unknown ground, hands off
        key.close()
        raise TypeError("async cache keys")
    if key is None or key not in store:
        return False
    store.pop(key, None)
    for name in ("used_generation", "children", "timestamps"):   # LRU / RAM pressure bookkeeping of the same key
        d = getattr(sub, name, None)
        if isinstance(d, dict):
            d.pop(key, None)
    return True


def pass_nodes(dynprompt, unique_id):
    """The clones made for the pass whose Loop End is `unique_id` (its siblings: same parent), and what they expanded in turn.
    Pass 0 (the workflow's own nodes, no parent) = empty: never touched. None = this ComfyUI can't tell (no parents)."""
    parent_of, every = getattr(dynprompt, "get_parent_node_id", None), getattr(dynprompt, "all_node_ids", None)
    if not callable(parent_of) or not callable(every):
        return None
    me = parent_of(unique_id)
    if me is None:
        return set()
    alln = [n for n in every() if n != unique_id]
    mine = {n for n in alln if parent_of(n) == me}
    grow = True
    while grow:                                                # a node of the pass that expanded too (a nested loop): its children go too
        grow = False
        for n in alln:
            if n not in mine and parent_of(n) in mine:
                mine.add(n)
                grow = True
    return mine


def free_pass(dynprompt, unique_id, executor=None):
    """D-381: the clones of a finished pass leave ComfyUI's output cache and its node objects. Returns (outputs dropped, why not)."""
    if not CONFIG.get("loop_free", True):
        return 0, "off"
    ex = executor if executor is not None else RUN["executor"]
    caches = getattr(ex, "caches", None)
    if caches is None:
        return 0, "no executor"
    ids = pass_nodes(dynprompt, unique_id)
    if ids is None:
        return 0, "no parents in this ComfyUI"
    n = 0
    for nid in ids:
        if _cache_forget(getattr(caches, "outputs", None), nid):
            n += 1
        _cache_forget(getattr(caches, "objects", None), nid)
    return n, ""


def _vram():
    try:
        import torch
        if not torch.cuda.is_available():
            return {}
        free, total = torch.cuda.mem_get_info()
        return {"vram_used": total - free, "vram_free": free, "vram_total": total, "alloc": torch.cuda.memory_allocated(),
                "reserved": torch.cuda.memory_reserved()}
    except Exception:
        return {}


def _models_vram():
    try:
        import sys
        mon = sys.modules.get("_succy_monitor")
        ms = mon.loaded_models() if mon is not None else []
        return sum(int(m[1]) for m in ms), len(ms)
    except Exception:
        return 0, 0


def reading():
    """What the memory looks like now: VRAM (driver + torch), the process RAM, the models ComfyUI holds on the GPU."""
    mv, mn = _models_vram()
    return dict(_vram(), ram=rss(), models_vram=mv, models=mn)


def loop_pass(dynprompt=None, unique_id=None, index=0, total=1, start_id=None, begin=False):
    """Called by the Loop: begin=True at the Loop Start of pass 0 (the baseline), else at each Loop End (pass index+1 done):
    frees the pass, then records the reading. Never raises: a loop keeps turning whatever happens here."""
    try:
        freed, why = (0, "") if begin else free_pass(dynprompt, unique_id)
        if freed:
            gc.collect()
        now = time.time()
        last = next((p for p in reversed(LOOP["passes"]) if p.get("loop") == str(start_id)), None)
        rec = dict(reading(), loop=str(start_id), total=int(total), at=now, s=round(now - last["at"], 1) if last and not begin else 0.0,
                   freed=freed)
        rec["pass"] = 0 if begin else int(index) + 1
        if why:
            rec["why"] = why
            LOOP["why"] = why
        LOOP["freed"] += freed
        LOOP["passes"].append(rec)
        del LOOP["passes"][:-_PASSES_MAX]
        g = lambda k: f"{(rec.get(k) or 0) / _GB:.2f}"
        print(f"[Succy Loop] {start_id} pass {rec['pass']}/{total} · {rec['s']} s · VRAM used {g('vram_used')} GB (torch {g('alloc')}, "
            f"models {g('models_vram')}) · RAM {g('ram')} GB · let go {freed} outputs" + (f" ({why})" if why else ""))
        return rec
    except Exception as e:
        LOOP["errors"] += 1
        LOOP["why"] = f"{type(e).__name__}: {str(e)[:160]}"
        return None


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
        RUN["executor"] = self                                 # D-381: a Loop End frees its pass in THIS executor's caches
        try:
            return orig(self, *a, **k)
        finally:
            RUN["executor"] = None
            try:
                census(self)                                   # D-386: before the ceiling touches anything
            except Exception:
                pass
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


def stats(gpu=True):
    models = 0
    try:
        import sys
        mon = sys.modules.get("_succy_monitor")
        if mon is not None:
            models = sum(m[2] for m in mon.loaded_models())
    except Exception:
        models = 0
    return {"process": rss(), "models": models, "ours": ours_ram(), "config": dict(CONFIG), "hooked": STATE["hooked"],
            "why": STATE["why"], "frees": STATE["frees"], "runs": STATE["runs"], "last": STATE["last"], "psutil": psutil is not None,
            "loop": {"passes": list(LOOP["passes"]), "freed": LOOP["freed"], "why": LOOP["why"], "errors": LOOP["errors"],
                     "on": CONFIG["loop_free"], "census": CENSUS["history"][-5:], "now": reading() if gpu else {"ram": rss(), "gpu": "no answer in 3 s (stuck?)"}}}


def _routes():
    from aiohttp import web
    from server import PromptServer
    R = PromptServer.instance.routes

    @R.get("/succy/ram/stats")
    async def _stats(request):
        # D-385: never on the server's own loop: with the GPU stuck (VRAM full, the driver spilling into RAM) a CUDA reading can hang,
        # and on the loop it took the whole server with it (the queue stopped answering too). 3 s, then an answer without the GPU.
        import asyncio
        try:
            return web.json_response(await asyncio.wait_for(asyncio.to_thread(stats), 3.0))
        except asyncio.TimeoutError:
            return web.json_response(stats(gpu=False))

    @R.post("/succy/ram/config")
    async def _config(request):
        if not same_origin(request):
            return refused()
        try:
            body = await request.json()
            cfg = configure(body.get("ceiling_gb"), body.get("memo_gb"), body.get("models"), body.get("loop_free"))
        except Exception as e:
            return web.json_response({"error": str(e)[:200]}, status=400)
        return web.json_response({"ok": True, "config": cfg})


def setup():
    install()
    try:
        _routes()
    except Exception as e:
        print(f"[Succy Pack] RAM routes not installed: {e}")
