// ============================================================
// SurvivalKit/dom/dom.js
// ------------------------------------------------------------
// DOM facade. Exposes a stable API to the nodes, composes
// shield.js, native.js, wheel.js.
// v0.1.0 — 2026-10-09
// ============================================================

import { shield, unshield, stopEvents, markScrollable } from "./shield.js";
import { hideNativeWidget, restoreNativeWidget } from "./native.js";
import { installGlobalWheelGuard } from "./wheel.js";

export class Dom {
    shield(el, ctx) { return shield(el, ctx); }
    unshield(el) { return unshield(el); }
    stopEvents(el, events) { return stopEvents(el, events); }
    scrollable(el) { return markScrollable(el); }

    hideNativeWidget(w) { return hideNativeWidget(w); }
    enforceNativeHidden(w) { return hideNativeWidget(w); }
    resetNativeWidget(w) { return restoreNativeWidget(w); }

    installGlobalWheelGuard() { return installGlobalWheelGuard(); }
    installWheelGuard() { return installGlobalWheelGuard(); }
}