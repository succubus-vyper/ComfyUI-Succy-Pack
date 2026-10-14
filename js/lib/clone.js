// ============================================================
// lib/clone.js
// ------------------------------------------------------------
// Safe clone for state/values. Doesn't clone DOM, functions, symbols.
// Returns undefined for those types.
// v0.1.0 — 2026-10-09
// ============================================================

export function cloneSafe(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "function" || t === "symbol") return undefined;
    if (t !== "object") return value;

    if (typeof Node !== "undefined" && value instanceof Node) return undefined;
    if (typeof Window !== "undefined" && value instanceof Window) return undefined;

    if (seen.has(value)) return undefined;
    seen.add(value);
    // "seen" = current path: shared (non-cyclic) references get cloned. Sharing is fine, loops are not.
    try { return cloneObject(value, seen); } finally { seen.delete(value); }
}

function cloneObject(value, seen) {
    if (Array.isArray(value)) {
        const out = [];
        for (const v of value) {
            const c = cloneSafe(v, seen);
            if (c !== undefined) out.push(c);
        }
        return out;
    }
    if (value instanceof Date)   return new Date(value.getTime());
    if (value instanceof RegExp) return new RegExp(value.source, value.flags);

    if (value instanceof Map) {
        const m = new Map();
        for (const [k, v] of value) {
            const ck = cloneSafe(k, seen);
            const cv = cloneSafe(v, seen);
            if (ck !== undefined && cv !== undefined) m.set(ck, cv);
        }
        return m;
    }
    if (value instanceof Set) {
        const s = new Set();
        for (const v of value) {
            const c = cloneSafe(v, seen);
            if (c !== undefined) s.add(c);
        }
        return s;
    }

    const out = {};
    for (const k of Object.keys(value)) {
        try {
            const c = cloneSafe(value[k], seen);
            if (c !== undefined) out[k] = c;
        } catch (_) {}
    }
    return out;
}

export function shallowEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.is(a[k], b[k])) return false;
    return true;
}