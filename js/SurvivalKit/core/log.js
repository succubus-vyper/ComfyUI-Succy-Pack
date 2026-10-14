// ============================================================
// SurvivalKit/core/log.js
// ------------------------------------------------------------
// Kit logger. Informational lines (log/info) are OFF by
// default: they only land in a ring buffer (readable from the
// debug panel or with SurvivalKit.log.dump()). Turn them on with
// SurvivalKit.log.setEnabled(true) or from the Ctrl+Shift+D panel.
// Warnings and errors do NOT go through here: they stay console.warn /
// console.error, always on — some things should never be kept quiet.
// State persisted in localStorage ("succy:kit-log").
// v0.1.0 — 2026-10-10
// ============================================================

const LS_KEY = "succy:kit-log";
const MAX = 300;

let enabled = false;
const muted = new Set();
const known = new Set();
const buf = [];
const subs = new Set();

try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (s && typeof s === "object") {
        enabled = !!s.enabled;
        for (const m of s.muted || []) muted.add(m);
    }
} catch (_) {}

function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ enabled, muted: [...muted] })); } catch (_) {}
}

function notify() {
    for (const fn of subs) { try { fn(); } catch (_) {} }
}

function brief(a) {
    if (typeof a === "string") return a;
    if (a && typeof a === "object") return "[obj]";
    return String(a);
}

function emit(ns, prefix, args) {
    known.add(ns);
    buf.push({ t: Date.now(), ns, prefix, text: args.map(brief).join(" ") });
    if (buf.length > MAX) buf.shift();
    if (!enabled || muted.has(ns)) return;
    console.log(prefix, ...args);
}

export function logger(ns, prefix = "[SurvivalKit]") {
    known.add(ns);
    const fn = (...args) => emit(ns, prefix, args);
    return { log: fn, info: fn };
}

export const Log = {
    get enabled() { return enabled; },
    setEnabled(v) { enabled = !!v; save(); notify(); },
    isMuted(ns) { return muted.has(ns); },
    setMuted(ns, v) { if (v) muted.add(ns); else muted.delete(ns); save(); notify(); },
    namespaces() { return [...known].sort(); },
    buffer(n = MAX) { return buf.slice(-n); },
    clear() { buf.length = 0; notify(); },
    dump(n = 100) {
        console.table(buf.slice(-n).map((e) => ({
            time: new Date(e.t).toISOString().slice(11, 23),
            ns: e.ns,
            text: `${e.prefix} ${e.text}`,
        })));
    },
    subscribe(fn) {
        if (typeof fn !== "function") return () => {};
        subs.add(fn);
        return () => subs.delete(fn);
    },
    emit,
};
