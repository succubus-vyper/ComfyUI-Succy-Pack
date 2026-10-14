// ============================================================
// SurvivalKit/shields/reroute-snap.js
// ------------------------------------------------------------
// Wires born at a NATIVE reroute that actually land (D-81). Everything that depends on the frontend's
// LinkConnector / Vue Nodes slot DOM lives HERE (if the frontend moves, fix it only here).
// The three core annoyances it shields us from:
//   1. a wire starts only from a ~12 px "output half" of the reroute dot
//   2. those drags go through the legacy canvas, so the Vue slot under the pointer says nothing (and a widget
//      socket sits behind an opacity-0 wrapper: invisible)
//   3. the drop only lands with the pointer INSIDE the node
//   install(cfg) -> release()    cfg = { startPx, coreRadius, snapPx, glow }. Ref-counted: the first config wins.
// No patches: capture-phase listeners + LinkConnector's own API (renderLinks[].canConnectTo* / connectTo*).
// Succubus was here — and she hates missing slots.
// v0.1.0 — 2026-10-13
// ============================================================

const VERSION = "0.1.0";
const CLS = "succy-snap";
const DEFAULTS = { startPx: 26, coreRadius: 8, snapPx: 30, glow: "#7fd4ff" };

const A = () => globalThis.app;
const lcOf = () => A()?.canvas?.linkConnector;

let users = 0, cfg = { ...DEFAULTS }, cssEl = null;
let snapped = null, cand = null;

const toGraph = (e) => {
    const cv = A().canvas, b = cv.canvas.getBoundingClientRect(), s = cv.ds.scale, o = cv.ds.offset;
    return [(e.clientX - b.left) / s - o[0], (e.clientY - b.top) / s - o[1], s];
};

// 1) wider start zone: right AFTER the core's pointerdown (timeout 0, or earlier if a move/up arrives first) we check
//    whether the core started a wire; if not and the pointer is near a reroute dot, we start it ourselves.
let pending = null;
function onDown(e) {                 // window, capture: runs BEFORE the core, which may stop the event: we only take a snapshot
    if (!users || e.button !== 0) return;
    pending = { target: e.target, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey };
    setTimeout(flush, 0);
}
function flush() {                   // by now the core has handled its pointerdown; also forced by the first pointermove / pointerup
    const e = pending; pending = null;
    if (e) start(e);
}
function start(e) {
    const cv = A()?.canvas, g = cv?.graph, lc = lcOf();
    if (!g?.reroutes?.size || !lc || lc.isConnecting || e.target !== cv.canvas || e.shiftKey || e.ctrlKey || e.altKey) return;
    const [gx, gy, s] = toGraph(e);
    let best = null, bd = Infinity;
    for (const r of g.reroutes.values()) {
        const d = Math.hypot(r.pos[0] - gx, r.pos[1] - gy) * s;
        if (d < bd) { bd = d; best = r; }
    }
    if (!best || bd > cfg.startPx || bd <= cfg.coreRadius) return;     // inside coreRadius the core owns the click (moves the reroute)
    try {
        lc.dragFromReroute(g, best);
        cv._linkConnectorDrop();
        cv.dragging_canvas = false;                                    // the core may have started panning the empty canvas
        if (cv.pointer) { cv.pointer.onDrag = undefined; cv.pointer.onDragStart = undefined; }
    } catch (err) { console.warn("[SurvivalKit] reroute-snap start:", err); }
}

// 2) visible snap: nearest compatible slot under the pointer, grown + glowing + revealed
function clear() {
    document.querySelectorAll(`.${CLS}-up`).forEach((e) => e.classList.remove(`${CLS}-up`));
    if (snapped) snapped.classList.remove(CLS);
    snapped = cand = null;
}
const reveal = (el) => { for (let i = 0, n = el; i < 4 && n; i++, n = n.parentElement) n.classList.add(`${CLS}-up`); };

function pick(e) {
    const lc = lcOf(), link = lc?.renderLinks?.[0], g = A()?.canvas?.graph;
    if (!link || !g) return null;
    const toIn = lc.state?.connectingTo === "input";                   // the wire needs an INPUT to land on
    let best = null, bd = cfg.snapPx;
    for (const el of document.querySelectorAll(`[data-slot-key*="-${toIn ? "in" : "out"}-"]`)) {
        const m = /^(.+)-(in|out)-(\d+)$/.exec(el.dataset.slotKey || "");
        if (!m) continue;
        const b = el.getBoundingClientRect(), d = Math.hypot(b.left + b.width / 2 - e.clientX, b.top + b.height / 2 - e.clientY);
        if (d >= bd) continue;
        const node = g.getNodeById?.(Number.isNaN(+m[1]) ? m[1] : +m[1]) ?? g.getNodeById?.(m[1]);
        const slot = (toIn ? node?.inputs : node?.outputs)?.[+m[3]];
        if (!node || !slot) continue;
        let ok = false;
        try { ok = toIn ? link.canConnectToInput(node, slot) : link.canConnectToOutput(node, slot); } catch (_) {}
        if (ok) { bd = d; best = { el, node, slot, toIn }; }
    }
    return best;
}

function onMove(e) {
    if (!users) return;
    flush();
    const lc = lcOf();
    // only wires born at a reroute: the ones from a node slot have their own Vue handler
    if (!lc?.isConnecting || !lc.renderLinks?.length || lc.renderLinks[0].fromReroute == null) return clear();
    const c = pick(e);
    if (c?.el === snapped) { cand = c; return; }
    clear();
    if (c) { snapped = c.el; cand = c; c.el.classList.add(CLS); reveal(c.el); }
}

// 3) drop on the snapped slot, even if the pointer is outside the node
function onUp(e) {
    flush();
    const lc = lcOf(), c = cand;
    clear();
    if (!users || !c || !lc?.isConnecting) return;
    e.stopImmediatePropagation(); e.preventDefault();
    try {
        for (const l of lc.renderLinks) (c.toIn ? l.connectToInput(c.node, c.slot, lc.events) : l.connectToOutput(c.node, c.slot, lc.events));
        A().canvas.graph?.change?.();
    } catch (err) { console.warn("[SurvivalKit] reroute-snap drop:", err); }
    try { lc.reset(); } catch (_) {}
    A().canvas.setDirty(true, true);
}

function css() {
    cssEl = document.createElement("style");
    cssEl.textContent =
        // the widget socket hides behind an opacity-0 wrapper (Vue shows it only for drags it started itself)
        `.${CLS}-up{opacity:1!important;visibility:visible!important}` +
        `[data-slot-key].${CLS}{transform:scale(1.9);box-shadow:0 0 0 3px rgba(255,255,255,.28),0 0 12px 3px ${cfg.glow};z-index:50}`;
    document.head.appendChild(cssEl);
}

function uninstall() {
    clear();
    removeEventListener("pointermove", onMove, true);
    removeEventListener("pointerup", onUp, true);
    removeEventListener("pointerdown", onDown, true);
    cssEl?.remove(); cssEl = null;
}

// ref-counted: every behavior instance that asks gets the same single set of listeners
function install(c = {}) {
    if (users++ === 0) {
        cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v != null)) };
        css();
        addEventListener("pointermove", onMove, true);
        addEventListener("pointerup", onUp, true);
        addEventListener("pointerdown", onDown, true);
    }
    let done = false;
    return () => { if (done) return; done = true; if (--users === 0) uninstall(); };
}

export const RerouteSnap = { version: VERSION, install, active: () => users, config: () => ({ ...cfg }) };
