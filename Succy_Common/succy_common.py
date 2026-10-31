"""Succy Pack — the shared drawer. One copy of everything the nodes used to carry around on their own.

Loaded ONCE by __init__.py and registered as `_succy_common`, so every node just does `from _succy_common import ...`
(tests and the bench register it the same way). No ComfyUI, torch or aiohttp at import time: it runs anywhere.

What lives here, and why one copy:
  - AnyType / ANY            the '*' type that ComfyUI's checker waves through
  - parse_bool/int/float     ONE reading of "what does this text mean as a number", with a policy knob
  - loads_loose / to_container   JSON -> Python literal -> single-quoted JSON, and ONE rule for empty text
  - convert_text             text -> STRING/INT/FLOAT/BOOLEAN/LIST/DICT/ARRAY/JSON/COMBO (Pick Combo cells, Primitive multiline)
  - same_origin              the little bouncer for the routes that press buttons (Pause, Crop, Stitch)
  - DISPLAY                  node display names, filled by __init__.py: the single place names are written
  - live_eval / LiveInputs   the LIVE LINK (D-156): a node "as it is now" -> its outputs, no Queue. A class opts in with
                             SUCCY_LIVE = (output names) + a classmethod succy_live(widgets, inputs, node_id) -> {output: value}.
                             The browser sends the chain {node_id, type, widgets, linked, from: {input: {output, ...source}}}.
  - coerce_widgets           browser widget values -> the Python types INPUT_TYPES declares (what a live call needs)
  - same_value / value_memo  the VALUE MEMO (D-210): a node's last result keyed by the values it really got (Load / Crop / Stitch)
"""
import ast
import json
import math
import re
import threading
import time
from collections import OrderedDict

__all__ = ["AnyType", "ANY", "parse_bool", "parse_int", "parse_float", "loads_loose", "to_container", "convert_text", "same_origin", "DISPLAY",
           "LiveWait", "LiveInputs", "live_eval", "live_touch", "door_values", "live_types", "coerce_widgets", "same_value", "ValueMemo", "value_memo", "memo_stats",
           "tensor_bytes", "ram_holder", "ours_ram", "forget_ours", "set_memo_budget", "say", "set_talk", "TALK",
           "gate_hold", "gate_action", "route_action", "has_readers", "stop_key", "in_loop", "keep_fresh", "fresh_values"]


class AnyType(str):
    """Legacy ComfyUI trick: compares equal to every type name, so any socket connects to it. A master of disguise."""
    def __ne__(self, _other):
        return False


ANY = AnyType("*")

# ---- the nodes' voice in ComfyUI's console (D-311): quiet unless she lets them talk (Succy Pack -> Console, sent by the page) ----
# say() is print() for chatter (a node paused, a value read as 0...); real failures keep print(), they always show
TALK = {"on": False}


def say(*args, **kw):
    """print() that only speaks when the nodes may talk. A lady knows when to keep her mouth shut."""
    if TALK["on"]:
        print(*args, **kw)


def set_talk(on):
    TALK["on"] = bool(on)
    return TALK["on"]


# node key -> display name; __init__.py writes it before it loads the nodes (Pause reads it for its v3 schema)
DISPLAY = {}

_TRUE = ("true", "1", "yes", "on", "y", "t")
_FALSE = ("false", "0", "no", "off", "n", "f", "")


def parse_bool(value, strict=False):
    """Words and numbers to a bool. strict=True raises on a word it doesn't know; otherwise the usual truthiness decides."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        v = value.strip().lower()
        if v in _TRUE:
            return True
        if v in _FALSE:
            return False
    if strict:
        raise ValueError(f"cannot parse {value!r} as BOOLEAN")
    return bool(value)


def _num_error(value, kind, strict, tag):
    if strict:
        raise ValueError(f"cannot parse {value!r} as {kind}")
    if tag and str(value).strip():
        say(f"[{tag}] '{str(value)[:40]}' is not a number -> 0")
    return 0 if kind == "INT" else 0.0


def parse_int(value, strict=False, tag=""):
    """To an int. Text like '3.6' rounds (half away from zero). Garbage: strict raises, otherwise 0 (and a console line if `tag` is set).
    Blank text is 0 in both modes. Big whole numbers stay exact (no float rounding)."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return _num_error(value, "INT", strict, tag)
        return int(math.floor(abs(value) + 0.5)) * (1 if value >= 0 else -1)
    if isinstance(value, str):
        s = value.strip()
        if s == "":
            return 0
        try:
            return int(s)
        except ValueError:
            try:
                return parse_int(float(s), strict, tag)
            except ValueError:
                return _num_error(value, "INT", strict, tag)
    return _num_error(value, "INT", strict, tag)


def parse_float(value, strict=False, tag=""):
    """To a float. Garbage: strict raises, otherwise 0.0 (and a console line if `tag` is set). Blank text is 0.0."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if s == "":
            return 0.0
        try:
            return float(s)
        except ValueError:
            return _num_error(value, "FLOAT", strict, tag)
    return _num_error(value, "FLOAT", strict, tag)


def loads_loose(text):
    """JSON as typed, then a Python literal ({'a': 1}, (1, 2), True...), then JSON with the single quotes swapped.
    Raises ValueError when nothing fits. Order matters: the apostrophes inside a valid literal are never touched."""
    for attempt in (lambda: json.loads(text), lambda: ast.literal_eval(text), lambda: json.loads(text.replace("'", '"'))):
        try:
            return attempt()
        except Exception:
            continue
    raise ValueError("not a literal")


def to_container(value, kind):
    """Fit `value` into LIST/ARRAY or DICT/JSON.
    The one rule for text: empty -> [] / {}; a literal that parses is used (a list stays a list, a scalar gets wrapped);
    text that isn't a literal becomes its non-blank lines (LIST) or {"value": text} (DICT)."""
    want_list = kind in ("LIST", "ARRAY")
    if isinstance(value, str):
        s = value.strip()
        if s == "":
            return [] if want_list else {}
        try:
            value = loads_loose(s)
        except ValueError:
            if want_list:
                lines = [ln.strip() for ln in s.split("\n") if ln.strip()]
                return lines if len(lines) > 1 else [s]
            return {"value": s}
    if isinstance(value, tuple):
        value = list(value)
    if want_list:
        return value if isinstance(value, list) else [value]
    return value if isinstance(value, dict) else {"value": value}


def wired_outputs(prompt, unique_id):
    """Output slots of this node that some node in the prompt reads (D-243: the truth, not what the browser last wrote).
    None = can't tell (no prompt / not in it): the caller falls back to what it was told."""
    if not isinstance(prompt, dict) or unique_id is None or str(unique_id) not in prompt:
        return None
    uid, out = str(unique_id), set()
    for n in prompt.values():
        for v in ((n or {}).get("inputs") or {}).values():
            if isinstance(v, list) and len(v) == 2 and str(v[0]) == uid:
                try:
                    out.add(int(v[1]))
                except (TypeError, ValueError):
                    pass
    return out


TEXT_FORMATS = ("STRING", "INT", "FLOAT", "BOOLEAN", "LIST", "DICT", "ARRAY", "JSON", "COMBO")


def convert_text(raw_value, output_format, tag=""):
    """One reading of a piece of text as the format the user picked. Unknown format = the text itself."""
    fmt = (output_format or "STRING").upper()
    s = "" if raw_value is None else str(raw_value)
    if fmt in ("STRING", "COMBO"):
        return s
    if fmt == "INT":
        return parse_int(s, tag=tag)
    if fmt == "FLOAT":
        return parse_float(s, tag=tag)
    if fmt == "BOOLEAN":
        return parse_bool(s)
    if fmt in ("LIST", "ARRAY", "DICT", "JSON"):
        return to_container(s, fmt)
    return s


def same_origin(request):
    """True when a request that presses a button comes from the page ComfyUI itself served.
    A browser always sends Origin on cross-site POSTs: if it is there and its host isn't ours, some other site is poking
    the route (a stranger's tab while ComfyUI listens on the LAN). No Origin = not a browser form/fetch (curl, tests): allowed,
    because whoever can reach the port can already do worse. Works with anything that has .headers and .host."""
    origin = request.headers.get("Origin")
    if not origin:
        return True
    host = (request.host or request.headers.get("Host") or "").lower()
    try:
        from urllib.parse import urlsplit
        return urlsplit(origin).netloc.lower() == host
    except Exception:
        return False


def refused():
    """The one answer for a route that won't serve a cross-site poke: 403 + this text (the check itself is same_origin)."""
    from aiohttp import web
    return web.json_response({"error": "cross-origin request refused"}, status=403)


def is_link(v):
    """True for a prompt link, [node_id, output_slot] (ComfyUI's own is_link, without needing the engine)."""
    return isinstance(v, (list, tuple)) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)


def clean_label(raw, i):
    """A user-typed result name made safe for the debug pane: letters, digits, space, _ and -, 18 chars; empty = r<i>."""
    return re.sub(r"[^a-zA-Z0-9 _-]", "", str(raw or "")).strip()[:18] or f"r{i}"


def display_id(dynprompt, node_id):
    """The id the frontend shows (clones of nested loops have other internal ids). Same type in, same type out:
    None stays None, a failing/absent dynprompt gives node_id back untouched (callers that want text wrap it in str())."""
    if node_id is None:
        return None
    try:
        if dynprompt is not None and hasattr(dynprompt, "get_display_node_id"):
            return dynprompt.get_display_node_id(node_id)
    except Exception:
        pass
    return node_id


# ---------------------------------------------------------------------------
# LIVE LINK (D-156): every Succy node that can say what it outputs "as it is now" does, without a Queue.
# The frontend (NodeStructure runtime/live-link.js) walks the wires back through live nodes and sends the chain;
# live_eval runs it from the far end, each node getting its upstream outputs through LiveInputs. Pure Python: the
# node classes bring the torch. Not ready is a state (LiveWait), not an error — she just isn't dressed yet.
# ---------------------------------------------------------------------------

LIVE_DEPTH = 8               # nodes in one chain at most: a loop of wires can't send us round and round
_LIVE_MEMO = OrderedDict()   # chain -> outputs: two viewers of the same node share one computation
_LIVE_MEMO_MAX = 16          # D-336: her chain (Load, Crop, Rotate, Tile, Stitch) + each view's own reduced copy fits
_LIVE_LOCK = threading.Lock()
_LIVE_EPOCH = [0]
# D-336: ONE live job at a time. Five views asking after a Run were five threads each sewing the same 3072x5504 chain, torch on every
# core in each: 28 s an answer. In turn, the first computes and the four others find it in the memo. Re-entrant: a job may call a job.
_LIVE_WORK = threading.RLock()
LIVE_STATS = {"jobs": 0, "busy_ms": 0, "worst_ms": 0, "worst_wait_ms": 0, "waiting": 0, "last_ms": 0, "nodes": {}}   # nodes: type -> n, last / worst ms (its own)
_LIVE_CLOCK = threading.local()


def live_job(fn, *args, **kw):
    """Run fn(*args, **kw) as THE live job (waits for the one running). Every route that computes a live picture goes through here."""
    t0 = time.perf_counter()
    with _LIVE_LOCK:
        LIVE_STATS["waiting"] += 1
    try:
        with _LIVE_WORK:
            t1 = time.perf_counter()
            try:
                return fn(*args, **kw)
            finally:
                ms = int((time.perf_counter() - t1) * 1000)
                with _LIVE_LOCK:
                    LIVE_STATS["jobs"] += 1
                    LIVE_STATS["busy_ms"] += ms
                    LIVE_STATS["last_ms"] = ms
                    LIVE_STATS["worst_ms"] = max(LIVE_STATS["worst_ms"], ms)
                    LIVE_STATS["worst_wait_ms"] = max(LIVE_STATS["worst_wait_ms"], int((t1 - t0) * 1000))
    finally:
        with _LIVE_LOCK:
            LIVE_STATS["waiting"] -= 1


class LiveWait(Exception):
    """A source that can't answer YET. need = 'image' (load one) | 'run' (only a Run brings it); why = what the user reads."""
    def __init__(self, need, why):
        super().__init__(why)
        self.need, self.why = need, why


def live_touch():
    """A live node ran or changed its own state (a folder counter): what the memo remembers may be stale."""
    with _LIVE_LOCK:
        _LIVE_EPOCH[0] += 1
        _LIVE_MEMO.clear()
        _LIVE_LAST.clear()


def live_types(mapping):
    """{node type: [live output names]} of the classes that opted in (SUCCY_LIVE + succy_live)."""
    out = {}
    for key, cls in (mapping or {}).items():
        outs = getattr(cls, "SUCCY_LIVE", None)
        if outs and callable(getattr(cls, "succy_live", None)):
            out[key] = [str(o) for o in outs]
    return out


class LiveInputs:
    """What a live node gets for its inputs: get(name) = the upstream live output, None when the input has no live source
    (not wired, or wired to a node that only a Run can fill: the node then falls back to its last Run)."""
    def __init__(self, spec, mapping, depth=0, show=None):
        spec = spec if isinstance(spec, dict) else {}
        self._from = spec.get("from") if isinstance(spec.get("from"), dict) else {}
        self._linked = set(str(x) for x in (spec.get("linked") or []))
        self._mapping, self._depth = mapping, depth
        # D-314: the longest side the browser will SEE of this node's own view (None = full size: a node downstream, a Run, ⧉ / ⬇).
        # A node may work on a smaller copy then, and says the real sizes in "_real" — she dresses down only for the mirror.
        self.show = show if depth == 0 and show else None

    def linked(self, name):
        # a wire whose live source says "I hand out nothing" (an Any on Index 0 or on a hole) counts as NO wire at all (D-172)
        return name in self._linked and not self.empty(name)

    def live(self, name):
        return name in self._from and name in self._linked

    def empty(self, name):
        """True when the live source behind `name` chose to give nothing on purpose (it lists the output in "_empty")."""
        if not self.live(name):
            return False
        src = self._from[name]
        try:
            outs = live_eval(src, self._mapping, self._depth + 1)
        except LiveWait:
            return False
        return str(src.get("output") or "") in (outs.get("_empty") or ())

    def get(self, name):
        if not self.live(name) or self.empty(name):
            return None
        src = self._from[name]
        outs = live_eval(src, self._mapping, self._depth + 1)
        out = str(src.get("output") or "")
        if outs.get(out) is None:
            raise LiveWait("run", f"{src.get('type', 'the node')} has no live '{out}': Run once")
        return outs[out]


def door_values(widgets, inputs, last, doors, who="the node", wait=True):
    """D-228: ONE way for every node's live view to read its rings (EXT doors), so the view says what the Run will do.
    doors = [(widget key, (input names...), (last-Run keys...))]. A ring the browser could read NOW never gets here as a wire: the kit
    folds its value into `widgets` (SurvivalKit nodePorts.doorValue). A ring still wired: a live Succy source -> its value now; else the
    last Run's; else wait=True raises LiveWait ("Run once"), wait=False leaves it out and names it in `unknown`. Never a made-up default.
    -> (widgets with the rings filled in, set of keys nobody can read yet)."""
    out, unknown, last = dict(widgets or {}), set(), last or {}
    for key, names, lkeys in doors:
        src = next((n for n in names if inputs.linked(n)), None)
        if src is None:
            continue
        v = None
        if getattr(inputs, "live", None) is None or inputs.live(src):        # a stand-in without live() = try it
            try:
                v = inputs.get(src)
            except LiveWait:
                v = None
        if v is None:
            v = next((last[k] for k in lkeys if last.get(k) is not None), None)
        if v is None:
            if wait:
                raise LiveWait("run", f"{who}'s {key} comes from a wire only a Run can read: Run once")
            unknown.add(key)
            continue
        out[key] = v
    return out, unknown


_LIVE_LAST = OrderedDict()   # (type, node_id, size) -> (spec, epoch, outputs): each node's last answer (D-336)
_LIVE_PREV = OrderedDict()   # (type, node_id) -> (spec, epoch, show) of its last computation: why it was computed again (D-336)


def _why_again(spec, show):
    """What changed since this node was last computed: first | run (a Run / live_touch) | size (another view size) | w:<widget names>
    | from | linked | same (nothing: the memo lost it). Called under _LIVE_LOCK."""
    k = (spec.get("type"), str(spec.get("node_id", "")))
    now = ({x: v for x, v in spec.items() if x != "output"}, _LIVE_EPOCH[0], show)
    prev = _LIVE_PREV.pop(k, None)
    _LIVE_PREV[k] = now
    while len(_LIVE_PREV) > 64:
        _LIVE_PREV.popitem(last=False)
    if prev is None:
        return "first"
    ps, pe, pw = prev
    s = now[0]
    if ps.get("widgets") != s.get("widgets"):
        a, b = ps.get("widgets") or {}, s.get("widgets") or {}
        return "w:" + ",".join(sorted(x for x in set(a) | set(b) if a.get(x) != b.get(x))[:3])
    if json.dumps(ps.get("from"), sort_keys=True, default=str) != json.dumps(s.get("from"), sort_keys=True, default=str):
        return "from"
    if ps.get("linked") != s.get("linked"):
        return "linked"
    if pe != now[1]:
        return "run"
    if pw != show:
        return "size"
    return "same" if ps == s else "other"


def live_eval(spec, mapping, depth=0, show=None):
    """One node of the chain, as it is now -> {output name: value}. Raises LiveWait when it can't answer yet.
    show = the longest side the browser views (only the asked node, depth 0: what it hands to others stays full size, D-314)."""
    if not isinstance(spec, dict) or not isinstance(spec.get("type"), str):
        raise LiveWait("run", "nothing live on this wire")
    if depth > LIVE_DEPTH:
        raise LiveWait("run", "the live chain is too long: Run once")
    cls = (mapping or {}).get(spec["type"])
    fn = getattr(cls, "succy_live", None) if cls is not None and getattr(cls, "SUCCY_LIVE", None) else None
    if not callable(fn):
        raise LiveWait("run", f"{spec['type']} can't send live: Run once")
    try:
        # the output asked is NOT part of the node's work: a Rotate reading crop, crop_mask and stitch from one Crop = ONE crop (D-336)
        # and the view's size only for a node that reads it (SUCCY_LIVE_SHOW): a Crop seen at 1536 and read full by its Rotate = one crop
        key = json.dumps([{k: v for k, v in spec.items() if k != "output"}, _LIVE_EPOCH[0],
                          show if depth == 0 and getattr(cls, "SUCCY_LIVE_SHOW", False) else None],
                         sort_keys=True, default=str)
    except (TypeError, ValueError):
        key = None
    # D-336, her SUCCY_WHY: the Crop computed again 30 times out of 36 with NOTHING changed ("same"): the LRU lost it (many views, many
    # sizes) or its text key told equal specs apart. Each node also keeps its LAST answer, compared by value: never lost to the others
    me = (spec["type"], str(spec.get("node_id", "")), show if depth == 0 and getattr(cls, "SUCCY_LIVE_SHOW", False) else None)
    bare = {k: v for k, v in spec.items() if k != "output"}
    with _LIVE_LOCK:
        last = _LIVE_LAST.get(me)
        if last is not None and last[1] == _LIVE_EPOCH[0] and last[0] == bare:
            _LIVE_LAST.move_to_end(me)
            return last[2]
    if key is not None:
        with _LIVE_LOCK:
            hit = _LIVE_MEMO.get(key)
            if hit is not None:
                _LIVE_MEMO.move_to_end(key)
                return hit
    widgets = spec.get("widgets") if isinstance(spec.get("widgets"), dict) else {}
    # D-336: each node's OWN time (what its upstream took is not counted twice), for /succy/live/stats
    stack = _LIVE_CLOCK.__dict__.setdefault("stack", [])
    stack.append(0.0)
    t0 = time.perf_counter()
    try:
        outs = fn(dict(widgets), LiveInputs(spec, mapping, depth, show), str(spec.get("node_id", "")))
    finally:
        took = time.perf_counter() - t0
        own = int((took - stack.pop()) * 1000)
        if stack:
            stack[-1] += took
        with _LIVE_LOCK:
            n = LIVE_STATS["nodes"].setdefault(spec["type"], {"n": 0, "last_ms": 0, "worst_ms": 0, "why": {}})
            n["n"] += 1
            n["last_ms"] = own
            n["worst_ms"] = max(n["worst_ms"], own)
            why = _why_again(spec, show if depth == 0 else None)
            n["why"][why] = n["why"].get(why, 0) + 1
            while len(n["why"]) > 12:
                n["why"].pop(next(iter(n["why"])))
    outs = outs if isinstance(outs, dict) else {}
    with _LIVE_LOCK:
        _LIVE_LAST[me] = (bare, _LIVE_EPOCH[0], outs)
        _LIVE_LAST.move_to_end(me)
        while len(_LIVE_LAST) > 48:
            _LIVE_LAST.popitem(last=False)
    if key is not None:
        with _LIVE_LOCK:
            _LIVE_MEMO[key] = outs
            while len(_LIVE_MEMO) > _LIVE_MEMO_MAX:
                _LIVE_MEMO.popitem(last=False)
    return outs


def coerce_widgets(cls, widgets):
    """Browser widget values -> what the node's function expects, by the types INPUT_TYPES declares (required + optional widgets).
    Unknown names are dropped; a value that doesn't read falls back to the widget's default. Combos keep only listed values."""
    try:
        it = cls.INPUT_TYPES()
    except Exception:
        return {}
    decl = {**(it.get("optional") or {}), **(it.get("required") or {})}
    out = {}
    for name, value in (widgets or {}).items():
        d = decl.get(name)
        if not d:
            continue
        kind, opts = d[0], (d[1] if len(d) > 1 and isinstance(d[1], dict) else {})
        if opts.get("forceInput"):
            continue
        default = opts.get("default")
        try:
            if isinstance(kind, (list, tuple)):
                v = str(value)
                out[name] = v if v in [str(k) for k in kind] else (default if default is not None else (kind[0] if kind else v))
            elif kind == "INT":
                v = int(round(float(value)))
                lo, hi = opts.get("min"), opts.get("max")
                out[name] = max(lo, v) if lo is not None and v < lo else min(hi, v) if hi is not None and v > hi else v
            elif kind == "FLOAT":
                v = float(value)
                if not math.isfinite(v):
                    raise ValueError
                lo, hi = opts.get("min"), opts.get("max")
                out[name] = max(lo, v) if lo is not None and v < lo else min(hi, v) if hi is not None and v > hi else v
            elif kind == "BOOLEAN":
                out[name] = parse_bool(value)
            elif kind == "STRING":
                out[name] = "" if value is None else str(value)
        except (TypeError, ValueError):
            if default is not None:
                out[name] = default
    return out


# ---------------------------------------------------------------------------
# VALUE MEMO (D-210): ComfyUI re-runs a node when ANY setting upstream changed (a Pick Combo on another row, an Any switched),
# even when the value that reaches the node is the very same. Load / Crop / Stitch keep their last result keyed by the VALUES
# they really got (widgets after the EXT wires, wired tensors, file + mtime): same values = the old result back at once, no
# file read, no mask, no resize. Exact comparison (torch.equal), never a sampled hash: a false "same" would hand out the wrong
# picture. One entry per node, the oldest node lets go past `cap`. She remembers what you gave her, not who handed it over.
# ---------------------------------------------------------------------------

def same_value(a, b):
    """True only when a and b are the same value: tensors equal element by element (same shape, dtype, device),
    dicts / lists / tuples item by item, the rest by ==. Anything that can't be compared counts as different."""
    if a is b:
        return True
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same_value(a[k], b[k]) for k in a)
    if isinstance(a, (list, tuple)):
        return len(a) == len(b) and all(same_value(x, y) for x, y in zip(a, b))
    if hasattr(a, "shape") and hasattr(a, "dtype") and hasattr(a, "device"):
        try:
            import torch
            return (tuple(a.shape) == tuple(b.shape) and a.dtype == b.dtype and a.device == b.device and bool(torch.equal(a, b)))
        except Exception:
            return False
    try:
        return bool(a == b)
    except Exception:
        return False


def _tensors(v, out):
    """Every tensor inside v (dicts, lists, tuples walked)."""
    if isinstance(v, dict):
        for x in v.values():
            _tensors(x, out)
    elif isinstance(v, (list, tuple)):
        for x in v:
            _tensors(x, out)
    elif hasattr(v, "shape") and hasattr(v, "dtype") and hasattr(v, "device"):
        out.append(v)
    return out


def _mark(t):
    """What a tensor looks like now: its in-place version counter, or (inference tensors keep none) the float64 sum of its values."""
    try:
        return ("v", int(t._version))
    except Exception:
        try:
            return ("s", float(t.sum(dtype=__import__("torch").float64)))
        except Exception:
            return ("?", id(t))


def _storage(t):
    """(identity, bytes) of the memory under a tensor: views of one picture share it, so it is counted once."""
    try:
        s = t.untyped_storage()
        return ("t", s.data_ptr()), int(s.nbytes())
    except Exception:
        pass
    b = t
    while getattr(b, "base", None) is not None:          # numpy views (the bench): the array that owns the memory
        b = b.base
    try:
        return ("n", id(b)), int(b.nbytes)
    except Exception:
        try:
            return ("n", id(b)), int(t.element_size() * t.nelement())
        except Exception:
            return ("n", id(b)), 0


def tensor_bytes(tensors, seen=None):
    """Bytes really held by these tensors: each piece of memory once, however many views point at it. `seen` is shared to sum several groups."""
    seen = {} if seen is None else seen
    for t in tensors:
        k, n = _storage(t)
        seen[k] = n
    return sum(seen.values())


_MEMO_COUNT = {"hit": "hits", "miss": "misses", "skip": "skips"}
_MEMOS = OrderedDict()       # name -> ValueMemo: a module reloaded finds its memo (and its counters) again
# D-308: every memo together lives under ONE budget in bytes (12 entries of 8k pictures were ~10 GB), the oldest entry of any memo goes first
_BUDGET = {"bytes": int(2 * 1024 ** 3), "evicted": 0, "too_big": 0, "seq": 0}
_BUDGET_LOCK = threading.Lock()
_HOLDERS = OrderedDict()     # name -> (forget(), tensors()): other things of ours that keep pictures (the last Run of Load / Crop)


def set_memo_budget(gb):
    """The memos' budget in GB (0 = no memo at all); fits them under it at once."""
    _BUDGET["bytes"] = max(0, int(float(gb) * 1024 ** 3))
    _fit_budget()
    return _BUDGET["bytes"]


def _memo_bytes():
    seen = {}
    for m in list(_MEMOS.values()):
        with m._lock:
            groups = [e[2] for e in m._d.values()]
        for marks in groups:
            tensor_bytes([t for t, _ in marks], seen)
    return sum(seen.values())


def _fit_budget():
    """Oldest entries out (any memo) until all of them fit the budget. Counts what went."""
    with _BUDGET_LOCK:
        while _memo_bytes() > _BUDGET["bytes"]:
            old = None
            for m in list(_MEMOS.values()):
                with m._lock:
                    for node, e in m._d.items():
                        if old is None or e[3] < old[2]:
                            old = (m, node, e[3])
                        break                              # each memo is in order: its first entry is its oldest
            if old is None:
                break
            with old[0]._lock:
                old[0]._d.pop(old[1], None)
            _BUDGET["evicted"] += 1


def ram_holder(name, forget, tensors):
    """Registers something of ours that keeps pictures: forget() lets them go, tensors() lists them (for the RAM row)."""
    _HOLDERS[name] = (forget, tensors)


def ours_ram():
    """What the pack itself keeps in RAM: {"memo", "held": {name: bytes}, "total"} in bytes (shared memory counted once in total)."""
    seen = {}
    for m in list(_MEMOS.values()):
        with m._lock:
            groups = [e[2] for e in m._d.values()]
        for marks in groups:
            tensor_bytes([t for t, _ in marks], seen)
    memo = sum(seen.values())
    held = {}
    for name, (_f, tensors) in list(_HOLDERS.items()):
        try:
            ts = _tensors(list(tensors()), [])
        except Exception:
            ts = []
        held[name] = tensor_bytes(ts)
        tensor_bytes(ts, seen)
    kept = sum(len(m._d) for m in list(_MEMOS.values()))
    return {"memo": memo, "held": held, "total": sum(seen.values()), "kept": kept, "budget": _BUDGET["bytes"],
            "evicted": _BUDGET["evicted"], "too_big": _BUDGET["too_big"]}


def forget_ours(holders=True):
    """Every memo lets go, and (holders=True: ComfyUI's free) every holder too. Returns how many memo entries went.
    D-328: the RAM ceiling passes holders=False: the last Runs are references to what ComfyUI's cache holds anyway (dropping them
    freed nothing) and they are what the live views and ⧉ / ⬇ read: emptied after every Run they said "Run once" right after one."""
    n = 0
    for m in list(_MEMOS.values()):
        with m._lock:
            n += len(m._d)
        m.forget()
    for name, (forget, _t) in (list(_HOLDERS.items()) if holders else []):
        try:
            forget()
        except Exception:
            pass
    return n


class ValueMemo:
    """One remembered result per node id. get() -> the result or None (counted as hit / miss), put() stores it,
    skip() counts a run that must not use the memo (a hold that stops), stats() is what the Monitor reads."""
    def __init__(self, name, cap=12):
        self.name, self.cap = name, cap
        self._d = OrderedDict()                            # node id -> (key, result, [(tensor, its mark when stored)], order of arrival)
        self._per = OrderedDict()                          # node id -> {"hits", "misses", "skips", "last"}
        self._lock = threading.Lock()
        self.hits = self.misses = self.skips = 0

    def _count(self, node, what):
        with self._lock:
            c = self._per.pop(node, None) or {"hits": 0, "misses": 0, "skips": 0, "last": ""}
            k = _MEMO_COUNT[what]
            c[k] += 1
            c["last"] = what
            self._per[node] = c
            while len(self._per) > self.cap * 4:
                self._per.popitem(last=False)
            setattr(self, k, getattr(self, k) + 1)

    def get(self, node, key):
        node = str(node)
        with self._lock:
            e = self._d.get(node)
        # same values in AND nothing remembered was changed in place since (a node writing into a tensor it got): only then the old result
        if e is not None and same_value(e[0], key) and all(_mark(t) == m for t, m in e[2]):
            with self._lock:
                if node in self._d:
                    self._d.move_to_end(node)
            self._count(node, "hit")
            return e[1]
        self._count(node, "miss")
        return None

    def put(self, node, key, result):
        node = str(node)
        ts = _tensors((key, result), [])
        with self._lock:
            self._d.pop(node, None)
        if tensor_bytes(ts) > _BUDGET["bytes"]:            # bigger than the whole budget: never kept (it would push everyone else out)
            _BUDGET["too_big"] += 1
            return
        with _BUDGET_LOCK:
            _BUDGET["seq"] += 1
            seq = _BUDGET["seq"]
        with self._lock:
            self._d[node] = (key, result, [(t, _mark(t)) for t in ts], seq)
            while len(self._d) > self.cap:
                self._d.popitem(last=False)
        _fit_budget()

    def skip(self, node):
        node = str(node)
        with self._lock:
            self._d.pop(node, None)                        # what comes after a hold is new: the old result must not come back
        self._count(node, "skip")

    def forget(self, node=None):
        with self._lock:
            if node is None:
                self._d.clear()
            else:
                self._d.pop(str(node), None)

    def stats(self):
        with self._lock:
            groups = [e[2] for e in self._d.values()]
        seen = {}
        for marks in groups:
            tensor_bytes([t for t, _ in marks], seen)
        with self._lock:
            return {"hits": self.hits, "misses": self.misses, "skips": self.skips, "kept": len(self._d), "cap": self.cap, "bytes": sum(seen.values()),
                    "nodes": {k: dict(v) for k, v in self._per.items()}}


def value_memo(name, cap=12):
    """The memo called `name` (made the first time)."""
    m = _MEMOS.get(name)
    if m is None:
        m = _MEMOS[name] = ValueMemo(name, cap)
    return m


def memo_stats():
    """{memo name: stats} for every value memo: the Monitor's row."""
    return {k: m.stats() for k, m in _MEMOS.items()}


# ---------------------------------------------------------------------------
# D-330: Stop on Crop / Stitch / Tile Split = a pause INSIDE the same Run (the global pause gate, Succy_Common/succy_pause_gate.py),
# not a new queue. The node shows what came in, asks the gate, runs on with the values it has and the gate holds the Run before the
# next node; she draws / drags, ▶ hands the gate the graph of now and it runs the node again with her values (D-264), then goes on.
# Load / SAM / a model before it are never touched again. The old way (wait in the node, ▶ = re-queue) only without the gate.
# ---------------------------------------------------------------------------

def _gate():
    import sys
    return sys.modules.get("_succy_pause_gate")


def has_readers(dynprompt, unique_id):
    """True when some node of the running prompt reads an output of `unique_id` (the gate holds BEFORE the next node: none = no hold).
    Can't tell = False (the old wait, which always works)."""
    try:
        p = getattr(dynprompt, "original_prompt", None)
        if not isinstance(p, dict):
            return False
        me = str(unique_id)
        return any(isinstance(v, list) and len(v) == 2 and str(v[0]) == me
                   for n in p.values() if isinstance(n, dict) for v in (n.get("inputs") or {}).values())
    except Exception:
        return False


_LOOP_STARTS = ("Succy_LoopStart", "Succy_WhileStart")
_LOOP_ENDS = ("Succy_LoopEnd", "Succy_WhileEnd")


def in_loop(dynprompt, unique_id):
    """True when the node sits INSIDE a Succy loop (after a Start whose End is not before it). Can't tell = False."""
    try:
        seen, stack = set(), [str(unique_id)]
        while stack:
            nid = stack.pop()
            if nid in seen:
                continue
            seen.add(nid)
            stack += [str(v[0]) for v in ((dynprompt.get_node(nid) or {}).get("inputs") or {}).values() if is_link(v)]
        kind = {n: (dynprompt.get_node(n) or {}).get("class_type") for n in seen}
        ends = [n for n in seen if kind[n] in _LOOP_ENDS]
        closed = {str(f[0]) for n in ends for f in [(dynprompt.get_node(n).get("inputs") or {}).get("flow")] if is_link(f)}
        return any(kind[n] in _LOOP_STARTS and n not in closed for n in seen)
    except Exception:
        return False


def _wants_stop(inputs):
    """D-332: the prompt inputs of a node on Stop (a wire on `hold` counts as on) that is not the old ▶'s transit."""
    h = inputs.get("hold", False)
    return (h is True or is_link(h)) and not str(inputs.get("run_id", "")).endswith("_continue")


def _stage_stop(dynprompt, unique_id):
    return not in_loop(dynprompt, unique_id)


def stop_key(cls, hold, run_id):
    """IS_CHANGED of a node (`cls` = its mapped class, the name it got in __init__.py does not matter) with Stop / Reuse (Crop, Stitch, Tile Split). Stop = the node runs on EVERY Run (the Run waits there).
    D-332: with the gate (async engine) like the Succy Pause (D-271 / D-273): a STABLE key, the gate runs it anyway and stages it at the
    start of every prompt, so a ▶ with nothing changed takes what follows from the cache (no sampling again) and a Split right after a
    cached Load still stops on the 2nd Run. Without the gate: NaN (always changed), as before. Reuse / the old ▶'s transit: cached."""
    if not hold or str(run_id).endswith("_continue"):
        return "passthrough"
    gate = _gate()
    try:
        if gate is not None and gate.always_run(cls, _wants_stop, _stage_stop):
            return "hold"
    except Exception as exc:
        print(f"[Succy] pause gate always_run failed ({exc}): the node runs as always changed")
    return float("nan")


def gate_hold(did, timeout, event, dynprompt=None, unique_id=None):
    """Ask the gate to hold the Run right after node `did` (once a prompt: run again with her values, it lets the Run through).
    Tells the page (`event`, the node's hold info) so its ▶ resumes in place. -> True = held by the gate, go on at once;
    False = no gate, or nothing still to run after the node (the last node of the run): the node waits the old way.
    D-332: the gate knows what is still to run (a Stitch at the end with another branch still to go = held by the gate); when it
    cannot tell, a node of the prompt reading this one is the sign."""
    gate, held = _gate(), False
    try:
        more = getattr(gate, "more_to_run", lambda: None)() if gate is not None else None
        held = (gate is not None and (more is not None or has_readers(dynprompt, unique_id))   # the gate decides when it knows
                and bool(gate.hold_after(str(did), timeout, "continue", once=True)))
    except Exception as exc:
        print(f"[Succy] pause gate unavailable ({exc}): the node waits the old way")
    try:
        from server import PromptServer
        PromptServer.instance.send_sync(event, {"node_id": str(did), "in_loop": False, "gate": bool(held), "in_place": True})   # D-332: ▶ never re-queues
    except Exception:
        pass
    return held


_FRESH = {}                  # D-332: display id -> the page's prompt of now that ▶ brought to a node waiting in itself


def keep_fresh(did, action, prompt):
    """The route of a node that waits in itself (no gate, or the last node of the run): ▶ brought the prompt of now. Kept for
    fresh_values(); ■ / no prompt = nothing kept."""
    if action == "continue" and isinstance(prompt, dict) and prompt:
        _FRESH[str(did)] = prompt
    else:
        _FRESH.pop(str(did), None)


def fresh_values(did, unique_id, current):
    """D-332, after the node's own wait: her plain values of NOW for this node that differ from what it runs with ({} = none).
    The node goes on with them in place (no new queue: a Crop on Stop before it would stop again, the sampler sample again).
    Wires are never taken from the page: what came in is what this Run has."""
    prompt = _FRESH.pop(str(did), None)
    node = None
    if isinstance(prompt, dict):
        node = prompt.get(str(did)) or prompt.get(str(unique_id))
    ins = node.get("inputs") if isinstance(node, dict) else None
    if not isinstance(ins, dict):
        return {}
    out = {}
    for k, v in ins.items():
        if k in current and k not in ("run_id", "unique_id", "dynprompt") and not is_link(v) and not isinstance(current[k], (list, dict)) \
                and not hasattr(current[k], "shape"):
            try:
                if v != current[k]:
                    out[k] = v
            except Exception:
                continue
    return out


def gate_action(did, action, prompt=None):
    """▶ / ■ pressed on a node the gate holds for: True = the gate took it (resume with the graph of now, or stop)."""
    gate = _gate()
    try:
        return gate is not None and bool(gate.node_action(str(did), action, prompt))
    except Exception as exc:
        print(f"[Succy] pause gate action failed: {exc}")
        return False



# D-333: the ▶ / ■ route and the old wait of every node with Stop / Reuse (Crop, Stitch, Tile Split, Rotate): one copy, here.
# `states` = the node module's own dict (display id -> "wait" | "continue" | "stop"), kept on the server instance by the module.

async def stop_route(request, states):
    """POST /succy/<node>/action {node_id, action: continue | stop, prompt?}: the gate first (it holds the Run for the node), else
    the node's own wait (▶ with the prompt of now = her values, in place)."""
    from aiohttp import web
    if not same_origin(request):
        return refused()
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad JSON"}, status=400)
    if not isinstance(data, dict) or data.get("node_id") is None or data.get("action") not in ("continue", "stop"):
        return web.json_response({"error": "node_id and action ('continue' | 'stop') required"}, status=400)
    where = route_action(states, data["node_id"], data["action"], data.get("prompt"))
    return web.json_response({"status": "ok", "gate": where.startswith("gate"), "where": where})


def route_action(states, node_id, action, prompt=None):
    """D-334: where ▶ / ■ of a node with Stop / Reuse lands, first match wins, so the buttons are never dead:
    1. the node waits in itself (D-332: ▶ brings her values, in place): a stale ask left in the gate never swallows the click;
    2. the gate holds the Run for this node (D-330: resume in place / stop);
    3. the gate holds the Run for someone else (the node's page and the gate disagree on who): ▶ goes on, ■ stops the Run.
    -> "node" | "gate" | "gate-any" | "idle" (nothing held: kept for a wait that has not started yet, as before).
    She never has to press twice; Succubus hates a door that only pretends to be open."""
    did = str(node_id)
    if states.get(did) == "wait":
        keep_fresh(did, action, prompt)
        states[did] = action
        return "node"
    if gate_action(did, action, prompt):
        return "gate"
    gate = _gate()
    try:
        if gate is not None and gate.snapshot().get("paused"):
            if action == "stop":
                gate._interrupt()
            else:
                gate.resume(prompt)
            return "gate-any"
    except Exception as exc:
        print(f"[Succy] pause gate action failed: {exc}")
    states[did] = action
    return "idle"


def wait_here(states, did, timeout, tag):
    """The old wait, in the node (no gate, or the last node of the run): ▶ (or the timeout) = go on, ■ = the whole Run stops.
    Interruptible (ComfyUI's own interrupt), never longer than `timeout` seconds."""
    import time
    import comfy.model_management as mm
    states[did] = "wait"
    gate = _gate()
    try:
        snap = gate.snapshot() if gate is not None else {}
        if snap.get("by") == str(did) and not snap.get("paused"):
            gate.ask(False)                  # D-334: an ask left for this node in the gate: it waits here, the gate holds nobody after it
    except Exception:
        pass
    t0 = time.time()
    try:
        while True:
            mm.throw_exception_if_processing_interrupted()
            st = states.get(did, "wait")
            if st == "stop":
                say(f"{tag} node {did} stopped by user.")
                mm.interrupt_current_processing()
                return
            if st == "continue" or time.time() - t0 >= timeout:
                return
            time.sleep(0.2)
    finally:
        states.pop(did, None)
