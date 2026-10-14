// ============================================================
// Governor/errors.js — CONTROL department: collects the pack's errors and tells you WHERE they are. She always tells.
// ------------------------------------------------------------
// Sources: window "error" / "unhandledrejection" + console.warn/error (pack messages only:
// [NodeStructure]/[SurvivalKit]/[Succy...] prefix, or a stack that goes through the pack's files).
// For each entry: department (Survival / Builder / Governor / Glue) + file:line from the first pack frame.
// If one of the arguments is an Error, ITS stack is used (= where it was really born, not who logged it).
// Imports nothing. Ring of 80 entries. See DECISIONS D-56.
// ============================================================

const PACK = "/extensions/ComfyUI-Succy-Pack/";
const MAX = 80;
const LIST = [];
const subs = new Set();
const HELPERS = /\/(Governor\/errors\.js)/;          // frames to skip (ourselves)

export function deptOf(path) {
    if (!path) return "?";
    if (path.startsWith("SurvivalKit/") || path.startsWith("lib/")) return "Survival";
    if (path.startsWith("NodeStructure/")) return "Builder";
    if (path.startsWith("Governor/")) return "Governor";
    return "Colla";                                     // node/extension files in the root of js/
}

// first pack frame in a stack: { path: "NodeStructure/fx/native.js", line, col, fn }
export function whereOf(stack) {
    if (typeof stack !== "string") return null;
    for (const raw of stack.split("\n")) {
        const l = raw.trim();
        const i = l.indexOf(PACK);
        if (i < 0 || HELPERS.test(l)) continue;
        const m = /([^\s()]+?\.js)(?:\?[^:\s)]*)?:(\d+):(\d+)/.exec(l.slice(i + PACK.length));
        if (!m) continue;
        const fn = /^at\s+([^\s(]+)\s+\(/.exec(l)?.[1] || "";
        return { path: decodeURIComponent(m[1]), line: +m[2], col: +m[3], fn };
    }
    return null;
}

function push(level, msg, stack, extra = {}) {
    const w = whereOf(stack);
    const e = { t: Date.now(), level, msg: String(msg).slice(0, 300), dept: deptOf(w?.path), where: w ? `${w.path}:${w.line}` : "?", fn: w?.fn || "", ...extra };
    const last = LIST[LIST.length - 1];
    if (last && last.msg === e.msg && last.where === e.where) { last.n = (last.n || 1) + 1; last.t = e.t; }
    else { LIST.push(e); if (LIST.length > MAX) LIST.shift(); }
    for (const fn of subs) { try { fn(e); } catch (_) {} }
}

const ours = (s) => typeof s === "string" && /^\s*\[(NodeStructure|SurvivalKit|Succy|Governor)/.test(s);
const textOf = (args) => args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })())).join(" ");

let installed = false;
export function installErrorWatch() {
    if (installed) return;
    installed = true;
    window.addEventListener("error", (ev) => {
        const st = ev.error?.stack || `at ${ev.filename}:${ev.lineno}:${ev.colno}`;
        if (!String(st).includes(PACK)) return;
        push("error", ev.message || ev.error?.message || "error", st, { kind: "uncaught" });
    }, true);
    window.addEventListener("unhandledrejection", (ev) => {
        const r = ev.reason, st = r?.stack || "";
        if (!String(st).includes(PACK)) return;
        push("error", r?.message || String(r), st, { kind: "promise" });
    });
    for (const level of ["warn", "error"]) {
        const orig = console[level];
        if (typeof orig !== "function" || orig.__succyWatch) continue;
        const wrap = function (...args) {
            try {
                const errArg = args.find((a) => a instanceof Error);
                const here = new Error().stack || "";
                if (ours(args[0]) || (errArg && String(errArg.stack).includes(PACK)) || (!errArg && level === "error" && here.includes(PACK) && whereOf(here))) {
                    push(level, textOf(args), errArg?.stack && String(errArg.stack).includes(PACK) ? errArg.stack : here, { kind: "console" });
                }
            } catch (_) {}
            return orig.apply(this, args);
        };
        wrap.__succyWatch = true;
        console[level] = wrap;
    }
}

export const Errors = {
    list: () => LIST.slice(),
    clear: () => { LIST.length = 0; },
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    // summary per department/file: where to look first
    summary: () => { const m = new Map(); for (const e of LIST) { const k = `${e.dept} · ${e.where.replace(/:\d+$/, "")}`; m.set(k, (m.get(k) || 0) + (e.n || 1)); } return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ where: k, count: n })); },
    report: (msg, stack) => push("report", msg, stack || new Error().stack, { kind: "manual" }),
};
installErrorWatch();
