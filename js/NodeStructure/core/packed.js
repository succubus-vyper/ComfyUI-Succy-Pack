// ============================================================
// NodeStructure/core/packed.js — "packed natives" (D-79)
// ------------------------------------------------------------
// A frontend widget is expensive: every one gets an input socket and the frontend does O(n^2) work on them, so a node with
// 240 widgets took ~3 s to create, clone or load. A packed node keeps ONE real hidden widget (a STRING holding JSON) and
// declares the rest as "virtual natives": the spec still says `$native.f1_3`, api.native.get/set still work, but the values
// live inside that JSON, and only what differs from the default is written down (less is more, darling).
//
//   NodeStructure.define(TYPE, { natives: ["num_operations"], packed: { widget: "ops", defaults: { label_1: "Parse 1", ... } }, ... })
//
// The Python side reads the same JSON (missing key = default) and the real widget is declared there as a plain STRING.
// How: ctx.utils.getNative / setNative of THIS node get dressed: virtual names answer from the JSON, everything else falls
// through to the real widgets. Writes go through the real widget's own setNative, so callback + undo checkpoint come free.
// ============================================================

// names the spec may use with `$native.` besides the real widgets
export function packedNames(packed) {
    return packed && packed.defaults && typeof packed.defaults === "object" ? Object.keys(packed.defaults) : [];
}

export function installPacked(ctx, packed) {
    if (!ctx?.utils || !packed?.widget || ctx.__nsPacked) return false;
    ctx.__nsPacked = true;
    const DEF = new Map(Object.entries(packed.defaults || {}));
    const origGet = ctx.utils.getNative, origSet = ctx.utils.setNative;
    let raw = null, obj = {};

    // parsed JSON, re-parsed only when the widget text really changed (undo, load, paste... all land here)
    const store = () => {
        const v = origGet(packed.widget)?.value ?? "";
        if (v !== raw) {
            raw = v;
            try { const p = JSON.parse(v || "{}"); obj = p && typeof p === "object" && !Array.isArray(p) ? p : {}; } catch (_) { obj = {}; }
        }
        return obj;
    };

    ctx.utils.getNative = (name) => {
        if (!DEF.has(name)) return origGet(name);
        const st = store();
        return { name, value: name in st ? st[name] : DEF.get(name), virtual: true };
    };
    ctx.utils.setNative = (name, value) => {
        if (!DEF.has(name)) return origSet(name, value);
        const o = { ...store() };
        if (value === undefined || Object.is(value, DEF.get(name))) delete o[name]; else o[name] = value;
        return origSet(packed.widget, JSON.stringify(o));
    };
    return true;
}
