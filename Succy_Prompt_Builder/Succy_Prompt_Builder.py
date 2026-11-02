import importlib.util
import json
import os
import sys

from _succy_common import refused, same_origin, say   # the shared drawer (loaded once by __init__.py)

# ====================================================================== #
#  Succy_Prompt_Builder — her V6 "Succubus Vyper Prompt Builder" as a     #
#  native node (D-365). Protagonist / NPC / Cinematography / Scene /      #
#  Settings tabs, Preset · Custom · Random cards, cascading parametric    #
#  fields filtered by her JSON rules, Ref 1-10, Global Roll, a real seed. #
#  Out: system (the System box) + prompt (Prompt prefix + input blocks). #
#  No LLM, no API key, no settings.ini: she builds, someone else talks.   #
#  Widgets:  seed (+ control_after_generate) · data (packed JSON: modes,  #
#  sexes, NPCs, notecards, locked values, 🎲 counters, Ref) · one STRING  #
#  per text box (its own EXT ring) · system_prompt / prompt_prefix        #
#  (D-376: written, or picked from the System/ and Prampt_Prefix/ notecard folders).   #
#  The brain is pb_core.compute: the Run and the live view share it.      #
# ====================================================================== #

HERE = os.path.dirname(os.path.abspath(__file__))
TAG = "Succy Prompt Builder"


def _load(name):
    """Our two sibling modules, registered under their plain names (pb_core imports pb_engines)."""
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_load("pb_engines")
core = _load("pb_core")

SEED_MAX = 0xFFFFFFFFFFFFFFFF
TEXTS = list(core.TEXT_NATIVE.values())          # body, clothes, npc1_body ... visual_engine, composition, background, action
MAX_TEXT = 200_000                                # a box bigger than this is not a prompt any more
MAX_DATA = 64_000


def _texts(kw):
    return {k: str(kw.get(k) or "")[:MAX_TEXT] for k in TEXTS}


class Succy_Prompt_Builder:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # real seed: ComfyUI's own control_after_generate rolls it (fixed by default: what you see stays what you get)
                "seed": ("INT", {"default": 0, "min": 0, "max": SEED_MAX, "control_after_generate": True}),
                "data": ("STRING", {"default": ""}),
            },
            # the boxes: real widgets so every one has its own ring (EXT v2: a wire on it = that box comes from the wire)
            "optional": {
                **{k: ("STRING", {"default": "", "multiline": True}) for k in TEXTS},
                "system_prompt": ("STRING", {"default": "", "multiline": True}),
                "prompt_prefix": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("system", "prompt")
    FUNCTION = "build"
    OUTPUT_NODE = True        # it shows its command in the node, even with nothing wired after it
    SUCCY_CACHE = "pure"      # SmartCache (D-213): text in, text out, no side effects
    CATEGORY = "Succy Pack"

    def build(self, seed=0, data="", system_prompt="", prompt_prefix="", **kw):
        miss = core.missing_files()
        if miss:
            raise RuntimeError(f"[{TAG}] missing data files in {HERE}: {', '.join(miss)} — copy them from your V6 folder")
        texts = _texts(kw)
        # every box arrives as a value here, wired or not: ComfyUI already read the wire on a lit ring
        res = core.compute(data, texts, seed, system_prompt or "", prefix=prompt_prefix or "")
        for n in res["notes"]:
            say(f"[{TAG}] {n}")
        ui = {"pb_prompt": [res["prompt"]], "pb_seed": [int(seed)], "pb_texts": [json.dumps({k: texts[k] for k in TEXTS})]}
        return {"ui": ui, "result": (res["system"], res["prompt"])}


# ---------------------------------------------------------------- routes (the live UI: menus, notecards, the view)
try:
    from aiohttp import web
    from server import PromptServer
except Exception:          # pragma: no cover — tests without ComfyUI
    PromptServer = None

if PromptServer is not None and not getattr(PromptServer.instance, "_succy_pb_routes", False):
    PromptServer.instance._succy_pb_routes = True
    routes = PromptServer.instance.routes

    async def _body(request):
        try:
            raw = await request.text()
            if len(raw) > MAX_DATA + 16 * MAX_TEXT:
                return None
            j = json.loads(raw or "{}")
            return j if isinstance(j, dict) else None
        except Exception:
            return None

    @routes.post("/succy/prompt_builder/boot")
    async def _pb_boot(request):
        # body {} -> what the node needs to start: missing files, the notecard names per panel, the system text of the file
        if not same_origin(request):
            return refused()
        core.ensure_examples()
        names = {p: core.notecard_names(p) for p in (*core.PANELS, *core.SETTING_FOLDERS)}
        return web.json_response({"missing": core.missing_files(), "notecards": names})

    @routes.post("/succy/prompt_builder/view")
    async def _pb_view(request):
        # body {seed, data, texts, wired, system} -> compute(): the boxes, the blue values, the final command. Same as the Run.
        if not same_origin(request):
            return refused()
        j = await _body(request)
        if j is None:
            return web.json_response({"error": "bad request"}, status=400)
        try:
            seed = max(0, min(SEED_MAX, int(j.get("seed") or 0)))
        except (TypeError, ValueError):
            seed = 0
        data = j.get("data") if isinstance(j.get("data"), (str, dict)) else ""
        texts = j.get("texts") if isinstance(j.get("texts"), dict) else {}
        wired = j.get("wired") if isinstance(j.get("wired"), dict) else {}
        texts = {k: str(texts.get(k) or "")[:MAX_TEXT] for k in TEXTS}
        wired = {k: str(v)[:MAX_TEXT] for k, v in wired.items() if k in TEXTS}
        try:
            res = core.compute(data, texts, seed, str(j.get("system") or "")[:MAX_TEXT], wired, str(j.get("prefix") or "")[:MAX_TEXT])
        except Exception as exc:
            return web.json_response({"error": f"{type(exc).__name__}: {exc}"})
        return web.json_response(res)

    @routes.post("/succy/prompt_builder/menu")
    async def _pb_menu(request):
        # body {field, data, ctx} -> {items: [values]}: the entries of one parametric / VE menu, filtered by the JSON rules
        if not same_origin(request):
            return refused()
        j = await _body(request)
        field = str((j or {}).get("field") or "")
        if field not in core.PARAM_OWNER:
            return web.json_response({"error": "unknown field"}, status=400)
        ctx = j.get("ctx") if isinstance(j.get("ctx"), dict) else {}
        return web.json_response({"items": core.menu(field, j.get("data") or "", ctx)})

    @routes.post("/succy/prompt_builder/notecard")
    async def _pb_note(request):
        # body {panel, name} -> {text}: one notecard's text. The name must be one the folder lists: no paths from the page
        if not same_origin(request):
            return refused()
        j = await _body(request) or {}
        panel, name = str(j.get("panel") or ""), str(j.get("name") or "")
        if panel not in core.PANELS and panel not in core.SETTING_FOLDERS:
            return web.json_response({"error": "unknown panel"}, status=400)
        notes = core.notecards(core.folder_of(panel))
        if name not in notes:
            return web.json_response({"error": "no such notecard"}, status=404)
        return web.json_response({"text": notes[name]})
