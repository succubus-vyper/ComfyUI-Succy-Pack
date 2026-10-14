// ============================================================
// NodeStructure/util/json.js
// ------------------------------------------------------------
// Pure JSON utilities (no DOM, no dependencies).
// The spec is ONLY JSON: everything needed to clone it,
// compare it and make sure it's hiding nothing else lives here.
// ============================================================

export const MAX_DEPTH = 32;

export function isPlainObject(v) {
    if (v === null || typeof v !== "object") return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
}

// JSON-only clone. Functions/symbols/undefined/NaN/DOM -> error (never
// copied silently). Cycles -> error. Always returns a brand new object.
export function deepClone(v, depth = 0, seen = new Set()) {
    if (depth > MAX_DEPTH) throw new Error("deepClone: profondita' > " + MAX_DEPTH);
    if (v === null) return null;
    const t = typeof v;
    if (t === "string" || t === "boolean") return v;
    if (t === "number") {
        if (!Number.isFinite(v)) throw new Error("deepClone: non-finite number");
        return v;
    }
    if (t !== "object") throw new Error("deepClone: non-JSON type (" + t + ")");
    if (seen.has(v)) throw new Error("deepClone: riferimento circolare");
    seen.add(v);
    try {
        if (Array.isArray(v)) return v.map((x) => deepClone(x, depth + 1, seen));
        if (!isPlainObject(v)) throw new Error("deepClone: not a plain object");
        const out = {};
        for (const k of Object.keys(v)) {
            if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
            out[k] = deepClone(v[k], depth + 1, seen);
        }
        return out;
    } finally {
        seen.delete(v);
    }
}

// JSON with sorted keys: stable signature for comparisons and caches.
export function stable(v) {
    return JSON.stringify(v, (k, x) => {
        if (x && typeof x === "object" && !Array.isArray(x)) {
            const o = {};
            for (const kk of Object.keys(x).sort()) o[kk] = x[kk];
            return o;
        }
        return x;
    });
}

export function deepEqual(a, b) {
    try { return stable(a) === stable(b); } catch (_) { return false; }
}

// Looks for non-JSON values. Returns [{path, why}]. Doesn't throw.
export function findNonJson(v, path = "$", out = [], depth = 0, seen = new Set()) {
    if (depth > MAX_DEPTH) { out.push({ path, why: "troppo profondo" }); return out; }
    if (v === null) return out;
    const t = typeof v;
    if (t === "string" || t === "boolean") return out;
    if (t === "number") { if (!Number.isFinite(v)) out.push({ path, why: "non-finite number" }); return out; }
    if (t !== "object") { out.push({ path, why: "tipo " + t }); return out; }
    if (seen.has(v)) { out.push({ path, why: "ciclo" }); return out; }
    seen.add(v);
    if (Array.isArray(v)) v.forEach((x, i) => findNonJson(x, `${path}[${i}]`, out, depth + 1, seen));
    else if (!isPlainObject(v)) out.push({ path, why: "not a plain object" });
    else for (const k of Object.keys(v)) findNonJson(v[k], `${path}.${k}`, out, depth + 1, seen);
    seen.delete(v);
    return out;
}

// node.properties: primitives and strings only (Vue's reactive Proxies break
// structuredClone). Returns the keys that break the rule.
export function propertyViolations(props) {
    const bad = [];
    if (!props || typeof props !== "object") return bad;
    for (const k of Object.keys(props)) {
        const v = props[k];
        const t = typeof v;
        if (v === null || t === "string" || t === "number" || t === "boolean") continue;
        bad.push(`${k}:${Array.isArray(v) ? "array" : t}`);
    }
    return bad;
}

export function safeParse(str, def = null) {
    if (typeof str !== "string" || !str) return def;
    try {
        const o = JSON.parse(str);
        return o === undefined ? def : o;
    } catch (_) { return def; }
}
