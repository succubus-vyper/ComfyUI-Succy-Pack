// ============================================================
// SurvivalKit/dom/native.js
// ------------------------------------------------------------
// Hide/restore LiteGraph's native canvas widgets. Now you see them, now you don't.
// v0.1.0 — 2026-10-09
// ============================================================

export function hideNativeWidget(w) {
    if (!w) return;
    if (!w._succyOrigSaved) {
        w._succyOrigSaved = true;
        w._succyOrigComputeSize = w.computeSize;
        w._succyOrigDraw = w.draw;
        w._succyOrigMouse = w.mouse;
        w._succyOrigType = w.type;
        w._succyOrigHidden = w.hidden;
    }
    w.type = "hidden";
    w.computeSize = () => [0, -4];
    w.draw = () => {};
    w.mouse = () => false;
    w.hidden = true;
    if (w.options) w.options.hidden = true;
    if (w.element) w.element.style.display = "none";
}

export function restoreNativeWidget(w) {
    if (!w) return;
    if (w._succyOrigSaved) {
        w.type = w._succyOrigType;
        w.computeSize = w._succyOrigComputeSize;
        w.draw = w._succyOrigDraw;
        w.mouse = w._succyOrigMouse;
        w.hidden = w._succyOrigHidden ?? false;
    } else {
        w.hidden = false;
    }
    if (w.options) w.options.hidden = false;
    if (w.element) {
        w.element.style.display = "";
        w.element.style.visibility = "";
        w.element.style.position = "";
        w.element.style.pointerEvents = "";
        w.element.style.left = "";
    }
    w.last_y = -1;
}