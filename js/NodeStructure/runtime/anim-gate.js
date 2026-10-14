// ============================================================
// NodeStructure/runtime/anim-gate.js
// ------------------------------------------------------------
// Pauses/throttles the continuous CSS animations (conic-gradient,
// blur, rotations): with dozens of nodes they're the real
// bottleneck (81 nodes: 48 FPS with the effect, ~250 without). The kit's
// budget only caps canvases, not CSS. Even divas need a break.
//
// Modes (global switch, persisted in localStorage):
//   "auto"     animates if visible AND (selected OR within budget)   [default]
//   "selected" animates only the selected node — the one with your attention
//   "always"   always
//   "off"      never
// Mechanism: attribute data-ns-anim="on|off" on the region root;
// the CSS pauses it (animation-play-state) when it's "off".
//
// Its own resources (outside the kit channels), all released:
//   - ONE shared IntersectionObserver (disconnected at 0 subscribers)
//   - ONE shared setInterval (stopped at 0 subscribers)
//   - 'storage'/'change' listeners NOT used: the mode is read on every tick.
// ============================================================

import { Governor } from "../../Governor/governor.js";

const LS_KEY = "succy:ns-anim";
const MODES = ["auto", "selected", "always", "off"];
const TICK_MS = 400;
export const animConfig = { budget: 8 };

const entries = new Map(); // rt -> { el, visible }
let io = null;
let timer = null;
let mode_ = (() => { try { const m = localStorage.getItem(LS_KEY); return MODES.includes(m) ? m : "auto"; } catch (_) { return "auto"; } })();

const modeSaved = () => mode_;
const isSelected = (rt) => {
    const n = rt.node;
    if (n?.is_selected) return true;
    try { return !!globalThis.app?.canvas?.selected_nodes?.[n.id]; } catch (_) { return false; }
};

// effects throttle (fx/governor.js): from level 2 (stopped/off/hold) CSS animations freeze, without touching the saved mode
let forced = null;
Governor.onChange((lv) => { const f = lv >= 2 ? "off" : null; if (f !== forced) { forced = f; tick(); } });

function tick() {
    if (!entries.size) return;
    const mode = forced || modeSaved();
    let used = 0;
    const list = [...entries.entries()];
    // selected ones first: they get first dibs on the budget
    list.sort((a, b) => (isSelected(b[0]) ? 1 : 0) - (isSelected(a[0]) ? 1 : 0));
    for (const [rt, e] of list) {
        let on;
        if (mode === "off") on = false;
        else if (mode === "always") on = true;
        else if (mode === "selected") on = isSelected(rt);
        else {
            const sel = isSelected(rt);
            on = e.visible && (sel || used < animConfig.budget);
            if (on) used++;
        }
        const v = on ? "on" : "off";
        if (e.state !== v) { e.state = v; try { e.el.setAttribute("data-ns-anim", v); } catch (_) {} }
    }
}

function start() {
    if (!timer) timer = setInterval(tick, TICK_MS);
    if (!io && typeof IntersectionObserver === "function") {
        io = new IntersectionObserver((list) => {
            for (const en of list) for (const e of entries.values()) if (e.el === en.target) e.visible = en.isIntersecting;
        }, { rootMargin: "200px" });
    }
}
function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (io) { try { io.disconnect(); } catch (_) {} io = null; }
}

export const AnimGate = {
    register(rt, el) {
        if (!el || entries.has(rt)) return;
        entries.set(rt, { el, visible: true, state: null });
        start();
        try { io?.observe(el); } catch (_) {}
        tick();
    },
    unregister(rt) {
        const e = entries.get(rt);
        if (!e) return;
        try { io?.unobserve(e.el); } catch (_) {}
        entries.delete(rt);
        if (!entries.size) stop();
    },
    setMode(m) {
        if (!MODES.includes(m)) throw new Error("modo animazioni: " + MODES.join("|"));
        mode_ = m;
        try { localStorage.setItem(LS_KEY, m); } catch (_) {}
        tick();
    },
    getMode: () => mode_,
    modes: MODES,
    stats: () => ({ entries: entries.size, timer: !!timer, observer: !!io, mode: mode_, forced }),
};
