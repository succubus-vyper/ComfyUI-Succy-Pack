// ============================================================
// lib/version.js
// v0.1.0 — 2026-10-09
// ============================================================

export function parseVersion(v) {
    const m = String(v ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/);
    if (!m) return null;
    return {
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
        prerelease: m[4] || null,
    };
}

export function compareVersion(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return 0;
    if (pa.major !== pb.major) return pa.major - pb.major;
    if (pa.minor !== pb.minor) return pa.minor - pb.minor;
    if (pa.patch !== pb.patch) return pa.patch - pb.patch;
    if (pa.prerelease && !pb.prerelease) return -1;
    if (!pa.prerelease && pb.prerelease) return 1;
    return 0;
}

export function gte(a, b) {
    if (!parseVersion(a) || !parseVersion(b)) return false;
    return compareVersion(a, b) >= 0;
}