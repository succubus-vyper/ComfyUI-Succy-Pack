// ============================================================
// NodeStructure/fx/store.js — effects store (from the backend, never hardcoded)
// One store per route. Used by effects_system / deck_system / params_system and by the renderers.
// ============================================================
import { EXPR_CACHE } from "./engine.js";

export const FALLBACK = {
    id: "__fallback__", name: "Plain", params: [],
    layers: [{ type: "stroke", color: "auto", width: 3 }],
    skin: [{ type: "disc", color: "#4b5552", radius: 1 }, { type: "disc", color: "#707c78", radius: 0.66 }],
};

const STORES = new Map();
export function getStore(route) {
    let s = STORES.get(route);
    if (!s) { s = { route, list: [], byId: new Map(), loaded: false, loading: null, errors: [], listeners: new Set() }; STORES.set(route, s); }
    return s;
}

let _api = null;
async function comfyApi() {
    if (_api) return _api;
    try { _api = (await import("../../../../scripts/api.js")).api; } catch (_) { _api = globalThis.app?.api || null; }
    return _api;
}

export function loadEffects(route, force = false) {
    const st = getStore(route);
    if (st.loading && !force) return st.loading;
    st.loading = (async () => {
        try {
            // "/__none__..." = no backend (catalog examples in selfTest): empty store, no fetch, no warning
            if (String(route).startsWith("/__none__")) { st.list = []; st.byId = new Map(); st.errors = []; st.loaded = true; return; }
            const a = await comfyApi();
            const r = await a.fetchApi(route + "?_=" + Date.now(), { cache: "no-store" });
            if (!r.ok) throw new Error(`HTTP ${r.status} on ${route}`);
            const j = await r.json();
            const list = Array.isArray(j?.effects) ? j.effects : [];
            st.list = list; st.byId = new Map(list.map((e) => [e.id, e]));
            st.errors = Array.isArray(j?.errors) ? j.errors : []; st.loaded = true;
            EXPR_CACHE.clear();
        } catch (e) { console.warn("[NodeStructure/fx] cannot load effects:", e); }
        finally { st.loading = null; }
        for (const fn of st.listeners) { try { fn(); } catch (_) {} }
    })();
    return st.loading;
}

export function isAnimated(e) {
    if (e._rrAnim === undefined) {
        let s = ""; try { s = JSON.stringify([e.layers, e.skin]); } catch (_) {}
        e._rrAnim = (typeof e.animated === "boolean") ? e.animated : /"dots"|"orbit"|"pulse"|"spin"|speed|Speed|\bt\b/.test(s);
    }
    return e._rrAnim;
}
