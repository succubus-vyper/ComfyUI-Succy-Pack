// ============================================================
// SurvivalKit/core/node-state.js
// ------------------------------------------------------------
// External WeakMap holding all the kit's per-node state.
// The node carries NO custom properties (_succy*): we leave no marks.
// ComfyUI's structuredClone / multiClone find nothing.
// v0.1.0 — 2026-10-09
// ============================================================

const STORE = new WeakMap();

function ensure(node) {
    let e = STORE.get(node);
    if (!e) {
        e = {
            removed: false,
            ready: false,
            ctx: null,
            dom: null,
            root: null,
            kitDom: new Set(),
            canvases: new Set(),
            rafs: new Set(),
            resizeEls: new Set(),
            visibleNatives: new Set(),
            internalResize: false,
            config: null,
            persistNatives: null,
        };
        STORE.set(node, e);
    }
    return e;
}

export const NodeState = {
    ensure,
    get(node, key, def) {
        const e = STORE.get(node);
        if (!e) return def;
        const v = e[key];
        return v === undefined ? def : v;
    },
    set(node, key, value) {
        ensure(node)[key] = value;
    },
    del(node) {
        STORE.delete(node);
    },
    all(node) {
        return STORE.get(node);
    },
};