import json
import os

# ---------------------------------------------------------------------------
# Succy Reroute — ONLY the wire effects route (D-59)
#
# The pack's reroute is ComfyUI's NATIVE one ("Add Reroute") with the effects from
# js/Succy_NativeReroutes.js. This file reads every .json in ./effects and serves them on
#   GET /succy/reroute/effects   (re-read on every request: add a json, reload, done).
#
# No node here: __init__.py lists this file as a route-only entry ("class": None), so it is loaded for the route alone.
# ---------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
EFFECTS_DIR = os.path.join(HERE, "effects")
ROUTE = "/succy/reroute/effects"


def succy_reroute_load_effects():
    """Returns (effects, errors). Knows nothing about what's inside the jsons."""
    effects, errors, seen = [], [], set()

    if not os.path.isdir(EFFECTS_DIR):
        return effects, [f"effects folder not found: {EFFECTS_DIR}"]

    for fn in sorted(os.listdir(EFFECTS_DIR)):
        if not fn.lower().endswith(".json") or fn.startswith("_"):
            continue
        path = os.path.join(EFFECTS_DIR, fn)
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
        except Exception as e:  # broken json: we report it but don't hold the others back
            errors.append(f"{fn}: {e}")
            continue

        items = data if isinstance(data, list) else [data]
        for idx, it in enumerate(items):
            if not isinstance(it, dict):
                errors.append(f"{fn}[{idx}]: not an object")
                continue
            if not isinstance(it.get("layers"), list):
                errors.append(f"{fn}[{idx}]: missing 'layers' list")
                continue
            base = os.path.splitext(fn)[0]
            it.setdefault("id", base if len(items) == 1 else f"{base}_{idx}")
            it["id"] = str(it["id"])
            it.setdefault("name", it["id"])
            if it["id"] in seen:
                errors.append(f"{fn}: duplicate id '{it['id']}' ignored")
                continue
            seen.add(it["id"])
            it["_file"] = fn
            effects.append(it)

    def _order(e):
        o = e.get("order", 1000)
        return (o if isinstance(o, (int, float)) else 1000, e["_file"], e["id"])

    effects.sort(key=_order)
    return effects, errors


def _register_route():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception as e:
        print(f"[Succy Reroute] server not available, effects route skipped: {e}")
        return

    inst = getattr(PromptServer, "instance", None)
    if inst is None:
        return
    if getattr(inst, "_succy_reroute_route", False):
        return  # already registered (module reload)

    @inst.routes.get(ROUTE)
    async def succy_reroute_effects(request):
        effects, errors = succy_reroute_load_effects()
        for err in errors:
            print(f"[Succy Reroute] {err}")
        return web.json_response(
            {"effects": effects, "errors": errors},
            headers={"Cache-Control": "no-store"},
        )

    inst._succy_reroute_route = True


_register_route()


# Node names (and the class mapping) live ONLY in the pack's __init__.py (NODES). Nobody gets to name herself here, honey.
