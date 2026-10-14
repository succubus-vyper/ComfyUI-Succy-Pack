// ============================================================
// lib/expression.js
// ------------------------------------------------------------
// @name token substitution using a map. Pure: no eval.
// Future use: NodeStructure token menu, Succy_Label preview.
// v0.1.0 — 2026-10-09
// ============================================================

const TOKEN_RE = /@([a-zA-Z_][a-zA-Z0-9_]*)/g;

export function extractTokens(text) {
    const out = [];
    const seen = new Set();
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(String(text ?? ""))) !== null) {
        const k = m[1];
        if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
}

export function resolveTokens(text, map, { keepUnknown = true } = {}) {
    return String(text ?? "").replace(TOKEN_RE, (full, key) => {
        if (map && Object.prototype.hasOwnProperty.call(map, key)) {
            const v = map[key];
            return v === undefined || v === null ? "" : String(v);
        }
        return keepUnknown ? full : "";
    });
}

export function hasToken(text, key) {
    const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`@${esc}\\b`);
    return re.test(String(text ?? ""));
}