// ============================================================
// NodeStructure/components/index.js
// ------------------------------------------------------------
// Components are catalog PIECES (type "component"): they register with
// piece(card, factory) (catalog/registry.js). This file only provides the
// accessories used by the factories and the getters used by parser/renderer.
//
//   factory(node, h) -> {
//       el, container?, update?(), value?: { get(), set(v), events:[...], onCommit?(fn) },
//       handlesText?: true,
//   }
//   h = { rt, bag, item, val(v), listen(el, ev, fn, opts), tree }
// ============================================================

import { impl, namesWithAlias } from "../catalog/registry.js";

export const getComponent = (name) => impl(name, "component");
export const componentNames = () => namesWithAlias("component");

export function mkEl(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
}

// number from a prop (literal or ref); fallback if not finite
export function num(h, v, def) {
    const x = h.val(v);
    const n = typeof x === "number" ? x : Number(x);
    return Number.isFinite(n) ? n : def;
}

// normalized options: ["a","b"] or [{value,label}]
export function normOptions(list) {
    if (!Array.isArray(list)) return [];
    return list.map((o) => (o && typeof o === "object")
        ? { value: o.value, label: String(o.label ?? o.value), ...(typeof o.tone === "string" ? { tone: o.tone } : {}), ...(o.fx === true ? { fx: true } : {}) }
        : { value: o, label: String(o) });
}

// URLs allowed for <img>: http(s), data:image, blob:, relative. We don't let just anyone in.
export function safeUrl(u) {
    if (typeof u !== "string" || !u) return "";
    if (/^\s*javascript:/i.test(u)) return "";
    if (/^(https?:|blob:|data:image\/|\/|\.\/|\.\.\/)/i.test(u)) return u;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u; // relative, no scheme
    return "";
}
