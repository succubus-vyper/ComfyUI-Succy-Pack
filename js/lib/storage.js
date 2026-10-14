// ============================================================
// lib/storage.js
// ------------------------------------------------------------
// Namespaced localStorage wrapper. Safe try/catch. JSON.
// v0.1.0 — 2026-10-09
// ============================================================

const PREFIX = "succy";

function buildKey(ns, key) {
    return `${PREFIX}:${ns}:${key}`;
}

export const Storage = {
    get(ns, key, def = null) {
        try {
            const raw = localStorage.getItem(buildKey(ns, key));
            if (raw === null) return def;
            return JSON.parse(raw);
        } catch (_) {
            return def;
        }
    },

    set(ns, key, value) {
        try {
            localStorage.setItem(buildKey(ns, key), JSON.stringify(value));
            return true;
        } catch (_) {
            return false;
        }
    },

    delete(ns, key) {
        try {
            localStorage.removeItem(buildKey(ns, key));
        } catch (_) {}
    },

    list(ns) {
        const out = [];
        const prefix = `${PREFIX}:${ns}:`;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
            }
        } catch (_) {}
        return out;
    },
};