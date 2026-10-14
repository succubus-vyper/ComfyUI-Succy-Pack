// ============================================================
// SurvivalKit/persistence/serialize.js
// ------------------------------------------------------------
// Read/write of persistNatives. Single source of truth
// for saving native widgets.
//
// v0.1.1 — 2026-10-10: succy_natives is now a JSON string in
// node.properties (avoids Vue reactive Proxies that break
// structuredClone). parseObject still accepts legacy objects.
// ============================================================

// Normalizes a properties.succy_* field that can be:
//   - undefined/null  → def
//   - JSON string     → parsed object, or def if parsing fails
//   - plain object    → as is (old workflow compat)
//   - anything else   → def
export function parseObject(raw, def = {}) {
    if (raw === undefined || raw === null) return def;
    if (typeof raw === "string") {
        try {
            const o = JSON.parse(raw);
            return (o && typeof o === "object" && !Array.isArray(o)) ? o : def;
        } catch (_) { return def; }
    }
    if (typeof raw === "object" && !Array.isArray(raw)) return raw;
    return def;
}

export function readNatives(node, names) {
    const out = {};
    for (const name of names) {
        const w = node.widgets?.find((x) => x.name === name);
        if (w && w.value !== undefined) out[name] = w.value;
    }
    return out;
}

export function restoreNatives(node, names) {
    const saved = parseObject(node.properties?.succy_natives, null);
    if (!saved) return;
    if (!node.widgets) return;
    for (const name of names) {
        if (saved[name] === undefined) continue;
        const w = node.widgets.find((x) => x.name === name);
        if (!w) continue;
        if (w.value === undefined || w.value === null || w.value === "") {
            w.value = saved[name];
        }
    }
}

export function persistNatives(node, names, values) {
    const prev = parseObject(node.properties?.succy_natives, {});
    const merged = { ...prev };
    const src = values || readNatives(node, names);
    for (const name of names) {
        if (src[name] !== undefined) merged[name] = src[name];
    }
    node.properties = node.properties || {};
    node.properties.succy_natives = JSON.stringify(merged);
    return merged;
}