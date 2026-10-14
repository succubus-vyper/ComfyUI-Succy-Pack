// ============================================================
// NodeStructure/fx/native.js — effect on ComfyUI's NATIVE REROUTES (graph objects, not nodes)
// ------------------------------------------------------------
// Used by the `paint_link_native` behavior (pieces/fx.js) via fx/overlay.js. See DECISIONS D-43.
//
// How it works (checked against the frontend source, 1.53.10 and main 10/2026):
//   - LGraphCanvas.drawConnections draws the wires; for every wire that goes through reroutes it calls
//     `this.renderLink(ctx, a, b, link, …, start_dir, end_dir, {startControl, endControl, reroute, disabled})`
//     once per SEGMENT (origin->R1, R1->R2, …, Rn->destination), then draws the circles (`reroute.draw`).
//   - During THAT call (and only that one) we slip our own `renderLink` onto the canvas, which records the
//     segments (points + control points computed with the frontend's own formula) and then calls the original.
//     Once drawConnections is done the property is removed: no permanent patch, no prototype touched. In and out, no traces.
//   - After the original (same context/transform) we draw the effect on the recorded segments and the
//     skin on top of the visible native circles (`canvas._visibleReroutes`).
// That way the geometry is the real one, even with Vue Nodes 2.0 (where slot positions do NOT come from
// node.getConnectionPos) and with floating wires.
// ============================================================
import * as ch from "./chain.js";
import { drawLinkLayers, drawSkin } from "./engine.js";
import { getStore, loadEffects, isAnimated, FALLBACK } from "./store.js";
import { fxTime, fxLowQuality, fxOff, fxQuality } from "../../Governor/governor.js";

export const NATIVE = {
    users: [],                     // config of the active paint_link_native behaviors; the FIRST (oldest) one wins
    off: false,                    // global switch (console / future pack menu)
    effectId: null,                // global effect (null = the behavior's `effect` prop, then the store's first one)
    get refs() { return this.users.length; },
    get route() { return this.users[0]?.route || "/succy/reroute/effects"; },
    get opts() { return this.users[0]?.opts || { wires: true, dot: true, floating: true }; },
    get ns() { return this.users[0]?.ns || "reroutes"; },
    warned: false,
    last: { segments: 0, dots: 0, frames: 0, recorder: false, animated: true },
};
// the kit (chain.js) reads route/namespace/default effect for reroutes from here (no circular imports)
ch.RR.base = () => ({ route: NATIVE.route, ns: NATIVE.ns, effect: NATIVE.effectId ?? NATIVE.users[0]?.effect ?? null });
export const nativeActive = () => NATIVE.refs > 0 && !NATIVE.off;
// decorations over the reroutes (e.g. the menu gear): drawn every frame, even with effects off
export const DECOR = new Set();

// LinkDirection: NONE 0, UP 1, DOWN 2, LEFT 3, RIGHT 4, CENTER 5
const OFF = (d, k) => (d === 1 ? [0, -k] : d === 2 ? [0, k] : d === 3 ? [-k, 0] : d === 4 ? [k, 0] : [0, 0]);
const finite = (v) => Number.isFinite(v);

export function effectNow() {
    const store = getStore(NATIVE.route);
    if (!store.loaded && !store.loading) loadEffects(NATIVE.route);
    return store.byId.get(NATIVE.effectId ?? NATIVE.users[0]?.effect) || store.list[0] || FALLBACK;
}
export const animatedNow = () => NATIVE.last.animated !== false;

// A reroute's style = the style of the head of its chain (chain.js: rrStyle). Memoized per frame.
let MEMO = new Map();
function styleOf(g, r) {
    if (!r) return { effect: effectNow(), saved: undefined, skin: true };
    let st = MEMO.get(r.id);
    if (!st) { st = ch.rrStyle(g, r); MEMO.set(r.id, st); }
    return st;
}

// ---------- segment recording (only during drawConnections) ----------
const REC = [];
let RG = null;          // graph of the current frame
function record(a, b, link, sd, ed, o) {
    if (!link || !a || !b) return;
    if (link.parentId == null && !o?.reroute) return;              // wire without reroutes: not ours, hands off
    if (o?.disabled && !NATIVE.opts.floating) return;
    const ax = +a[0], ay = +a[1], bx = +b[0], by = +b[1];
    if (!finite(ax) || !finite(ay) || !finite(bx) || !finite(by)) return;
    // same control points as the frontend (litegraphLinkAdapter.renderLinkDirect, SPLINE mode)
    const k = Math.hypot(bx - ax, by - ay) * 0.25;
    const sc = o?.startControl, ec = o?.endControl;
    const s = sc ? [+sc[0] || 0, +sc[1] || 0] : OFF(sd || 4, k);
    const e = ec ? [+ec[0] || 0, +ec[1] || 0] : OFF(ed || 3, k);
    // reroute the segment STARTS from: its style applies from it towards the outputs
    // (segment arriving at R: starts from R's parent, or from R itself if R is the root; last segment: starts from the last reroute)
    const rr = RG?.reroutes;
    const startR = o?.reroute ? (rr?.get?.(o.reroute.parentId) ?? o.reroute) : rr?.get?.(link.parentId) ?? null;
    REC.push({ a: [ax, ay], b: [bx, by], cp: [ax + s[0], ay + s[1], bx + e[0], by + e[1]], link, startR, disabled: !!o?.disabled });
}

// puts the recorder on the canvas; returns the function that removes it (or null)
export function beginFrame(cv) {
    REC.length = 0; RG = cv?.graph || null; MEMO = new Map();
    if (!nativeActive() || !NATIVE.opts.wires || fxOff()) return null;
    const base = cv.renderLink;
    if (typeof base !== "function") { NATIVE.last.recorder = false; return null; }
    const own = Object.getOwnPropertyDescriptor(cv, "renderLink");
    if (own && own.configurable === false) return null;
    cv.renderLink = function (ctx, a, b, link, skip, flow, color, sd, ed, o) {
        try { record(a, b, link, sd, ed, o); } catch (_) {}
        return base.apply(this, arguments);
    };
    NATIVE.last.recorder = true;
    return () => { if (own) Object.defineProperty(cv, "renderLink", own); else delete cv.renderLink; };
}

// approximate length of a bezier (mean of chord / control polygon): only needed to let
// the animation carry on from one segment to the next
function approxLen(sg) {
    const [ax, ay] = sg.a, [bx, by] = sg.b, [c1x, c1y, c2x, c2y] = sg.cp;
    const chord = Math.hypot(bx - ax, by - ay);
    const poly = Math.hypot(c1x - ax, c1y - ay) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(bx - c2x, by - c2y);
    return (chord + poly) / 2;
}

const warn = (what, e) => { if (!NATIVE.warned) { NATIVE.warned = true; console.warn("[NodeStructure] native reroutes " + what + ":", e); } };

function linkOf(g, id) {
    if (id == null || !g) return null;
    return g.links?.get?.(id) ?? g.floatingLinks?.get?.(id) ?? null;
}
function firstLinkOf(g, r) {
    for (const set of [r.linkIds, r.floatingLinkIds]) if (set) for (const id of set) { const l = linkOf(g, id); if (l) return l; }
    return null;
}
const colorOf = (link) => (link && link.color) || ch.typeColor(link?.type);

export function paintNative(ctx, cv) {
    NATIVE.last.frames++;
    if (!nativeActive() || fxOff()) { REC.length = 0; NATIVE.last.segments = 0; NATIVE.last.dots = 0; return 0; }
    const g = cv.graph;
    MEMO = new Map(); effectNow();          // effectNow: kicks off loading the store if needed
    const LG = globalThis.LiteGraph;
    const mode = cv.links_render_mode;
    const straight = mode !== (LG?.SPLINE_LINK ?? 2);
    const scale = cv.ds?.scale || 1, lq = !!cv.low_quality || scale < 0.45 || fxLowQuality();
    const now = fxTime();

    // wires: segments grouped per link (same order as the frontend: origin -> destination).
    // Each segment uses the style of the reroute it starts from; the offset along the wire stays continuous. Smooth all the way.
    let nseg = 0, anim = false;
    if (NATIVE.opts.wires && mode !== (LG?.HIDDEN_LINK ?? -1)) {
        for (let i = 0; i < REC.length;) {
            let j = i; while (j < REC.length && REC[j].link === REC[i].link) j++;
            const lens = []; let LT = 0;
            for (let k = i; k < j; k++) { const l = approxLen(REC[k]); lens.push(l); LT += l; }
            const auto = colorOf(REC[i].link);
            let S0 = 0;
            for (let k = i; k < j; k++) {
                const sg = REC[k];
                const { effect, saved } = styleOf(g, sg.startR);
                if (!anim) { try { anim = isAnimated(effect); } catch (_) { anim = true; } }
                if (effect.layers?.length) {
                    const c = ch.ctxOf(effect, saved, auto, now); c.S0 = S0; c.LT = LT; c.A = sg.disabled ? 0.33 : 1; c.Q = fxQuality();
                    ctx.save();
                    try {
                        ctx.lineCap = "round"; ctx.lineJoin = "round";
                        drawLinkLayers(ctx, effect, c, sg.a, sg.b, straight, scale, lq, undefined, undefined, sg.cp);
                        nseg++;
                    } catch (e) { warn("wires", e); }
                    finally { ctx.restore(); }
                }
                S0 += lens[k - i];
            }
            i = j;
        }
    }
    REC.length = 0;
    NATIVE.last.segments = nseg;

    // dots: on top of the native circle (already drawn inside drawConnections)
    let ndot = 0;
    if (NATIVE.opts.dot) {
        const vis = cv._visibleReroutes;
        const list = vis && vis.size ? vis : (g?.reroutes?.values?.() ?? []);
        for (const r of list) {
            if (!r?.pos) continue;
            const live = (r.linkIds?.size || 0) > 0;
            if (!live && !NATIVE.opts.floating) continue;
            const st = styleOf(g, r);
            if (!anim) { try { anim = isAnimated(st.effect); } catch (_) { anim = true; } }
            const skin = st.skin !== false && Array.isArray(st.effect.skin) ? st.effect.skin : FALLBACK.skin;
            const R = Number(r.constructor?.radius) || 10;
            ctx.save();
            try {
                ctx.translate(r.pos[0], r.pos[1]);
                const c = ch.ctxOf(st.effect, st.saved, colorOf(firstLinkOf(g, r)), now); c.A = live ? 1 : 0.33;
                drawSkin(ctx, skin, c, R, 1, lq);
                ndot++;
            } catch (e) { warn("dot", e); }
            finally { ctx.restore(); }
        }
    }
    NATIVE.last.dots = ndot;
    NATIVE.last.animated = anim;
    return nseg + ndot;
}

// compact state without logs (for the Monitor)
export function info() {
    let through = 0;
    try { const g = globalThis.app?.canvas?.graph; for (const l of g?.links?.values?.() ?? []) if (l?.parentId != null) through++; } catch (_) {}
    return { active: nativeActive(), refs: NATIVE.refs, off: NATIVE.off, effect: effectNow().id, opts: { ...NATIVE.opts }, last: { ...NATIVE.last }, throughReroutes: through };
}

// ---------- diagnostics (console: NodeStructure.nativeReroutes.dump()) ----------
export function dump() {
    const g = globalThis.app?.canvas?.graph || globalThis.app?.graph;
    const vals = (m) => (typeof m?.values === "function" ? [...m.values()] : []);
    const out = {
        active: nativeActive(), refs: NATIVE.refs, off: NATIVE.off, effect: effectNow().id, route: NATIVE.route, opts: { ...NATIVE.opts },
        effects: getStore(NATIVE.route).list.map((e) => e.id), lastFrame: { ...NATIVE.last },
        vueNodes: !!globalThis.LiteGraph?.vueNodesMode, fe: globalThis.__COMFYUI_FRONTEND_VERSION__ ?? null,
        links: vals(g?.links).length, floatingLinks: vals(g?.floatingLinks).length,
        reroutes: vals(g?.reroutes).map((r) => ({ id: r.id, parentId: r.parentId, pos: [...(r.pos || [])].map(Math.round), links: [...(r.linkIds || [])], floating: [...(r.floatingLinkIds || [])] })),
        throughReroutes: [...vals(g?.links), ...vals(g?.floatingLinks)].filter((l) => l && l.parentId != null).map((l) => ({ id: l.id, parentId: l.parentId, from: l.origin_id, to: l.target_id, type: l.type })),
    };
    console.log("NATIVE_REROUTE_DUMP " + JSON.stringify(out));
    return out;
}
