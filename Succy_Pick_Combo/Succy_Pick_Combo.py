import json

from _succy_common import ANY, convert_text   # the shared drawer (loaded once by __init__.py)

# ====================================================================== #
#  Succy_Pick_Combo — multi-column "Pick Combo" (D-67)                    #
#  Table: rows (label) x columns (cmb1..cmbN, max 8). You pick ONE         #
#  row; each column comes out of its own socket, converted to its format. #
#  The data arrives from the frontend in the hidden `table` widget (JSON): #
#     {"fmt": ["STRING", ...], "rows": [["label", "v1", ..., "v8"], ...]}  #
#  Outputs (LIVE order, the frontend keeps the sockets matched):          #
#     cmb1..cmbN, index, label, picked   (+ padding up to 11)
#  `picked` = "List of Picked": the chosen row as a REAL list, each value in its column's format.                 #
# ====================================================================== #

MAX_ROWS = 20
MAX_COLS = 8
FORMATS = ["STRING", "INT", "FLOAT", "BOOLEAN", "LIST", "DICT", "ARRAY", "JSON", "COMBO"]


def _pc_convert(raw_value, output_format):
    return convert_text(raw_value, output_format, tag="Succy Pick Combo")


class PickedFloat(float):
    """A float that remembers how it was written: "2.0000" stays 2.0000, a bare "2" shows as 2.00.
    Math sees a plain float; only the printed list (preview, str()) wears the decimals. Dressed to be read."""
    def __new__(cls, value, text):
        obj = super().__new__(cls, value)
        obj._text = text
        return obj

    def __repr__(self):
        return self._text

    __str__ = __repr__


# SmartCache (D-213): a PickedFloat goes through the hidden Succy_Value with its decimals, exactly as it left.
# SmartCache missing (its file broken) = the Combo still loads: its List of Picked just stays on its wire.
try:
    from _succy_cache import register_type
    register_type(PickedFloat, "PickedFloat", lambda v: [float(v).hex(), v._text], lambda j: PickedFloat(float.fromhex(j[0]), j[1]))
except ImportError:
    pass


def _pc_float_text(raw, value):
    """The text a picked float prints with: her own decimals if she wrote some, otherwise two."""
    s = str(raw).strip()
    if s and "." in s and "e" not in s.lower():
        try:
            if float(s) == value:
                return s.lstrip("+")
        except ValueError:
            pass
    return f"{value:.2f}"


def _pc_picked(row, fmt, k):
    """List of Picked: the chosen row's values, each converted to its column's format.
    Strings print with quotes, INT and FLOAT without (FLOAT keeps its decimals, see PickedFloat)."""
    out = []
    for c in range(k):
        v = _pc_convert(row[1 + c], fmt[c])
        if fmt[c] == "FLOAT" and isinstance(v, float):
            v = PickedFloat(v, _pc_float_text(row[1 + c], v))
        out.append(v)
    return out


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
                "choice_in":      (ANY, {"forceInput": True}),
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, choice=None, **kwargs):
        # the `choice` list belongs to the single node (frontend): don't validate it against options=[]
        return True

    RETURN_TYPES = (ANY,) * (MAX_COLS + 3)
    RETURN_NAMES = tuple(f"cmb{i}" for i in range(1, MAX_COLS + 1)) + ("index", "label", "picked")
    FUNCTION = "run"
    SUCCY_CACHE = "pure"  # SmartCache (D-213): each wire carries only its own cell (was the D-211 splitter)
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
            if isinstance(choice_in, (int, float)) and not isinstance(choice_in, bool):
                idx = int(choice_in)                  # a whole number plugged into the chip door = the row INDEX
                ch = None
            else:
                ch = str(choice_in if choice_in is not None else choice).strip()
            if ch is None:
                pass
            elif 0 <= sel < n and labels[sel].strip() == ch:
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
        out = values + [idx, labels[idx], _pc_picked(row, fmt, k)]
        out += [None] * (MAX_COLS + 3 - len(out))
        return tuple(out)
