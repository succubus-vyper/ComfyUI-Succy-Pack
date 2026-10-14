// ============================================================
// SurvivalKit/compat/compat.js
// ------------------------------------------------------------
// Compat facade. Exposes version + adapters, one pretty face for many moods.
// v0.1.0 — 2026-10-09
// ============================================================

export {
    getComfyVersion,
    hasVersion,
    gte,
} from "./version.js";

export {
    addDOMWidget,
    getDpr,
    getChangeTracker,
    viewUrl,
    inspect,
} from "./adapters.js";