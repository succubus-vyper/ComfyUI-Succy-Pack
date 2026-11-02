# ====================================================================== #
#  pb_core.py — the Prompt Builder's brain, no ComfyUI inside (D-365)     #
#  The V6 flow (gather -> parametric engines -> fields -> compose_prompt) #
#  as ONE pure function: compute(data, texts, seed, ...) -> what every    #
#  box shows, what every blue field rolled, and the final command. The    #
#  node's Run and the live view call the SAME function: what you see is   #
#  what comes out. Randomness = random.Random(seed | field | reroll),     #
#  one per field, so locking or rerolling one never moves the others.    #
#  The JSON archives are only READ (cached by mtime), never written.     #
# ====================================================================== #
import json
import os
import random
import re
import threading

try:                                       # loaded by the node file (it registers us) or imported by the tests
    import pb_engines as E                 # noqa: N812
except ImportError:                        # pragma: no cover
    from . import pb_engines as E          # type: ignore

HERE = os.path.dirname(os.path.abspath(__file__))
JSON_DIR = os.path.join(HERE, "data_engine")       # her V6 archives, byte for byte (copied by hand, not in git)
NOTE_DIR = os.path.join(HERE, "data")              # System_instructions.txt + the notecards (Bodies/, Clothes/, ...)
JSON_NAMES = ("human_bodies", "clothes", "composition_specs", "visual_engines", "backgrounds", "actions")
FOLDERS = ("Bodies", "Clothes", "Actions", "Backgrounds", "Visual_Engines", "Compositions")
SYSTEM_FILE = "System_instructions.txt"
MAX_NOTE_BYTES = 256 * 1024                         # a notecard is a page of text, not a novel
MAX_NOTES = 500                                     # per folder

NPCS = (1, 2, 3, 4)
CHAR_KEYS = ["body", "clothes"] + [f"npc{i}_{s}" for i in NPCS for s in ("body", "clothes")]
ENGINE_KEYS = ["ve", "comp", "bg", "act"]
# the text widgets (real STRING natives: each has its own EXT ring) <- the panel key
TEXT_NATIVE = {**{k: k for k in CHAR_KEYS}, "ve": "visual_engine", "comp": "composition", "bg": "background", "act": "action"}
PANELS = CHAR_KEYS + ENGINE_KEYS
VE_KEYS = ["ve_cat", "ve_eng", "ve_var"]
PARAMS = {"ve": VE_KEYS, "comp": E.COMP_KEYS, "bg": E.BG_KEYS, "act": E.ACT_KEYS}
PARAM_OWNER = {p: eng for eng, ps in PARAMS.items() for p in ps}
FOLDER_OF = {"ve": "Visual_Engines", "comp": "Compositions", "bg": "Backgrounds", "act": "Actions"}
LLM = "LLM CHOICE"
AUTO = "[AUTORESOLVE]"
REF_RE = re.compile(r"^\[REF[0-9\-\s]*\]\s*")

# The packed `data` widget (JSON, only what differs is written). SAME defaults as dev/src/Succy_Prompt_Builder.js (VDEF).
# V6 start-up state (config.UI_STARTUP_STATE): protagonist female, Body custom, Clothes random, NPC 1 female preset/preset,
# NPC 2-4 random sex custom/custom, every engine parametric, no NPC enabled.
DEFAULTS = {
    "sex": "female",
    **{f"npc{i}_sex": ("female" if i == 1 else "random") for i in NPCS},
    **{f"npc{i}_on": False for i in NPCS},
    "m_body": "custom", "m_clothes": "random",
    **{f"m_npc{i}_{s}": ("preset" if i == 1 else "custom") for i in NPCS for s in ("body", "clothes")},
    **{f"m_{k}": "parametric" for k in ENGINE_KEYS},
    **{f"p_{k}": "" for k in PANELS},              # chosen notecard (or "LLM CHOICE")
    **{f"v_{p}": "" for p in PARAM_OWNER},          # a LOCKED parameter value; "" = random (blue, from the seed)
    **{f"r_{k}": 0 for k in PANELS},                # 🎲 counter: +1 = that field rolls again, nothing else moves
    **{f"ref_{n}": "" for n in range(1, 11)},       # Ref n -> the panel holding it (one panel per number, all over the UI)
}
CHAR_MODES = ("preset", "custom", "random")
ENGINE_MODES = ("preset", "custom", "parametric")
SEXES = ("random", "female", "male", "trans")


def clean_data(raw):
    """JSON of the `data` widget -> full dict (defaults filled in, wrong types/values back to the default)."""
    try:
        d = json.loads(raw) if isinstance(raw, str) and raw.strip() else (raw if isinstance(raw, dict) else {})
    except (ValueError, TypeError):
        d = {}
    if not isinstance(d, dict):
        d = {}
    out = {}
    for k, dv in DEFAULTS.items():
        v = d.get(k, dv)
        if isinstance(dv, bool):
            v = bool(v) if isinstance(v, (bool, int)) else dv
        elif isinstance(dv, int):
            try:
                v = int(v)
            except (TypeError, ValueError):
                v = dv
        else:
            v = str(v) if v is not None else dv
        out[k] = v
    for k in CHAR_KEYS:
        if out["m_" + k] not in CHAR_MODES:
            out["m_" + k] = DEFAULTS["m_" + k]
    for k in ENGINE_KEYS:
        if out["m_" + k] not in ENGINE_MODES:
            out["m_" + k] = DEFAULTS["m_" + k]
    for k in ["sex"] + [f"npc{i}_sex" for i in NPCS]:
        if out[k] not in SEXES:
            out[k] = DEFAULTS[k]
    for n in range(1, 11):
        if out[f"ref_{n}"] not in PANELS:
            out[f"ref_{n}"] = ""
    return out


# ---------------------------------------------------------------- data on disk (read only)
_LOCK = threading.Lock()
_JSON = {}            # name -> (stamp, dict)    6 entries at most
_NOTES = {}           # folder -> (stamp, {name: text})    6 entries at most
_SYS = [None, ""]     # (stamp, text)


def _stamp(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def load_json(name):
    """One of her V6 archives, parsed once and kept until the file changes. Missing / unreadable = {} (said by missing_files)."""
    path = os.path.join(JSON_DIR, name + ".json")
    s = _stamp(path)
    with _LOCK:
        hit = _JSON.get(name)
        if hit and hit[0] == s:
            return hit[1]
    data = {}
    if s is not None:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError) as exc:
            print(f"[Succy Prompt Builder] {name}.json unreadable: {exc}")
            data = {}
    with _LOCK:
        _JSON[name] = (s, data if isinstance(data, dict) else {})
    return _JSON[name][1]


def notecards(folder):
    """{name: text} of data/<folder>/*.txt (V6 DataManager: name without .txt, content stripped). Cached by the folder's files."""
    if folder not in FOLDERS:
        return {}
    path = os.path.join(NOTE_DIR, folder)
    try:
        files = sorted(f for f in os.listdir(path) if f.lower().endswith(".txt"))[:MAX_NOTES]
    except OSError:
        files = []
    stamp = tuple((f, _stamp(os.path.join(path, f))) for f in files)
    with _LOCK:
        hit = _NOTES.get(folder)
        if hit and hit[0] == stamp:
            return hit[1]
    out = {}
    for f in files:
        try:
            if os.path.getsize(os.path.join(path, f)) > MAX_NOTE_BYTES:
                continue
            with open(os.path.join(path, f), "r", encoding="utf-8") as fh:
                out[os.path.splitext(f)[0]] = fh.read().strip()
        except OSError:
            continue
    with _LOCK:
        _NOTES[folder] = (stamp, out)
    return out


def system_text():
    path = os.path.join(NOTE_DIR, SYSTEM_FILE)
    s = _stamp(path)
    with _LOCK:
        if _SYS[0] == s and s is not None:
            return _SYS[1]
    txt = ""
    if s is not None:
        try:
            with open(path, "r", encoding="utf-8") as f:
                txt = f.read()
        except OSError:
            txt = ""
    with _LOCK:
        _SYS[0], _SYS[1] = s, txt
    return txt


DELIM = "*-_-_-_-_-_-*"


def system_parts():
    """System_instructions.txt split on her delimiter (V6 split it only for the LLM call): (System, Prompt prefix). No delimiter = all System."""
    txt = system_text()
    if DELIM in txt:
        a, b = txt.split(DELIM, 1)
        return a.strip(), b.strip()
    return txt.strip(), ""


def missing_files():
    out = [f"data_engine/{n}.json" for n in JSON_NAMES if _stamp(os.path.join(JSON_DIR, n + ".json")) is None]
    if _stamp(os.path.join(NOTE_DIR, SYSTEM_FILE)) is None:
        out.append(f"data/{SYSTEM_FILE}")
    return out


def folder_of(panel):
    if panel.endswith("body"):
        return "Bodies"
    if panel.endswith("clothes"):
        return "Clothes"
    return FOLDER_OF.get(panel)


def notecard_names(panel):
    """The Preset menu of a panel: Body / Clothes only list notecards whose name ends in .m / .f / .t (V6 rule)."""
    names = sorted(notecards(folder_of(panel)).keys(), key=str.lower)
    if panel in CHAR_KEYS:
        names = [n for n in names if n.lower().replace(".txt", "").endswith((".m", ".f", ".t"))]
    return names


# ---------------------------------------------------------------- helpers
def rng_for(seed, key, roll):
    """Each field's own dice: same seed + same field + same 🎲 count = the same roll, on any machine (str seeds hash with sha512)."""
    return random.Random(f"{int(seed)}|{key}|{int(roll)}")


def strip_ref(text):
    return REF_RE.sub("", str(text or "").strip()).strip()


def ref_tag(data, panel):
    nums = sorted(n for n in range(1, 11) if data.get(f"ref_{n}") == panel)
    return f"[REF {'-'.join(map(str, nums))}]" if nums else ""


def with_ref(data, panel, text):
    """V6 update_ref_text: the panel's [REF n-m] in front of its text (never on [AUTORESOLVE] or an empty box)."""
    base = strip_ref(text)
    tag = ref_tag(data, panel)
    if not base or not tag or AUTO in base:
        return base
    return f"{tag} {base}"


def subjects(data):
    """V6 get_subjects_string: 1 + enabled NPCs -> solo / 1_npc / 2_npcs / crowd."""
    n = 1 + sum(1 for i in NPCS if data.get(f"npc{i}_on"))
    return {1: "solo", 2: "1_npc", 3: "2_npcs"}.get(n, "crowd")


def sex_from_name(name):
    n = str(name or "").lower().replace(".txt", "")
    return "female" if n.endswith(".f") else "male" if n.endswith(".m") else "trans" if n.endswith(".t") else None


def radio_sex(data, body_key):
    return data["sex"] if body_key == "body" else data.get(body_key.split("_")[0] + "_sex", "random")


def _menu_values(spec, param):
    return list((spec.get("parameters", {}).get(param, {}) or {}).get("values", []) or [])


# ---------------------------------------------------------------- generators (V6 PromptManager)
def gen_body(rng, sex, exclude):
    body = E.HumanBodyGenerator(load_json("human_bodies"), rng)
    if sex in (None, "", "random"):
        sex = rng.choice(["male", "female"])
    for _ in range(20):
        try:
            desc = body.format_body(body.generate_random_body(sex))
        except Exception:                  # V6: a broken roll is just tried again
            continue
        if desc in exclude:
            continue
        if desc and len(desc) > 20:
            return desc, sex
    return "", sex


def gen_outfit(rng, sex, exclude):
    eng = E.ClothesEngine(load_json("clothes"), rng)
    for _ in range(20):
        outfit = eng.generate_outfit(sex=sex or "random")
        if outfit not in exclude:
            return outfit
    return eng.generate_outfit(sex=sex or "random")


def ve_pick(rng, locked):
    """V6 reroll_ve_local: the catalog filtered by the LOCKED Category / Engine / Variant, one entry at random, one variant at random.
    A value picked from the menu matches exactly; a typed piece of text matches as a substring (V6). FIX D-365: the variant
    filter looked for the text inside str(the whole list); it now looks in each variant."""
    ve = E.VisualEngine(load_json("visual_engines"))
    cat = ve.get_catalog()
    want = {k: str(locked.get(k) or "").strip() for k in VE_KEYS}

    def keep(items, field, val, var=False):
        if not val:
            return items
        low = val.lower()
        if var:
            exact = [i for i in items if any(str(v).strip() == val for v in (i["variant"] if isinstance(i["variant"], list) else [i["variant"]]))]
            return exact or [i for i in items if any(low in str(v).lower() for v in (i["variant"] if isinstance(i["variant"], list) else [i["variant"]]))]
        exact = [i for i in items if str(i[field]).strip() == val]
        return exact or [i for i in items if low in str(i[field]).lower()]

    items = keep(keep(keep(cat, "category", want["ve_cat"]), "engine", want["ve_eng"]), "variant", want["ve_var"], var=True)
    if not items:
        return None
    chosen = rng.choice(items)
    variants = chosen["variant"] if isinstance(chosen["variant"], list) else [chosen["variant"]]
    variant = want["ve_var"] or (rng.choice(variants) if variants else "")
    return {"code": chosen["code"], "ve_cat": chosen["category"], "ve_eng": chosen["engine"], "ve_var": variant,
            "text": ve.block_text(chosen["code"], variant)}


def locked_of(data, engine):
    return {p: data[f"v_{p}"].strip() for p in PARAMS[engine] if str(data.get(f"v_{p}") or "").strip() and data[f"v_{p}"].strip().lower() != "random"}


# ---------------------------------------------------------------- the whole thing
def compute(data, texts=None, seed=0, system=None, wired=None, prefix=None):
    """data: the packed widget (dict or JSON) · texts: {native name: box text} · wired: {native name: text from a wire} (a ring lit
    at Run; in the live view the last Run's value or a marker) · system / prefix: the node's own System and Prompt prefix
    ("" = that half of System_instructions.txt, D-365c).
    -> {"boxes": {panel: text shown}, "auto": {param: value}, "ve": {...}, "subjects", "final": {panel: text in the prompt},
        "prompt": str, "notes": [str]}"""
    d = clean_data(data)
    texts, wired = dict(texts or {}), dict(wired or {})
    seed = int(seed or 0)
    out = {"boxes": {}, "auto": {}, "params": {}, "final": {}, "notes": [], "subjects": subjects(d), "missing": missing_files()}

    def box(panel):
        nat = TEXT_NATIVE[panel]
        return str(wired[nat]) if nat in wired else str(texts.get(nat) or "")

    def preset_text(panel, current):
        name = d.get(f"p_{panel}", "")
        if name == LLM:
            return AUTO
        base = strip_ref(current)
        if base and AUTO not in base:
            return base                                            # the notecard as it was put in the box
        return notecards(folder_of(panel)).get(name, "")

    # ---- characters (protagonist first, then the NPCs: used bodies / outfits are never handed out twice, V6)
    used_b, used_c, rolled_sex = set(), set(), {}
    for panel in CHAR_KEYS:
        if panel.startswith("npc") and not d.get(panel.split("_")[0] + "_on"):
            continue                                               # V6: a disabled NPC is skipped, its box left alone
        nat = TEXT_NATIVE[panel]
        mode = "custom" if nat in wired else d["m_" + panel]
        cur = box(panel)
        text = preset_text(panel, cur) if mode == "preset" else strip_ref(cur) if mode == "custom" and AUTO not in cur else ""
        if not text:
            # random, or an EMPTY custom / preset box: V6 fills it at Generate (resolve_field: empty = generated)
            rng = rng_for(seed, panel, d["r_" + panel])
            if panel.endswith("body"):
                text, rolled_sex[panel] = gen_body(rng, radio_sex(d, panel), used_b)
            else:
                body_key = panel.replace("clothes", "body")
                # FIX D-365: V6's Generate dressed every random outfit as sex "random"; its 🎲 used the body's EFFECTIVE sex
                # (the notecard's .f/.m/.t, else the radio). Both now use the effective one, and a random-sex body
                # rolled just now lends its rolled sex.
                sx = None
                if d["m_" + body_key] == "preset":
                    sx = sex_from_name(d.get("p_" + body_key))
                sx = sx or rolled_sex.get(body_key) or radio_sex(d, body_key)
                text = gen_outfit(rng, sx, used_c)
            if mode == "random":
                out["boxes"][panel] = with_ref(d, panel, text)    # the box shows what the seed rolled
        final = with_ref(d, panel, text)
        out["final"][panel] = final
        if final:
            (used_b if panel.endswith("body") else used_c).add(strip_ref(final))

    # ---- Visual Engine -> Composition -> Background -> Action (the V6 cascade)
    eng_text = {}
    ve_vals = {}
    for eng in ENGINE_KEYS:
        nat = TEXT_NATIVE[eng]
        mode = "custom" if nat in wired else d["m_" + eng]
        cur = box(eng)
        locked = locked_of(d, eng)
        rng = rng_for(seed, eng, d["r_" + eng])
        settings = {}
        if mode == "parametric":
            if eng == "ve":
                pick = ve_pick(rng, locked)
                if pick is None:
                    out["notes"].append("Visual Engine: nothing in the catalog matches the locked Category / Engine / Variant")
                    text = ""
                else:
                    text = pick["text"]
                    settings = {k: pick[k] for k in VE_KEYS}
                    ve_vals = dict(settings)
            elif eng == "comp":
                ce = E.CompositionEngine(load_json("composition_specs"), rng)
                settings = ce.generate_composition(locked)
                text = ce.compose_description(settings)
            elif eng == "bg":
                be = E.BackgroundEngine(load_json("backgrounds"), rng)
                settings = be.generate_background(locked)
                text = be.compose_description(settings)
            else:
                comp = out["params"]
                ext = {"subjects": out["subjects"], "framing": comp.get("framing", ""), "viewpoint": comp.get("viewpoint", ""),
                       "aspect_ratio": comp.get("aspect_ratio", "")}
                ae = E.ActionEngine(load_json("actions"), rng)
                settings = ae.generate_action(locked, ext)
                text = ae.compose_description(settings)
            out["boxes"][eng] = with_ref(d, eng, text)
        else:
            settings = dict(locked)                                # not parametric: only what she locked is "set"
            text = preset_text(eng, cur) if mode == "preset" else strip_ref(cur)
            if eng == "ve":
                ve_vals = {k: v for k, v in locked.items()}
        for p in PARAMS[eng]:
            v = settings.get(p, "")
            out["params"][p] = v
            if p not in locked and v:
                out["auto"][p] = v
        eng_text[eng] = with_ref(d, eng, text) if text != AUTO else AUTO
        out["final"][eng] = eng_text[eng]

    f_sys, f_pre = system_parts()
    out["system"] = system.strip() if (system or "").strip() else f_sys
    out["prompt"] = compose_prompt(d, out["final"], ve_vals, prefix.strip() if (prefix or "").strip() else f_pre)
    return out


def compose_prompt(d, final, ve_vals, prefix=""):
    """V6 PromptManager.compose_prompt, same blocks and wording. Decided in D-365 (her ok, point 3):
    [OTHER ELEMENTS] keeps ONLY Ve cat / Ve eng / Ve var — the system text ends with "Shot on [Ve eng], [Ve var]" and needs them —
    and drops what V6 leaked there by accident (Sex preference, Subjects, Ref alloc N, every *_preset, the raw action values,
    even a random body rolled for an empty "Body preset"). Blocks in a fixed order (V6 followed a set's order, it changed per run)."""
    # D-365c (her request): System goes out on its own socket; the prompt = her Prompt prefix + the input blocks
    parts = ([prefix, ""] if prefix else []) + ["--- INPUT VARIABLES FOR GENERATION ---"]
    prot = [f"{lab}: {final[k]}" for k, lab in (("body", "Body"), ("clothes", "Clothes")) if final.get(k)]
    if prot:
        parts += ["\n[PROTAGONIST]", "\n".join(prot)]
    other = [f"{lab}: {ve_vals[k]}" for k, lab in (("ve_cat", "Ve cat"), ("ve_eng", "Ve eng"), ("ve_var", "Ve var")) if ve_vals.get(k)]
    if other:
        parts += ["\n[OTHER ELEMENTS]", "\n".join(other)]
    npc = [f"- NPC {i} (Body: {final.get(f'npc{i}_body', 'Any')} | Clothes: {final.get(f'npc{i}_clothes', 'Any')})"
           for i in NPCS if d.get(f"npc{i}_on")]
    parts += ["\n[NPCs]", "\n".join(npc) if npc else "None enabled."]
    parts += ["\n[VISUAL ENGINE]", final.get("ve") or "No overrides."]
    # V6 wording, "[CINEMATOGRAPHY]" included (her ok: it is the word her LLM reads)
    for blk, k in (("[CINEMATOGRAPHY]", "comp"), ("[BACKGROUND]", "bg"), ("[ACTION]", "act")):
        parts += [f"\n{blk}", final.get(k) or "No overrides."]
    return "\n".join(parts)


# ---------------------------------------------------------------- menus (the live UI asks, the JSON never travels whole)
def menu(field, data, ctx=None):
    """The entries of one parametric / VE menu, already filtered by the JSON rules against the OTHER fields as they are now
    (V6 open_parametric_menu / open_ve_menu). ctx = {param: current value} as the view shows it (locked + blue)."""
    d = clean_data(data)
    ctx = {k: str(v) for k, v in (ctx or {}).items() if isinstance(v, str) and v and v.lower() != "random"}
    if field in VE_KEYS:
        cat = E.VisualEngine(load_json("visual_engines")).get_catalog()
        c, e = ctx.get("ve_cat", ""), ctx.get("ve_eng", "")
        if field == "ve_cat":
            return sorted({i["category"] for i in cat if i["category"]})
        sel = [i for i in cat if not c or str(i["category"]).strip() == c or c.lower() in str(i["category"]).lower()]
        if field == "ve_eng":
            return sorted({i["engine"] for i in sel if i["engine"]})
        sel = [i for i in sel if not e or str(i["engine"]).strip() == e or e.lower() in str(i["engine"]).lower()]
        out = set()
        for i in sel:
            out.update(str(v) for v in (i["variant"] if isinstance(i["variant"], list) else [i["variant"]]) if v)
        return sorted(out)
    eng = PARAM_OWNER.get(field)
    if eng not in ("comp", "bg", "act"):
        return []
    spec = load_json({"comp": "composition_specs", "bg": "backgrounds", "act": "actions"}[eng])
    rules = {"comp": E.CompositionEngine, "bg": E.BackgroundEngine, "act": E.ActionEngine}[eng](spec, random.Random(0))
    current = {p: ctx[p] for p in PARAMS[eng] if p in ctx and p != field}
    if eng == "act":
        current.update({k: ctx[k] for k in ("framing", "viewpoint", "aspect_ratio") if k in ctx})
        current["subjects"] = subjects(d)
    keep = []
    for v in _menu_values(spec, field):
        test = dict(current)
        test[field] = v
        if not rules._check_hard_constraints(test):
            keep.append(v)
    return keep
