# Succy global pause gate v1.8.0 (D-263, D-259 (3) + (4), D-264, D-266, D-267, D-268, D-271, D-273, D-277)
# The ⏸ of the top bar (dev/src/NodeStructure/app/topbar.js) holds the WHOLE run between two nodes:
#   ComfyUI's engine runs one node at a time through `execution.execute(...)`. We wrap that function: before every node that is
#   NOT in the cache, if a pause was asked for this prompt, we wait there (short sleeps) until ▶, Stop / Interrupt or a new prompt.
#   The node at work always finishes (the KSampler ends its steps, then the run stops).
#   POST /succy/run/pause {on, prompt_id} · POST /succy/run/resume {prompt?} · GET /succy/run/state
#   Page events: "succy.run.paused" {prompt_id, node, done, todo} (display ids: red / green borders) ·
#                "succy.run.resumed" {prompt_id, why, report}
# Edit while paused (D-263c, D-259 (4)): ▶ sends the page's prompt of NOW. Before the run goes on, the values of the GREEN nodes
# (still to run) that she changed are written into the frozen prompt the engine is running (dynprompt), and the cache keys of
# those nodes and of everything downstream are computed again (a cached green node she touched runs again, with the new value).
# D-264: a RED node she changed (already through, or never staged because it came from the cache: a Bool feeding a switch)
# runs AGAIN in this run when a green node still reads from it, directly or through other red nodes: its cache key (and the
# chain's) is computed again, the green readers get a fresh link to it, and the node held right now steps back (PENDING) until
# the chain is through. Engines without that machinery (the old sync one) keep it for the next Run.
# D-266: a GREEN node whose wires changed is rewired now (the page sends the prompt shaped by SmartCache like a Run, so a switch
# it skipped shows up as a moved wire on the reader): its old waits are dropped, the new sources (pulled into the running prompt
# when the run did not have them: the unpicked branch, a Succy_Value twin) get linked and run if they are not in the cache.
# D-267: the Succy Pause node asks the same hold (`hold_after`): it returns at once and the run stops before the next node not in
# the cache, with its timeout (continue / stop) and its id in the events (`by`); Continue on the node = ▶ (same edits). Inside a
# running Succy loop the hold is a closed world (`closed`): the run waits, but the edits wait for the next Run (D-265).
# D-268: the borders answer HER question, "if I change it, does it count now?": green = still to run · amber (`live`) = already
# through but a green node still reads it, so a changed value runs again now (D-264) · red = through, a change waits for the next
# Run. No amber on an engine that cannot run a node again, nor while a Succy loop is running (closed world, D-265: the global ⏸
# inside a running loop keeps the edits for the next Run too).
# Not this run (said in the report): red nodes no green node reads, wires moved on red nodes, a node that changed class, new
# nodes no green node reads.
# A cached node she did not touch still passes straight through. If ComfyUI renames / reshapes `execute`, nothing is wrapped,
# the state says why (the ⏸ turns grey, the Monitor row turns yellow) and every run goes on exactly as before.
# D-271: a node that must run EVERY time (the Succy Pause, `always_run`) used to be "always changed" (NaN fingerprint + a new
# run_id per Run): everything after it (the KSampler) never came from the cache. Now its key is stable and the gate makes it run
# anyway: it is never "cached" for the execution list (a reader that runs stages it), and its own cache entry is skipped (only for
# that call): the Pause asks its hold, its readers keep their keys. Nothing changed after it = nothing runs, the KSampler included.
# D-273 (her rule for the Pause): pause on = the run ALWAYS stops, even when everything after it is in the cache. At the first node
# of a prompt the gate stages every Pause that wants to stop (`always_run(..., stage=)`, never one inside a Succy loop) and makes
# every node still to run after it (the output nodes, which ComfyUI stages even when cached) wait for it; a hold asked by a Pause
# stops before the next node, cached or not. Continue with nothing changed = the outputs come from the cache, nothing samples
# again; with changes = only what changed runs again, with its chain (D-264, now from the outputs). A Pause holds once per prompt:
# re-run because something before it changed, it lets the run through.
# Loaded by succy_canvas_menu.py (so __init__.py stays untouched). She lets you catch your breath... only when SHE decides.
import asyncio
import inspect
import threading
import time

STEP = 0.1                                     # seconds between two looks at the flags while holding
TOPBAR_HOLD_S = 30 * 60                        # A3: a ⏸ of the top bar lets go by itself after 30 min (continue): a dead tab never jams the queue
ORPHAN_GRACE_S = 60                            # A3: ...and sooner when no page is connected for this long (closed tab, crashed browser)
NEED = ("server", "dynprompt", "caches", "current_item")
_lock = threading.Lock()
STATE = {"hooked": False, "why": "not installed", "want": False, "prompt": None, "paused": False, "node": None,
         "done": [], "todo": [], "pauses": 0, "changes": None, "last_report": None,
         "by": None, "deadline": None, "on_timeout": "continue", "closed": False, "live": [],
         "hold_s": None, "forever": False}       # A3: the top bar's window (starts when the hold does) / "hold forever", only when asked
_orphan = {"since": None}                      # A3: when the last page went away while a top-bar pause holds   # D-267: who asked (a Pause node) and its timeout
_run = {"prompt": None, "done": set(), "dp": None, "held": set(), "staged": set()}   # what the gate has seen pass in the current prompt (cache included)
PENDING = None                                 # execution.ExecutionResult.PENDING, found by install(): lets a held node step back
FAILURE = None                                 # D-273: ExecutionResult.FAILURE: Stop while held ends the run as ComfyUI's own interrupt
ALWAYS = {}                                    # D-271: class_type (or class) -> predicate(inputs) "must run now" (the Succy Pause, pause_flow on)
STAGE = {}                                     # D-273: class_type (or class) -> predicate(dynprompt, id) "stage it at the start of the prompt"
_ORIG_IS_CACHED = None                         # ExecutionList.is_cached before the patch (the gate's own questions use it)


def _interrupted():
    try:
        import comfy.model_management as mm
        return bool(mm.processing_interrupted())
    except Exception:
        return False


def _interrupt():
    try:
        import comfy.model_management as mm
        mm.interrupt_current_processing()
    except Exception:
        pass


def _send(event, data):
    try:
        from server import PromptServer
        s = PromptServer.instance
        s.send_sync(event, data, getattr(s, "client_id", None))
    except Exception:
        pass                                   # no page listening: the pause still holds


def snapshot():
    with _lock:
        return {k: (list(v) if isinstance(v, (list, set)) else v) for k, v in STATE.items() if k != "changes"} | {"has_changes": STATE["changes"] is not None}


def ask(on, prompt_id=None, by=None, timeout=None, on_timeout="continue", closed=False, forever=False):
    """⏸ asked (on=True) for this prompt, or the ask taken back before it landed (on=False). `by` / `timeout` / `closed`: a Pause
    node asked it (D-267); the ⏸ of the top bar asks without them (edits on) and gets TOPBAR_HOLD_S + the orphan release (A3),
    unless `forever` says, out loud, to wait for ever."""
    topbar = bool(on and by is None and not timeout)
    with _lock:
        STATE.update(hold_s=TOPBAR_HOLD_S if topbar and not forever else None, forever=bool(topbar and forever))
        _orphan["since"] = None
        STATE["want"] = bool(on)
        STATE["prompt"] = str(prompt_id) if on and prompt_id else None
        STATE.update(by=str(by) if on and by is not None else None, on_timeout=str(on_timeout or "continue"),
                     deadline=time.time() + float(timeout) if on and timeout else None, closed=bool(on and closed))
    return snapshot()


def hold_after(by, timeout=None, on_timeout="continue", closed=False):
    """D-267, called by the Pause node from INSIDE its own execute: hold the run before the next node not in the cache.
    False = the gate is not hooked (the node waits the old way, in its own function)."""
    if not STATE["hooked"] or not _run["prompt"]:
        return False
    if str(by) in _run["staged"]:                      # D-273: a staged Pause holds once a prompt (a loop's clones hold every turn)
        if str(by) in _run["held"]:
            return True                                # run again because something before it changed: let it through
        _run["held"].add(str(by))
    ask(True, _run["prompt"], by=by, timeout=timeout, on_timeout=on_timeout, closed=closed)
    return True


def node_action(by, action, prompt=None):
    """Continue / Stop pressed on the Pause node `by`: True when the gate holds (or is about to hold) for that node."""
    with _lock:
        mine = STATE["by"] == str(by) and (STATE["want"] or STATE["paused"])
    if not mine:
        return False
    if action == "stop":
        _interrupt()                                   # the hold sees it, lets go; ComfyUI's own check ends the run
    else:
        resume(prompt)
    return True


def _pages_open():
    """True / False = a page is / is not connected to the server's websocket; None = cannot tell (never releases on a guess)."""
    try:
        from server import PromptServer
        socks = getattr(PromptServer.instance, "sockets", None)
        return None if not isinstance(socks, dict) else len(socks) > 0
    except Exception:
        return None


def _orphaned():
    """A3: a top-bar pause (not 'forever') with no page connected for ORPHAN_GRACE_S: nobody is left to press ▶."""
    with _lock:
        topbar = STATE["by"] is None and STATE["hold_s"] is not None
    if not topbar or _pages_open() is not False:
        _orphan["since"] = None
        return False
    now = time.time()
    if _orphan["since"] is None:
        _orphan["since"] = now
    return now - _orphan["since"] >= ORPHAN_GRACE_S


def _expired():
    """The Pause node's timeout (or the top bar's window, A3) ran out while holding, or the page that paused is gone: on_timeout
    'continue' lets go (no edits), anything else stops the run."""
    orphan = _orphaned()
    with _lock:
        d = STATE["deadline"]
        if not orphan and (d is None or time.time() < d):
            return False
        stop = STATE["on_timeout"] != "continue"
        STATE.update(want=False, deadline=None, changes=None)
    if stop:
        _interrupt()
    return True


def resume(prompt=None):
    """▶: the gate lets the run go on. `prompt` = the page's prompt of now (graphToPrompt().output): the green nodes' edits."""
    with _lock:
        STATE["want"] = False
        STATE["changes"] = prompt if isinstance(prompt, dict) and prompt else None
    return snapshot()


def _is_link(v):
    return isinstance(v, (list, tuple)) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)


def diff_prompt(original, fresh, todo, done=(), values=False):
    """What ▶ can apply: {id: {input: value}} for the green nodes (todo) whose plain values changed. The rest, reported:
    late = changed nodes that are not green (red, cached, or not run at all) · wires = a link moved / added / removed ·
    new = nodes the run does not have. `values=True`: late carries {input: value} too (what a re-run needs)."""
    apply, late, wires, new = {}, {}, [], []
    for nid, fn in (fresh or {}).items():
        nid = str(nid)
        on = original.get(nid)
        if not isinstance(fn, dict):
            continue
        if on is None:
            new.append(nid)
            continue
        if fn.get("class_type") != on.get("class_type"):
            wires.append(nid)
            continue
        oi, fi = on.get("inputs", {}) or {}, fn.get("inputs", {}) or {}
        vals, wired = {}, False
        for k in set(oi) | set(fi):
            a, b = oi.get(k, _MISSING), fi.get(k, _MISSING)
            if a == b or (_is_link(a) and _is_link(b) and list(a) == list(b)):
                continue
            if _is_link(a) or _is_link(b) or a is _MISSING or b is _MISSING:
                wired = True
            else:
                vals[k] = b
        if wired:
            wires.append(nid)
        if vals:
            if nid in todo:
                apply[nid] = vals
            else:
                late[nid] = vals if values else sorted(vals)
    return apply, late, sorted(wires), sorted(new)


_MISSING = object()


def downstream(original, ids):
    """`ids` and every node that reads from them, directly or not (their cache keys hold the changed value)."""
    kids = {}
    for nid, node in original.items():
        for v in ((node or {}).get("inputs") or {}).values():
            if _is_link(v):
                kids.setdefault(str(v[0]), set()).add(str(nid))
    out, stack = set(), list(ids)
    while stack:
        n = stack.pop()
        if n in out:
            continue
        out.add(n)
        stack.extend(kids.get(n, ()))
    return out


def _inputs(original, nid):
    return ((original.get(nid) or {}).get("inputs") or {}).items()


def upstream(original, ids):
    """Every node `ids` read from, directly or not (not `ids` themselves)."""
    out, stack = set(), list(ids)
    while stack:
        for _k, v in _inputs(original, stack.pop()):
            if _is_link(v) and str(v[0]) not in out:
                out.add(str(v[0]))
                stack.append(str(v[0]))
    return out - set(ids)


def _reads(el, g, src, k):
    """Does green node g really read src now? Linked inputs live in execution_cache[g] (lazy ones only once asked for)."""
    ec = getattr(el, "execution_cache", None)
    if isinstance(ec, dict):
        return src in (ec.get(g) or {})
    try:
        _, _, info = el.get_input_info(g, k)
        return not (info or {}).get("lazy", False)
    except Exception:
        return True


def rerun_plan(original, late, todo, el):
    """D-264: the changed non-green nodes a green node still reads, through other non-green nodes or not.
    Returns (nodes that must run again, links to make again [(from, socket, green)])."""
    red = downstream(original, late) - todo           # their cache keys change: a green reader must not take the old output
    links = []
    for g in sorted(todo):
        for k, v in _inputs(original, g):
            if _is_link(v) and str(v[0]) in red and _reads(el, g, str(v[0]), k):
                links.append((str(v[0]), v[1], g))
    srcs = {s for s, _, _ in links}
    again = (srcs | upstream(original, srcs)) & red
    return again, links


def rewire_plan(original, fresh, todo):
    """D-266: green nodes (same class) whose links changed -> {id: their inputs of now}, and the nodes of `fresh` they need that
    the running prompt does not have (followed upstream) -> {id: node}."""
    rew, pulled = {}, {}
    for nid in sorted(todo):
        on, fn = original.get(nid), (fresh or {}).get(nid)
        if not isinstance(on, dict) or not isinstance(fn, dict) or fn.get("class_type") != on.get("class_type"):
            continue
        oi, fi = on.get("inputs") or {}, fn.get("inputs") or {}
        lk = lambda d: {k: list(v) for k, v in d.items() if _is_link(v)}         # noqa: E731
        if lk(oi) != lk(fi):
            rew[nid] = dict(fi)
    stack = [str(v[0]) for i in rew.values() for v in i.values() if _is_link(v)]
    while stack:
        n = stack.pop()
        if n in original or n in pulled or not isinstance((fresh or {}).get(n), dict):
            continue
        pulled[n] = fresh[n]
        stack.extend(str(v[0]) for v in (fresh[n].get("inputs") or {}).values() if _is_link(v))
    return rew, pulled


def _lazy(el, g, k):
    try:
        _, _, info = el.get_input_info(g, k)
        return bool((info or {}).get("lazy", False))
    except Exception:
        return False


def _can_rerun(el):
    return PENDING is not None and all(hasattr(el, n) for n in ("add_strong_link", "blockCount", "blocking", "is_cached"))


async def _refresh_keys(caches, dynprompt, changed, ids):
    for nid in changed:
        try:
            dynprompt.get_node(nid).pop("is_changed", None)    # IS_CHANGED may read the value she changed
        except Exception:
            pass
    for cache in list(getattr(caches, "all", None) or [getattr(caches, "outputs", None)]):
        ks = getattr(cache, "cache_key_set", None)
        if ks is None or not hasattr(ks, "get_node_signature"):
            continue                                   # id-keyed caches (objects) do not hold values
        icc = getattr(getattr(ks, "is_changed_cache", None), "is_changed", None)
        for nid in ids:
            ks.keys.pop(nid, None)
            if isinstance(icc, dict) and nid in changed:
                icc.pop(nid, None)
        await ks.add_keys(sorted(ids))


def _take_changes(a, rerun=False):
    """Writes the edits into the running prompt; returns (report, ids whose cache keys must be computed again,
    links to make again once the keys are new). `rerun`: the engine can run red nodes again (D-264)."""
    with _lock:
        fresh, STATE["changes"] = STATE["changes"], None
        closed = STATE["closed"]
    if closed:                                         # D-267 + D-265: a started loop is a closed world, edits = next Run
        return ({"closed": "loop", "late": {}, "applied": {}, "rerun": {}} if fresh else None), set(), ([], [])
    if not fresh or _interrupted():
        return None, set(), ([], [])
    dp, el = a["dynprompt"], a.get("execution_list")
    original = getattr(dp, "original_prompt", None)
    if not isinstance(original, dict):
        return {"error": "the running prompt is not readable"}, set(), ([], [])
    todo = {str(i) for i in list(getattr(el, "pendingNodes", {}) or {})} | {str(a["current_item"])}
    apply, late, wires, new = diff_prompt(original, fresh, todo, values=True)
    rew, pulled = rewire_plan(original, fresh, todo) if rerun else ({}, {})
    for nid, vals in apply.items():
        original[nid]["inputs"].update(vals)
    drop, links = [], []
    for nid, ins in rew.items():                     # D-266: the green node reads its new sources from now on
        old = {str(v[0]) for v in original[nid]["inputs"].values() if _is_link(v)}
        new_src = {str(v[0]) for v in ins.values() if _is_link(v)}
        original[nid]["inputs"] = dict(ins)
        drop += [(o, nid) for o in old - new_src]
        links += [(str(v[0]), v[1], nid) for k, v in ins.items() if _is_link(v) and not _lazy(el, nid, k)]
    original.update(pulled)
    # D-277: a node NOT green whose wires moved (the Any's choice: SmartCache moves the reader to another hidden Succy_Value)
    # counts as changed like a value: if a green node still reads it, it runs again now with its wires of now
    moved = {}
    if rerun:
        for nid in wires:
            fn = fresh.get(nid) or {}
            if nid not in todo and nid not in rew and fn.get("class_type") == (original.get(nid) or {}).get("class_type"):
                moved[nid] = dict(fn.get("inputs") or {})
                late[nid] = {**late.get(nid, {}), **moved[nid]}
    again, more = rerun_plan(original, late, todo, el) if rerun and late else (set(), [])
    redo = {n: late.pop(n) for n in list(late) if n in again}
    for nid, vals in redo.items():
        original[nid]["inputs"].update(vals)
        if nid in moved:                              # exactly the wires of now (an input gone stays gone)
            original[nid]["inputs"] = dict(moved[nid])
    stack = [str(v[0]) for n in redo if n in moved for v in moved[n].values() if _is_link(v)]
    while stack:                                       # the new sources it reads (the twin of the new choice) join the run
        n = stack.pop()
        if n in original or not isinstance(fresh.get(n), dict):
            continue
        original[n] = pulled[n] = fresh[n]
        stack.extend(str(v[0]) for v in (fresh[n].get("inputs") or {}).values() if _is_link(v))
    links += more if redo else []
    report = {"applied": {k: sorted(v) for k, v in apply.items()}, "rerun": {k: sorted(v) for k, v in redo.items()},
              "chain": sorted(again - set(redo)), "rewired": sorted(rew), "late": {k: sorted(v) for k, v in late.items()},
              "wires": [w for w in wires if w not in rew and w not in redo], "new": [n for n in new if n not in pulled]}
    with _lock:
        STATE["last_report"] = report
    changed = set(apply) | set(redo) | set(rew) | set(pulled)
    return report, (downstream(original, changed) if changed else set()), (drop, links)


def _relink(el, plan, current):
    """New keys in place: old waits of rewired nodes dropped, the green readers wait for their (new / red) sources.
    True = the held node itself must step back."""
    drop, links = plan
    for src, g in drop:
        if g in (el.blocking.get(src) or {}):
            del el.blocking[src][g]
            el.blockCount[g] -= 1
    for src, sock, g in links:
        el.add_strong_link(src, sock, g)
    return el.blockCount.get(current, 0) > 0


def _hold_for(prompt_id):
    with _lock:
        if not STATE["want"]:
            return False
        if STATE["prompt"] not in (None, str(prompt_id)):
            STATE["want"], STATE["prompt"] = False, None     # asked for a run that has ended: never leaks onto the next one
            STATE.update(by=None, deadline=None, closed=False, hold_s=None, forever=False)
            return False
        return True


def _new_prompt(prompt_id, dynprompt=None):
    if _run["prompt"] != prompt_id:
        _run.update(prompt=prompt_id, done=set(), dp=dynprompt, held=set(), staged=set())
        return True
    return False


def _display(dynprompt, uid):
    try:
        return str(dynprompt.get_display_node_id(uid))
    except Exception:
        return str(uid)


def plan(dynprompt, execution_list, current, done_ids):
    """Display ids of the nodes already through (red) and still to run (green). A node both done and to do (a loop body that
    already turned once, a subgraph half run) counts as done: her rule, a started While / Loop is red."""
    raw = {str(i) for i in list(getattr(execution_list, "pendingNodes", {}) or {})} | {str(current)}
    original = getattr(dynprompt, "original_prompt", None)
    if isinstance(original, dict):                     # D-264: what the green nodes read from the cache never comes through
        seen = raw | {str(i) for i in done_ids}
        done_ids = set(done_ids) | {i for i in upstream(original, seen) - raw if _is_cached(execution_list, i)}
    done = {_display(dynprompt, i) for i in done_ids}
    todo = {_display(dynprompt, i) for i in raw}
    return sorted(done), sorted(todo - done)


def live_of(dynprompt, execution_list, current, done):
    """D-268: the red display ids a green node still reads (directly or through other red nodes): changed, they run again now."""
    original = getattr(dynprompt, "original_prompt", None)
    if not isinstance(original, dict):
        return []
    raw = {str(i) for i in list(getattr(execution_list, "pendingNodes", {}) or {})} | {str(current)}
    return sorted({_display(dynprompt, i) for i in upstream(original, raw) - raw} & set(done))


def _loop_running(dynprompt, execution_list, current):
    """A node of the run is a clone made by an expansion (a Succy loop turning): its display id is not its own id."""
    raw = {str(i) for i in list(getattr(execution_list, "pendingNodes", {}) or {})} | {str(current)}
    return any(_display(dynprompt, i) != i for i in raw)


def always_run(cls, wants=None, stage=None):
    """D-271: `cls` (a class_type name, or a V1 node class) runs on every prompt that reaches it, with a STABLE cache key: its readers stay cached.
    `wants(inputs)` (the node's prompt inputs) says when (None = always). D-273: `stage(dynprompt, id)` True = the gate stages it at
    the start of every prompt and makes what still runs after it wait (a Pause stops even when all after it is cached).
    Returns True when the gate can do it (hooked, async engine). D-273: a V3 node (io.ComfyNode) passes its node_id: ComfyUI
    calls it on a fresh CLONE of its class every time (the clone is neither the mapped class nor worth keeping)."""
    ALWAYS[cls] = wants
    if stage is not None:
        STAGE[cls] = stage
    return always_ready()


def always_ready():
    with _lock:
        return bool(STATE["hooked"] and STATE.get("always"))


def _key(table, class_type):
    """The ALWAYS / STAGE key of a class_type: its name, or (a V1 node) its mapped class. None = not registered."""
    if class_type in table:
        return class_type
    import nodes as _nodes
    cls = _nodes.NODE_CLASS_MAPPINGS.get(class_type)
    return cls if cls is not None and cls in table else None


def _always(dynprompt, uid):
    if not ALWAYS:
        return False
    try:
        node = dynprompt.get_node(uid)
        k = _key(ALWAYS, node.get("class_type"))
        if k is None:
            return False
        wants = ALWAYS[k]
        return True if wants is None else bool(wants(node.get("inputs") or {}))
    except Exception:
        return False


def _patch_is_cached(cls):
    global _ORIG_IS_CACHED
    orig = getattr(cls, "is_cached", None)
    if orig is None or getattr(orig, "_succy_always", False):
        return orig is not None

    def is_cached(self, node_id):
        dp = getattr(self, "dynprompt", None)
        if _always(dp, node_id) and not (dp is _run["dp"] and node_id in _run["done"]):
            return False                           # a reader that runs stages it: the Pause asks its hold every time (once a prompt)
        return orig(self, node_id)
    is_cached._succy_always = True
    is_cached._succy_orig = orig
    _ORIG_IS_CACHED = orig
    cls.is_cached = is_cached
    return True


class _SkipOne:
    """The cache of outputs, blind for ONE node id (its entry is not read; it is written again, same key)."""
    def __init__(self, outputs, uid):
        self._o, self._u = outputs, uid

    async def get(self, node_id):
        if node_id == self._u:
            return None
        return await self._o.get(node_id)

    def __getattr__(self, k):
        return getattr(self._o, k)


class _FreshFor:
    def __init__(self, caches, uid):
        self._c, self.outputs = caches, _SkipOne(caches.outputs, uid)

    def __getattr__(self, k):
        return getattr(self._c, k)


def _stage_always(dp, el):
    """D-273, first node of a prompt: stage the always-run nodes that ask for it (STAGE) and make every pending node after them
    wait for them (outputs from the cache included). Returns the ids staged."""
    original = getattr(dp, "original_prompt", None)
    if not STAGE or not isinstance(original, dict):
        return []
    mine = []
    for nid, node in original.items():
        try:
            k = _key(STAGE, (node or {}).get("class_type"))
            if k is not None and _always(dp, nid) and STAGE[k](dp, nid):
                mine.append(str(nid))
        except Exception:
            continue                               # unsure = not staged: it runs when a reader needs it (D-271)
    staged = []
    for nid in mine:
        after = (downstream(original, [nid]) - {nid}) & {str(i) for i in el.pendingNodes}
        if not after:
            continue                               # nothing still to run reads it: nothing to stop
        el.add_node(nid)
        for t in sorted(after):
            if t not in el.blocking[nid]:
                el.blocking[nid][t] = {}
                el.blockCount[t] += 1
        staged.append(nid)
    return staged


def _is_cached(execution_list, uid):
    try:
        orig = getattr(getattr(type(execution_list), "is_cached", None), "_succy_orig", None)
        return orig(execution_list, uid) if orig else execution_list.is_cached(uid)
    except Exception:
        return False                           # unknown = hold on it too: pausing before a cached node costs nothing


def _enter(a):
    pid, node = a["prompt_id"], a["current_item"]
    dp, el = a["dynprompt"], a["execution_list"]
    done, todo = plan(dp, el, node, _run["done"])
    shown = _display(dp, node)
    loop = _loop_running(dp, el, node)
    with _lock:
        closed = STATE["closed"] = STATE["closed"] or loop
        if STATE["deadline"] is None and STATE["hold_s"]:
            STATE["deadline"] = time.time() + STATE["hold_s"]     # A3: the top bar's window starts when the run really stops
    live = [] if closed or not _can_rerun(el) else live_of(dp, el, node, done)
    done = [d for d in done if d not in live]
    with _lock:
        STATE.update(paused=True, node=shown, done=done, todo=todo, live=live)
        STATE["pauses"] += 1
        by = STATE["by"]
    _send("succy.run.paused", {"prompt_id": pid, "node": shown, "done": done, "todo": todo, "live": live, "by": by, "closed": closed})


def _leave(pid, report=None, timeout=False):
    why = "stop" if _interrupted() else "timeout" if timeout else "play"
    with _lock:
        by = STATE["by"]
        STATE.update(paused=False, node=None, done=[], todo=[], live=[], by=None, deadline=None, closed=False, hold_s=None, forever=False)
        _orphan["since"] = None
        if why == "stop":
            STATE["want"], STATE["prompt"], STATE["changes"] = False, None, None
    _send("succy.run.resumed", {"prompt_id": pid, "why": why, "report": report, "by": by})


def _passed(uid, result):
    # SUCCESS (enum of the new engines) or True (the old tuple): PENDING / FAILURE are not "through"
    r = result[0] if isinstance(result, tuple) and result else result
    if r is True or getattr(r, "name", None) == "SUCCESS":
        _run["done"].add(uid)


def _stopped(a):
    """Stop pressed while held: what ComfyUI's execute returns on an interrupt (a cached node would skip its own check)."""
    if FAILURE is None or not _interrupted():
        return None
    try:
        import comfy.model_management as mm
        dp = a["dynprompt"]
        return (FAILURE, {"node_id": dp.get_real_node_id(a["current_item"])}, mm.InterruptProcessingException())
    except Exception:
        return None


def _with_caches(sig, args, kwargs, caches):
    b = sig.bind_partial(*args, **kwargs)
    b.arguments["caches"] = caches
    return b.args, b.kwargs


def wrap(orig):
    """The gated twin of `execution.execute` (async on the new engines, sync on the old ones)."""
    sig = inspect.signature(orig)

    def args_of(args, kwargs):
        return sig.bind_partial(*args, **kwargs).arguments

    def must_hold(a):
        _new_prompt(a.get("prompt_id"), a.get("dynprompt"))
        with _lock:
            by = STATE["by"]                       # D-273: a Pause asked = stop before the next node, even one from the cache
        return _hold_for(a.get("prompt_id")) and (by is not None or not _is_cached(a.get("execution_list"), a["current_item"]))

    def stage_first(a):
        """D-273: the first node of a prompt stages the Pauses; True = this node must now wait for one (step back)."""
        el = a.get("execution_list")
        if _run["prompt"] == a.get("prompt_id") or not STAGE or not always_ready() or not _can_rerun(el):
            return False
        _new_prompt(a.get("prompt_id"), a.get("dynprompt"))
        try:
            _run["staged"] = {_display(a["dynprompt"], n) for n in _stage_always(a["dynprompt"], el)}
        except Exception as e:                         # never breaks a run: the Pause runs when a reader needs it (D-271)
            with _lock:
                STATE["last_report"] = {"error": "stage: " + str(e)[:180]}
            return False
        return el.blockCount.get(a["current_item"], 0) > 0

    if inspect.iscoroutinefunction(orig):
        async def gated(*args, **kwargs):
            a = args_of(args, kwargs)
            if stage_first(a):
                return (PENDING, None, None)           # an output (from the cache) after a Pause: the Pause first
            if must_hold(a):
                _enter(a)
                report, back, late = None, False, False
                try:
                    while _hold_for(a.get("prompt_id")) and not _interrupted():
                        if _expired():
                            late = True
                            break
                        await asyncio.sleep(STEP)
                    el = a.get("execution_list")
                    report, ids, links = _take_changes(a, rerun=_can_rerun(el))
                    if ids:
                        await _refresh_keys(a["caches"], a["dynprompt"], set(report["applied"]) | set(report["rerun"]), ids)
                    if links and (links[0] or links[1]):
                        back = _relink(el, links, a["current_item"])
                except Exception as e:                 # an edit that cannot land never breaks the run
                    report = {"error": str(e)[:200]}
                finally:
                    _leave(a.get("prompt_id"), report, late)
                if back:
                    return (PENDING, None, None)       # the engine unstages it: the red chain runs, then this node
                stopped = _stopped(a)
                if stopped is not None:
                    return stopped                     # D-273: Stop before an output from the cache: no "success", nothing emitted
            if "caches" in a and _always(a.get("dynprompt"), a["current_item"]):
                args, kwargs = _with_caches(sig, args, kwargs, _FreshFor(a["caches"], a["current_item"]))
            res = await orig(*args, **kwargs)    # interrupted: ComfyUI's own check inside raises and reports it, as always
            _passed(a["current_item"], res)
            return res
    else:
        def gated(*args, **kwargs):
            a = args_of(args, kwargs)
            if must_hold(a):
                _enter(a)
                report, late = None, False
                try:
                    while _hold_for(a.get("prompt_id")) and not _interrupted():
                        if _expired():
                            late = True
                            break
                        time.sleep(STEP)
                    report, _ids, _l = _take_changes(a)    # old engines: values written, cache keys not computed again
                except Exception as e:
                    report = {"error": str(e)[:200]}
                finally:
                    _leave(a.get("prompt_id"), report, late)
            res = orig(*args, **kwargs)
            _passed(a["current_item"], res)
            return res
    gated._succy_gate = True
    gated._succy_orig = orig
    return gated


def install(module=None):
    """Wraps `execute` of ComfyUI's `execution` module once. Any surprise = not hooked, with the reason; nothing else changes."""
    try:
        if module is None:
            import execution as module
        fn = getattr(module, "execute", None)
        if fn is None:
            raise LookupError("execution.execute is gone")
        if not getattr(fn, "_succy_gate", False):
            names = list(inspect.signature(fn).parameters)
            if tuple(names[:4]) != NEED or "prompt_id" not in names or "execution_list" not in names:
                raise LookupError("execute() changed shape: " + ", ".join(names[:9]))
            module.execute = wrap(fn)
        always = False
        if inspect.iscoroutinefunction(getattr(module.execute, "_succy_orig", module.execute)):
            try:
                el = getattr(module, "ExecutionList", None)
                if el is None:
                    from comfy_execution.graph import ExecutionList as el
                always = _patch_is_cached(el)          # the async engine awaits caches.outputs.get: _SkipOne speaks that
            except Exception:
                always = False
        global PENDING, FAILURE
        PENDING = getattr(getattr(module, "ExecutionResult", None), "PENDING", None)
        FAILURE = getattr(getattr(module, "ExecutionResult", None), "FAILURE", None)
        with _lock:
            STATE.update(hooked=True, why="", always=always)
    except Exception as e:
        with _lock:
            STATE.update(hooked=False, why=str(e)[:200])
    return snapshot()


def _routes():
    from aiohttp import web
    from server import PromptServer
    try:
        from _succy_common import refused, same_origin
    except Exception:
        same_origin = lambda r: True               # noqa: E731 (the shared drawer is always there in ComfyUI)
        refused = lambda: web.json_response({"error": "cross-origin request refused"}, status=403)   # noqa: E731
    R = PromptServer.instance.routes

    @R.get("/succy/run/state")
    async def _state(request):
        return web.json_response(snapshot())

    @R.post("/succy/run/pause")
    async def _pause(request):
        if not same_origin(request):
            return refused()
        if not STATE["hooked"]:
            return web.json_response({"error": "pause gate not hooked: " + STATE["why"]} | snapshot(), status=409)
        try:
            data = await request.json()
        except Exception:
            data = {}
        return web.json_response(ask(bool(data.get("on", True)), data.get("prompt_id"), forever=bool(data.get("forever"))) if isinstance(data, dict) else snapshot())

    @R.post("/succy/run/resume")
    async def _resume(request):
        if not same_origin(request):
            return refused()
        try:
            data = await request.json()
        except Exception:
            data = {}
        return web.json_response(resume(data.get("prompt") if isinstance(data, dict) else None))


def setup():
    install()
    try:
        _routes()
    except Exception as e:
        with _lock:
            STATE.update(why=(STATE["why"] + " · " if STATE["why"] else "") + "routes: " + str(e)[:120])
    if not STATE["hooked"]:
        print(f"[Succy Pack] Global pause off (ComfyUI changed?): {STATE['why']}")
