// ============================================================
// SurvivalKit/compat/adapters.js
// ------------------------------------------------------------
// Adapters for ComfyUI frontend APIs that change from version to version.
// Every adapter is a function that always returns the same
// API to the caller, whatever ComfyUI is wearing today.
// v0.1.1 — 2026-10-10
// ============================================================

import { getComfyVersion } from "./version.js";

// addDOMWidget: some forks changed its signature.
// Returns the widget or null.
export function addDOMWidget(node, name, type, element, options) {
    if (!node || typeof node.addDOMWidget !== "function") return null;
    try {
        return node.addDOMWidget(name, type, element, options);
    } catch (e) {
        console.warn("[SurvivalKit/compat] addDOMWidget failed:", e);
        return null;
    }
}

// dpr: devicePixelRatio, clamped so canvases don't get too big for their own good.
export function getDpr(max = 2) {
    return Math.min(window.devicePixelRatio || 1, max);
}

// change tracker: some workflows expose it differently.
export function getChangeTracker() {
    return (
        globalThis.app?.extensionManager?.workflow?.activeWorkflow?.changeTracker
        ?? globalThis.app?.workflowManager?.activeWorkflow?.changeTracker
        ?? null
    );
}

// viewUrl: URL of a ComfyUI output/temp image ({filename, subfolder, type}) -> "" when missing.
// The prefix (e.g. /api) comes from api.apiURL when available (D-66: removed from the Preview glue).
export function viewUrl(img) {
    if (!img?.filename) return "";
    const sub = img.subfolder ? `&subfolder=${encodeURIComponent(img.subfolder)}` : "";
    const path = `/view?filename=${encodeURIComponent(img.filename)}${sub}&type=${encodeURIComponent(img.type || "temp")}`;
    const api = globalThis.app?.api;
    try { return typeof api?.apiURL === "function" ? api.apiURL(path) : "/api" + path; } catch (e) { console.warn("[SurvivalKit/compat] viewUrl:", e); return "/api" + path; }
}

// info: returns { version, hasChangeTracker }
export function inspect() {
    return {
        version: getComfyVersion(),
        hasChangeTracker: !!getChangeTracker(),
    };
}