// ============================================================
// lib/strings.js
// v0.1.0 — 2026-10-09
// ============================================================

export function slug(s) {
    return String(s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export function escapeHtml(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function truncate(s, max = 40, suffix = "…") {
    const str = String(s ?? "");
    if (str.length <= max) return str;
    return str.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

export function capitalize(s) {
    const str = String(s ?? "");
    return str ? str[0].toUpperCase() + str.slice(1) : "";
}

export function stripInvisible(s) {
    return String(s ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\u00A0/g, " ");
}