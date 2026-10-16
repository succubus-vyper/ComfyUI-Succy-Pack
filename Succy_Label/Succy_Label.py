import server
from aiohttp import web
import aiohttp
import urllib.parse
import json
import os
import re

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
        print(f"[Succy_Label] effects/{family}.json unreadable: {e}")
        return []


# === PROXY SERVER TO GET AROUND COMFYUI'S CSP ===
routes = server.PromptServer.instance.routes


@routes.get("/succy/css_proxy")
async def succy_css_proxy(request):
    # Re-reads Fonts.json on every request: if you add a font and hit ↻ in the menu,
    # the next request includes it without restarting the server.
    fonts = _load_family("Fonts")
    # family names only (letters, digits, + : ; @ , . = -): nothing else can ride along into the Google URL
    imports = [f.get("import") for f in fonts
               if isinstance(f, dict) and isinstance(f.get("import"), str) and re.fullmatch(r"[A-Za-z0-9+:;@,.=\-]+", f["import"])]
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


# Only Google's font CDN may pass through: this route is NOT a general URL fetcher (no SSRF, no LAN peeking).
_FONT_HOSTS = ("fonts.gstatic.com",)
_FONT_MAX_BYTES = 5 * 1024 * 1024
_FONT_TYPES = ("font/", "application/font", "application/x-font", "application/octet-stream")


@routes.get("/succy/font_proxy")
async def succy_font_proxy(request):
    url = request.rel_url.query.get("url")
    if not url:
        return web.Response(status=404)
    url = urllib.parse.unquote(url)
    try:
        u = urllib.parse.urlsplit(url)
        # https only, exact host from the allowlist, default port, no credentials in the URL
        if u.scheme != "https" or u.hostname not in _FONT_HOSTS or u.port not in (None, 443) or u.username or u.password:
            return web.Response(status=403)
        async with aiohttp.ClientSession() as session:
            # allow_redirects=False: an allowed host must not bounce us to somewhere that is not
            async with session.get(url, allow_redirects=False, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    return web.Response(status=404)
                ctype = (resp.content_type or "").lower()
                if not ctype.startswith(_FONT_TYPES):
                    return web.Response(status=403)
                data = await resp.content.read(_FONT_MAX_BYTES + 1)
                if len(data) > _FONT_MAX_BYTES:
                    return web.Response(status=413)
                return web.Response(body=data, content_type=ctype, headers={"Cache-Control": "public, max-age=86400"})
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
