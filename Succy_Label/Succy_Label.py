import server
from aiohttp import web
import aiohttp
import urllib.parse
import json
import os

# ===================================================
# Succy_Label — backend
# The style (fonts, colors, effects) lives in the node's state on the frontend side (NodeStructure,
# note_box piece): there are NO widgets here anymore. The backend only serves:
#   - the effect JSONs from the effects/ folder (read on every request: they reload without a restart)
#   - the Google Fonts proxy (ComfyUI's CSP — we know a way around her rules)
#   - the optional `text` input (STRING): during a Queue the text reaches the frontend (ui.succy_text)
# ===================================================
_EFFECTS_DIR = os.path.join(os.path.dirname(__file__), "effects")
_FAMILIES = ("BG_Animations", "Text_Styles", "Borders_Styles", "Overlay_Patterns", "Bg_Anim_Palettes", "Fonts", "Overlay_Style")


def _load_family(family):
    try:
        with open(os.path.join(_EFFECTS_DIR, f"{family}.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("effects", data.get("items", []))
    except Exception as e:
        print(f"[Succy_Label] effects/{family}.json non leggibile: {e}")
        return []


# === PROXY SERVER TO GET AROUND COMFYUI'S CSP ===
routes = server.PromptServer.instance.routes


@routes.get("/succy/css_proxy")
async def succy_css_proxy(request):
    # Re-reads Fonts.json on every request: if you add a font and hit ↻ in the menu,
    # the next request includes it without restarting the server.
    fonts = _load_family("Fonts")
    imports = [f.get("import") for f in fonts if isinstance(f, dict) and f.get("import")]
    if not imports:
        return web.Response(text="/* No Google fonts configured */", content_type="text/css")
    url = ("https://fonts.googleapis.com/css2?family="
           + "&family=".join(imports)
           + "&display=swap")
    headers = {"User-Agent": "Mozilla/5.0"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as resp:
                css = await resp.text()
                css = css.replace("url(https://", "url(/succy/font_proxy?url=https://")
                return web.Response(
                    text=css,
                    content_type="text/css",
                    headers={"Cache-Control": "no-store, must-revalidate"},
                )
    except Exception as e:
        return web.Response(text=f"/* Proxy Error: {e} */", content_type="text/css")


@routes.get("/succy/font_proxy")
async def succy_font_proxy(request):
    url = request.rel_url.query.get("url")
    if not url:
        return web.Response(status=404)
    url = urllib.parse.unquote(url)
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                data = await resp.read()
                return web.Response(body=data, content_type=resp.content_type)
    except Exception:
        return web.Response(status=404)


# === SERVES _UI_Options.json TO THE FRONTEND ===
@routes.get("/succy/uiconfig")
async def succy_uiconfig(request):
    try:
        with open(os.path.join(_EFFECTS_DIR, "_UI_Options.json"), "r", encoding="utf-8") as f:
            return web.json_response(json.load(f))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# === SERVES THE EFFECT JSONs TO THE FRONTEND ===
@routes.get("/succy/effects/{family}")
async def succy_effects_json(request):
    family = request.match_info.get("family", "")
    if family not in _FAMILIES:
        return web.Response(status=404)
    try:
        with open(os.path.join(_EFFECTS_DIR, f"{family}.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        return web.json_response(data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


class Succy_Label:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {
                # connected: during a Queue this text becomes the note's text
                "text": ("STRING", {"forceInput": True, "tooltip": "Optional. When connected, the incoming text replaces the label text on every run."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "show"
    CATEGORY = "Succy Pack"
    OUTPUT_NODE = True
    DESCRIPTION = "Styled note/label. Connect a STRING to display it during a run."

    def show(self, text=None):
        if text is None:
            return {}
        return {"ui": {"succy_text": [str(text)]}}


# Node names (and the class mapping) live ONLY in the pack's __init__.py (NODES). Nobody gets to name herself here, honey.
