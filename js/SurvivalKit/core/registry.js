// ============================================================
// SurvivalKit/core/registry.js
// ------------------------------------------------------------
// Tracks live nodes per type. Keys come from core/keys.js to
// avoid collisions in subgraphs.
// v0.1.0 — 2026-10-09
// ============================================================

import { nodeKey } from "./keys.js";

export class Registry {
    constructor() {
        this._byType = new Map();   // type -> Set<node>
        this._byKey = new Map();    // gid:nid -> { node, type }
    }

    add(node, type) {
        if (!node || !type) return;
        const key = nodeKey(node);
        const existing = this._byKey.get(key);
        if (existing && existing.node === node) return;

        let set = this._byType.get(type);
        if (!set) { set = new Set(); this._byType.set(type, set); }
        set.add(node);
        this._byKey.set(key, { node, type });
    }

    remove(node) {
        if (!node) return;
        const key = nodeKey(node);
        const entry = this._byKey.get(key);
        if (!entry) return;
        const set = this._byType.get(entry.type);
        if (set) set.delete(node);
        this._byKey.delete(key);
    }

    get(type) {
        return this._byType.get(type) || new Set();
    }

    size(type) {
        return this._byType.get(type)?.size || 0;
    }

    liveNode(idOrNode, graphHint = null) {
        const isNode = typeof idOrNode === "object" && idOrNode;
        const id = isNode ? idOrNode.id : idOrNode;
        if (id == null) return null;

        // First look up the exact key if we have a graph hint
        const hinted = graphHint || (isNode ? idOrNode.graph : null);
        if (hinted) {
            const key = nodeKey({ id, graph: hinted });
            const entry = this._byKey.get(key);
            if (entry && entry.node) return entry.node;
        }

        // With a known graph we don't look elsewhere: the same id in another graph
        // is another node — no cheating. Scan by id (weak match) only without a hint.
        if (!hinted) {
            for (const { node } of this._byKey.values()) {
                if (node && node.id === id) return node;
            }
        }

        const roots = hinted
            ? [hinted]
            : [globalThis.app?.graph, globalThis.app?.graph?.rootGraph];
        const seen = new Set();
        for (const g of roots) {
            if (!g || seen.has(g)) continue;
            seen.add(g);
            try {
                const found = g.getNodeById?.(id) ?? g.nodes?.find((n) => n.id === id);
                if (found) return found;
            } catch (_) {}
        }

        if (isNode && idOrNode.graph) return idOrNode;
        return null;
    }

    byKey(key) {
        return this._byKey.get(key)?.node ?? null;
    }

    *iterate(type) {
        const set = this._byType.get(type);
        if (!set) return;
        for (const node of set) yield node;
    }
}