// ============================================================
// NodeStructure/fx/note-store.js — effect data for note_box (read from the node's folder)
// ------------------------------------------------------------
// The glue declares WHERE the JSONs live (config.note_box = { route, ui, fonts, families }):
//   route    families prefix  (route + families.<role>  -> JSON {effects|items:[...]})
//   ui       JSON {defaults:{key:value}, items:{key:{default, options:[{id,label,...}]}}}
//   fonts    font CSS stylesheet (the node backend's proxy); optional
//   families role -> file name (background, text, border, pattern, palette, fonts, overlayStyle)
// Here: loading, reload without restart, effects CSS ("css" field of the JSONs), fonts,
// defaults and reading style values. No node DOM, no drawing (that's pieces/note.js).
// Formerly Succy_Label.js v5 (loader, _succyDefault*, palette, pattern duration): logic unchanged.
// ============================================================
import { updateCss } from "../theme/theme.js";

export const ROLES = ["background", "text", "border", "pattern", "palette", "fonts", "overlayStyle"];

// style key -> where it takes its choices/defaults from (the note_box contract)
export const KEYMAP = {
    font_family: ["fam", "fonts"], bg_style: ["fam", "background"], bg_palette: ["fam", "palette"],
    pattern: ["fam", "pattern"], pattern_animation: ["fam", "overlayStyle"], text_style: ["fam", "text"], border_style: ["fam", "border"],
    align: ["ui", "align"], align_vertical: ["ui", "align_vertical"], pattern_blend: ["ui", "pattern_blend"], bg_grad_style: ["ui", "gradient"],
};
// every style key read by note_box — her whole wardrobe
export const STYLE_KEYS = [
    "font_size", "font_family", "font_color", "line_height", "align", "align_vertical", "padding",
    "text_style", "text_style_color", "text_style_color_b", "text_style_intensity", "text_style_speed",
    "border_style", "border_width", "border_radius", "border_glow", "border_color", "border_color_b", "box_shadow", "box_shadow_color",
    "bg_color", "bg_grad_style", "bg_grad_balance", "bg_grad_softness", "bg_grad_color",
    "bg_style", "bg_speed", "bg_palette", "bg_color_a", "bg_color_b", "bg_color_c",
    "pattern", "pattern_animation", "pattern_speed", "pattern_blend", "pattern_color", "pattern_color_b",
];

const STORES = new Map();
const FONT_LINK = "succy-ns-note-fonts";

function blank(cfg) {
    const fam = {};
    for (const r of ROLES) fam[r] = new Map();
    return { cfg, loaded: false, loading: null, errors: [], fam, ui: new Map(), defaults: new Map(), listeners: new Set(), gen: 0 };
}

export function noteStore(cfg = {}) {
    const key = `${cfg.route || ""}|${cfg.ui || ""}`;
    let s = STORES.get(key);
    if (!s) { s = blank(cfg); s.key = key; STORES.set(key, s); }
    return s;
}

async function getJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
}

// loads everything; on error it does NOT replace already loaded data (like the old reload: "invalid JSON -> cancelled")
export function loadNote(s, force = false) {
    if (s.loading) return s.loading;
    if (s.loaded && !force) return Promise.resolve(s);
    const c = s.cfg, fams = c.families || {};
    s.loading = (async () => {
        const next = blank(c);
        const errors = [];
        await Promise.all(ROLES.map(async (role) => {
            if (!fams[role]) return;
            try {
                const d = await getJson(String(c.route || "") + fams[role]);
                for (const e of d.effects || d.items || []) if (e && e.id) next.fam[role].set(e.id, e);
            } catch (e) { errors.push(`${role}: ${e.message || e}`); console.warn(`[NodeStructure] note_box: font family '${role}' not loaded:`, e); }
        }));
        if (c.ui) {
            try {
                const d = await getJson(c.ui);
                for (const [k, v] of Object.entries(d.items || {})) next.ui.set(k, v);
                for (const [k, v] of Object.entries(d.defaults || {})) next.defaults.set(k, v);
            } catch (e) { errors.push(`ui: ${e.message || e}`); console.warn("[NodeStructure] note_box: ui config not loaded:", e); }
        }
        s.errors = errors;
        if (!errors.length || !s.loaded) { s.fam = next.fam; s.ui = next.ui; s.defaults = next.defaults; }
        s.loaded = true; s.gen++;
        injectCss(s); ensureFonts(s, force);
        for (const fn of [...s.listeners]) { try { fn(); } catch (_) {} }
        return s;
    })().finally(() => { s.loading = null; });
    return s.loading;
}

// Effects CSS (keyframes, [data-text-style=..] selectors etc.): one sheet PER STORE (config), replaced on reload.
// (D-60: a single shared sheet got emptied by another store, e.g. the selfTest example with a fake route)
function injectCss(s) {
    if (!Object.keys(s.cfg.families || {}).length) return;
    const chunks = [];
    for (const m of Object.values(s.fam)) for (const e of m.values()) if (e && typeof e.css === "string" && e.css.trim() && !e.css.includes("{{")) chunks.push(`/* ${e.id} */\n${e.css}`);
    updateCss("note-fx-" + String(s.key).replace(/[^\w]/g, "_").slice(0, 48), chunks.join("\n\n") || "/* note fx: vuoto */");
}

function ensureFonts(s, bust) {
    if (!s.cfg.fonts) return;
    try {
        let l = document.getElementById(FONT_LINK);
        const href = s.cfg.fonts + (bust ? (s.cfg.fonts.includes("?") ? "&" : "?") + "v=" + Date.now() : "");
        if (!l) { l = document.createElement("link"); l.id = FONT_LINK; l.rel = "stylesheet"; l.href = href; document.head.appendChild(l); }
        else if (bust) l.href = href;
    } catch (e) { console.warn("[NodeStructure] note_box: fonts not loaded:", e); }
}

// ---------- reads ----------
export const entry = (s, role, id) => s.fam[role]?.get(id) || null;
export function defaultId(s, role) {
    for (const e of s.fam[role]?.values() || []) if (e.default === true) return e.id;
    return role === "fonts" ? "system-ui" : null;
}
export const uiOptions = (s, key) => s.ui.get(key)?.options || [];
export const uiDefault = (s, key) => s.ui.get(key)?.default || "";

export function defaultOf(s, key) {
    const m = KEYMAP[key];
    if (m?.[0] === "fam") return defaultId(s, m[1]);
    if (m?.[0] === "ui") return uiDefault(s, m[1]);
    return s.defaults.get(key);
}

// choices for a key as [{value,label}] (family or ui options)
export function optionsOf(s, key) {
    const m = KEYMAP[key];
    if (m?.[0] === "fam") return [...(s.fam[m[1]]?.values() || [])].map((e) => ({ value: e.id, label: e.label || e.id }));
    if (m?.[0] === "ui") return uiOptions(s, m[1]).map((o) => ({ value: o.id, label: o.label || o.id }));
    return [];
}

// effective value: saved JSON (all sections {section:{key:value}}) on top of the JSON defaults
export function readSaved(raw) {
    let o = {};
    try { o = typeof raw === "string" && raw ? JSON.parse(raw) : {}; } catch (_) { o = {}; }
    const flat = {};
    if (o && typeof o === "object" && !Array.isArray(o)) for (const sec of Object.values(o)) if (sec && typeof sec === "object" && !Array.isArray(sec)) Object.assign(flat, sec);
    return flat;
}
export function valuesOf(s, raw) {
    const saved = readSaved(raw), out = {};
    for (const k of STYLE_KEYS) { const v = saved[k]; out[k] = v !== undefined && v !== null && v !== "" ? v : defaultOf(s, k); }
    return out;
}

// ---------- colors / timings (formerly Succy_Label.js, unchanged) ----------
export function normColor(v, fallback) {
    if (typeof v !== "string") return fallback;
    let x = v.trim().toLowerCase();
    if (x === "" || x === "transparent") return "#00000000";
    if (!x.startsWith("#")) x = "#" + x;
    if (/^#[0-9a-f]{8}$/.test(x)) return x;
    if (/^#[0-9a-f]{6}$/.test(x)) return x + "ff";
    if (/^#[0-9a-f]{4}$/.test(x)) return `#${x[1]}${x[1]}${x[2]}${x[2]}${x[3]}${x[3]}${x[4]}${x[4]}`;
    if (/^#[0-9a-f]{3}$/.test(x)) return `#${x[1]}${x[1]}${x[2]}${x[2]}${x[3]}${x[3]}ff`;
    return fallback;
}
export function hexRgb(hex) {
    const h = (hex || "#000000").replace("#", "");
    return { r: parseInt(h.substring(0, 2), 16) || 0, g: parseInt(h.substring(2, 4), 16) || 0, b: parseInt(h.substring(4, 6), 16) || 0 };
}
export function hexAlpha(hex) { return hex && hex.length === 9 ? parseInt(hex.substring(7, 9), 16) / 255 : 1; }
export function hexRgba(hex) { const { r, g, b } = hexRgb(hex); return `rgba(${r},${g},${b},${hexAlpha(hex)})`; }

// scroll cycle duration of the pattern: constant px/s across different patterns
export function patternDuration(s, tile, speed) {
    const sMin = 0.1, sMax = 10;
    const sFall = Number(s.defaults.get("pattern_speed")) || 5;
    const sp = Math.max(sMin, Math.min(sMax, Number(speed) || sFall));
    const velocity = 1.5 + 5 * sp;
    const t = Math.max(1, Number(tile) || 20);
    return Math.max(0.1, t / velocity);
}

// animated background palette: JSON preset or the user's 3 colors; 2-color effects repeat the second one
export function bgPalette(s, v) {
    const pal = v.bg_palette, def = defaultId(s, "palette");
    const preset = pal !== def ? entry(s, "palette", pal) : null;
    const cols = preset && Array.isArray(preset.colors) && !preset.noResolve ? preset.colors.slice() : [normColor(v.bg_color_a, "#000000ff"), normColor(v.bg_color_b, "#888888ff"), normColor(v.bg_color_c, "#ffffffff")];
    const e = entry(s, "background", v.bg_style);
    const n = e && typeof e.colors === "number" && e.colors > 0 ? e.colors : 3;
    return n < 3 ? [cols[0], cols[1] || cols[0], cols[1] || cols[0]] : [cols[0], cols[1] || cols[0], cols[2] || cols[1] || cols[0]];
}
