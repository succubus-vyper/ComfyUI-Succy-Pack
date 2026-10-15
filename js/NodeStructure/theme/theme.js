// ============================================================
// NodeStructure/theme/theme.js
// ------------------------------------------------------------
// Single theme: CSS tokens (--ns-*) + stylesheet. The same text
// serves both light DOM (injected once into <head>, all the
// rules under `.ns-root`) and Shadow DOM (constructable
// stylesheet adopted by the shadow root, with a <style> fallback).
//
// Isolation from Vue/Tailwind CSS: in light DOM we rely on the
// `ns-` prefix and a local reset on .ns-root; in Shadow DOM
// the isolation is real. See DECISIONS.md.
//
// Continuous animations (glow/conic): ONLY inside `.ns-glow`, and they
// stop with  [data-ns-anim="off"]  (set by AnimGate). The glow is earned.
// ============================================================

export const TOKENS_DARK = {
    "--ns-bg": "#1a1a1a",
    "--ns-bg-2": "rgba(0,0,0,0.35)",
    "--ns-bg-3": "rgba(0,0,0,0.5)",
    "--ns-fg": "#ddd",
    "--ns-fg-dim": "#888",
    "--ns-fg-faint": "#666",
    "--ns-accent": "#4a9eff",
    "--ns-accent-fg": "#7cbcff",
    "--ns-warn": "#ffb84d",
    "--ns-danger": "#e07070",
    // tone palette (D-82): segmented options, status_box, action buttons. Names say the MEANING, hex says the mood.
    "--ns-t-info": "#7cbcff",
    "--ns-t-warn": "#ffaa00",
    "--ns-t-danger": "#ff4444",
    "--ns-t-ok": "#3ddc84",
    "--ns-t-orange": "#ff6600",
    "--ns-t-out": "#22d3c5",
    "--ns-t-calm": "#9fb3c8",
    "--ns-t-mute": "#666666",
    "--ns-border": "rgba(255,255,255,0.10)",
    "--ns-border-hi": "rgba(74,158,255,0.55)",
    "--ns-radius": "6px",
    "--ns-gap": "6px",
    "--ns-font": "12px monospace",
    "--ns-glow-a": "#00ffff",
    "--ns-glow-b": "#ff00ff",
    "--ns-glow-opacity": "0.55",
    "--ns-glow-speed": "4s",
};

const tokenBlock = (sel, t) => `${sel}{${Object.entries(t).map(([k, v]) => `${k}:${v}`).join(";")}}`;

export const THEME_CSS = `
${tokenBlock(".ns-root", TOKENS_DARK)}
.ns-root{all:initial;display:block;box-sizing:border-box;font:var(--ns-font);color:var(--ns-fg);width:100%;height:100%;text-align:left;
  --ns-born:0s}
.ns-root *,.ns-root *::before,.ns-root *::after{box-sizing:border-box}
.ns-root.ns-auto{height:auto}
[data-ns-vis="0"],[data-ns-col="1"]{display:none !important}
.ns-stack{display:flex;flex-direction:column;gap:var(--ns-gap);min-width:0}
.ns-row{flex-direction:row;align-items:center}
.ns-box{display:flex;flex-direction:column;gap:var(--ns-gap);padding:8px;background:var(--ns-bg);border-radius:8px;min-width:0}
.ns-box-inset{background:var(--ns-bg-2);border:1px solid var(--ns-border);border-radius:var(--ns-radius)}
.ns-box-plain{background:transparent;padding:0}
.ns-spacer{flex:1 1 auto}
.ns-divider{height:1px;background:var(--ns-border);flex:0 0 1px}
.ns-grid{display:grid;gap:6px}
.ns-label{font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:var(--ns-fg-faint);white-space:nowrap}
.ns-label-hint{white-space:normal;overflow-wrap:anywhere;text-transform:none;letter-spacing:0;line-height:1.35}
.ns-row.ns-wrap{flex-wrap:wrap;row-gap:6px}
.ns-title{font-weight:700;color:var(--ns-accent-fg);letter-spacing:.5px;flex:1}
.ns-text{white-space:pre-wrap;word-break:break-word}
.ns-pre{font:11px monospace;white-space:pre-wrap;word-break:break-word;color:var(--ns-c-ok, #a0ffcc)}
.ns-mono{font-family:monospace}
.ns-badge{font-size:9px;letter-spacing:1px;padding:2px 6px;border-radius:3px;background:var(--ns-c-light-tint, rgba(255,255,255,.08));color:var(--ns-c-text-3, #aaa);text-transform:uppercase;white-space:nowrap}
.ns-badge-accent{background:var(--ns-c-accent-tint, rgba(74,158,255,.18));color:var(--ns-accent-fg)}
.ns-badge-warn{background:var(--ns-c-warn-tint, rgba(255,170,0,.16));color:var(--ns-warn)}
.ns-btn{padding:4px 8px;background:var(--ns-c-light-tint, rgba(255,255,255,.06));border:1px solid var(--ns-border);border-radius:4px;color:var(--ns-c-text-2, #ccc);font:bold 11px monospace;cursor:pointer}
.ns-btn:hover{background:var(--ns-c-accent-tint, rgba(74,158,255,.22));border-color:var(--ns-border-hi);color:var(--ns-c-text-strong, #fff)}
.ns-btn.ns-on{color:var(--ns-warn)}
.ns-btn.ns-cool{color:var(--ns-accent)}
.ns-pv2 .ns-btn.ns-on-info,.ns-btn.ns-on-info{background:color-mix(in srgb,var(--ns-t-info) 20%,transparent);border-color:color-mix(in srgb,var(--ns-t-info) 55%,transparent);color:var(--ns-t-info)}
.ns-pv2 .ns-btn.ns-on,.ns-btn.ns-on{background:color-mix(in srgb,var(--ns-t-warn) 20%,transparent);border-color:color-mix(in srgb,var(--ns-t-warn) 55%,transparent);color:var(--ns-t-warn)}
.ns-pv2 .ns-btn.ns-cool,.ns-btn.ns-cool{background:color-mix(in srgb,var(--ns-t-info) 18%,transparent);border-color:color-mix(in srgb,var(--ns-t-info) 50%,transparent);color:var(--ns-t-info)}
/* little square toggle (Pause: On Timeout play/stop) */
.ns-seg.ns-seg-mini{flex:none;align-self:flex-start;padding:2px;gap:3px}
.ns-seg-mini .ns-seg-btn{flex:none;width:30px;height:28px;padding:0;font-size:13px;line-height:1;border-radius:3px;border:1px solid rgba(255,255,255,.08)}
/* output-type marker: TEAL = "this conditions an output type". Dark teal ground, bright teal text (two shades, like Sound Warning) */
.ns-select.ns-sel-out,.ns-pv2 .ns-select.ns-sel-out,.ns-table-btn.ns-table-fmt{background:color-mix(in srgb,var(--ns-t-out) 16%,#0e0e0e);border-color:color-mix(in srgb,var(--ns-t-out) 55%,transparent);color:var(--ns-t-out)}
.ns-select.ns-sel-out:hover,.ns-table-btn.ns-table-fmt:hover{background:color-mix(in srgb,var(--ns-t-out) 26%,#0e0e0e);border-color:var(--ns-t-out)}
/* picker pager « 1/48 » */
.ns-pick-pager{display:flex;align-items:center;justify-content:center;gap:12px;padding:5px 8px 3px;font:11px var(--nsm-font,monospace);color:var(--nsm-text-muted,#999)}
.ns-pick-pg{min-width:26px;height:22px;padding:0;border:1px solid var(--nsm-line-strong,#444);border-radius:5px;background:var(--nsm-field,#222);color:var(--nsm-text,#ddd);cursor:pointer;font-size:13px;line-height:1}
.ns-pick-pg:hover:not(:disabled){background:var(--nsm-surface-hover,#333)}
.ns-pick-pg:disabled{opacity:.35;cursor:default}
.ns-pick-pgi{min-width:48px;text-align:center}
.ns-btn-ghost{background:transparent;border-color:transparent;color:var(--ns-c-text-3, #999)}
.ns-btn-icon{padding:2px 6px;min-width:22px}
.ns-btn.ns-disabled,.ns-btn:disabled{opacity:.4;pointer-events:none}
.ns-disabled{opacity:.45;pointer-events:none}
.ns-head{display:flex;align-items:center}
.ns-card.ns-on,.ns-card-on{border-color:var(--ns-accent);background:var(--ns-c-accent-tint, rgba(74,158,255,.12))}
.ns-input,.ns-select{background:var(--ns-bg-2);border:1px solid var(--ns-border);border-radius:4px;color:var(--ns-c-text, #e0e0e0);font:12px monospace;outline:none;padding:5px 8px;min-width:0;color-scheme:dark}
.ns-input:focus,.ns-select:focus{border-color:var(--ns-border-hi)}
.ns-textarea{resize:vertical;white-space:pre-wrap}
.ns-select{flex:1;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:6px;text-align:left;min-width:0}
.ns-select-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ns-select-caret{opacity:.6;flex:0 0 auto}
.ns-toggle{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--ns-c-text-3, #999);cursor:pointer}
.ns-stepper{display:flex;align-items:stretch;height:28px;flex:1 1 84px;min-width:84px;background:var(--ns-bg-2);border:1px solid var(--ns-border);border-radius:4px;overflow:hidden}
.ns-step{width:30px;background:var(--ns-c-light-tint, rgba(255,255,255,.04));border:none;color:var(--ns-c-text-3, #aaa);font:bold 15px monospace;cursor:pointer}
.ns-step:hover{background:var(--ns-c-accent-tint, rgba(74,158,255,.22));color:var(--ns-c-text-strong, #fff)}
.ns-step-input{flex:1;min-width:24px;background:transparent;border:none;border-left:1px solid var(--ns-c-light-tint, rgba(255,255,255,.08));border-right:1px solid var(--ns-c-light-tint, rgba(255,255,255,.08));color:var(--ns-c-text, #e0e0e0);font:bold 12px monospace;text-align:center;outline:none}
.ns-seg{display:flex;gap:2px;background:var(--ns-bg-2);border-radius:4px;padding:2px;flex:1}
.ns-seg-btn{flex:1;padding:7px 4px;border:none;background:transparent;color:var(--ns-c-text-4, #666);font:bold 11px monospace;cursor:pointer;border-radius:3px}
.ns-seg-btn:hover:not(.ns-active){color:var(--ns-c-text-3, #999);background:var(--ns-c-light-tint, rgba(255,255,255,.04))}
.ns-seg-btn.ns-active{color:var(--ns-c-text-strong, #fff);background:var(--ns-c-light-tint, rgba(255,255,255,.10))}
.ns-seg-btn.ns-tone-info.ns-active{color:var(--ns-t-info);background:color-mix(in srgb,var(--ns-t-info) 15%,transparent)}
.ns-seg-btn.ns-tone-warn.ns-active{color:var(--ns-t-warn);background:color-mix(in srgb,var(--ns-t-warn) 15%,transparent)}
.ns-seg-btn.ns-tone-danger.ns-active{color:var(--ns-t-danger);background:color-mix(in srgb,var(--ns-t-danger) 15%,transparent)}
.ns-seg-btn.ns-tone-ok.ns-active{color:var(--ns-t-ok);background:color-mix(in srgb,var(--ns-t-ok) 15%,transparent)}
.ns-seg-btn.ns-tone-orange.ns-active{color:var(--ns-t-orange);background:color-mix(in srgb,var(--ns-t-orange) 15%,transparent)}
.ns-seg-btn.ns-tone-calm.ns-active{color:var(--ns-t-calm);background:color-mix(in srgb,var(--ns-t-calm) 15%,transparent)}
.ns-seg-btn.ns-tone-mute.ns-active{color:var(--ns-t-mute);background:color-mix(in srgb,var(--ns-t-mute) 15%,transparent)}
.ns-seg-btn.ns-tone-fx.ns-active{box-shadow:0 0 5px color-mix(in srgb,currentColor 35%,transparent)}
.ns-btn-act{flex:1;padding:9px 8px;font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:#fff;transition:background .15s,box-shadow .15s,opacity .15s}
.ns-slim .ns-seg-btn{padding:3px 4px}.ns-slim .ns-btn-act,.ns-btn-act.ns-slim{padding:4px 8px}
.ns-btn.ns-tone-ok{background:#2d6a2d}.ns-btn.ns-tone-ok:hover:not(:disabled):not(.ns-disabled){background:#3a8a3a;border-color:var(--ns-border);box-shadow:0 0 10px rgba(58,138,58,.30)}
.ns-btn.ns-tone-danger{background:#8b1a1a}.ns-btn.ns-tone-danger:hover:not(:disabled):not(.ns-disabled){background:#b02020;border-color:var(--ns-border);box-shadow:0 0 10px rgba(176,32,32,.30)}
.ns-btn.ns-tone-ok.ns-disabled,.ns-btn.ns-tone-danger.ns-disabled,.ns-btn.ns-tone-ok:disabled,.ns-btn.ns-tone-danger:disabled{filter:saturate(.5);box-shadow:none;cursor:not-allowed}
.ns-field{display:flex;align-items:center;gap:8px;min-height:22px}
.ns-field-label{flex:0 0 38%;font-size:11px;color:var(--ns-c-text-3, #aaa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-field-wide .ns-field-label{flex:1 1 auto;white-space:normal}.ns-field-wide .ns-field-body{flex:0 0 auto}
.ns-field-body{flex:1;display:flex;align-items:center;gap:8px;min-width:0}
.ns-field-body input[type=range]{flex:1;min-width:0;accent-color:var(--ns-accent)}
.ns-field-body input[type=color]{width:34px;height:22px;padding:0;border:1px solid var(--ns-border);border-radius:4px;background:var(--ns-c-field-bg, #0f1011);cursor:pointer}
.ns-field-val{flex:0 0 42px;text-align:right;font-size:10px;color:var(--ns-accent-fg)}
/* bare swatch (D-111): a colour field with no label, a small square that fits in a tight toolbar row */
.ns-field.ns-field-bare{flex:0 0 auto;gap:0;min-height:0}.ns-field-bare .ns-field-label{display:none}.ns-field-bare .ns-field-body{flex:0 0 auto}.ns-field-bare input[type=color]{width:22px;height:22px;border-radius:4px}
.ns-image{width:100%;height:100%;object-fit:contain;pointer-events:none;user-select:none}
.ns-canvas{display:block;width:100%;height:100%;pointer-events:none}
.ns-slot{min-width:0}
.ns-relative{position:relative}
.ns-overlay{position:absolute;inset:0}
.ns-fill{flex:1 1 0;min-height:0}
.ns-scroll{overflow-y:auto;overflow-x:hidden}
.ns-missing{color:var(--ns-danger);font-size:10px}
.ns-grip{position:absolute;left:0;right:0;bottom:0;height:10px;cursor:ns-resize;background:transparent;z-index:20;user-select:none;touch-action:none;transition:background .15s}
.ns-grip::after{content:"";position:absolute;left:50%;top:4px;transform:translateX(-50%);width:40px;height:2px;border-radius:2px;background:var(--ns-c-light-tint, rgba(255,255,255,.10));transition:background .15s}
.ns-grip:hover{background:var(--ns-c-accent-tint, rgba(74,158,255,.18))}
.ns-grip:hover::after{background:var(--ns-c-accent-tint, rgba(124,188,255,.9))}
.ns-grip.ns-active{background:var(--ns-c-accent-tint, rgba(74,158,255,.32))}
.ns-grip.ns-active::after{background:var(--ns-accent-fg)}
/* --- glow continuo (UNICO effetto continuo del tema) --- */
.ns-hovershow{opacity:0;transition:opacity .15s}
*:hover>.ns-hovershow,.ns-hovershow:focus-visible{opacity:1}
.ns-glow{position:relative;isolation:isolate}
.ns-glow::before{content:"";position:absolute;inset:-2px;border-radius:10px;background:conic-gradient(from 0deg,var(--ns-glow-a),var(--ns-glow-b),var(--ns-glow-a));animation:ns-spin var(--ns-glow-speed) linear infinite;animation-delay:var(--ns-born,0s);z-index:-1;filter:blur(4px);opacity:var(--ns-glow-opacity);pointer-events:none}
.ns-glow.ns-collapsed::before{animation:none;opacity:.35}
.ns-root[data-ns-anim="off"] .ns-glow::before,.ns-root[data-ns-anim="off"].ns-glow::before{animation-play-state:paused}
.ns-root[data-ns-anim="off"] *{animation-play-state:paused !important}
@keyframes ns-spin{to{transform:rotate(360deg)}}
/* --- menu float --- */
.ns-menu-layer{position:fixed;inset:0;z-index:999990;pointer-events:none}
.ns-menu-backdrop{position:fixed;inset:0;background:var(--ns-c-shadow, rgba(0,0,0,.55));pointer-events:auto}
.ns-menu{position:fixed;pointer-events:auto;z-index:999991;display:flex;flex-direction:column;min-width:160px;max-width:96vw;max-height:94vh;padding:4px;background:var(--ns-c-menu-bg, #1b1c1e);color:var(--ns-c-text, #d6d6d6);border:1px solid var(--ns-border);border-radius:8px;box-shadow:0 10px 36px var(--ns-c-shadow, rgba(0,0,0,.6));font:12px monospace;outline:none;overflow:auto}
.ns-menu-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--ns-c-text-2, #ccc);font:bold 11px monospace;text-align:left;cursor:pointer;white-space:nowrap}
.ns-menu-item:hover,.ns-menu-item.ns-focus{background:var(--ns-c-warn-tint, rgba(255,184,77,.2));color:var(--ns-warn)}
.ns-menu-item[disabled]{opacity:.4;pointer-events:none}
.ns-menu-check{width:12px;flex:0 0 12px;color:var(--ns-accent-fg)}
.ns-menu-key{margin-left:auto;color:var(--ns-c-text-4, #777);font-weight:normal}
.ns-menu-sep{height:1px;margin:3px 2px;background:var(--ns-border)}
.ns-menu-sub{position:relative}
.ns-menu-sub>.ns-menu-children{position:absolute;left:100%;top:-4px;display:none}
.ns-menu-sub:hover>.ns-menu-children,.ns-menu-sub.ns-open>.ns-menu-children{display:flex}
.ns-panel{padding:0;gap:0;min-width:270px;min-height:120px;resize:both;overflow:hidden}
.ns-panel-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--ns-c-menu-head, #232426);border-bottom:1px solid var(--ns-border);cursor:grab;user-select:none;flex:0 0 auto}
.ns-panel-head.ns-drag{cursor:grabbing}
.ns-panel-title{font-weight:bold;letter-spacing:.4px;white-space:nowrap;flex:1}
.ns-panel-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px;display:flex;flex-direction:column;gap:12px}
.ns-toast-host{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:999998;pointer-events:none}
.ns-toast{padding:8px 14px;background:var(--ns-c-toast-bg, rgba(20,20,30,.95));border:1px solid var(--ns-c-accent-tint, rgba(74,158,255,.4));border-left:3px solid var(--ns-accent);border-radius:6px;color:var(--ns-c-text, #eee);font:11px monospace;box-shadow:0 4px 16px var(--ns-c-shadow, rgba(0,0,0,.6));pointer-events:auto}
`;

// ------------------------------------------------------------
const GLOBAL_STYLE_ID = "succy-ns-theme";
let _sheet = null;

export function ensureGlobalTheme() {
    if (document.getElementById(GLOBAL_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = GLOBAL_STYLE_ID;
    s.textContent = THEME_CSS;
    document.head.appendChild(s);
}

// Shared constructable stylesheet (a single instance for every shadow root).
export function sharedSheet() {
    if (_sheet) return _sheet;
    try {
        if (typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
            const sh = new CSSStyleSheet();
            sh.replaceSync(THEME_CSS);
            _sheet = sh;
        }
    } catch (_) { _sheet = null; }
    return _sheet;
}

// ------------------------------------------------------------
// Node-specific CSS (classes with ITS OWN prefix, e.g. .sx-*).
// Light DOM: <style id="succy-ns-css-<id>"> in head (once).
// Shadow DOM: added as an extra sheet to every shadow root.
// ------------------------------------------------------------
const EXTRA = new Map(); // id -> { css, sheet }

export function registerCss(id, css) {
    const safe = String(id).replace(/[^\w-]/g, "");
    if (EXTRA.has(safe)) return false;
    let sheet = null;
    try {
        if (typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) { sheet = new CSSStyleSheet(); sheet.replaceSync(css); }
    } catch (_) { sheet = null; }
    EXTRA.set(safe, { css, sheet });
    if (!document.getElementById("succy-ns-css-" + safe)) {
        const st = document.createElement("style");
        st.id = "succy-ns-css-" + safe;
        st.textContent = css;
        document.head.appendChild(st);
    }
    return true;
}
export const extraCss = () => [...EXTRA.values()];

// updates an already registered CSS (palette): same shared sheet -> every open menu changes outfit instantly
export function updateCss(id, css) {
    const safe = String(id).replace(/[^\w-]/g, "");
    const e = EXTRA.get(safe);
    if (!e) return registerCss(safe, css);
    e.css = css;
    try { e.sheet?.replaceSync(css); } catch (_) {}
    const st = document.getElementById("succy-ns-css-" + safe);
    if (st) st.textContent = css;
    return true;
}

// ------------------------------------------------------------
// MENU v2 (dedicated menu protocol, D-57): --nsm-* token palette. A palette = JSON object
// { token: color }. Only one today ("graphite"); the pack menu will be able to pick others with
// NodeStructure.theme.setMenuPalette(name | {token: value}). No colors written into the pieces: tokens only.
// ------------------------------------------------------------
export const MENU_PALETTES = {
    graphite: {
        "--nsm-bg": "#1c1f24", "--nsm-head": "#20242a", "--nsm-foot": "#1a1d21", "--nsm-inset": "#15171b", "--nsm-field": "#22262d",
        "--nsm-surface": "#20242a", "--nsm-surface-hover": "#2a2f37", "--nsm-raised": "#22262d",
        "--nsm-line": "#2a2e36", "--nsm-line-strong": "#343a44",
        "--nsm-text": "#e6e8eb", "--nsm-text-strong": "#f2f4f7", "--nsm-text-dim": "#c3c8d0", "--nsm-text-muted": "#9aa1ab", "--nsm-text-faint": "#6f7680",
        "--nsm-accent": "#7aa2f7", "--nsm-accent-text": "#0f1320", "--nsm-accent-soft": "#232a38", "--nsm-accent-soft-text": "#c3d3fa", "--nsm-focus": "rgba(122,162,247,.35)",
        "--nsm-seg-on": "#2c323c", "--nsm-switch-off": "#3a404a", "--nsm-knob": "#eef0f3",
        "--nsm-danger": "#f2a7ae", "--nsm-chip-bg": "#2a2620", "--nsm-chip-text": "#e3b778",
        "--nsm-veil-a": "rgba(28,31,36,.55)", "--nsm-veil-b": "rgba(28,31,36,.85)",
        "--nsm-font": "\"IBM Plex Sans\", system-ui, -apple-system, \"Segoe UI\", sans-serif", "--nsm-mono": "\"IBM Plex Mono\", ui-monospace, \"SF Mono\", Consolas, monospace",
    },
};
let _palette = "graphite";
const paletteCss = (tok) => `.ns-pv2{${Object.entries(tok).filter(([k]) => /^--nsm-[\w-]+$/.test(k)).map(([k, v]) => `${k}:${String(v).replace(/[;{}<>]/g, "")}`).join(";")}}`;
export function setMenuPalette(p) {
    const base = MENU_PALETTES.graphite;
    const tok = typeof p === "string" ? MENU_PALETTES[p] : (p && typeof p === "object" ? { ...base, ...p } : null);
    if (!tok) return false;
    _palette = typeof p === "string" ? p : "custom";
    updateCss("ns-menu-palette", paletteCss({ ...base, ...tok }));
    return true;
}
export const getMenuPalette = () => ({ name: _palette, tokens: { ...MENU_PALETTES.graphite } });

// ------------------------------------------------------------
// NODE PALETTE (D-58): the node UIs (Preview, X, ...) use --ns-* and --ns-c-* tokens (color roles,
// e.g. --ns-c-pane-bg, --ns-c-text, --ns-c-warn). Without a palette the usual colors apply (fallbacks written
// in the CSS), so the look doesn't change. setNodePalette({token: value}) overrides them on the fly for every node;
// setNodePalette(null) goes back to the original. The pack menu (future) will call it.
// ------------------------------------------------------------
let _nodePalette = null;
export function setNodePalette(tok) {
    if (tok !== null && (typeof tok !== "object" || Array.isArray(tok))) return false;
    const ok = tok ? Object.entries(tok).filter(([k]) => /^--ns-[\w-]+$/.test(k)) : [];
    _nodePalette = tok ? Object.fromEntries(ok) : null;
    updateCss("ns-node-palette", ok.length ? `.ns-root{${ok.map(([k, v]) => `${k}:${String(v).replace(/[;{}<>]/g, "")}`).join(";")}}` : "/* no palette: original colours */");
    return true;
}
export const getNodePalette = () => (_nodePalette ? { ..._nodePalette } : null);
export const NODE_COLOR_ROLES = ["--ns-c-pane-bg", "--ns-c-text", "--ns-c-text-2", "--ns-c-text-3", "--ns-c-text-4", "--ns-c-text-5", "--ns-c-text-strong", "--ns-c-warn", "--ns-c-ok", "--ns-c-menu-bg", "--ns-c-menu-head", "--ns-c-field-bg", "--ns-c-accent-tint", "--ns-c-light-tint", "--ns-c-shadow", "--ns-c-warn-tint", "--ns-c-danger-tint", "--ns-c-toast-bg", ...Object.keys(TOKENS_DARK)];

export const MENU_V2_CSS = `
.ns-menu.ns-pv2{padding:0;gap:0;resize:none;overflow:hidden;max-width:none;max-height:none;min-width:0;min-height:0;background:var(--nsm-bg);color:var(--nsm-text);border:1px solid var(--nsm-line-strong);border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.4);font:12px/1.4 var(--nsm-font)}
.ns-pv2[data-ns-size=L]{--nsm-head-h:48px;--nsm-bar-h:52px;--nsm-foot-h:48px;--nsm-card-h:64px;--nsm-prev-h:40px;--nsm-row-h:46px}
.ns-pv2[data-ns-size=M]{--nsm-head-h:42px;--nsm-bar-h:46px;--nsm-foot-h:40px;--nsm-card-h:54px;--nsm-prev-h:32px;--nsm-row-h:38px}
.ns-pv2[data-ns-size=S]{--nsm-head-h:40px;--nsm-bar-h:44px;--nsm-foot-h:38px;--nsm-card-h:42px;--nsm-prev-h:40px;--nsm-row-h:36px}
.ns-pv2[data-ns-size=fit]{--nsm-head-h:36px;--nsm-bar-h:40px;--nsm-foot-h:36px;--nsm-card-h:42px;--nsm-prev-h:32px;--nsm-row-h:34px;display:flex;flex-direction:column}
.ns-pv2[data-ns-size=fit] .ns-panel-body{overflow:auto;flex:0 1 auto}
.ns-pv2 .ns-panel-head{height:var(--nsm-head-h);box-sizing:border-box;padding:0 8px 0 14px;gap:10px;background:var(--nsm-head);border-bottom:1px solid var(--nsm-line)}
.ns-pv2 .ns-panel-title{flex:0 1 auto;font:600 13px var(--nsm-font);letter-spacing:.01em;overflow:hidden;text-overflow:ellipsis;color:var(--nsm-text)}
.ns-pv2 .ns-pv2-chip{display:inline-flex;align-items:center;height:22px;box-sizing:border-box;padding:0 8px;border-radius:11px;background:var(--nsm-chip-bg);color:var(--nsm-chip-text);font:11px var(--nsm-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}
.ns-pv2 .ns-pv2-chip:empty{display:none}
.ns-pv2 .ns-pv2-fill{flex:1}
.ns-pv2 .ns-pv2-headx{display:flex;align-items:center;gap:4px}
.ns-pv2 .ns-pv2-headx canvas{width:18px;height:18px}
.ns-pv2 .ns-panel-body{padding:0;gap:0;overflow:hidden;display:flex;flex-direction:column}
.ns-pv2 .ns-panel-body>*{flex:1 1 auto;min-height:0}
.ns-pv2 .ns-btn{height:28px;box-sizing:border-box;padding:0 12px;border:1px solid var(--nsm-line-strong);border-radius:6px;background:var(--nsm-field);color:var(--nsm-text);font:500 12px var(--nsm-font);cursor:pointer}
.ns-pv2 .ns-btn:hover{background:var(--nsm-surface-hover);border-color:var(--nsm-line-strong);color:var(--nsm-text)}
.ns-pv2 .ns-btn:focus-visible,.ns-pv2 .ns-seg-btn:focus-visible,.ns-pv2 .ns-card:focus-visible{outline:none;box-shadow:0 0 0 3px var(--nsm-focus)}
.ns-pv2 .ns-btn.ns-btn-primary{background:var(--nsm-accent);border-color:var(--nsm-accent);color:var(--nsm-accent-text);font-weight:600}
.ns-pv2 .ns-btn.ns-btn-primary:hover{filter:brightness(1.08)}
.ns-pv2 .ns-btn.ns-btn-ghost{background:transparent;border-color:transparent;color:var(--nsm-text-muted)}
.ns-pv2 .ns-btn.ns-btn-icon{width:30px;height:30px;padding:0;border:0;background:transparent;color:var(--nsm-text-muted);font:15px system-ui;display:inline-flex;align-items:center;justify-content:center}
.ns-pv2 .ns-btn.ns-btn-icon:hover{background:var(--nsm-surface-hover);color:var(--nsm-text)}
.ns-pv2 .ns-label{font:12px var(--nsm-font);color:var(--nsm-text-muted);text-transform:none;letter-spacing:0}
.ns-pv2 .ns-label-section{font:600 11px var(--nsm-font);letter-spacing:.08em;text-transform:uppercase;color:var(--nsm-text-muted)}
.ns-pv2 .ns-label-mono{font:11px var(--nsm-mono);color:var(--nsm-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ns-pv2 .ns-label-error{color:var(--nsm-danger)}
.ns-pv2 .ns-disabled{opacity:.28;pointer-events:none}
/* sezioni a altezza fissa */
.ns-pv2 .ns-m-bar{flex:none;height:var(--nsm-bar-h);box-sizing:border-box;display:flex;flex-direction:row;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid var(--nsm-line)}
.ns-pv2 .ns-m-page{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:0}
.ns-pv2 .ns-m-main{flex:1 1 auto;min-height:0;position:relative;display:flex;flex-direction:column;gap:0}
.ns-pv2 .ns-m-lock{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:0}
.ns-pv2 .ns-m-fx{flex:none;padding:12px 14px 14px;border-bottom:1px solid var(--nsm-line)}
.ns-pv2 .ns-m-params{flex:1 1 auto;min-height:0;padding:12px 14px 0;display:flex;flex-direction:column;gap:8px}
.ns-pv2 .ns-m-foot{flex:none;height:var(--nsm-foot-h);box-sizing:border-box;display:flex;flex-direction:row;align-items:center;gap:10px;padding:0 14px;border-top:1px solid var(--nsm-line);background:var(--nsm-foot)}
.ns-pv2 .ns-m-veil{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;padding:24px;background:linear-gradient(var(--nsm-veil-a),var(--nsm-veil-b))}
.ns-pv2 .ns-m-veil[data-ns-vis="0"]{display:none}
.ns-pv2 .ns-m-veil .ns-notice{width:300px;max-width:100%;box-sizing:border-box;padding:18px;gap:12px;background:var(--nsm-raised);border:1px solid var(--nsm-line-strong);border-radius:10px;color:var(--nsm-text);font:12px/1.5 var(--nsm-font);box-shadow:0 10px 30px rgba(0,0,0,.45)}
.ns-pv2 .ns-m-veil .ns-label{color:var(--nsm-text-dim);white-space:normal}
.ns-pv2 .ns-m-veil .ns-row .ns-btn{flex:1}
/* segmentato */
.ns-pv2 .ns-seg{flex:none;padding:3px;gap:2px;background:var(--nsm-inset);border:1px solid var(--nsm-line);border-radius:8px}
.ns-pv2 .ns-seg-btn{height:26px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--nsm-text-muted);font:500 12px var(--nsm-font);cursor:pointer}
.ns-pv2 .ns-seg-btn.ns-active{background:var(--nsm-seg-on);color:var(--nsm-text-strong)}
/* card */
.ns-pv2 .ns-cards{gap:8px}
.ns-pv2 .ns-cards-head{height:22px}
.ns-pv2 .ns-cards-head .ns-btn{width:24px;height:22px;padding:0;border:0;background:transparent;color:var(--nsm-text-muted);font-size:10px}
.ns-pv2 .ns-cards-head .ns-btn:hover{background:var(--nsm-surface-hover)}
.ns-pv2 .ns-cards-head .ns-label:not(.ns-label-section){font:11px var(--nsm-mono);min-width:34px;text-align:center}
.ns-pv2 .ns-cards-grid{gap:8px;grid-auto-rows:var(--nsm-card-h)}
.ns-pv2 .ns-card{height:var(--nsm-card-h);box-sizing:border-box;padding:0;gap:0;border:1px solid var(--nsm-line);border-radius:7px;background:var(--nsm-surface);overflow:hidden;transition:background-color .12s,border-color .12s}
.ns-pv2 .ns-card:hover{background:var(--nsm-surface-hover);border-color:var(--nsm-line-strong)}
.ns-pv2 .ns-card.ns-on{border-color:var(--nsm-accent);background:var(--nsm-accent-soft)}
.ns-pv2 .ns-card-prev{height:var(--nsm-prev-h);flex:none}
.ns-pv2 .ns-card-name{padding:0 6px;font:11px/22px var(--nsm-font);text-align:left;color:var(--nsm-text-dim)}
.ns-pv2 .ns-card.ns-on .ns-card-name{color:var(--nsm-text)}
.ns-pv2[data-ns-size=S] .ns-card-name{display:none}
/* form a griglia fissa */
.ns-pv2 .ns-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:var(--nsm-row-h);column-gap:18px;row-gap:2px;align-content:start}
.ns-pv2[data-ns-size=S] .ns-form-grid{grid-template-columns:minmax(0,1fr)}
.ns-pv2[data-ns-size=S] .ns-form[data-ns-cols-s="2"] .ns-form-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.ns-form-grid>.ns-row.ns-form-off{visibility:hidden;pointer-events:none}
.ns-pv2 .ns-m-sec{flex:none;display:flex;flex-direction:column;gap:2px}
.ns-pv2 .ns-m-sec+.ns-m-sec{margin-top:6px;padding-top:6px;border-top:1px solid var(--nsm-line)}
.ns-pv2 .ns-form-grid>.ns-row{min-width:0;align-items:center;gap:8px}
.ns-pv2 .ns-form-foot{display:flex;align-items:center;gap:4px;height:24px}
.ns-pv2 .ns-form-foot .ns-btn{height:22px;padding:0 8px;font-size:11px}
.ns-pv2 .ns-form-pg{font:11px var(--nsm-mono);color:var(--nsm-text-muted);min-width:34px;text-align:center}
.ns-pv2 .ns-form-grid .ns-btn{height:22px;padding:0 8px;border-radius:11px;font-size:11px;background:transparent;color:var(--nsm-text-muted)}
.ns-pv2 .ns-form-grid .ns-btn.ns-on{background:var(--nsm-accent-soft);border-color:var(--nsm-accent);color:var(--nsm-accent-soft-text)}
/* campi */
.ns-pv2 .ns-field{flex:1;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:8px;row-gap:5px}
.ns-pv2 .ns-field-label{grid-row:1;grid-column:1;font:12px var(--nsm-font);color:var(--nsm-text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ns-pv2 .ns-field-body{display:contents}
.ns-pv2 .ns-field-val{grid-row:1;grid-column:2;flex:none;font:11px var(--nsm-mono);color:var(--nsm-text);text-align:right}
.ns-pv2 .ns-field-val{cursor:text;border-radius:3px;padding:0 3px}
.ns-pv2 .ns-field-val:hover{background:var(--nsm-surface-hover)}
.ns-pv2 .ns-field-val-edit{grid-row:1;grid-column:2;justify-self:end;height:20px;box-sizing:border-box;padding:0 4px;border:1px solid var(--nsm-accent);border-radius:4px;background:var(--nsm-field);color:var(--nsm-text);font:11px var(--nsm-mono);text-align:right;outline:none;box-shadow:0 0 0 3px var(--nsm-focus)}
.ns-pv2 .ns-field input[type=range]{grid-row:2;grid-column:1/-1;-webkit-appearance:none;appearance:none;width:100%;height:16px;margin:0;background:transparent;cursor:pointer}
.ns-pv2 .ns-field input[type=range]:focus{outline:none}
.ns-pv2 .ns-field input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(to right,var(--nsm-accent) 0,var(--nsm-accent) var(--p,0%),var(--nsm-line-strong) var(--p,0%),var(--nsm-line-strong) 100%)}
.ns-pv2 .ns-field input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:var(--nsm-knob);border:2px solid var(--nsm-accent);box-shadow:0 1px 3px rgba(0,0,0,.5)}
.ns-pv2 .ns-field input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px var(--nsm-focus)}
.ns-pv2 .ns-field input[type=range]::-moz-range-track{height:4px;border-radius:2px;background:var(--nsm-line-strong)}
.ns-pv2 .ns-field input[type=range]::-moz-range-progress{height:4px;border-radius:2px;background:var(--nsm-accent)}
.ns-pv2 .ns-field input[type=range]::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--nsm-knob);border:2px solid var(--nsm-accent)}
.ns-pv2 .ns-field input[type=color]{grid-row:1;grid-column:2;-webkit-appearance:none;appearance:none;width:22px;height:22px;padding:0;border:1px solid var(--nsm-line-strong);border-radius:5px;background:none;cursor:pointer}
.ns-pv2 .ns-field input[type=color]::-webkit-color-swatch-wrapper{padding:0}
.ns-pv2 .ns-field input[type=color]::-webkit-color-swatch{border:0;border-radius:4px}
.ns-pv2 .ns-field select,.ns-pv2 .ns-select{grid-row:2;grid-column:1/-1;height:28px;box-sizing:border-box;padding:0 10px;border:1px solid var(--nsm-line-strong);border-radius:6px;background:var(--nsm-field);color:var(--nsm-text);font:12px var(--nsm-font)}
.ns-pv2 .ns-field input[type=number],.ns-pv2 .ns-field .ns-input{grid-row:2;grid-column:1/-1;height:28px;box-sizing:border-box;padding:0 8px;border:1px solid var(--nsm-line-strong);border-radius:6px;background:var(--nsm-field);color:var(--nsm-text);font:12px var(--nsm-mono)}
.ns-pv2 input[type=checkbox]{-webkit-appearance:none;appearance:none;position:relative;flex:none;width:32px;height:18px;margin:0;border-radius:9px;background:var(--nsm-switch-off);cursor:pointer;transition:background-color .12s}
.ns-pv2 input[type=checkbox]::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--nsm-knob);box-shadow:0 1px 2px rgba(0,0,0,.4);transition:left .12s}
.ns-pv2 input[type=checkbox]:checked{background:var(--nsm-accent)}
.ns-pv2 input[type=checkbox]:checked::after{left:16px}
.ns-pv2 input[type=checkbox]:focus-visible{outline:none;box-shadow:0 0 0 3px var(--nsm-focus)}
.ns-pv2 .ns-field.ns-field-wide{display:flex;flex-direction:row-reverse;justify-content:flex-end;align-items:center;gap:10px}
.ns-pv2 .ns-field.ns-field-wide .ns-field-label{white-space:nowrap}
`;
registerCss("ns-menu-v2", MENU_V2_CSS);
registerCss("ns-menu-palette", paletteCss(MENU_PALETTES.graphite));
registerCss("ns-node-palette", "/* no palette: original colours */");

// Applies the theme to a .ns-root container (per-instance tokens validated by the parser).
export function applyTheme(rootEl, { theme, tokens } = {}) {
    if (theme) rootEl.dataset.nsTheme = String(theme).replace(/[^\w-]/g, "");
    if (tokens) for (const [k, v] of Object.entries(tokens)) {
        if (/^--ns-[\w-]+$/.test(k) && typeof v === "string") rootEl.style.setProperty(k, v);
    }
}
