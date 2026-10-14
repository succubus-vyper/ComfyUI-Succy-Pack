import ast
import json

# ====================================================================== #
#  Succy_Pick_Combo — multi-column "Pick Combo" (D-67)                    #
#  Table: rows (label) x columns (cmb1..cmbN, max 8). You pick ONE         #
#  row; each column comes out of its own socket, converted to its format. #
#  The data arrives from the frontend in the hidden `table` widget (JSON): #
#     {"fmt": ["STRING", ...], "rows": [["label", "v1", ..., "v8"], ...]}  #
#  Outputs (LIVE order, the frontend keeps the sockets matched):          #
#     cmb1..cmbN, index, label, all   (+ padding up to 11)                 #
# ====================================================================== #

MAX_ROWS = 20
MAX_COLS = 8
FORMATS = ["STRING", "INT", "FLOAT", "BOOLEAN", "LIST", "DICT", "ARRAY", "JSON", "COMBO"]


def _pc_parse_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("true", "1", "yes", "on", "y", "t"):
            return True
        if v in ("false", "0", "no", "off", "n", "f", ""):
            return False
    return bool(value)


def _pc_parse_number(s: str, as_int: bool):
    """Number from the string; if it isn't a number -> 0 and a console warning (it used to silently become 1)."""
    try:
        f = float(s)
        return int(round(f)) if as_int else f
    except (ValueError, TypeError):
        if str(s).strip():
            print(f"[Succy Pick Combo] '{str(s)[:40]}' is not a number -> 0")
        return 0 if as_int else 0.0


_PC_LIST_TYPES = ("LIST", "ARRAY")
_PC_DICT_TYPES = ("JSON", "DICT")


def _pc_coerce_container(value, output_type):
    if output_type in _PC_LIST_TYPES:
        return value if isinstance(value, list) else [value]
    if output_type in _PC_DICT_TYPES:
        return value if isinstance(value, dict) else {"value": value}
    return value


def _pc_parse_json_or_literal(source: str, output_type):
    try:
        return _pc_coerce_container(json.loads(source), output_type)
    except (json.JSONDecodeError, TypeError):
        pass
    try:
        return _pc_coerce_container(ast.literal_eval(source), output_type)
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        pass
    if output_type in _PC_LIST_TYPES:
        lines = [line.strip() for line in source.split("\n") if line.strip()]
        return lines if len(lines) > 1 else [source]
    if output_type in _PC_DICT_TYPES:
        return {"value": source}
    return source


def _pc_convert(raw_value, output_format):
    fmt = (output_format or "STRING").upper()
    s = "" if raw_value is None else str(raw_value)
    if fmt in ("STRING", "COMBO"):
        return s
    if fmt == "INT":
        return _pc_parse_number(s, True)
    if fmt == "FLOAT":
        return _pc_parse_number(s, False)
    if fmt == "BOOLEAN":
        return _pc_parse_bool(s)
    if fmt in ("LIST", "ARRAY", "DICT", "JSON"):
        return _pc_parse_json_or_literal(s, fmt)
    return s


class AnyType(str):
    """Wildcard for ComfyUI's type-checker. Goes with anything."""
    def __ne__(self, __value):
        return False


ANY = AnyType("*")


def _pc_table(raw):
    """JSON of the `table` widget -> (fmt[8], rows[20][1+8]) always complete."""
    try:
        t = json.loads(raw) if isinstance(raw, str) and raw.strip() else {}
    except (json.JSONDecodeError, TypeError):
        print("[Succy Pick Combo] table JSON unreadable -> empty table")
        t = {}
    if not isinstance(t, dict):
        t = {}
    fmt = [str(f).upper() for f in (t.get("fmt") or []) if f is not None][:MAX_COLS]
    fmt += ["STRING"] * (MAX_COLS - len(fmt))
    fmt = [f if f in FORMATS else "STRING" for f in fmt]
    rows = []
    for r in (t.get("rows") or [])[:MAX_ROWS]:
        r = [("" if c is None else str(c)) for c in (r if isinstance(r, list) else [r])][: MAX_COLS + 1]
        rows.append(r + [""] * (MAX_COLS + 1 - len(r)))
    while len(rows) < MAX_ROWS:
        rows.append([f"Option {len(rows) + 1}"] + [""] * MAX_COLS)
    return fmt, rows


class Succy_Pick_Combo:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "num_options":    ("INT", {"default": 2, "min": 1, "max": MAX_ROWS, "step": 1}),
                "num_values":     ("INT", {"default": 1, "min": 1, "max": MAX_COLS, "step": 1}),
                "selected_index": ("INT", {"default": 0, "min": 0, "max": MAX_ROWS - 1, "step": 1}),
                # EXT: the row is picked by NAME with the `choice` dropdown (pluggable from outside)
                "use_choice":     ("BOOLEAN", {"default": False}),
                # Dynamic COMBO: the entries (= labels) are set by the frontend for each node
                "choice":         ("COMBO", {"options": [], "default": "Option 1"}),
                "table":          ("STRING", {"default": ""}),
            },
            # EXT chip door (D-86): a real socket that takes the row NAME from any STRING source. The frontend only shows it
            # in Chip mode; unplugged or hidden, `choice` (the widget) speaks for itself.
            "optional": {
                "choice_in":      ("STRING", {"forceInput": True}),
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, choice=None, **kwargs):
        # the `choice` list belongs to the single node (frontend): don't validate it against options=[]
        return True

    RETURN_TYPES = (ANY,) * (MAX_COLS + 3)
    RETURN_NAMES = tuple(f"cmb{i}" for i in range(1, MAX_COLS + 1)) + ("index", "label", "all")
    FUNCTION = "run"
    CATEGORY = "Succy Pack"

    def run(self, num_options, num_values, selected_index, use_choice=False, choice="",
            table="", choice_in=None, **kwargs):
        n = max(1, min(MAX_ROWS, int(num_options)))
        k = max(1, min(MAX_COLS, int(num_values)))
        fmt, rows = _pc_table(table)
        rows = rows[:n]
        labels = [r[0] for r in rows]
        sel = max(0, min(int(selected_index), n - 1))

        idx = None
        # 1) EXT: by name (the `choice` widget can be wired from outside through a reroute).
        #    With duplicate labels the chosen row wins if it has that name, otherwise the first one.
        if use_choice:
            # the chip door wins when somebody is plugged into it (she brought her own date), else the widget
            ch = str(choice_in if choice_in is not None else choice).strip()
            if 0 <= sel < n and labels[sel].strip() == ch:
                idx = sel
            else:
                for i, lbl in enumerate(labels):
                    if lbl.strip() == ch:
                        idx = i
                        break
            if idx is None:
                print(f"[Succy Pick Combo] choice '{ch[:40]}' is not a label -> row {sel}")
        # 2) row chosen in the node — her own pick, no outside influence
        if idx is None:
            idx = sel
        idx = max(0, min(idx, n - 1))

        row = rows[idx]
        values = [_pc_convert(row[1 + c], fmt[c]) for c in range(k)]
        all_json = json.dumps([r[: 1 + k] for r in rows], ensure_ascii=False)
        out = values + [idx, labels[idx], all_json]
        out += [None] * (MAX_COLS + 3 - len(out))
        return tuple(out)
