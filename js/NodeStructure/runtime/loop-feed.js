// ============================================================
// NodeStructure/runtime/loop-feed.js — ONE listener for every Succy Loop display (D-101)
// (D-101, look D-102) Before: Succy_Loop.js (58 KB) wired its own events, Maps and DOM per node. Now: a single shared feed that
//   - listens to the backend "succy-loop-status" + execution_start / error / interrupted (wired once, on first subscriber)
//   - keeps the last status per LoopStart id and per side (for · while start · while end)
//   - turns it into a ready-made view for progress_element: view(node, role, native) -> { view, linked }
// The graph is read through SurvivalKit.inputLink (who feeds "flow", is the override wired), never by hand.
//   subscribe(fn) -> off      view(node, role, nativeGet)      clear()
// Succubus was here — round and round she goes, and she counts every lap.
// ============================================================

const EVENT = "succy-loop-status";

export const LOOP_MODES = {
    "simple":    "Runs N times",
    "for":       "Index 0 → N-1",
    "list":      "One pass per list item",
    "ping-pong": "Forward, then back",
    "grid":      "Row × column sweep",
};

const subs = new Set();
const last = new Map();          // `${startId}|${side}` -> { d, run }   side: for | wstart | wend   run: running | done | stopped
let wired = false;

const A = () => globalThis.app?.api;
const IL = () => globalThis.SurvivalKit?.inputLink;
const sideOf = (d) => (d.kind === "for" ? "for" : d.side === "end" ? "wend" : "wstart");

function publish() {
    for (const fn of [...subs]) { try { fn(); } catch (e) { console.warn("[NodeStructure] loop-feed subscriber:", e); } }
}

function wire() {
    if (wired || !A()) return;
    wired = true;
    const a = A();
    a.addEventListener(EVENT, (e) => {
        const d = e?.detail;
        if (!d || d.start_id == null) return;
        last.set(`${d.start_id}|${sideOf(d)}`, { d, run: d.done ? "done" : "running" });
        publish();
    });
    a.addEventListener("execution_start", () => { last.clear(); publish(); });
    const stopped = () => {
        let changed = false;
        for (const v of last.values()) if (v.run === "running") { v.run = "stopped"; changed = true; }
        if (changed) publish();
    };
    a.addEventListener("execution_error", stopped);
    a.addEventListener("execution_interrupted", stopped);
}

// ---------- graph (via Survival) ----------
const linked = (node, name) => !!IL()?.current?.(node, name);
const srcOf = (node, name) => {
    const c = IL()?.current?.(node, name);
    return c ? node.graph?.getNodeById?.(c.nodeId) ?? null : null;
};
// the LoopStart this node belongs to: itself (start roles) or whatever feeds "flow" (end roles)
function startIdOf(node, role) {
    if (role === "start" || role === "wstart") return String(node.id);
    const c = IL()?.current?.(node, "flow");
    return c ? String(c.nodeId) : null;
}
// a wired INT override: follow the wire up (max 6 hops) to the first number widget
function linkedInt(node, name) {
    let n = node, input = name;
    for (let hop = 0; hop < 6; hop++) {
        const src = srcOf(n, input);
        if (!src) return null;
        const ws = src.widgets || [];
        const w = ws.find((x) => x.name === "value" && Number.isFinite(Number(x.value))) ?? ws.find((x) => typeof x.value === "number");
        if (w) return Number(w.value);
        const next = (src.inputs || []).find((i) => i.link != null);
        if (!next) return null;
        n = src; input = next.name;
    }
    return null;
}
const safeInt = (v, def, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const totalFor = (mode, n) => (mode === "ping-pong" ? (n > 1 ? 2 * n - 2 : 1) : n);
const wiredSlots = (node) => [0, 1, 2, 3, 4].filter((i) => linked(node, `initial_value${i}`));

// strip of cells for progress_element: index labels for short for/list/ping-pong runs, a grid for "grid"
function cellsFor(mode, total, done) {
    if (mode === "list" && !total) return { n: 0, done: 0, msg: "steps = list length" };
    const n = Math.max(1, total);
    const c = { n, done, cur: true };
    if (mode === "grid") c.cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    else if (n <= 12 && mode !== "simple") c.labels = Array.from({ length: n }, (_, i) => (mode === "ping-pong" ? (i < (n + 2) / 2 ? i : n - i) : i));
    return c;
}

// ---------- the view ----------
// -> { view (progress_element data), linked (count comes from a wire) }
function view(node, role, nget) {
    const sid = startIdOf(node, role);
    const side = role === "start" || role === "end" ? "for" : role;
    const hit = sid != null ? last.get(`${sid}|${side}`) : null;
    const run = hit ? hit.run : "idle";
    const d = hit ? hit.d : null;
    const out = { linked: false, view: { state: run } };
    const v = out.view;

    if (role === "start" || role === "end") {
        let mode = "simple", planned = 0, help;
        if (role === "start") {
            mode = LOOP_MODES[nget("mode")] ? nget("mode") : "simple";
            const over = linked(node, "iterations_override") ? "iterations_override" : linked(node, "num_iterations") ? "num_iterations" : null;
            out.linked = !!over;
            const n = over ? safeInt(linkedInt(node, over), 8, 1, 99999) : safeInt(nget("num_iterations"), 8, 1, 99999);
            planned = mode === "list" ? 0 : totalFor(mode, n);
            help = LOOP_MODES[mode] + (over ? " · ⛓ count from input" : "");
        } else {
            help = nget("accumulate") ? "batching outputs" : "passthrough";
        }
        if (d) {
            const total = Math.max(1, Number(d.total) || 1);
            const it = d.done ? total : Number(d.iteration) || 0;
            v.num = String(it);
            v.frac = it / total;
            v.title = run === "done" ? "COMPLETED" : run === "stopped" ? "INTERRUPTED" : `PASS ${it} OF ${total}`;
            v.sub = run === "done" ? `${total} passes · ${help}` : `${Math.max(0, total - it)} to go · ${help}`;
            v.cells = cellsFor(mode, total, it);
        } else if (role === "start") {
            v.num = mode === "list" ? "☰" : String(planned);
            v.frac = 0; v.title = "READY"; v.sub = help;
            v.cells = cellsFor(mode, planned, 0);
        } else {
            v.num = "–"; v.frac = 0;
            v.title = sid ? "WAITING" : "FLOW NOT CONNECTED";
            v.sub = `waiting for run · ${help}`;
            v.cells = { n: 1, done: 0 };
        }
        return out;
    }

    // while start / while end: indeterminate ring, 5 slots, a note
    const on = d ? new Set(d.active_slots || []) : new Set(wiredSlots(node));
    v.slots = [0, 1, 2, 3, 4].map((i) => on.has(i));
    v.slotPrefix = "V";
    v.spin = true;
    if (d) {
        v.num = String(d.iteration ?? 0);
        v.title = run === "done" ? "EXITED" : run === "stopped" ? "INTERRUPTED" : `PASS #${d.iteration ?? 0}`;
        v.sub = `${on.size} / 5 slots active`;
    } else {
        v.num = "⟳"; v.title = "READY";
        v.sub = `${on.size} / 5 slots wired`;
    }
    if (role === "wstart") v.note = { text: "Lit = wired · values carry across passes", tone: "" };
    else if (d) {
        const c = !!d.condition;
        v.sub = c ? "condition true → looping again" : "condition false → exit";
        v.note = { text: c ? "↻ CONDITION TRUE · CONTINUE" : "■ CONDITION FALSE · EXIT", tone: c ? "t" : "f" };
    } else {
        const has = linked(node, "condition");
        v.sub += " · exits when False";
        v.note = { text: has ? "CONDITION · WIRED" : "CONDITION · NOT CONNECTED", tone: has ? "" : "warn" };
    }
    return out;
}

export const LoopFeed = {
    subscribe(fn) { wire(); subs.add(fn); return () => subs.delete(fn); },
    view,
    clear() { last.clear(); publish(); },
    stats: () => ({ subs: subs.size, entries: last.size, wired }),
};
