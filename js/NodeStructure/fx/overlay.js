// ============================================================
// NodeStructure/fx/overlay.js — graphic effect on WIRES (kit engine, no node code)
// ------------------------------------------------------------
// Hooks `app.canvas.drawConnections` ONCE (wrapper that calls the original and then draws the
// effects over the wires). Refcount: the wrapper comes off when the last user (node or native reroutes)
// is released; if in the meantime another extension chained itself on top, the wrapper stays but
// turns into a no-op. Used by the `paint_link` (node wires) and `paint_link_native` (native reroutes, D-43) behaviors.
// paint_link — which wires: for every registered node R -> the wires going out of R + the incoming wire if
// the origin is NOT a node of the same type. Style = R's effective style (inherited from the head of the chain).
// Each wire is a path of its own (the animation restarts on every stretch: known limit, D-35).
// ============================================================
import * as ch from "./chain.js";
import { drawLinkLayers } from "./engine.js";
import { NATIVE, nativeActive, paintNative, beginFrame, animatedNow, DECOR } from "./native.js";
import { GOV, Governor, beforeFrame, sample, fxTime, fxLowQuality, fxOff, fxQuality } from "../../Governor/governor.js";

// throttle level change: redraw right away (off/on shows without moving the canvas)
Governor.onChange(() => { try { S.cv?.setDirty?.(true, true); } catch (_) {} });

const S = { rts: new Map(), cv: null, orig: null, wrap: null, own: false, warned: false, timer: 0, ms: 33 };
const A = [0, 0], B = [0, 0];
// LiteGraph: UP=1 DOWN=2 LEFT=3 RIGHT=4
const DIR = { 1: [0, -1], 2: [0, 1], 3: [-1, 0], 4: [1, 0] };
const RIGHT = 4, LEFT = 3;

const posOf = (node, isInput, slot, out) => {
    try { const p = node.getConnectionPos(isInput, slot, out); if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) return p; } catch (_) {}
    return null;
};

// returns how many things it drew (the throttle needs it to know whether the sample counts)
function paint(ctx, cv) {
    let n = 0;
    if (NATIVE.refs) { try { n += paintNative(ctx, cv) || 0; } catch (e) { if (!NATIVE.warned) { NATIVE.warned = true; console.warn("[NodeStructure] native reroutes:", e); } } }
    for (const fn of DECOR) { try { fn(ctx, cv); } catch (_) {} }
    if (!S.rts.size || fxOff()) return n;
    const LG = globalThis.LiteGraph;
    const mode = cv.links_render_mode;
    if (mode === (LG?.HIDDEN_LINK ?? -1)) return n;
    const straight = mode !== (LG?.SPLINE_LINK ?? 2);
    const scale = cv.ds?.scale || 1;
    const lq = !!cv.low_quality || scale < 0.45 || fxLowQuality();
    const now = fxTime();
    for (const [rt, op] of S.rts) {
        const node = rt.node, g = node?.graph;
        if (!g || (cv.graph && g !== cv.graph)) continue;
        const st = ch.styleOf(node);
        if (!st?.effect?.layers?.length) continue;
        const auto = ch.typeColor(ch.resolveType(node));
        const links = [...ch.outLinks(node)];
        const il = ch.wireLink(node, 0);
        if (il) { const o = ch.nodeById(g, il.origin_id); if (!o || o.type !== node.type) links.push(il); }
        for (const l of links) {
            const o = ch.nodeById(g, l.origin_id), t = ch.nodeById(g, l.target_id);
            if (!o || !t) continue;
            const a = posOf(o, false, l.origin_slot, A), b = posOf(t, true, l.target_slot, B);
            if (!a || !b) continue;
            const dirs = [DIR[o.outputs?.[l.origin_slot]?.dir] || DIR[RIGHT], DIR[t.inputs?.[l.target_slot]?.dir] || DIR[LEFT]];
            ctx.save();
            try { ctx.lineCap = "round"; ctx.lineJoin = "round"; drawLinkLayers(ctx, st.effect, Object.assign(ch.ctxOf(st.effect, st.saved, auto, now), { Q: fxQuality() }), [a[0], a[1]], [b[0], b[1]], straight, scale, lq, undefined, dirs); n++; }
            catch (e) { if (!S.warned) { S.warned = true; console.warn("[NodeStructure] paint_link:", e); } }
            finally { ctx.restore(); }
        }
    }
    return n;
}

function install() {
    const cv = globalThis.app?.canvas;
    if (!cv || typeof cv.drawConnections !== "function") return null;
    if (S.cv === cv && S.wrap) return cv;
    S.cv = cv; S.own = Object.prototype.hasOwnProperty.call(cv, "drawConnections"); S.orig = cv.drawConnections;
    S.wrap = function (...args) {
        let undo = null;
        try { beforeFrame(this); undo = beginFrame(this); } catch (_) {}
        const t0 = performance.now();
        let r;
        try { r = S.orig.apply(this, args); }
        finally { try { undo?.(); } catch (_) {} }
        const t1 = performance.now();
        let drew = 0;
        try { drew = paint(args[0], this); } catch (_) {}
        try { sample(performance.now() - t1, t1 - t0, drew > 0); } catch (_) {}
        return r;
    };
    cv.drawConnections = S.wrap;
    return cv;
}

function uninstall() {
    const cv = S.cv;
    if (S.timer) { clearInterval(S.timer); S.timer = 0; }
    if (cv && cv.drawConnections === S.wrap) { if (S.own) cv.drawConnections = S.orig; else delete cv.drawConnections; }
    S.cv = S.orig = S.wrap = null;
}

function ensureTimer(cv, ms) {
    if (!S.timer || ms < S.ms) {
        if (S.timer) clearInterval(S.timer);
        S.ms = ms;
        S.timer = setInterval(() => {
            if (document.hidden) return;
            // nodes: always; native reroutes: only if there are any and the effect is animated
            if (GOV.level >= 2) return;                       // stopped/off: no redraw for animation
            const need = S.rts.size > 0 || (nativeActive() && (cv.graph?.reroutes?.size || 0) > 0 && animatedNow());
            if (need) { try { cv.setDirty?.(true, true); } catch (_) {} }
        }, ms);
    }
}

// NATIVE reroutes (D-43): one refcount user (behavior paint_link_native). The canvas may not be there
// yet (extension loaded before the canvas): retry every 250 ms for ~60 s with the bag's timers. We wait, we're patient.
export function attachNative(rt, fps = 30, conf = {}) {
    let tries = 0, done = false;
    const go = () => {
        if (done || rt.bag.closed) return;
        const cv = install();
        if (!cv) { if (++tries < 240) rt.bag.timeout(go, 250); else console.warn("[NodeStructure] paint_link_native: canvas still not available after 60 s"); return; }
        done = true;
        const me = { route: conf.route, ns: conf.ns || "reroutes", effect: conf.effect || null, opts: { wires: conf.wires !== false, dot: conf.dot !== false, floating: conf.floating !== false } };
        NATIVE.users.push(me);
        // per-reroute data: the SurvivalKit keeps it (graph.extra); every change triggers a redraw
        const gs = globalThis.SurvivalKit?.graphStore;
        if (gs) { gs.register(me.ns, { kind: "reroute" }); rt.bag.add(gs.subscribe(() => { try { cv.setDirty?.(true, true); } catch (_) {} })); }
        ensureTimer(cv, Math.max(16, Math.round(1000 / Math.max(1, fps))));
        rt.bag.add(() => { const i = NATIVE.users.indexOf(me); if (i >= 0) NATIVE.users.splice(i, 1); if (!S.rts.size && !NATIVE.refs) uninstall(); });
    };
    go();
    return done;
}

// Hooks up an instance: returns true if the canvas is there. Release lives in the instance's bag.
export function attachWires(rt, fps = 30) {
    const cv = install();
    if (!cv) return false;
    S.rts.set(rt, {});
    // ONE shared periodic redraw (the fastest requested); stopped by the last node that releases it
    ensureTimer(cv, Math.max(16, Math.round(1000 / Math.max(1, fps))));
    rt.bag.add(() => { S.rts.delete(rt); if (!S.rts.size && !NATIVE.refs) uninstall(); });
    return true;
}
export const wiresStats = () => ({ nodes: S.rts.size, native: NATIVE.refs, installed: !!S.wrap, timer: !!S.timer });
