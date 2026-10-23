# ============================================================
# Succy_Multi_Math.py - up to 15 chained equations over up to 10 inputs (a..j).
# The UI (inputs that grow, @tokens, labels, debug pane) lives in js/Succy_Multi_Math.js (glue) + the kit.
# This file only does the maths, and does it without eval(): formulas are parsed to an AST and walked by a tiny
# whitelisted interpreter (numbers, + - * / // % ^, comparisons, and/or/not, a if c else b, math functions).
# Nothing else gets in. Not a dunder, not an attribute, not a 9**9**9. Safe to share workflows, sweetheart.
# D-72 - Succubus
# ============================================================
import ast
import json
import math
import re
from decimal import Decimal, ROUND_HALF_UP

MAX_EQUATIONS = 15
INPUT_NAMES = list("abcdefghij")
FORMAT_OPTIONS = ["FLOAT", "INT", "STRING", "BOOL"]

MAX_EXPR_LEN = 2000      # characters per formula
MAX_NODES = 400          # AST nodes per formula (a formula, not a novel)
MAX_ARGS = 16

# ---- whitelisted names -------------------------------------------------------------------------------
_CONSTS = {k: getattr(math, k) for k in ("pi", "e", "tau", "inf", "nan")}


def _fn_clamp(x, lo, hi):
    return max(lo, min(hi, x))


def _fn_lerp(a, b, t):
    return a + (b - a) * t


def _fn_sign(x):
    return (x > 0) - (x < 0)


def _fn_avg(*xs):
    if not xs:
        raise ValueError("avg() needs at least one value")
    return sum(xs) / len(xs)


def _fn_ifelse(c, a, b):
    return a if c else b


def _fn_factorial(n):
    # math.factorial(1e9) would happily grind for hours: floats overflow past 170! anyway, so we stop there
    if n < 0 or n != int(n) or n > 170:
        raise ValueError("factorial needs a whole number between 0 and 170")
    return math.factorial(int(n))


def _fn_round(x, nd=None):
    """Round half UP (away from zero): 2.5 -> 3, 3.5 -> 4, -2.5 -> -3. Python's round() goes to the even one; nobody asked for that, sweetie (D-99).
    Through str() so 2.675 rounds as typed, not as the float pretends."""
    x = float(x)
    if not math.isfinite(x):
        return x
    q = Decimal(1).scaleb(-int(nd or 0))
    r = Decimal(str(x)).quantize(q, rounding=ROUND_HALF_UP)
    return float(r)


_FUNCS = {k: getattr(math, k) for k in dir(math)
          if not k.startswith("_") and callable(getattr(math, k))}
_FUNCS.update({
    "abs": abs, "min": min, "max": max, "round": _fn_round, "pow": math.pow,
    "int": lambda x: float(int(x)), "float": float, "bool": lambda x: float(bool(x)),
    "factorial": _fn_factorial, "clamp": _fn_clamp, "lerp": _fn_lerp, "sign": _fn_sign, "avg": _fn_avg, "ifelse": _fn_ifelse,
})

_BINOPS = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
    ast.FloorDiv: lambda a, b: a // b,
    ast.Mod: lambda a, b: a % b,
    ast.Pow: lambda a, b: math.pow(a, b),      # math.pow raises OverflowError instead of grinding forever
}
_CMPS = {
    ast.Eq: lambda a, b: a == b, ast.NotEq: lambda a, b: a != b,
    ast.Lt: lambda a, b: a < b, ast.LtE: lambda a, b: a <= b,
    ast.Gt: lambda a, b: a > b, ast.GtE: lambda a, b: a >= b,
}


def _walk(node, env):
    """Evaluates one AST node. Everything is a float (constants are converted on sight: no bigint tricks)."""
    if isinstance(node, ast.Expression):
        return _walk(node.body, env)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (bool, int, float)):
            return float(node.value)
        raise ValueError("only numbers are allowed")
    if isinstance(node, ast.Name):
        if node.id in env:
            return env[node.id]
        if node.id in _CONSTS:
            return _CONSTS[node.id]
        raise NameError(f"unknown name '{node.id}'")
    if isinstance(node, ast.BinOp):
        op = _BINOPS.get(type(node.op))
        if op is None:
            raise ValueError("operator not allowed")
        return float(op(_walk(node.left, env), _walk(node.right, env)))
    if isinstance(node, ast.UnaryOp):
        v = _walk(node.operand, env)
        if isinstance(node.op, ast.USub):
            return -v
        if isinstance(node.op, ast.UAdd):
            return v
        if isinstance(node.op, ast.Not):
            return float(not v)
        raise ValueError("operator not allowed")
    if isinstance(node, ast.BoolOp):
        # short-circuit like python: 'a and b' gives the first falsy / last value
        v = 0.0
        for sub in node.values:
            v = _walk(sub, env)
            if isinstance(node.op, ast.And) and not v:
                return v
            if isinstance(node.op, ast.Or) and v:
                return v
        return v
    if isinstance(node, ast.Compare):
        left = _walk(node.left, env)
        for op, comp in zip(node.ops, node.comparators):
            right = _walk(comp, env)
            fn = _CMPS.get(type(op))
            if fn is None:
                raise ValueError("comparison not allowed")
            if not fn(left, right):
                return 0.0
            left = right
        return 1.0
    if isinstance(node, ast.IfExp):
        return _walk(node.body, env) if _walk(node.test, env) else _walk(node.orelse, env)
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS or node.keywords:
            raise ValueError("function not allowed")
        if len(node.args) > MAX_ARGS:
            raise ValueError("too many arguments")
        r = _FUNCS[node.func.id](*[_walk(a, env) for a in node.args])
        return float(r)
    raise ValueError(f"'{type(node).__name__}' is not allowed")


def evaluate(expr, env):
    """expr: formula text (python-ish, '^' = power). env: {name: float}. Returns float or raises."""
    expr = re.sub(r"!(?!=)", " not ", str(expr).replace("^", "**")).strip()        # `!b` reads as `not b` (D-256); `!=` stays as it is
    if len(expr) > MAX_EXPR_LEN:
        raise ValueError("formula too long")
    tree = ast.parse(expr, mode="eval")
    if sum(1 for _ in ast.walk(tree)) > MAX_NODES:
        raise ValueError("formula too complex")
    return float(_walk(tree, env))


# ---- text helpers --------------------------------------------------------------------------------------
_TOKEN = re.compile(r"@\{?([A-Za-z_][A-Za-z0-9_]*)\}?")


def _clean_label(raw, i):
    clean = re.sub(r"[^a-zA-Z0-9 _-]", "", str(raw or "")).strip()[:18]
    return clean or f"r{i}"


def _build_debug_labels(kwargs, n):
    """key -> human label for the debug pane (inputs + r1..rn)."""
    labels = {name: name for name in INPUT_NAMES}
    for i in range(1, n + 1):
        labels[f"r{i}"] = _clean_label(kwargs.get(f"label_{i}", f"Equation {i}"), i)
    return labels


def _show_value(v):
    try:
        s = str(int(v)) if isinstance(v, float) and math.isfinite(v) and v.is_integer() else str(v)
    except Exception:
        s = "?"
    return s if len(s) <= 30 else s[:27] + "..."


def _debug_expand_vars(text, env, labels):
    """Replaces every @key with 'Label[value]' for the debug pane."""
    if not text:
        return ""

    def rep(m):
        k = m.group(1)
        label = labels.get(k, k)
        return f"{label}[{_show_value(env[k])}]" if k in env else f"{label}[?]"

    return _TOKEN.sub(rep, str(text)).strip()


def _convert(raw, fmt):
    """float -> requested output format. INT / STRING refuse inf and nan (they used to crash the node)."""
    if fmt == "INT":
        if not math.isfinite(raw):
            raise ValueError(f"{raw} cannot be an INT")
        return int(_fn_round(raw))
    if fmt == "STRING":
        return str(int(raw)) if math.isfinite(raw) and raw.is_integer() else repr(raw)
    if fmt == "BOOL":
        return bool(raw)
    return float(raw)


class Cfg(dict):
    """Per-equation settings from the `ops` JSON; a missing key gives the default."""

    def get(self, key, default=None):
        if key in self:
            return dict.get(self, key)
        m = re.fullmatch(r"(label_|equation_|format_r)(\d+)", str(key))
        if not m:
            return default
        return {"label_": f"Equation {m.group(2)}", "equation_": "", "format_r": "INT"}[m.group(1)]


def load_cfg(raw):
    try:
        data = json.loads(raw) if isinstance(raw, str) and raw.strip() else {}
        return Cfg(data) if isinstance(data, dict) else Cfg()
    except ValueError:
        return Cfg()


class Succy_Multi_Math:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {name: ("*", {"forceInput": True}) for name in INPUT_NAMES}

        # labels, equations and formats live packed in ONE hidden JSON widget (only non-defaults are stored): 45 frontend widgets
        # made the node slow to create / clone / load. The UI side is NodeStructure's `packed` (D-79).
        optional["ops"] = ("STRING", {"default": "{}"})

        return {
            "required": {
                "num_equations": ("INT", {"default": 1, "min": 1, "max": MAX_EQUATIONS, "step": 1}),
            },
            "optional": optional,
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    RETURN_TYPES = ("*",) * MAX_EQUATIONS
    RETURN_NAMES = tuple(f"r{i}" for i in range(1, MAX_EQUATIONS + 1))
    FUNCTION = "compute"
    SUCCY_CACHE = "pure"  # SmartCache (D-213): same inputs = same numbers: precomputed, each wire carries only its result
    CATEGORY = "Succy Pack"
    OUTPUT_NODE = True

    def compute(self, num_equations=1, **kwargs):
        cfg = load_cfg(kwargs.get("ops"))
        env = {}
        notes = []
        for name in INPUT_NAMES:
            val = kwargs.get(name, 0.0)
            try:
                env[name] = float(val) if val is not None else 0.0
            except Exception:                      # an IMAGE batch raises RuntimeError, not ValueError: it used to kill the node (D-202)
                env[name] = 0.0
                shape = getattr(val, "shape", None)
                what = f"{type(val).__name__} {list(shape)}" if shape is not None else type(val).__name__
                notes.append(f"input {name}: '{what}' is not a number, using 0")

        n = max(1, min(MAX_EQUATIONS, int(num_equations)))
        labels = _build_debug_labels(cfg, n)
        results, lines = [], []

        for i in range(1, n + 1):
            raw_expr = cfg.get(f"equation_{i}", "") or ""
            fmt = str(cfg.get(f"format_r{i}", "INT") or "INT").upper()
            expr = _TOKEN.sub(lambda m: m.group(1), str(raw_expr)).strip()
            shown = _debug_expand_vars(raw_expr, env, labels) or "(empty)"
            err = None
            raw = 0.0
            if expr:
                try:
                    raw = evaluate(expr, env)
                except Exception as e:             # a broken formula gives 0 and a red line, never a dead queue
                    err = f"{type(e).__name__}: {e}"
                    print(f"[Succy Multi Math] eq {i} ('{expr}'): {err}")
                    raw = 0.0
            env[f"r{i}"] = raw                     # later formulas can use @r{i}
            try:
                val = _convert(raw, fmt)
            except Exception as e:
                err = err or f"{type(e).__name__}: {e}"
                val = _convert(0.0, fmt)
            results.append(val)
            head = f'[{fmt.capitalize()}]"{labels[f"r{i}"]}" (r{i}) = {shown}'
            lines.append(f"{head}  ->  ERR {err}" if err else f"{head}  ->  {val}")

        lines.extend(notes)
        while len(results) < MAX_EQUATIONS:
            results.append(0.0)

        return {"ui": {"text": ["\n".join(lines).strip()]}, "result": tuple(results)}
