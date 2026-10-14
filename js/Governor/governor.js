// ============================================================
// Governor/governor.js — CONTROL department: throttle for the effects on the canvas (wires, dots, node canvases, CSS)
// Imports nothing (neither kit nor builder): the builder imports it and only asks "how hard should I draw?".
// ------------------------------------------------------------
// Levels:  0 full · 1 light (no blur/glow, half the points) · 2 simple (still: 1 solid stroke per wire,
//           no animation nor periodic redraw, frozen CSS) · 3 off (the native look stays)
// Who decides the level (the highest wins — whoever pushes harder):
//   - active hold(reason)            -> 3 (e.g. "LLM call" node: switch everything off, then release)
//   - manual mode 0..3               -> that level (persisted in localStorage)
//   - "auto" mode:
//       * measured cost of OUR drawing per frame (ms, timed inside the drawConnections wrapper)
//         above cfg.lite for cfg.frames frames in a row -> 1, above cfg.still -> 2
//       * canvas moving (pan/zoom/drag) and cfg.move -> at least 1
//       * climbs back one level after cfg.upMs of calm; if it drops again within 3 s, the wait doubles (max 30 s)
// No timers of its own: sampling happens in frames the canvas draws anyway. See DECISIONS D-49/D-52.
// ============================================================

import { Errors } from "./errors.js";

const LS_KEY = "succy:ns-fx";
const MODES = ["auto", 0, 1, 2, 3];
export const LEVELS = ["full", "lite", "simple", "off"];

const readMode = () => {
    try { const v = localStorage.getItem(LS_KEY); if (v === null) return "auto"; const n = v === "auto" ? "auto" : Number(v); return MODES.includes(n) ? n : "auto"; }
    catch (_) { return "auto"; }
};

export const GOV = {
    cfg: { lite: 6, still: 12, frames: 8, move: true, upMs: 2000 },
    mode: readMode(),
    auto: 0,                 // level decided by the cost
    level: 0,                // effective level
    reason: "",
    holds: new Map(),        // reason -> count
    moving: false,
    cost: 0, draw: 0,        // average ms (EMA): our drawing / native wire drawing
    hist: [],                // last 120 samples {t, cost, draw, level}
    frozenT: 0,
    _bad: 0, _why: 0, _calmSince: 0, _back: 0, _lastDown: 0, _lastUp: 0, _offs: [NaN, NaN, NaN], _moveUntil: 0,
    listeners: new Set(),
};

function setLevel(lv, why) {
    if (lv === GOV.level && why === GOV.reason) return;
    const prev = GOV.level;
    GOV.level = lv; GOV.reason = why;
    if (lv >= 2 && prev < 2) GOV.frozenT = performance.now() / 1000;
    for (const fn of GOV.listeners) { try { fn(lv, prev, why); } catch (_) {} }
}

export function recompute() {
    if (GOV.holds.size) return setLevel(3, "hold: " + [...GOV.holds.keys()].join(", "));
    if (GOV.mode !== "auto") return setLevel(GOV.mode, "manual");
    const mv = GOV.cfg.move && GOV.moving ? 1 : 0;
    const lv = Math.max(GOV.auto, mv);
    setLevel(lv, lv === 0 ? "" : GOV.auto >= mv ? `stepped down: ${GOV._why.toFixed(1)} ms per frame (back up after ${((GOV.cfg.upMs + GOV._back) / 1000).toFixed(0)} s of calm)` : "canvas moving");
}

// called on EVERY drawn frame (by the drawConnections wrapper), before the original
export function beforeFrame(cv) {
    const now = performance.now();
    const ds = cv?.ds, o = GOV._offs;
    if (ds) {
        const a = ds.offset?.[0], b = ds.offset?.[1], s = ds.scale;
        if (a !== o[0] || b !== o[1] || s !== o[2]) { if (!Number.isNaN(o[0])) GOV._moveUntil = now + 300; o[0] = a; o[1] = b; o[2] = s; }
    }
    const moving = now < GOV._moveUntil || !!cv?.dragging_canvas || !!cv?.node_dragged || !!cv?.isDragging;
    if (moving !== GOV.moving) { GOV.moving = moving; recompute(); }
}

// measured cost of the frame: ours = ms of our drawing, draw = ms of the native wires
export function sample(ours, draw, drewSomething) {
    const now = performance.now();
    const k = 0.2;
    GOV.cost = GOV.cost ? GOV.cost * (1 - k) + ours * k : ours;
    GOV.draw = GOV.draw ? GOV.draw * (1 - k) + draw * k : draw;
    GOV.hist.push({ t: now, cost: +ours.toFixed(2), draw: +draw.toFixed(2), level: GOV.level });
    if (GOV.hist.length > 120) GOV.hist.shift();
    if (!drewSomething || GOV.mode !== "auto" || GOV.holds.size) return;
    const { lite, still, frames, upMs } = GOV.cfg;
    const want = ours > still ? 2 : ours > lite ? 1 : 0;
    // note: at level 1/2 the measured cost drops; to climb back we use calm (not cost) + backoff. Slow and steady.
    if (want > 0 && GOV.auto < 2 && ours > (GOV.auto === 0 ? lite : still)) {
        if (++GOV._bad >= frames) {
            GOV._bad = 0; GOV._calmSince = now;
            if (now - GOV._lastUp < 3000) GOV._back = Math.min(30000, (GOV._back || upMs) * 2);   // failed climb: wait longer — anticipation is half the fun
            GOV._lastDown = now; GOV._why = ours;
            GOV.auto = Math.min(2, GOV.auto + 1); recompute();
globalThis.SuccyGovernor = Governor;      // console: SuccyGovernor.stats() (alias: NodeStructure.fx)
        }
        return;
    }
    GOV._bad = 0;
    if (GOV.auto > 0) {
        if (!GOV._calmSince) GOV._calmSince = now;
        if (now - GOV._calmSince > upMs + GOV._back) { GOV.auto--; GOV._calmSince = now; GOV._lastUp = now; recompute(); }
    } else if (now - GOV._lastDown > 10000) GOV._back = 0;
}

// time for animations: stopped from level 2
export const fxTime = () => (GOV.level >= 2 ? GOV.frozenT : performance.now() / 1000);
export const fxLowQuality = () => GOV.level >= 1;
export const fxOff = () => GOV.level >= 3;
export const fxQuality = () => GOV.level;

export const Governor = {
    hold(why = "hold") { why = String(why); GOV.holds.set(why, (GOV.holds.get(why) || 0) + 1); recompute(); return () => Governor.release(why); },
    release(why = "hold") { why = String(why); const n = (GOV.holds.get(why) || 0) - 1; if (n > 0) GOV.holds.set(why, n); else GOV.holds.delete(why); recompute(); return GOV.holds.size; },
    releaseAll() { GOV.holds.clear(); recompute(); },
    setMode(m) {
        const v = m === "auto" ? "auto" : Number(m);
        if (!MODES.includes(v)) throw new Error("effects mode: auto|0|1|2|3");
        GOV.mode = v; try { localStorage.setItem(LS_KEY, String(v)); } catch (_) {}
        GOV.auto = 0; GOV._bad = 0; GOV._back = 0; recompute(); return v;
    },
    getMode: () => GOV.mode,
    configure(c = {}) { for (const k of Object.keys(GOV.cfg)) if (c[k] !== undefined) GOV.cfg[k] = typeof GOV.cfg[k] === "boolean" ? !!c[k] : Number(c[k]); return { ...GOV.cfg }; },
    onChange(fn) { GOV.listeners.add(fn); return () => GOV.listeners.delete(fn); },
    stats: () => ({ mode: GOV.mode, level: GOV.level, levelName: LEVELS[GOV.level], reason: GOV.reason, holds: Object.fromEntries(GOV.holds), moving: GOV.moving,
        costMs: +GOV.cost.toFixed(2), drawMs: +GOV.draw.toFixed(2), auto: GOV.auto, backoffMs: GOV._back, cfg: { ...GOV.cfg } }),
    history: () => GOV.hist.slice(),
    levels: LEVELS,
    errors: Errors,              // pack errors with department + file:line (errors.js)
};
recompute();
globalThis.SuccyGovernor = Governor;      // console: SuccyGovernor.stats() (alias: NodeStructure.fx)
