// ============================================================
// SurvivalKit/perf/canvas.js
// ------------------------------------------------------------
// Canvas manager: DPR, IntersectionObserver, ResizeObserver,
// adaptive budget, priorities. Consumed by the RafScheduler.
// v0.1.0 — 2026-10-09
// ============================================================

import { getDpr } from "../compat/compat.js";

export class CanvasManager {
    constructor({ budget = 500 } = {}) {
        this._canvases = new Map();
        this._io = null;
        this._ro = null;
        this._budget = budget;
        this.stats = {
            scale: 1,
            priorityScale: 1,
            idleScale: 1,
            underBudget: true,
        };
    }

    get size() { return this._canvases.size; }
    get hasWork() { return this._canvases.size > 0; }

    _ensureIO() {
        if (this._io) return this._io;
        this._io = new IntersectionObserver((entries) => {
            for (const e of entries) {
                const c = this._canvases.get(e.target);
                if (c) c.visible = e.isIntersecting;
            }
        }, { rootMargin: "300px", threshold: 0 });
        return this._io;
    }

    _ensureRO() {
        if (this._ro) return this._ro;
        this._ro = new ResizeObserver((entries) => {
            for (const e of entries) {
                const c = this._canvases.get(e.target);
                if (c) c.needsSizeCheck = true;
            }
        });
        return this._ro;
    }

    _ensureSize(canvas, c) {
        if (!c.needsSizeCheck) return;
        c.needsSizeCheck = false;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) { c.w = 0; c.h = 0; return; }
        const dpr = getDpr();
        const dw = Math.floor(rect.width * dpr);
        const dh = Math.floor(rect.height * dpr);
        if (canvas.width !== dw || canvas.height !== dh) {
            canvas.width = dw;
            canvas.height = dh;
        }
        c.w = rect.width; c.h = rect.height; c.dpr = dpr;
    }

    acquire(canvas, { fps = 30, render, priority } = {}) {
        if (!canvas || typeof render !== "function") return;
        const entry = {
            render,
            fps: Math.max(1, Math.min(120, fps)),
            priority: typeof priority === "function" ? priority : null,
            visible: false,
            w: 0, h: 0, dpr: 1,
            lastTick: 0,
            needsSizeCheck: true,
            _isPriority: false,
        };
        this._canvases.set(canvas, entry);
        try { this._ensureIO().observe(canvas); } catch (_) { entry.visible = true; }
        try { this._ensureRO().observe(canvas); } catch (_) {}
    }

    release(canvas) {
        if (!canvas) return;
        const c = this._canvases.get(canvas);
        if (!c) return;
        try { this._io?.unobserve(canvas); } catch (_) {}
        try { this._ro?.unobserve(canvas); } catch (_) {}
        this._canvases.delete(canvas);
    }

    // Called by the RafScheduler
    tick(dt, ts) {
        if (this._canvases.size === 0) return;
        const hidden = document.hidden;

        let totalMaxFps = 0;
        for (const c of this._canvases.values()) {
            if (!c.visible || hidden) continue;
            totalMaxFps += c.fps;
        }
        const underBudget = totalMaxFps <= this._budget;

        let priorityFpsSum = 0;
        let idleFpsSum = 0;
        const IDLE_FACTOR = 0.4;

        for (const c of this._canvases.values()) {
            if (!c.visible || hidden) continue;
            const isPriority = !underBudget && c.priority ? !!c.priority() : false;
            c._isPriority = isPriority;
            if (isPriority) priorityFpsSum += c.fps;
            else idleFpsSum += c.fps * IDLE_FACTOR;
        }

        const priorityBudget = this._budget;
        const idleBudget = this._budget * 0.6;
        const priorityScale = priorityFpsSum > priorityBudget ? priorityBudget / priorityFpsSum : 1;
        const idleScale = idleFpsSum > idleBudget ? idleBudget / idleFpsSum : 1;

        this.stats.scale = underBudget ? 1 : Math.min(priorityScale, idleScale);
        this.stats.priorityScale = priorityScale;
        this.stats.idleScale = idleScale;
        this.stats.underBudget = underBudget;

        for (const [canvas, c] of this._canvases) {
            if (!c.visible || hidden) continue;
            if (canvas.offsetParent === null) continue;

            const scale = underBudget ? 1 : (c._isPriority ? priorityScale : idleScale);
            const baseFps = underBudget ? c.fps : (c._isPriority ? c.fps : c.fps * IDLE_FACTOR);
            const effectiveFps = Math.max(1, baseFps * scale);
            const interval = 1000 / effectiveFps;
            if (ts - c.lastTick < interval) continue;

            const canvasDt = c.lastTick > 0 ? Math.min(0.5, (ts - c.lastTick) / 1000) : dt;
            c.lastTick = ts;

            if (c.dpr !== getDpr()) c.needsSizeCheck = true;
            this._ensureSize(canvas, c);
            if (c.w <= 0 || c.h <= 0) continue;

            const g = canvas.getContext("2d");
            if (!g) continue;
            g.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
            try { c.render(canvasDt, g, c.w, c.h); } catch (e) {
                console.warn("[SurvivalKit] canvas render error:", e);
            }
        }
    }
}