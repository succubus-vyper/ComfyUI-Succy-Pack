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
"""
import ast
import json
import math
import threading
from collections import OrderedDict

__all__ = ["AnyType", "ANY", "parse_bool", "parse_int", "parse_float", "loads_loose", "to_container", "convert_text", "same_origin", "DISPLAY",
           "LiveWait", "LiveInputs", "live_eval", "live_touch", "live_types", "coerce_widgets"]


class AnyType(str):
    """Legacy ComfyUI trick: compares equal to every type name, so any socket connects to it. A master of disguise."""
    def __ne__(self, _other):
        return False


ANY = AnyType("*")

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
        print(f"[{tag}] '{str(value)[:40]}' is not a number -> 0")
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


# ---------------------------------------------------------------------------
# LIVE LINK (D-156): every Succy node that can say what it outputs "as it is now" does, without a Queue.
# The frontend (NodeStructure runtime/live-link.js) walks the wires back through live nodes and sends the chain;
# live_eval runs it from the far end, each node getting its upstream outputs through LiveInputs. Pure Python: the
# node classes bring the torch. Not ready is a state (LiveWait), not an error — she just isn't dressed yet.
# ---------------------------------------------------------------------------

LIVE_DEPTH = 8               # nodes in one chain at most: a loop of wires can't send us round and round
_LIVE_MEMO = OrderedDict()   # chain -> outputs: two viewers of the same node share one computation
_LIVE_MEMO_MAX = 8
_LIVE_LOCK = threading.Lock()
_LIVE_EPOCH = [0]


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
    def __init__(self, spec, mapping, depth=0):
        spec = spec if isinstance(spec, dict) else {}
        self._from = spec.get("from") if isinstance(spec.get("from"), dict) else {}
        self._linked = set(str(x) for x in (spec.get("linked") or []))
        self._mapping, self._depth = mapping, depth

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


def live_eval(spec, mapping, depth=0):
    """One node of the chain, as it is now -> {output name: value}. Raises LiveWait when it can't answer yet."""
    if not isinstance(spec, dict) or not isinstance(spec.get("type"), str):
        raise LiveWait("run", "nothing live on this wire")
    if depth > LIVE_DEPTH:
        raise LiveWait("run", "the live chain is too long: Run once")
    cls = (mapping or {}).get(spec["type"])
    fn = getattr(cls, "succy_live", None) if cls is not None and getattr(cls, "SUCCY_LIVE", None) else None
    if not callable(fn):
        raise LiveWait("run", f"{spec['type']} can't send live: Run once")
    try:
        key = json.dumps([spec, _LIVE_EPOCH[0]], sort_keys=True, default=str)
    except (TypeError, ValueError):
        key = None
    if key is not None:
        with _LIVE_LOCK:
            hit = _LIVE_MEMO.get(key)
            if hit is not None:
                _LIVE_MEMO.move_to_end(key)
                return hit
    widgets = spec.get("widgets") if isinstance(spec.get("widgets"), dict) else {}
    outs = fn(dict(widgets), LiveInputs(spec, mapping, depth), str(spec.get("node_id", "")))
    outs = outs if isinstance(outs, dict) else {}
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
