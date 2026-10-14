// ============================================================
// SurvivalKit/core/keys.js
// ------------------------------------------------------------
// Unified node keys. gid:nid to avoid collisions in
// subgraphs (same id in different graphs — same name, different bedroom).
// v0.1.0 — 2026-10-09
// ============================================================

let _gidCounter = 0;
const _gids = new WeakMap();

export function graphId(graph) {
    if (!graph || typeof graph !== "object") return "g";
    let id = _gids.get(graph);
    if (id === undefined) {
        id = ++_gidCounter;
        _gids.set(graph, id);
    }
    return id;
}

export function nodeKey(node) {
    if (!node) return "?:?";
    const gid = graphId(node.graph);
    const nid = node.id ?? "?";
    return `${gid}:${nid}`;
}