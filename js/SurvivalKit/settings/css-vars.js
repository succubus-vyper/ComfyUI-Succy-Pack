// ============================================================
// SurvivalKit/settings/css-vars.js
// ------------------------------------------------------------
// Applies/removes CSS variables on a target (default :root).
// Ready for the future theme panel.
// v0.1.0 — 2026-10-09
// ============================================================

export function applyCssVars(vars, target = document.documentElement) {
    if (!vars || typeof vars !== "object" || !target) return;
    for (const [k, v] of Object.entries(vars)) {
        const name = k.startsWith("--") ? k : `--${k}`;
        try { target.style.setProperty(name, String(v)); } catch (_) {}
    }
}

export function removeCssVars(names, target = document.documentElement) {
    if (!Array.isArray(names) || !target) return;
    for (const k of names) {
        const name = k.startsWith("--") ? k : `--${k}`;
        try { target.style.removeProperty(name); } catch (_) {}
    }
}

export function readCssVar(name, target = document.documentElement) {
    const n = name.startsWith("--") ? name : `--${name}`;
    try { return getComputedStyle(target).getPropertyValue(n).trim(); } catch (_) { return ""; }
}