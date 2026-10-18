# ============================================================
# Succy_Multi_Parse.py - up to 15 chained text operations over up to 10 inputs (a..j).
# The UI (inputs that grow, @tokens, field names that change with the mode, debug pane) lives in
# js/Succy_Multi_Parse.js (glue) + the kit. This file only does the string-fiddling.
#   - every operation has up to 3 plain fields f1_i / f2_i / f3_i (no hidden separators, D-78)
#   - @a / @r1 tokens like Multi Math; a field made ONLY of one token passes the raw value (lists included)
#   - a broken block never kills the queue: it gives a neutral value and a red line in the debug pane (D-73 style)
# Handle with care, darling: regexes are the one thing in here that can still bite.
# D-78 - Succubus
# ============================================================
import json
import math
import re

from _succy_common import parse_bool, parse_float, parse_int, to_container   # the shared drawer (loaded once by __init__.py)

MAX_OPERATIONS = 15
INPUT_NAMES = list("abcdefghij")

MODES = [
    "CONCATENATE", "REPLACE", "REGEX", "SPLIT", "CONTAINS",
    "COMPARE", "STARTS_ENDS", "TRIM", "CASE", "SUBSTRING", "LENGTH",
]

# the little "flavour" of a mode (toggle / dropdown above its fields). First value = default.
CONCAT_KINDS = ["ALL", "TEMPLATE"]          # ALL ("Default") = every wired input glued with the separator (D-204b) · TEMPLATE = @a text @b
REGEX_KINDS = ["EXTRACT", "REPLACE"]
EDGE_KINDS = ["STARTS", "ENDS"]
CASE_KINDS = ["UPPER", "LOWER", "TITLE", "SENTENCE", "SWAP", "SNAKE", "KEBAB", "CAMEL"]
TRIM_KINDS = ["ENDS", "COLLAPSE", "NO_SPACES", "NO_BLANK_LINES"]


def text_fields(mode, kind):
    """How many TEXT fields (f1..f3) the mode reads."""
    if mode == "REGEX": return 3 if kind == "REPLACE" else 2
    if mode == "CONCATENATE": return 1 if kind == "TEMPLATE" else 0      # Default reads only the separator (f2), shown apart
    return {"REPLACE": 3, "SPLIT": 2, "CONTAINS": 2, "COMPARE": 2,
            "STARTS_ENDS": 2, "TRIM": 1, "CASE": 1, "SUBSTRING": 1, "LENGTH": 1}.get(mode, 1)


OUTPUT_FORMATS = ["STRING", "INT", "FLOAT", "BOOLEAN",
                  "LIST", "DICT", "ARRAY", "JSON", "COMBO"]

INT_MIN, INT_MAX = -9999, 9999
# The frontend gives every widget an input socket, and with 240 widgets that is O(n^2) work on every create / clone / load.
# Our widgets are all hidden config, nobody wires into them: no socket, no lag. Sweetheart, less is more.
NOSOCK = {"socketless": True}
REGEX_TIMEOUT = 2.0          # seconds, only enforceable with the `regex` module (it ships with transformers, so usually there)
try:
    import regex as _rx      # same syntax as `re` for everyday patterns, plus a REAL timeout
except Exception:            # pragma: no cover - depends on the user's python
    _rx = None
REGEX_ENGINE = "regex (2s timeout)" if _rx else "re (nested-quantifier guard, no timeout)"
# a quantified group that already holds a quantifier inside: (a+)+  (.*)*  (\w+\s*)+ ... the classic way to hang a queue
_NESTED_QUANT = re.compile(r"\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})")
MAX_PATTERN_LEN = 500        # a monster pattern is the first step towards a hung queue
MAX_TEXT_LEN = 1_000_000     # regex gets at most 1M characters to chew on

# "@@" = a literal @ ; "@a" / "@{a}" = a variable. Unknown names are left alone (so e-mails survive).
_TOKEN = re.compile(r"@@|@\{?([A-Za-z_][A-Za-z0-9_]*)\}?")
_WHOLE_TOKEN = re.compile(r"@\{?([A-Za-z_][A-Za-z0-9_]*)\}?")
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\"}


def _unescape(s):
    """Turns the typed two characters \\n \\t \\r \\\\ into the real thing (delimiters, separators, replacements)."""
    return re.sub(r"\\([ntr\\])", lambda m: _ESCAPES[m.group(1)], s)


# ---- converters (text -> the output format you picked) ----------------------------------------------------
# strict readers: a block that can't read its input raises, and the block's own error isolation turns it into a red debug line
def _parse_bool(v): return parse_bool(v, strict=True)
def _parse_int(v): return parse_int(v, strict=True)
def _parse_float(v): return parse_float(v, strict=True)
_parse_container = to_container


def _convert(val, fmt):
    if fmt == "STRING":
        return json.dumps(val, indent=2, default=_text) if isinstance(val, (dict, list)) else _text(val)
    if fmt == "COMBO": return _text(val)
    if fmt == "INT": return _parse_int(val)
    if fmt == "FLOAT": return _parse_float(val)
    if fmt == "BOOLEAN": return _parse_bool(val)
    if fmt in ("LIST", "ARRAY", "DICT", "JSON"): return _parse_container(val, fmt)
    return val


def _neutral(fmt):
    """What a block gives when it breaks: something harmless of the right type, never an exception."""
    return {"STRING": "", "COMBO": "", "INT": 0, "FLOAT": 0.0, "BOOLEAN": False,
            "LIST": [], "ARRAY": [], "DICT": {}, "JSON": {}}.get(fmt, "")


# ---- tokens & debug text ---------------------------------------------------------------------------------------
def _text(v):
    """A value as text. Tensors (an IMAGE / MASK batch, a latent's samples) become a short tag, not torch's wall of digits:
    nobody wants 3 MB of floats in a prompt, darling (D-202)."""
    shape = getattr(v, "shape", None)
    if shape is not None and hasattr(v, "dtype") and not isinstance(v, (str, bytes)):
        return f"<tensor {'x'.join(str(int(d)) for d in shape)}>"
    return str(v)


def _clean_label(raw, i):
    return re.sub(r"[^a-zA-Z0-9 _-]", "", str(raw or "")).strip()[:18] or f"r{i}"


def _show_value(v, limit=30):
    s = _text(v).replace("\r", "").replace("\n", "⏎")
    return s if len(s) <= limit else s[:limit - 3] + "..."


def _expand_text(text, env):
    """Replaces every KNOWN @key with its value as text. Unknown @words stay exactly as typed."""
    def rep(m):
        k = m.group(1)
        if k is None:
            return "@"
        return _text(env[k]) if k in env else m.group(0)
    return _TOKEN.sub(rep, text)


def _debug_expand(text, env, labels):
    def rep(m):
        k = m.group(1)
        if k is None:
            return "@"
        if k not in env:
            return m.group(0)
        return f"{labels.get(k, k)}[{_show_value(env[k])}]"
    return _TOKEN.sub(rep, str(text or "")).replace("\n", "⏎")


# ---- the operations ---------------------------------------------------------------------------------------------
def _check_regex(pat, src):
    if len(pat) > MAX_PATTERN_LEN:
        raise ValueError(f"pattern too long (max {MAX_PATTERN_LEN} characters)")
    if len(src) > MAX_TEXT_LEN:
        raise ValueError(f"text too long for regex (max {MAX_TEXT_LEN} characters)")
    if _rx is None and _NESTED_QUANT.search(pat):
        raise ValueError("pattern has a quantifier inside a quantified group, like (a+)+: it could hang the queue")


def _regex_search(pat, src):
    return _rx.search(pat, src, timeout=REGEX_TIMEOUT) if _rx else re.search(pat, src)


def _regex_sub(pat, rep, src):
    return _rx.sub(pat, rep, src, timeout=REGEX_TIMEOUT) if _rx else re.sub(pat, rep, src)


def _same(a, b):
    """COMPARE: lists/dicts compare as they are, numbers as numbers (1 == 1.0), everything else as text."""
    if isinstance(a, (list, dict)) or isinstance(b, (list, dict)):
        return a == b
    try:
        x, y = float(str(a).strip()), float(str(b).strip())
        if math.isfinite(x) and math.isfinite(y):
            return x == y
    except ValueError:
        pass
    return str(a) == str(b)


# ---- case styles (D-78): the "madafacca upper/lower" ------------------------------------------------------------
def _cap_after(text, pattern):
    """Upper-cases the first letter found right after each match of `pattern` (and at the very start). Rest untouched."""
    out = re.sub(pattern, lambda m: m.group(1) + m.group(2).upper(), "\n" + text)
    return out[1:]


def _words(text):
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)          # fooBar -> foo Bar
    return re.findall(r"[^\W_]+", spaced)


def apply_case(kind, s):
    if kind == "UPPER": return s.upper()
    if kind == "LOWER": return s.lower()
    if kind == "SWAP": return s.swapcase()
    if kind == "TITLE":                                   # first letter of every word; the rest stays as typed
        return _cap_after(s, r"(^|[\s\-_/(\[\"])([^\W\d_])")
    if kind == "SENTENCE":                                # start of text, after . ! ? and after a new line
        return _cap_after(s, r"(^|[.!?]\s+|\n\s*)([^\W\d_])")
    w = _words(s)
    if kind == "SNAKE": return "_".join(x.lower() for x in w)
    if kind == "KEBAB": return "-".join(x.lower() for x in w)
    if kind == "CAMEL": return "".join(x.lower() if n == 0 else x.capitalize() for n, x in enumerate(w))
    raise ValueError(f"unknown case style '{kind}'")


def apply_trim(kind, s):
    if kind == "COLLAPSE":                                # runs of spaces/tabs -> one space, edges trimmed, new lines kept
        return "\n".join(re.sub(r"[ \t]+", " ", ln).strip() for ln in s.strip().split("\n"))
    if kind == "NO_SPACES": return re.sub(r"\s+", "", s)
    if kind == "NO_BLANK_LINES": return "\n".join(ln for ln in s.split("\n") if ln.strip())
    return s.strip()


def concat_items(env, wired):
    """What Concat Default glues: every wired input, in order. A list counts as its items (a LIST input)."""
    out = []
    for v in (env[k] for k in wired):
        out.extend(v if isinstance(v, (list, tuple)) else [v])
    return out


def concat_separator(raw):
    """Concat Default's separator, taken exactly as typed (spaces included); empty = one space. A one-line field has no Enter,
    so \\n or /n = new line and \\t or /t = tab (both slashes: nobody remembers which one, and nobody should have to)."""
    return _unescape(re.sub(r"/([nt])", r"\\\1", raw)) if raw != "" else " "


def run_mode(mode, kind, raw, nums, env, wired=(), trim=False):
    """raw = the three text fields, nums = the two numeric slots (int or None), kind = the mode's flavour, wired = the
    inputs that are plugged (a..j, in order), trim = Concat ALL's Trim switch. Returns the raw result (the format
    conversion happens afterwards)."""
    def val(idx):                     # field -> raw value if it's ONE token, otherwise text with tokens filled in
        text = raw[idx]
        if not text:
            return ""
        w = _WHOLE_TOKEN.fullmatch(text.strip())
        if w and w.group(1) in env:
            return env[w.group(1)]
        return _expand_text(text, env)

    def txt(idx):
        return _text(val(idx))

    if mode == "CONCATENATE":
        if kind == "TEMPLATE":                       # Hello @a, you are @b — the fancy one
            return val(0)
        # Default (D-204b): every wired input + the separator, nothing else to fill in. Trim = every piece trimmed (never the
        # separator), empty ones skipped (no "a, , c"). Plug, pick a separator, done: no @a @b ritual for the simple case, darling.
        items = [_text(x) for x in concat_items(env, wired)]
        if trim:
            items = [x.strip() for x in items if x.strip()]
        return concat_separator(raw[1]).join(items)

    if mode == "REPLACE":
        find = _unescape(txt(1))
        return txt(0) if find == "" else txt(0).replace(find, _unescape(txt(2)))

    if mode == "REGEX":
        src, pat = txt(0), txt(1)
        _check_regex(pat, src)
        if kind == "REPLACE":
            return _regex_sub(pat, txt(2), src)
        m = _regex_search(pat, src)
        if not m:
            return ""
        try:
            return m.group(1 if nums[0] is None else nums[0]) or ""
        except IndexError:
            return ""

    if mode == "SPLIT":
        src = val(0)
        if isinstance(src, list):
            parts = src
        else:
            delim = _unescape(txt(1))
            parts = str(src).split(delim) if delim else list(str(src))
        return parts if nums[0] is None else parts[nums[0]]

    if mode == "CONTAINS":
        src, needle = val(0), txt(1)
        return any(str(x) == needle for x in src) if isinstance(src, (list, tuple)) else needle in str(src)

    if mode == "COMPARE":
        return _same(val(0), val(1))

    if mode == "STARTS_ENDS":
        return txt(0).endswith(txt(1)) if kind == "ENDS" else txt(0).startswith(txt(1))

    if mode == "TRIM":
        return apply_trim(kind, txt(0))

    if mode == "CASE":
        return apply_case(kind, txt(0))

    if mode == "SUBSTRING":
        return txt(0)[nums[0]:nums[1]]

    if mode == "LENGTH":
        src = val(0)
        try:
            return len(src)
        except TypeError:
            return len(str(src))

    raise ValueError(f"unknown mode '{mode}'")


class Cfg(dict):
    """The node's whole per-block configuration lives in ONE hidden JSON widget (`ops`), holding only what differs from the
    defaults. A frontend widget costs a lot (241 of them made create / clone / load crawl), a JSON string costs nothing. D-79"""
    _KINDS = {"ct": CONCAT_KINDS, "rx": REGEX_KINDS, "se": EDGE_KINDS, "cs": CASE_KINDS, "tr": TRIM_KINDS}

    def get(self, key, default=None):
        if key in self:
            return dict.get(self, key)
        m = re.fullmatch(r"(label_|mode_|format_r|ct_|rx_|se_|cs_|tr_|tm_|f[123]_|n[12]_|e[12]_|o[12]_)(\d+)", str(key))
        if not m:
            return default
        pre, idx = m.group(1), m.group(2)
        if pre == "label_": return f"Parse {idx}"
        if pre == "mode_": return "CONCATENATE"
        if pre == "format_r": return "STRING"
        if pre[:2] in self._KINDS and pre[2] == "_": return self._KINDS[pre[:2]][0]
        if pre[0] == "f": return ""
        if pre[0] == "n": return 0
        if pre[0] == "e" or pre == "tm_": return False
        return "-"                                     # o1_ / o2_: no override


def load_cfg(raw):
    """JSON text -> Cfg. Unreadable text gives all defaults (and the pane says so)."""
    try:
        data = json.loads(raw) if isinstance(raw, str) and raw.strip() else {}
        return Cfg(data) if isinstance(data, dict) else Cfg()
    except ValueError:
        return Cfg()


def pick_int(cfg, i, k, env, kinds):
    """Numeric slot k of block i: an @override (ONLY an INT: a plugged INT input or an earlier block set to INT) beats the
    stepper; the stepper counts only when its switch is On. Returns an int or None (= use the mode's default)."""
    ov = str(cfg.get(f"o{k}_{i}", "-") or "-").strip()
    if ov not in ("-", ""):
        v = env.get(ov)
        is_int = (kinds.get(ov) == "INT") if ov.startswith("r") and ov[1:].isdigit() else (isinstance(v, int) and not isinstance(v, bool))
        if not is_int:
            raise ValueError(f"@{ov} is not an INT, plug an INT or set that block to INT")
        return int(v)
    if cfg.get(f"e{k}_{i}", False):
        return max(INT_MIN, min(INT_MAX, int(cfg.get(f"n{k}_{i}", 0) or 0)))
    return None


def _kind_of(mode, cfg, i):
    key, opts = {"CONCATENATE": ("ct", CONCAT_KINDS), "REGEX": ("rx", REGEX_KINDS), "STARTS_ENDS": ("se", EDGE_KINDS),
                 "CASE": ("cs", CASE_KINDS), "TRIM": ("tr", TRIM_KINDS)}.get(mode, (None, None))
    if key is None:
        return ""
    v = str(cfg.get(f"{key}_{i}", "") or "").upper()
    return v if v in opts else opts[0]


class Succy_Multi_Parse:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {name: ("*", {"forceInput": True}) for name in INPUT_NAMES}
        optional["ops"] = ("STRING", {"default": "{}", **NOSOCK})        # all the per-block settings, packed (see Cfg)
        return {
            "required": {
                "num_operations": ("INT", {"default": 1, "min": 1, "max": MAX_OPERATIONS, "step": 1, **NOSOCK}),
            },
            "optional": optional,
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    RETURN_TYPES = ("*",) * MAX_OPERATIONS
    RETURN_NAMES = tuple(f"r{i}" for i in range(1, MAX_OPERATIONS + 1))
    FUNCTION = "compute"
    CATEGORY = "Succy Pack"
    OUTPUT_NODE = True

    def compute(self, num_operations=1, **kwargs):
        cfg = load_cfg(kwargs.get("ops"))
        env = {}
        for name in INPUT_NAMES:
            v = kwargs.get(name, "")
            env[name] = v if v is not None else ""
        wired = [name for name in INPUT_NAMES if kwargs.get(name) is not None]     # ComfyUI only passes what is plugged
        kinds = {}                                   # rN -> the format it was set to (the INT override needs it)

        n = max(1, min(MAX_OPERATIONS, int(num_operations)))
        labels = {name: name for name in INPUT_NAMES}
        for i in range(1, n + 1):
            labels[f"r{i}"] = _clean_label(cfg.get(f"label_{i}", f"Parse {i}"), i)

        results, lines = [], []
        for i in range(1, n + 1):
            mode = str(cfg.get(f"mode_{i}", "CONCATENATE") or "CONCATENATE")
            fmt = str(cfg.get(f"format_r{i}", "STRING") or "STRING").upper()
            kind = _kind_of(mode, cfg, i)
            raw = [str(cfg.get(f"f{k}_{i}", "") or "") for k in (1, 2, 3)]

            shown = " | ".join(_debug_expand(raw[k], env, labels) for k in range(text_fields(mode, kind)))
            if mode == "CONCATENATE" and kind == "ALL":
                shown = "(all wired: " + (", ".join(wired) or "none") + ")  separator " + repr(concat_separator(raw[1]))

            err = None
            nums = [None, None]
            try:
                nums = [pick_int(cfg, i, 1, env, kinds), pick_int(cfg, i, 2, env, kinds)]
                used = {"REGEX": 1 if kind == "EXTRACT" else 0, "SPLIT": 1, "SUBSTRING": 2}.get(mode, 0)
                nums = [nums[0] if used >= 1 else None, nums[1] if used >= 2 else None]
                if used:
                    shown += "  [" + ", ".join("-" if x is None else str(x) for x in nums[:used]) + "]"
                raw_val = run_mode(mode, kind, raw, nums, env, wired, bool(cfg.get(f"tm_{i}", False)))
            except Exception as e:                  # a broken block gives a neutral value and a red line, never a dead queue
                err = f"{type(e).__name__}: {e}"
                print(f"[Succy Multi Parse] r{i} ('{labels[f'r{i}']}', {mode}): {err}")
                raw_val = _neutral(fmt)
            shown = shown if shown.strip(" |") else "(empty)"
            if len(shown) > 140:
                shown = shown[:137] + "..."
            env[f"r{i}"] = raw_val                  # later blocks can use @r{i}
            kinds[f"r{i}"] = fmt

            try:
                val = _convert(raw_val, fmt)
            except Exception as e:
                err = err or f"could not convert to {fmt}: {type(e).__name__}: {e}"
                val = _neutral(fmt)
            results.append(val)

            tag = f"{mode}/{kind}" if kind else mode
            head = f'[{fmt}] "{labels[f"r{i}"]}" (r{i}) {tag}\n  rule: {shown}\n  --> '
            lines.append(f"{head}ERR {err}\n" if err else f"{head}{_show_value(val, 40)}\n")

        while len(results) < MAX_OPERATIONS:
            results.append("")

        if any(str(cfg.get(f"mode_{i}", "")) == "REGEX" for i in range(1, n + 1)):
            lines.append(f"(regex engine: {REGEX_ENGINE})")
        return {"ui": {"text": ["\n".join(lines).strip()]}, "result": tuple(results)}
