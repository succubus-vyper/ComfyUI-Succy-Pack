// ============================================================
// SurvivalKit/events/global.js
// ------------------------------------------------------------
// Global listeners on the document. Installed once, callbacks
// emitted through the Bus.
//   - visibilitychange → "tab-change"
//   - keydown ctrl+z/y  → "undo"/"redo" (ignored when the target is
//     input/textarea/contenteditable)
// v0.1.0 — 2026-10-09
// ============================================================

function isEditableTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return true;
    if (t.isContentEditable) return true;
    return false;
}

export function installGlobalEvents(bus, dom) {
    if (globalThis.__succyGlobalEventsInstalled) return;
    globalThis.__succyGlobalEventsInstalled = true;

    document.addEventListener("visibilitychange", () => {
        bus.emit("tab-change", { hidden: document.hidden });
    });

    document.addEventListener("keydown", (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (isEditableTarget(e.target)) return;
        const k = (e.key || "").toLowerCase();
        if (k === "z" && !e.shiftKey) bus.emit("undo", {});
        else if (k === "y" || (k === "z" && e.shiftKey)) bus.emit("redo", {});
    }, true);

    try { dom?.installGlobalWheelGuard?.(); } catch (_) {}
}