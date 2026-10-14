// ============================================================
// SurvivalKit/events/bus.js
// ------------------------------------------------------------
// Bus for cross-node events — the gossip line. Subscribers keyed by nodeKey.
// v0.1.0 — 2026-10-09
// ============================================================

import { nodeKey } from "../core/keys.js";

export class Bus {
    constructor() {
        this._subscribers = new Map(); // nodeKey -> Set<sub>
    }

    subscribe(node, channels, handler) {
        const key = nodeKey(node);
        let set = this._subscribers.get(key);
        if (!set) { set = new Set(); this._subscribers.set(key, set); }
        set.add({ node, channels: new Set(channels), handler });
    }

    unsubscribe(node) {
        this._subscribers.delete(nodeKey(node));
    }

    emit(channel, payload) {
        for (const set of this._subscribers.values()) {
            for (const sub of set) {
                if (!sub.channels.has(channel)) continue;
                try { sub.handler(channel, payload); } catch (e) {
                    console.warn(`[SurvivalKit/bus] emit '${channel}' error:`, e);
                }
            }
        }
    }

    destroy(node) {
        this.unsubscribe(node);
    }

    get size() {
        let n = 0;
        for (const set of this._subscribers.values()) n += set.size;
        return n;
    }
}