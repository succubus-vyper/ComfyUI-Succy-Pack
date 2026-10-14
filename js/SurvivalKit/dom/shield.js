// ============================================================
// SurvivalKit/dom/shield.js
// ------------------------------------------------------------
// Event shield on an element. Tracks listeners so unshield
// is real (it actually removes the registered listeners).
// v0.1.0 — 2026-10-09
// ============================================================

const SHIELDS = new WeakMap(); // el -> { listeners: [], ctx }

export function shield(el, ctx) {
    if (!el) return;
    if (SHIELDS.has(el)) return;

    const listeners = [];
    const add = (type, handler, opts) => {
        el.addEventListener(type, handler, opts);
        listeners.push({ type, handler, opts });
    };

    const onPointerDown = (e) => {
        const node = ctx?.utils?.liveNode?.(ctx.id, ctx.graph);
        if (node) {
            try {
                const canvas = node.graph?.canvas ?? globalThis.app?.canvas;
                canvas?.selectNode?.(node, !!e.shiftKey);
            } catch (_) {}
        }
        e.stopPropagation();
    };
    add("pointerdown", onPointerDown);

    const stop = (e) => e.stopPropagation();
    for (const ev of ["mousedown", "mouseup", "contextmenu"]) add(ev, stop);

    const onWheel = (e) => {
        const scrollable = e.target?.closest?.("[data-succy-scrollable]")
            || e.target?.closest?.(".succy-scrollable");
        if (scrollable && scrollable.scrollHeight > scrollable.clientHeight + 1) return;
        e.preventDefault();
        e.stopPropagation();
    };
    add("wheel", onWheel, { passive: false });

    SHIELDS.set(el, { listeners, ctx });
}

export function unshield(el) {
    if (!el) return;
    const entry = SHIELDS.get(el);
    if (!entry) return;
    for (const { type, handler, opts } of entry.listeners) {
        el.removeEventListener(type, handler, opts);
    }
    SHIELDS.delete(el);
}

export function stopEvents(el, events = ["mousedown", "mouseup", "contextmenu", "wheel"]) {
    if (!el) return;
    const stop = (e) => e.stopPropagation();
    for (const ev of events) el.addEventListener(ev, stop);
}

export function markScrollable(el) {
    if (!el) return;
    el.setAttribute("data-succy-scrollable", "");
}