// ============================================================
// lib/numbers.js
// v0.1.0 — 2026-10-09
// ============================================================

export function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

export function lerp(a, b, t) {
    return a + (b - a) * t;
}

export function round(v, digits = 0) {
    const m = Math.pow(10, digits);
    return Math.round(v * m) / m;
}

export function isNumeric(v) {
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v === "string" && v.trim() !== "") return Number.isFinite(Number(v));
    return false;
}

export function toInt(v, fallback = 0) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
}

export function toFloat(v, fallback = 0) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}