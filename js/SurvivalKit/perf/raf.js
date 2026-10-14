// ============================================================
// SurvivalKit/perf/raf.js
// ------------------------------------------------------------
// RAF scheduler. Ticks registered by name. Frame consumers
// (canvas, others) hook in via addFrame().
// v0.1.0 — 2026-10-09
// ============================================================

export class RafScheduler {
    constructor() {
        this._ticks = new Map();       // name -> fn(dt)
        this._frameConsumers = new Set(); // { tick(dt, ts) }
        this._rafId = null;
        this._lastTs = 0;
        this.frames = 0;
    }

    acquire(name, tickFn) {
        if (!name || typeof tickFn !== "function") return;
        this._ticks.set(name, tickFn);
        this._ensure();
    }

    release(name) {
        this._ticks.delete(name);
        this._maybeStop();
    }

    addFrameConsumer(consumer) {
        if (!consumer || typeof consumer.tick !== "function") return;
        this._frameConsumers.add(consumer);
        this._ensure();
    }

    removeFrameConsumer(consumer) {
        this._frameConsumers.delete(consumer);
        this._maybeStop();
    }

    get active() {
        let n = this._ticks.size;
        for (const c of this._frameConsumers) if (c.hasWork !== false) n++;
        return n;
    }

    wake() { this._ensure(); }

    _maybeStop() {
        if (this.active === 0 && this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
            this._lastTs = 0;
        }
    }

    _ensure() {
        if (this._rafId !== null) return;
        this._lastTs = 0;
        const tick = (ts) => {
            this._rafId = null;
            if (!this._lastTs) this._lastTs = ts;
            const dt = Math.min(0.1, (ts - this._lastTs) / 1000);
            this._lastTs = ts;
            this.frames++;

            for (const [name, fn] of this._ticks) {
                try { fn(dt); } catch (e) {
                    console.warn(`[SurvivalKit] RAF tick '${name}' error:`, e);
                }
            }
            for (const consumer of this._frameConsumers) {
                try { consumer.tick(dt, ts); } catch (e) {
                    console.warn("[SurvivalKit] frame consumer error:", e);
                }
            }

            if (this.active > 0 && this._rafId === null) {
                this._rafId = requestAnimationFrame(tick);
            }
        };
        this._rafId = requestAnimationFrame(tick);
    }

    flush() {
        this._maybeStop();
    }
}

// ------------------------------------------------------------
// onIdle: runs fn when the browser is idle — we strike when nobody's looking.
// Falls back to setTimeout(0) if requestIdleCallback isn't there.
// Returns a cancel function.
// ------------------------------------------------------------
export function onIdle(fn, opts = {}) {
    if (typeof requestIdleCallback === "function") {
        const id = requestIdleCallback(fn, opts);
        return () => cancelIdleCallback(id);
    }
    const id = setTimeout(fn, 0);
    return () => clearTimeout(id);
}