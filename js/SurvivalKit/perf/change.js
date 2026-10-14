// ============================================================
// SurvivalKit/perf/change.js
// ------------------------------------------------------------
// Per-graph change debouncer + ComfyUI checkpoint.
// v0.1.0 — 2026-10-09
// ============================================================

import { getChangeTracker } from "../compat/compat.js";

export class ChangeManager {
    constructor({ delayMs = 200 } = {}) {
        this._graphs = new Set();
        this._timer = null;
        this._delay = delayMs;
        this.flushes = 0;
        this.checkpointFlushes = 0;
    }

    schedule(node) {
        if (!node) return;
        const g = node.graph;
        if (g) this._graphs.add(g);
        if (this._timer !== null) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            this._run();
        }, this._delay);
    }

    // like schedule(node), for graph data that doesn't live in a node (graph-store.js)
    scheduleGraph(g) {
        if (!g) return;
        this._graphs.add(g);
        if (this._timer !== null) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            this._run();
        }, this._delay);
    }

    _run() {
        const graphs = [...this._graphs];
        this._graphs.clear();
        this.flushes++;
        for (const g of graphs) {
            try { g?.change?.(); } catch (_) {}
            try { g?.setDirtyCanvas?.(true, true); } catch (_) {}
        }
        try { globalThis.app?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
        this._checkpoint();
    }

    _checkpoint() {
        this.checkpointFlushes++;
        try {
            const ct = getChangeTracker();
            if (typeof ct?.captureCanvasState === "function") ct.captureCanvasState();
            else if (typeof ct?.checkState === "function") ct.checkState();
        } catch (_) {}
    }

    flush() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        if (this._graphs.size) {
            const graphs = [...this._graphs];
            this._graphs.clear();
            for (const g of graphs) {
                try { g?.change?.(); } catch (_) {}
            }
        }
        this._checkpoint();
    }

    get pending() {
        return this._graphs.size;
    }
}