"""Succy Pack — SmartCache (D-213): ONE module that keeps every Succy node out of ComfyUI's way when nothing really changed.

ComfyUI re-runs a node when its settings (or anything upstream) change. Two levers, one contract:
  - PRECOMPUTE (light values, policy "pure"): just before a Run the browser sends the pure nodes of the prompt here; we run the
    REAL node (its own FUNCTION, no copy of its logic) wherever every input is a written value or the output of another pure node,
    and hand back each used output encoded with its exact type. The browser then feeds every wire through a hidden constant node
    (Succy_Value) holding only that value: same value = same constant = ComfyUI keeps the whole branch after it, foreign nodes too.
  - ROUTE (switches, policy "route"): a node that hands one of its inputs out UNTOUCHED (Any's picked) says which one, from its
    settings alone (succy_cache_route); the browser then wires the consumers straight to that source. Same source = nothing after
    it runs again, whatever else changed on the switch (its index, the branches it did not pick).
  - MEMO (heavy values, policy "memo"): the value memo of D-210 (succy_common.ValueMemo), the node's own last result.
Each Succy class declares SUCCY_CACHE = "pure" | "route" | "memo" | "never" | "none" (a class without it = selfTest FAIL).
Anything unsure = that wire stays as it was: slower, never wrong. No print: the Monitor and the tests are where this speaks.
No ComfyUI, torch or aiohttp at import time (the routes are installed only when the server is there).
She remembers what you gave her last time, and gives back exactly that — not a crumb more.
"""
import json
import os
import threading
import time

from _succy_common import ANY, memo_stats

__all__ = ["POLICIES", "register_type", "encode", "decode", "same", "coerce_like_comfy", "precompute", "policies", "stats", "switch",
           "Succy_Value"]

POLICIES = ("pure", "route", "memo", "never", "none")
CODE_MAX = 256 * 1024          # an encoded value larger than this stays on its wire (the prompt is not a parcel service)
BUDGET_S = 0.5                 # time to start new nodes in one precompute; what's left after it stays as it was
_LOCK = threading.Lock()
_SWITCH = {"pure": True, "off": set()}                      # global lever + classes switched off (by hand or by a failed check)
_STATS = {"runs": 0, "nodes": 0, "values": 0, "routes": 0, "skipped": 0, "errors": 0, "last_error": "", "ms": 0.0, "why": {}}
_CHECKED = {}                                               # class_type -> (ok, why): the self-check of each pure class, once


class _NoCode(Exception):
    """A value we can't write down exactly: its wire stays as it was."""


# ---- the codec: tagged JSON that comes back with the SAME type and value (never pickle: a prompt is not trusted code) ----------
_TYPES = {}                    # python class -> (name, to_json, from_json)
_BY_NAME = {}                  # name -> from_json


def register_type(cls, name, to_json, from_json):
    """A node's own value class (Pick Combo's PickedFloat): to_json(v) -> plain JSON, from_json(j) -> v. Exact or not at all."""
    _TYPES[cls] = (name, to_json, from_json)
    _BY_NAME[name] = from_json


def _enc(v, depth=0):
    if depth > 32:
        raise _NoCode("nested too deep")
    t = type(v)
    if v is None:
        return ["N"]
    if t is bool:
        return ["b", v]
    if t is int:
        return ["i", str(v)]                                     # as text: no JSON number loses a digit of a big int
    if t is float:
        return ["f", v.hex()]                                    # exact, nan and inf included
    if t is str:
        return ["s", v]
    if t is list or t is tuple:
        return ["l" if t is list else "t", [_enc(x, depth + 1) for x in v]]
    if t is dict:
        return ["d", [[_enc(k, depth + 1), _enc(x, depth + 1)] for k, x in v.items()]]
    if t in _TYPES:
        name, to_json, _ = _TYPES[t]
        return ["x", name, to_json(v)]
    raise _NoCode(t.__name__)


def _dec(c):
    tag = c[0]
    if tag == "N":
        return None
    if tag == "b":
        return bool(c[1])
    if tag == "i":
        return int(c[1])
    if tag == "f":
        return float.fromhex(c[1])
    if tag == "s":
        return str(c[1])
    if tag == "l":
        return [_dec(x) for x in c[1]]
    if tag == "t":
        return tuple(_dec(x) for x in c[1])
    if tag == "d":
        return {_dec(k): _dec(x) for k, x in c[1]}
    if tag == "x":
        return _BY_NAME[c[1]](c[2])
    raise ValueError(f"unknown value tag {tag!r}")


def encode(v):
    """v -> the text a Succy_Value carries, or None when it can't be written down exactly (or is too big)."""
    try:
        s = json.dumps(_enc(v), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (_NoCode, ValueError, TypeError, RecursionError):
        return None
    if len(s) > CODE_MAX or not same(decode(s), v):
        return None                                              # the round trip must be exact, or the wire stays
    return s


def decode(s):
    return _dec(json.loads(s))


def same(a, b):
    """Same type and same value, all the way down (nan == nan here: it is the same value, written the same way)."""
    if type(a) is not type(b):
        return False
    if type(a) is float:
        return a.hex() == b.hex()
    if isinstance(a, (list, tuple)):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return list(a.keys()) == list(b.keys()) and all(same(k, j) for k, j in zip(a, b)) and all(same(a[k], b[k]) for k in a)
    if type(a) in _TYPES:
        return _TYPES[type(a)][1](a) == _TYPES[type(b)][1](b)
    return a == b


# ---- the node as ComfyUI would call it --------------------------------------------------------------------------------------
def _declared(cls):
    try:
        d = cls.INPUT_TYPES() or {}
    except Exception:
        return None
    out = {}
    for cat in ("required", "optional"):
        for name, spec in (d.get(cat) or {}).items():
            out[name] = (spec[0] if isinstance(spec, (list, tuple)) and spec else spec, cat)
    hidden = d.get("hidden") or {}
    return out, hidden


def coerce_like_comfy(type_name, val):
    """A written value the way ComfyUI's validate_inputs hands it to the node: __value__ unwrapped, INT/FLOAT/STRING/BOOLEAN cast."""
    if isinstance(val, dict) and "__value__" in val:
        val = val["__value__"]
    if type_name == "INT":
        return int(val)
    if type_name == "FLOAT":
        return float(val)
    if type_name == "STRING":
        return str(val)
    if type_name == "BOOLEAN":
        return bool(val)
    return val


def _why_not(cls):
    """None when the class can be run here, else the reason (a generic rule, never a node's name)."""
    if getattr(cls, "SUCCY_CACHE", None) != "pure":
        return "not pure"
    if hasattr(cls, "define_schema"):
        return "v3 node"
    if hasattr(cls, "check_lazy_status"):
        return "lazy inputs"
    if any(getattr(cls, k, None) for k in ("INPUT_IS_LIST",)) or any(getattr(cls, "OUTPUT_IS_LIST", None) or ()):
        return "list semantics"
    if not isinstance(getattr(cls, "FUNCTION", None), str):
        return "no FUNCTION"
    return None


def _run_one(cls, node_id, inputs, value_of):
    """Run one pure node: inputs from the prompt, wires through value_of(src, slot) (raises _NoCode when unknown). -> (outputs, ui?)."""
    dec = _declared(cls)
    if dec is None:
        raise _NoCode("INPUT_TYPES failed")
    declared, hidden = dec
    kw = {}
    for name, (type_name, cat) in declared.items():
        if name not in inputs:
            if cat == "required":
                raise _NoCode(f"required input '{name}' missing")
            continue
        v = inputs[name]
        kw[name] = value_of(str(v[0]), int(v[1])) if isinstance(v, list) and len(v) == 2 else coerce_like_comfy(type_name, v)
    for name, kind in hidden.items():
        if kind == "UNIQUE_ID":
            kw[name] = str(node_id)
        else:
            raise _NoCode(f"hidden input {kind}")
    pure_ok = getattr(cls, "succy_cache_pure", None)
    if callable(pure_ok) and not pure_ok(kw):
        raise _NoCode("the node said no for these values")
    r = getattr(cls(), cls.FUNCTION)(**kw)
    ui = False
    if isinstance(r, dict):
        if "expand" in r:
            raise _NoCode("graph expansion")
        ui = bool(r.get("ui")) and not getattr(cls, "OUTPUT_NODE", False)
        r = r.get("result", ())
    if not isinstance(r, tuple):
        raise _NoCode("result is not a tuple")
    return r, ui


def _route_one(cls, nid, inputs, value_of):
    """A route node: {slot: input name} for the outputs that hand an input out untouched, + the ui it would have sent; or None.
    Wires the precompute knows arrive as values, the others only as names in `linked` (their value is nobody's business here)."""
    dec = _declared(cls)
    fn = getattr(cls, "succy_cache_route", None)
    if dec is None or not callable(fn):
        return None
    kw, linked = {}, set()
    for name, (type_name, cat) in dec[0].items():
        if name not in inputs:
            continue
        v = inputs[name]
        if isinstance(v, list) and len(v) == 2:
            linked.add(name)
            try:
                kw[name] = value_of(str(v[0]), int(v[1]))
            except _NoCode:
                pass
        else:
            kw[name] = coerce_like_comfy(type_name, v)
    r = fn(kw, linked)
    if not isinstance(r, dict):
        return None
    routes = {str(int(k)): n for k, n in (r.get("routes") or {}).items() if n in linked}    # only real wires: a hole has no source
    return {"routes": routes, "ui": r.get("ui")} if routes else None


def precompute(nodes, want, mapping, budget=BUDGET_S):
    """nodes = {id: {class_type, inputs}} (the pure / route part of a prompt), want = {id: [slots]} -> {"values": {id: {slot: code}},
    "routes": {id: {slot: input name}}, "route_ui": {id: ui}, "ui": [ids that must still run themselves], "skipped": {id: why}, "ms"}.
    A wire to a node not given here = unknown."""
    t0 = time.perf_counter()
    done, why, ui_ids, busy = {}, {}, [], set()

    def result(nid):
        if nid in done:
            return done[nid]
        if nid in why or nid in busy:
            raise _NoCode("upstream unknown")
        node = nodes.get(nid)
        cls = mapping.get((node or {}).get("class_type"))
        try:
            if node is None or cls is None:
                raise _NoCode("not a pure node of this prompt")
            reason = _why_not(cls) or (None if _SWITCH["pure"] else "switched off") or None
            if reason is None and node["class_type"] in _SWITCH["off"]:
                reason = "switched off for this class"
            if reason is None and not check_class(node["class_type"], cls)[0]:
                reason = "self-check failed: " + check_class(node["class_type"], cls)[1]
            if reason:
                raise _NoCode(reason)
            if time.perf_counter() - t0 > budget:
                raise _NoCode("time budget")
            busy.add(nid)
            try:
                out, ui = _run_one(cls, nid, node.get("inputs") or {}, lambda s, k: result(s)[k])
            finally:
                busy.discard(nid)
        except _NoCode as e:
            why[nid] = str(e)
            raise
        except Exception as e:                                       # the real Run will show the real error: we just step aside
            why[nid] = f"error: {type(e).__name__}: {e}"
            with _LOCK:
                _STATS["errors"] += 1
                _STATS["last_error"] = f"{node.get('class_type')} #{nid}: {type(e).__name__}: {e}"
            raise _NoCode(why[nid])
        if ui:
            ui_ids.append(nid)
        done[nid] = out
        return out

    values, routes, route_ui = {}, {}, {}
    for nid, slots in (want or {}).items():
        nid = str(nid)
        node = nodes.get(nid) or {}
        cls = mapping.get(node.get("class_type"))
        if cls is not None and getattr(cls, "SUCCY_CACHE", None) == "route":
            if not _SWITCH["pure"] or node["class_type"] in _SWITCH["off"]:
                why[nid] = "switched off"
                continue
            try:
                r = _route_one(cls, nid, node.get("inputs") or {}, lambda s, k: result(s)[k])
            except Exception as e:                                   # a route that can't tell = the switch stays where it is
                why[nid] = f"error: {type(e).__name__}: {e}"
                with _LOCK:
                    _STATS["errors"] += 1
                    _STATS["last_error"] = f"{node.get('class_type')} #{nid} (route): {type(e).__name__}: {e}"
                continue
            if r is None:
                why[nid] = "route unknown before the Run"
                continue
            routes[nid] = {k: n for k, n in r["routes"].items() if int(k) in [int(x) for x in slots]}
            if r.get("ui"):
                route_ui[nid] = r["ui"]
            continue
        try:
            out = result(nid)
        except _NoCode:
            continue
        if nid in ui_ids:
            continue                                                 # its own UI needs it to run: its wires stay
        for s in slots:
            s = int(s)
            if 0 <= s < len(out):
                code = encode(out[s])
                if code is not None:
                    values.setdefault(nid, {})[str(s)] = code
    ms = (time.perf_counter() - t0) * 1000
    with _LOCK:
        _STATS["runs"] += 1
        _STATS["nodes"] += len(done)
        _STATS["values"] += sum(len(v) for v in values.values())
        _STATS["routes"] += sum(len(v) for v in routes.values())
        _STATS["skipped"] += len(why)
        _STATS["ms"] = round(ms, 2)
        for w in why.values():
            k = w.split(":")[0]
            _STATS["why"][k] = _STATS["why"].get(k, 0) + 1
    return {"values": values, "routes": routes, "route_ui": route_ui, "ui": ui_ids, "skipped": why, "ms": round(ms, 2)}


# ---- policies, self-check, switches -----------------------------------------------------------------------------------------
_PACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _ours(cls):
    """A class written in this pack's folder (whatever name its module was loaded under)."""
    for v in vars(cls).values():                       # the file its methods were written in (__init__ never puts our modules in sys.modules)
        code = getattr(getattr(v, "__func__", v), "__code__", None)
        if code is not None:
            return os.path.abspath(code.co_filename).startswith(_PACK + os.sep)
    return False


def _default_inputs(cls):
    dec = _declared(cls)
    if dec is None:
        return None
    out = {}
    for name, (type_name, cat) in dec[0].items():
        spec = (cls.INPUT_TYPES().get(cat) or {}).get(name)
        opts = spec[1] if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict) else {}
        if "default" in opts:
            out[name] = opts["default"]
        elif isinstance(type_name, (list, tuple)) and type_name:
            out[name] = type_name[0]
        elif cat == "required":
            return None
    return out


def _no_wires(src, slot):
    raise _NoCode("no wires in a check")


def check_class(class_type, cls):
    """(ok, why) for one pure class, once per server: run it on its defaults, every output must come back from a Succy_Value
    identical (or be refused by encode, which is fine). A class that fails is left alone by the precompute: slower, never wrong."""
    if class_type in _CHECKED:
        return _CHECKED[class_type]
    res = (True, "")
    try:
        ins = _default_inputs(cls)
        if ins is not None and _why_not(cls) is None:
            out, _ = _run_one(cls, "0", ins, _no_wires)
            for i, v in enumerate(out):
                code = encode(v)
                if code is not None and not same(Succy_Value().run(code)[0], v):
                    res = (False, f"output {i} changes on the way through Succy_Value")
                    break
    except _NoCode:
        pass
    except Exception as e:
        res = (True, f"defaults don't run ({type(e).__name__}): checked by the codec only")
    _CHECKED[class_type] = res
    return res


def policies(mapping):
    """{class_type: {policy, ok, why, off}} for every Succy class ComfyUI knows. policy None = not declared (selfTest FAIL)."""
    out = {}
    for name, cls in list(mapping.items()):
        if not _ours(cls):
            continue
        p = getattr(cls, "SUCCY_CACHE", None)
        p = p if p in POLICIES else None
        ok, why = check_class(name, cls) if p == "pure" else (True, "")
        out[name] = {"policy": p, "ok": ok, "why": why, "off": name in _SWITCH["off"] or not ok,
                     **({"blocked": _why_not(cls)} if p == "pure" and _why_not(cls) else {})}
    return out


def switch(pure=None, off=None, on=None):
    """The levers: pure=False stops the precompute everywhere; off / on = class names switched off / back on."""
    with _LOCK:
        if pure is not None:
            _SWITCH["pure"] = bool(pure)
        for c in off or ():
            _SWITCH["off"].add(str(c))
        for c in on or ():
            _SWITCH["off"].discard(str(c))
        return {"pure": _SWITCH["pure"], "off": sorted(_SWITCH["off"])}


def stats(mapping):
    with _LOCK:
        pre = {**_STATS, "why": dict(_STATS["why"])}
    return {"policies": policies(mapping), "precompute": pre, "switch": switch(), "memos": memo_stats()}


# ---- the constant -------------------------------------------------------------------------------------------------------------
class Succy_Value:
    """The hidden constant a wire goes through (D-213): it holds ONE value, written by the browser from what the node really
    returned. Same text = same node = ComfyUI's own cache keeps everything after it. Never in the menu: she only works backstage."""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"value": ("STRING", {"default": "[\"N\"]"})}}

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    FUNCTION = "run"
    CATEGORY = "Succy Pack/hidden"
    DEPRECATED = True                                        # the frontend hides deprecated nodes from search and the menu
    DEV_ONLY = True
    SUCCY_CACHE = "none"

    def run(self, value='["N"]'):
        return (decode(value),)


# ---- the routes (only inside ComfyUI) ---------------------------------------------------------------------------------------
def _install_routes():
    try:
        import asyncio
        from aiohttp import web
        from server import PromptServer
        from _succy_common import same_origin
    except Exception:
        return
    srv = getattr(PromptServer, "instance", None)
    if srv is None or getattr(srv, "_succy_cache_routes", False):
        return
    srv._succy_cache_routes = True

    def mapping():
        try:
            import nodes
            return nodes.NODE_CLASS_MAPPINGS
        except Exception:
            return {}

    @srv.routes.post("/succy/cache/precompute")
    async def _precompute(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        try:
            body = await request.json()
            res = await asyncio.to_thread(precompute, body.get("nodes") or {}, body.get("want") or {}, mapping())
            return web.json_response(res)
        except Exception as e:
            with _LOCK:
                _STATS["errors"] += 1
                _STATS["last_error"] = f"route: {type(e).__name__}: {e}"
            return web.json_response({"values": {}, "ui": [], "skipped": {}, "error": str(e)})

    @srv.routes.get("/succy/cache/stats")
    async def _stats(request):
        return web.json_response(await asyncio.to_thread(stats, mapping()))

    @srv.routes.post("/succy/cache/switch")
    async def _switch(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        try:
            b = await request.json()
        except Exception:
            b = {}
        return web.json_response(switch(b.get("pure"), b.get("off"), b.get("on")))


_install_routes()
