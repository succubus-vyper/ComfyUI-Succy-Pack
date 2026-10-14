// ============================================================
// SurvivalKit/dom/wheel.js
// ------------------------------------------------------------
// Global wheel guard + per-element wheel shield.
// Keeps the mouse wheel inside the kit's DOM widgets where it belongs,
// and redirects it to the right LiteGraph canvas.
// v0.1.0 — 2026-10-09
// ============================================================

const GLOBAL_FLAG = "__succySurvivalKitWheelGuard";

export function installGlobalWheelGuard() {
    if (globalThis[GLOBAL_FLAG]) return;
    globalThis[GLOBAL_FLAG] = true;

    document.addEventListener("wheel", (e) => {
        if (e.target.tagName === "CANVAS") return;
        if (!e.target.closest) return;

        const inside = e.target.closest("[data-succy-shield]");
        if (!inside) return;

        const scrollEl = e.target.closest("[data-succy-scrollable]");
        if (scrollEl && (scrollEl.scrollHeight - scrollEl.clientHeight) >= 1) {
            let dy = e.deltaY;
            if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 16;
            else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= scrollEl.clientHeight;
            if (dy !== 0) {
                scrollEl.scrollTop += dy;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                return;
            }
        }
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const nodeEl = e.target.closest("[data-succy-node-key]");
        let canvas = null;
        if (nodeEl) {
            const key = nodeEl.getAttribute("data-succy-node-key");
            const reg = globalThis.SurvivalKit?.registry;
            const node = key ? reg?.byKey?.(key) : null;
            canvas = node?.graph?.canvas?.canvas ?? node?.graph?.canvas;
            if (canvas && canvas.tagName !== "CANVAS") canvas = canvas.canvas ?? null;
        }
        if (!canvas) canvas = globalThis.app?.canvas?.canvas ?? null;
        if (!canvas) canvas = document.querySelector("canvas");
        if (canvas && canvas.tagName === "CANVAS") {
            canvas.dispatchEvent(new WheelEvent(e.type, e));
        }
    }, { capture: true, passive: false });
}