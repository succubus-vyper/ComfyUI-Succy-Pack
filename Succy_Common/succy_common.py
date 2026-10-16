"""Succy Pack — the shared drawer. One copy of everything the nodes used to carry around on their own.

Loaded ONCE by __init__.py and registered as `_succy_common`, so every node just does `from _succy_common import ...`
(tests and the bench register it the same way). No ComfyUI, torch or aiohttp at import time: it runs anywhere.

What lives here, and why one copy:
  - AnyType / ANY            the '*' type that ComfyUI's checker waves through
  - parse_bool/int/float     ONE reading of "what does this text mean as a number", with a policy knob
  - loads_loose / to_container   JSON -> Python literal -> single-quoted JSON, and ONE rule for empty text
  - same_origin              the little bouncer for the routes that press buttons (Pause, Crop, Stitch)
  - DISPLAY                  node display names, filled by __init__.py: the single place names are written
"""
import ast
import json
import math

__all__ = ["AnyType", "ANY", "parse_bool", "parse_int", "parse_float", "loads_loose", "to_container", "same_origin", "DISPLAY"]


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
