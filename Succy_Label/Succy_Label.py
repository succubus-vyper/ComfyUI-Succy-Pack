import server
from aiohttp import web
import aiohttp
import urllib.parse
import json
import os
import re
import hashlib
import time

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
    # `v=` present = she hit ↻ (or Date.now() bust from the frontend): skip the disk copy and ask Google again
    css, err = await _fetch_css(url, fresh_ok=("v" not in request.rel_url.query))
    if css is None:
        return web.Response(text=f"/* Proxy Error: {err} — local font stack in use */", content_type="text/css", headers={"Cache-Control": "no-store"})
    return web.Response(text=css, content_type="text/css", headers={"Cache-Control": "public, max-age=3600"})


# The stylesheet blocks the page while it loads: offline / firewalled / captive-portal networks must not hold the first paint
# for aiohttp's 5-minute default. 10 s like the font proxy, and the last good copy (per URL) is served when Google won't answer (A1).
_CSS_TIMEOUT_S = 10
_CSS_LAST_GOOD = {}

# Disk copy (A2): Google is asked at most once a week per font list, and never when offline once a copy exists —
# a restart no longer re-downloads (and re-flows) every font. Stale copies are still better than a naked page.
_CACHE_DIR = os.path.join(os.path.dirname(__file__), "_font_cache")
_CSS_FRESH_S = 7 * 24 * 3600


def _cache_path(key, ext):
    return os.path.join(_CACHE_DIR, hashlib.sha1(key.encode("utf-8")).hexdigest()[:20] + ext)


def _disk_read(path, max_age=None):
    try:
        if max_age is not None and time.time() - os.path.getmtime(path) > max_age:
            return None
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def _disk_write(path, data):
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except OSError as e:
        print(f"[Succy_Label] font cache not written: {e}")


async def _fetch_css(url, session_factory=None, fresh_ok=True):
    """(css, None) on success or from the last good copy; (None, reason) when there is nothing to hand out.
    Fails fast and falls back gracefully — she waits for no one, and never leaves you with an empty page.
    fresh_ok: a disk copy younger than a week is served without asking Google at all."""
    path = _cache_path(url, ".css")
    if fresh_ok:
        raw = _disk_read(path, _CSS_FRESH_S)
        if raw:
            _CSS_LAST_GOOD[url] = raw.decode("utf-8", "replace")
            return _CSS_LAST_GOOD[url], None
    try:
        async with (session_factory or aiohttp.ClientSession)(timeout=aiohttp.ClientTimeout(total=_CSS_TIMEOUT_S)) as session:
            async with session.get(url, headers={"User-Agent": "Mozilla/5.0"}) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"HTTP {resp.status}")
                css = await resp.text()
        css = css.replace("url(https://", f"url(/succy/font_proxy?v={_FONT_CACHE_V}&url=https://")      # a new v = every browser forgets the font copies it kept (D-175)
        _CSS_LAST_GOOD[url] = css
        _disk_write(path, css.encode("utf-8"))
        return css, None
    except Exception as e:
        reason = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
        if url in _CSS_LAST_GOOD:
            return _CSS_LAST_GOOD[url], None
        raw = _disk_read(path)                                  # any age: stale beats naked
        if raw:
            _CSS_LAST_GOOD[url] = raw.decode("utf-8", "replace")
            return _CSS_LAST_GOOD[url], None
        return None, reason


# Only Google's font CDN may pass through: this route is NOT a general URL fetcher (no SSRF, no LAN peeking).
_FONT_HOSTS = ("fonts.gstatic.com",)
_FONT_MAX_BYTES = 5 * 1024 * 1024
_FONT_CACHE_V = 2        # raise it whenever the proxy ever handed out a bad font: the browser keeps fonts for a day (max-age), a new number makes it ask again
_FONT_MAGIC = (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf", b"wOFF", b"wOF2")      # TrueType / OpenType / collection / WOFF / WOFF2
_FONT_TYPES = ("font/", "application/font", "application/x-font", "application/octet-stream")


_FONT_HEADERS = {"Cache-Control": "public, max-age=2592000, immutable"}      # 30 days: a bad font is fixed by raising _FONT_CACHE_V, not by waiting


def _font_mime(data):
    return {b"wOF2": "font/woff2", b"wOFF": "font/woff", b"OTTO": "font/otf"}.get(data[:4], "font/ttf")


async def _read_capped(content, cap):
    """The WHOLE body, or None when it passes `cap` bytes. (StreamReader.read(n) hands back only what has arrived so far: a big font came out
    cut in half and the browser said "Failed to decode downloaded font" — D-175.)"""
    buf = bytearray()
    async for chunk in content.iter_chunked(65536):
        buf += chunk
        if len(buf) > cap:
            return None
    return bytes(buf)


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
        fpath = _cache_path(url, ".font")                       # the URL is versioned by Google: a copy never goes stale
        kept = _disk_read(fpath)
        if kept and kept[:4] in _FONT_MAGIC:
            return web.Response(body=kept, content_type=_font_mime(kept), headers=_FONT_HEADERS)
        async with aiohttp.ClientSession() as session:
            # allow_redirects=False: an allowed host must not bounce us to somewhere that is not
            # identity: no gzip / brotli / zstd to decode on the way (one less thing that can hand the browser garbage, D-175)
            async with session.get(url, allow_redirects=False, headers={"Accept-Encoding": "identity", "User-Agent": "Mozilla/5.0"},
                                   timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    return web.Response(status=404)
                ctype = (resp.content_type or "").lower()
                if not ctype.startswith(_FONT_TYPES):
                    return web.Response(status=403)
                data = await _read_capped(resp.content, _FONT_MAX_BYTES)
                if data is None:
                    return web.Response(status=413)
                if data[:4] not in _FONT_MAGIC:                 # not a font at all: say so in the console, hand out nothing the browser would choke on
                    print(f"[Succy_Label] font_proxy: {u.path} is not a font file (first bytes {data[:8].hex()}, {len(data)} bytes, "
                          f"type {ctype}, encoding {resp.headers.get('Content-Encoding')})")
                    return web.Response(status=502)
                _disk_write(fpath, data)
                return web.Response(body=data, content_type=ctype, headers=_FONT_HEADERS)
    except Exception as e:
        print(f"[Succy_Label] font_proxy failed: {e}")
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
    SUCCY_CACHE = "none"  # SmartCache (D-213): nothing to compute
    CATEGORY = "Succy Pack"
    OUTPUT_NODE = True
    DESCRIPTION = "Styled note/label. Connect a STRING to display it during a run."

    def show(self, text=None):
        if text is None:
            return {}
        return {"ui": {"succy_text": [str(text)]}}


# Node names (and the class mapping) live ONLY in the pack's __init__.py (NODES). Nobody gets to name herself here, honey.
