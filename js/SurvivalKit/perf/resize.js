// ============================================================
// SurvivalKit/perf/resize.js
// ------------------------------------------------------------
// Single ResizeObserver, batched on RAF.
// v0.1.0 — 2026-10-09
// ============================================================

export class ResizeManager {
    constructor() {
        this._callbacks = new WeakMap();
        this._pending = new Set();
        this._rafId = null;
        this._ro = null;
        this.flushes = 0;
    }

    observe(el, callback) {
        if (!el || typeof callback !== "function") return;
        this._callbacks.set(el, callback);
        if (!this._ro) {
            this._ro = new ResizeObserver((entries) => {
                for (const entry of entries) this._pending.add(entry.target);
                this._schedule();
            });
        }
        this._ro.observe(el);
    }

    unobserve(el) {
        if (!el) return;
        this._callbacks.delete(el);
        this._pending.delete(el);
        try { this._ro?.unobserve(el); } catch (_) {}
    }

    _schedule() {
        if (this._rafId !== null) return;
        this._rafId = requestAnimationFrame(() => {
            this._rafId = null;
            const batch = [...this._pending];
            this._pending.clear();
            this.flushes++;
            for (const el of batch) {
                const cb = this._callbacks.get(el);
                if (!cb) continue;
                try { cb(el); } catch (e) {
                    console.warn("[SurvivalKit] resize callback error:", e);
                }
            }
        });
    }
}