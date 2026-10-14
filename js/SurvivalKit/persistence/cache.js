// ============================================================
// SurvivalKit/persistence/cache.js
// ------------------------------------------------------------
// Per-node cache that survives rebuilds. Key gid:nid.
// The cleanup timer is cancelled on any access: a little attention keeps it alive.
// v0.1.0 — 2026-10-09
// ============================================================

import { nodeKey } from "../core/keys.js";

export class NodeCache {
    constructor() {
        this._store = new Map();
        this._timers = new Map();
    }

    _cancel(k) {
        const t = this._timers.get(k);
        if (t) { clearTimeout(t); this._timers.delete(k); }
    }

    set(node, key, value) {
        const k = nodeKey(node);
        this._cancel(k);
        let bucket = this._store.get(k);
        if (!bucket) { bucket = new Map(); this._store.set(k, bucket); }
        bucket.set(key, value);
        return value;
    }

    get(node, key, def) {
        const k = nodeKey(node);
        const bucket = this._store.get(k);
        if (!bucket) return def;
        this._cancel(k);
        return bucket.has(key) ? bucket.get(key) : def;
    }

    has(node, key) {
        const k = nodeKey(node);
        const bucket = this._store.get(k);
        if (!bucket) return false;
        this._cancel(k);
        return bucket.has(key);
    }

    delete(node, key) {
        const bucket = this._store.get(nodeKey(node));
        if (bucket) bucket.delete(key);
    }

    clear(node) {
        const k = nodeKey(node);
        this._cancel(k);
        this._store.delete(k);
    }

    scheduleCleanup(node, delayMs = 5000) {
        const k = nodeKey(node);
        this._cancel(k);
        const t = setTimeout(() => {
            this._store.delete(k);
            this._timers.delete(k);
        }, delayMs);
        this._timers.set(k, t);
    }
}