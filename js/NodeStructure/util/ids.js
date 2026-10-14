// ============================================================
// NodeStructure/util/ids.js
// ------------------------------------------------------------
// Ids for GLOBAL elements (menus, overlays, modals in the body): always
// based on ctx.key (gid:nid), NEVER on node.id (it collides between root and
// subgraph).
// ============================================================

export function safeSeg(s) {
    return String(s ?? "").replace(/[^\w:-]/g, "_");
}

export function globalId(ctxKey, kind, name = "") {
    return `succy-ns-${safeSeg(kind)}-${safeSeg(ctxKey)}${name ? "-" + safeSeg(name) : ""}`;
}

// All the global elements created by the builder for this key.
export function findGlobals(ctxKey) {
    const suffix = safeSeg(ctxKey);
    const out = [];
    try {
        for (const el of document.querySelectorAll('[id^="succy-ns-"]')) {
            const id = el.id;
            if (id.includes("-" + suffix + "-") || id.endsWith("-" + suffix)) out.push(el);
        }
    } catch (_) {}
    return out;
}
