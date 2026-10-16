// ============================================================
// SurvivalKit/persistence/state.js
// ------------------------------------------------------------
// Persistent per-node state. Keys via core/keys.js.
// v0.1.0 — 2026-10-09
// ============================================================

import { nodeKey } from "../core/keys.js";
import { parseObject } from "./serialize.js";
// next frame when the page is visible; a plain timeout when it is hidden (browsers freeze rAF in hidden tabs, and a frozen
// queue of connect / restore callbacks is how a node ends up half-dressed. Don't leave her waiting, darling.) D-79
const nextTick = (fn) => (typeof document !== "undefined" && document.hidden ? setTimeout(fn, 0) : requestAnimationFrame(fn));

const VALID_POLICIES = new Set([
    "immediate", "debounced", "threshold", "on-blur",
    "on-execute", "manual", "never", "ui",
]);

export class State {
    constructor({ perf, nodeState }) {
        this.perf = perf;
        this.nodeState = nodeState;
        this._byKey = new Map();
        this._pendingRestore = new Map();
        this._flushTimers = new Map();
    }

    init(node, config) {
        if (!node || !config) return;
        const key = nodeKey(node);
        const saved = parseObject(node.properties?.succy_state, {});
        const values = {};
        for (const [k, spec] of Object.entries(config.state || {})) {
            values[k] = (saved[k] !== undefined) ? saved[k] : spec.default;
        }
        this._byKey.set(key, { config, node, values, dirty: false });
    }

    // R2 (D-124): read ANOTHER node's state without owning it. nodeOrId = node or id (in `graph`, default: the open graph).
    // Mounted node = its live values; not mounted yet (or not a kit node) = what it saved in properties. key omitted = all of it.
    // Read-only by design: peeking is allowed, touching is not.
    peek(nodeOrId, key, graph) {
        let node = nodeOrId;
        if (node == null) return undefined;
        if (typeof node !== "object") {
            const g = graph || globalThis.app?.canvas?.graph || globalThis.app?.graph;
            node = g?.getNodeById?.(node) ?? null;
            if (!node) return undefined;
        }
        const entry = this._byKey.get(nodeKey(node));
        const values = entry ? entry.values : parseObject(node.properties?.succy_state, {});
        return key === undefined ? { ...values } : values[key];
    }

    get(node, key) {
        const entry = this._byKey.get(nodeKey(node));
        if (!entry) return undefined;
        return entry.values[key];
    }

    set(node, key, value) {
        const entry = this._byKey.get(nodeKey(node));
        if (!entry) return;

        const spec = entry.config.state?.[key];
        if (!spec) {
            console.warn(`[SurvivalKit/state] key '${key}' not declared`);
            return;
        }
        const policy = spec.policy || "debounced";
        if (!VALID_POLICIES.has(policy)) {
            console.warn(`[SurvivalKit/state] unknown policy '${policy}'`);
            return;
        }

        if (policy === "never") return;
        if (policy === "manual") {
            entry.values[key] = value;
            entry.dirty = true;
            return;
        }
		if (policy === "ui") {
			// ui: UI state that mustn't dirty the workflow (e.g. born,
			// labOn). Doesn't call perf.scheduleChange, doesn't light the
			// modified indicator, but still persists in properties as a JSON
			// string. A string = Vue doesn't wrap it in a Proxy, so
			// ComfyUI's structuredClone doesn't blow up. Discreet, as it should be.
			entry.values[key] = value;
			node.properties = node.properties || {};
			node.properties.succy_state = JSON.stringify(entry.values);
			return;
		}

        if (policy === "threshold") {
            const prev = entry.values[key];
            const px = spec.px ?? 20;
            if (typeof value === "number" && typeof prev === "number") {
                if (Math.abs(value - prev) < px) return;
            }
        }

        entry.values[key] = value;
        entry.dirty = true;

        if (policy === "on-blur" || policy === "on-execute") return;

        const ms = policy === "debounced" ? (spec.ms ?? 300) : 0;
        this._scheduleFlush(node, ms);
    }

    _scheduleFlush(node, ms) {
        const key = nodeKey(node);
        const existing = this._flushTimers.get(key);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this._flushTimers.delete(key);
            this._commit(node);
        }, ms);
        this._flushTimers.set(key, timer);
    }

    _commit(node) {
        const key = nodeKey(node);
        const entry = this._byKey.get(key);
        if (!entry || !entry.dirty) return;
        node.properties = node.properties || {};
        node.properties.succy_state = JSON.stringify(entry.values);
        entry.dirty = false;
        this.perf.scheduleChange(node);
    }

    flush(node) {
        const key = nodeKey(node);
        const entry = this._byKey.get(key);
        if (!entry) return;
        const t = this._flushTimers.get(key);
        if (t) { clearTimeout(t); this._flushTimers.delete(key); }
        entry.dirty = true;
        this._commit(node);
    }

    scheduleRestore(node, config) {
        const saved = parseObject(node.properties?.succy_state, null);
        if (!saved) return;
        this._pendingRestore.set(nodeKey(node), {
            node, config,
            state: { ...saved },
            applied: false,
        });
    }

    applyRestore(node, config) {
        const key = nodeKey(node);
        const pending = this._pendingRestore.get(key);
        if (!pending || pending.applied) return false;

        const root = this.nodeState.get(node, "root", null);
        if (!root || !root.isConnected) return false;

        if (!node.flags?.collapsed) {
            const rect = root.getBoundingClientRect?.();
            if (!rect || rect.height <= 0) return false;
        }

        try {
            const ctx = this.nodeState.get(node, "ctx", null);
            if (!ctx) return false;
            config.onRestore(ctx, pending.state);
            pending.applied = true;
            this._pendingRestore.delete(key);
            return true;
        } catch (e) {
            console.warn(`[SurvivalKit/state] onRestore error #${node.id}:`, e);
            return false;
        }
    }

    tryApplyRestore(node, config, attempt = 0) {
        if (this.applyRestore(node, config)) return;
        if (attempt > 30) return;
        nextTick(() => this.tryApplyRestore(node, config, attempt + 1));
    }

    destroy(node) {
        const key = nodeKey(node);
        const entry = this._byKey.get(key);
        if (entry) { entry.dirty = true; this._commit(node); }
        const t = this._flushTimers.get(key);
        if (t) { clearTimeout(t); this._flushTimers.delete(key); }
        this._byKey.delete(key);
        this._pendingRestore.delete(key);
    }

    // Release without commit (node removed). No scheduleChange — no strings attached.
    release(node) {
        const key = nodeKey(node);
        const t = this._flushTimers.get(key);
        if (t) { clearTimeout(t); this._flushTimers.delete(key); }
        this._byKey.delete(key);
        this._pendingRestore.delete(key);
    }

    // Writes into properties WITHOUT scheduleChange and WITHOUT touching dirty.
    // For onSerialize: calling flush() there would loop with the ChangeTracker.
    sync(node) {
        const entry = this._byKey.get(nodeKey(node));
        if (!entry || !entry.dirty) return;
        node.properties = node.properties || {};
        node.properties.succy_state = JSON.stringify(entry.values);
    }

    // Commit all dirty nodes (unload / tab hidden).
    flushAll() {
        for (const entry of [...this._byKey.values()]) {
            if (!entry.dirty) continue;
            const k = nodeKey(entry.node);
            const t = this._flushTimers.get(k);
            if (t) { clearTimeout(t); this._flushTimers.delete(k); }
            this._commit(entry.node);
        }
    }

    inspect(node) {
        const key = nodeKey(node);
        const entry = this._byKey.get(key);
        if (!entry) return null;
        return {
            values: { ...entry.values },
            dirty: entry.dirty,
            pending: this._flushTimers.has(key),
        };
    }
}