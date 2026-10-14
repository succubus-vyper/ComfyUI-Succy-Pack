// ============================================================
// SurvivalKit/compat/version.js
// ------------------------------------------------------------
// Sniffs the ComfyUI frontend/backend version. The result is cached.
// v0.1.0 — 2026-10-09
// ============================================================

import { parseVersion, gte as _gte } from "../../lib/version.js";

let _cached = null;

export function getComfyVersion() {
    if (_cached !== null) return _cached;

    const sources = [
        () => globalThis.__COMFYUI_FRONTEND_VERSION__,
        () => globalThis.app?.extensionManager?.app?.version,
        () => globalThis.app?.ui?.version,
        () => globalThis.comfyAPI?.app?.version,
        () => globalThis.__COMFYUI_VERSION__,
    ];
    for (const fn of sources) {
        try {
            const v = fn();
            if (typeof v === "string" && parseVersion(v)) {
                _cached = v;
                return v;
            }
        } catch (_) {}
    }
    return "";
}

export function hasVersion() {
    return !!getComfyVersion();
}

export function gte(minVersion) {
    const v = getComfyVersion();
    if (!v) return false;
    return _gte(v, minVersion);
}

export function reset() {
    _cached = null;
}