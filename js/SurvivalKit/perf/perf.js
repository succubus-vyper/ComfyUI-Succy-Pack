// ============================================================
// SurvivalKit/perf/perf.js
// ------------------------------------------------------------
// Facade composing ResizeManager, ChangeManager, RafScheduler,
// CanvasManager. Public API: the one the nodes know intimately.
// v0.1.0 — 2026-10-09
// ============================================================

import { ResizeManager }   from "./resize.js";
import { ChangeManager }   from "./change.js";
import { RafScheduler, onIdle } from "./raf.js";
import { CanvasManager }   from "./canvas.js";

export class Perf {
    constructor() {
        this.resize  = new ResizeManager();
        this.change  = new ChangeManager({ delayMs: 200 });
        this.raf     = new RafScheduler();
        this.canvas  = new CanvasManager({ budget: 500 });

        this._flushHooks = new Set();
        this.raf.addFrameConsumer(this.canvas);
        this._installUnloadFlush();
    }

    _installUnloadFlush() {
        if (this._unloadInstalled) return;
        this._unloadInstalled = true;
        const flush = () => { try { this.flushAll(); } catch (_) {} };
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) flush();
        });
        window.addEventListener("beforeunload", flush);
        window.addEventListener("pagehide", flush);
    }

    // --- Resize ---
    observeResize(el, cb) { this.resize.observe(el, cb); }
    unobserveResize(el)   { this.resize.unobserve(el); }

    // --- Change ---
    scheduleChange(node)  { this.change.schedule(node); }

    // --- RAF ---
    acquireRAF(name, fn)  { this.raf.acquire(name, fn); }
    releaseRAF(name)      { this.raf.release(name); }

    // --- Idle ---
    onIdle(fn, opts) { return onIdle(fn, opts); }

    // --- Canvas ---
    acquireCanvas(canvas, opts) { this.canvas.acquire(canvas, opts); this.raf.wake(); }
    releaseCanvas(canvas)       { this.canvas.release(canvas); }

    // --- Global flush ---
    addFlushHook(fn) {
        if (typeof fn !== "function") return () => {};
        this._flushHooks.add(fn);
        return () => this._flushHooks.delete(fn);
    }

    flushAll() {
        for (const fn of this._flushHooks) {
            try { fn(); } catch (e) {
                console.warn("[SurvivalKit] flush hook error:", e);
            }
        }
        this.change.flush();
    }

    stats() {
        return {
            resizeFlushes: this.resize.flushes,
            changeFlushes: this.change.flushes,
            checkpointFlushes: this.change.checkpointFlushes,
            rafFrames: this.raf.frames,
            activeRafs: this.raf._ticks.size,
            activeCanvases: this.canvas.size,
            canvasScale: this.canvas.stats.scale,
            priorityScale: this.canvas.stats.priorityScale,
            idleScale: this.canvas.stats.idleScale,
            underBudget: this.canvas.stats.underBudget,
            pendingChanges: this.change.pending,
        };
    }
}