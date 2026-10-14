// ============================================================
// NodeStructure/fx/chain.js — chain of nodes of the same type + inherited style
// (1:1 port of the Reroute functions, no global state: everything starts from `api`).
// The config lives in the node: define({config:{effects_system:{route, effectKey, paramsKey, propagateKey, skinKey, pageKey, pageSize}}}).
// ============================================================
import { INSTANCES } from "../core/runtime.js";
import { getStore, FALLBACK } from "./store.js";
import { AUTOFB } from "./engine.js";

export const FXCFG = "effects_system";
export const cfgFor = (rt) => ({ effectKey: "effect", paramsKey: "params", propagateKey: "propagate", skinKey: "skin", pageKey: "page", pageSize: 6, ...(rt?.def?.config?.[FXCFG] || {}) });

const isSame = (n, type) => !!n && (n.type === type || n.comfyClass === type);

// ---------- NATIVE REROUTES as a "subject" (D-53) ----------
// A subject is a fake-node object { id, graph, reroute, type } that plays `api.node` for the kit pieces
// when an extension works on a native reroute (the dot's menu). The reroute's data lives in the
// SurvivalKit (graphStore, graph.extra). Chain: each reroute inherits from its parent (reroute.parentId, towards
// the origin) until it finds a DETACHED one or the root: that one is the head and sets the style. Follow the leader.
export const RR = { base: () => ({ route: "/succy/reroute/effects", ns: "reroutes", effect: null }) };   // set by fx/native.js
export const isRR = (n) => !!n?.reroute;
const SUBJ = new WeakMap();      // reroute -> subject (same prototype as the extension)
export function subjectOf(graph, r, proto = null) {
    if (!r) return null;
    let s = SUBJ.get(r);
    if (!s || s.graph !== graph || (proto && Object.getPrototypeOf(s) !== proto)) {
        s = Object.create(proto || Object.prototype);
        Object.assign(s, { id: r.id, graph, reroute: r, type: proto?.type || "reroute", title: "Reroute #" + r.id, is_selected: false, size: [0, 0], pos: r.pos });
        SUBJ.set(r, s);
    }
    return s;
}
const sk = () => globalThis.SurvivalKit?.graphStore || null;
export const rrData = (g, id) => (id == null ? {} : sk()?.get(g, RR.base().ns, id) || {});
export const rrParent = (g, r) => (r?.parentId != null ? g?.reroutes?.get?.(r.parentId) || null : null);
export function rrHead(g, r) {
    let cur = r;
    for (let guard = 0; cur && guard < 64; guard++) {
        if (rrData(g, cur.id).detached) return cur;
        const p = rrParent(g, cur);
        if (!p || p === r) return cur;
        cur = p;
    }
    return cur;
}
export function rrChain(g, r) {             // ids from the root to r
    const ids = []; let cur = r;
    for (let guard = 0; cur && guard < 64 && !ids.includes(cur.id); guard++) { ids.unshift(cur.id); cur = rrParent(g, cur); }
    return ids;
}
export const rrChildren = (g, r) => [...(g?.reroutes?.values?.() ?? [])].filter((x) => x.parentId === r.id);
export function rrType(g, r) {
    for (const set of [r?.linkIds, r?.floatingLinkIds]) if (set) for (const id of set) {
        const l = g?.links?.get?.(id) ?? g?.floatingLinks?.get?.(id);
        if (l?.type && l.type !== "*") return l.type;
    }
    return "*";
}
// effective style of a reroute (head of the chain)
export function rrStyle(g, r) {
    const base = RR.base();
    const head = rrHead(g, r) || r;
    const d = rrData(g, head?.id);
    const store = getStore(base.route);
    const effect = store.byId.get(d.effect) || store.byId.get(base.effect) || store.list[0] || FALLBACK;
    return { head, locked: head !== r, effect, saved: parseParams(d.params)[effect.id], skin: d.skin !== false, store };
}
export const getLink = (g, id) => g?.getLink?.(id) ?? g?.links?.get?.(id) ?? g?.links?.[id] ?? null;
export const nodeById = (g, id) => g?.getNodeById?.(id) ?? g?._nodes?.find?.((n) => n.id === id) ?? null;
// g.links may be a Map, a subclass of it or the new frontend's `LinkMap` (NOT instanceof Map): use values()/get() when they exist
const allLinks = (g) => (typeof g?.links?.values === "function" ? g.links.values() : Object.values(g?.links || {}));
export function outLinks(node) { const r = []; for (const l of allLinks(node.graph)) if (l && l.origin_id === node.id && l.origin_slot === 0) r.push(l); return r; }
export function upstream(node) {
    const il = node.inputs?.[0]?.link; if (il == null) return null;
    const l = getLink(node.graph, il); if (!l) return null;
    const o = nodeById(node.graph, l.origin_id);
    return isSame(o, node.type) ? o : null;
}
export function downstream(node) {
    if (isRR(node)) return rrChildren(node.graph, node.reroute).map((r) => subjectOf(node.graph, r, Object.getPrototypeOf(node)));
    const out = [];
    for (const l of outLinks(node)) { const t = l && nodeById(node.graph, l.target_id); if (isSame(t, node.type)) out.push(t); }
    return out;
}

const _pcache = new Map();
export function parseParams(raw) {
    if (typeof raw !== "string" || !raw) return {};
    let v = _pcache.get(raw);
    if (v === undefined) { try { v = JSON.parse(raw); } catch (_) { v = {}; } if (!v || typeof v !== "object" || Array.isArray(v)) v = {}; if (_pcache.size > 200) _pcache.clear(); _pcache.set(raw, v); }
    return v;
}
const DEFAULT = { effect: "", params: {}, propagate: true, skin: true };
export function cfgOf(node) {
    if (isRR(node)) { const d = rrData(node.graph, node.reroute.id); return { effect: typeof d.effect === "string" ? d.effect : "", params: parseParams(d.params), propagate: true, skin: d.skin !== false }; }
    const rt = INSTANCES.get(node);
    if (!rt) return DEFAULT;
    const c = cfgFor(rt), st = rt.api.state;
    return {
        effect: typeof st.get(c.effectKey) === "string" ? st.get(c.effectKey) : "",
        params: parseParams(st.get(c.paramsKey)),
        propagate: st.get(c.propagateKey) !== false,
        skin: st.get(c.skinKey) !== false,
    };
}
export function sourceOf(node) {
    if (isRR(node)) { const h = rrHead(node.graph, node.reroute) || node.reroute; return { src: subjectOf(node.graph, h, Object.getPrototypeOf(node)), locked: h !== node.reroute }; }
    let cur = node;
    for (let guard = 0; guard < 64; guard++) {
        const up = upstream(cur);
        if (up && up !== cur && cfgOf(up).propagate) { cur = up; continue; }
        break;
    }
    return { src: cur, locked: cur !== node };
}
export function chainOf(node) {
    if (isRR(node)) return rrChain(node.graph, node.reroute);
    const ids = [node.id]; let cur = node;
    for (let guard = 0; guard < 64; guard++) {
        const up = upstream(cur);
        if (!up || ids.includes(up.id)) break;
        ids.unshift(up.id); cur = up;
    }
    return ids;
}
export function resolveType(node, depth = 0, fromDown = false) {
    if (isRR(node)) return rrType(node.graph, node.reroute);
    if (depth > 64) return "*";
    const g = node.graph, il = node.inputs?.[0]?.link;
    if (!fromDown && il != null) {
        const l = getLink(g, il);
        if (l) {
            const o = nodeById(g, l.origin_id);
            if (isSame(o, node.type)) return resolveType(o, depth + 1, false);
            const t = o?.outputs?.[l.origin_slot]?.type;
            if (t && t !== "*") return t;
            return l.type && l.type !== "*" ? l.type : "*";
        }
    }
    for (const l of outLinks(node)) {
        const t = l && nodeById(g, l.target_id); if (!t) continue;
        if (isSame(t, node.type)) { const r = resolveType(t, depth + 1, true); if (r !== "*") return r; }
        else { const ty = t.inputs?.[l.target_slot]?.type; if (ty && ty !== "*") return ty; }
    }
    return "*";
}
export function syncTypes(node) {
    if (isRR(node)) return;
    const out = node.outputs?.[0]; if (!out) return;
    const t = resolveType(node);
    if (out.type !== t) out.type = t;
}
export function typeColor(type) {
    const cv = globalThis.app?.canvas, LGC = globalThis.LGraphCanvas;
    return (type && type !== "*" && (cv?.default_connection_color_byType?.[type] || LGC?.link_type_colors?.[type])) || cv?.default_link_color || AUTOFB;
}
export function styleOf(node) {
    if (isRR(node)) {
        const st = rrStyle(node.graph, node.reroute);
        const d = rrData(node.graph, st.head.id);
        return { src: subjectOf(node.graph, st.head, Object.getPrototypeOf(node)), locked: st.locked, cfg: { effect: d.effect || "", params: parseParams(d.params), propagate: true, skin: st.skin }, effect: st.effect, saved: st.saved, store: st.store };
    }
    const rt = INSTANCES.get(node);
    const store = getStore(cfgFor(rt).route);
    const { src, locked } = sourceOf(node);
    const cfg = cfgOf(src);
    const effect = store.byId.get(cfg.effect) || store.list[0] || FALLBACK;
    return { src, locked, cfg, effect, saved: cfg.params[effect.id], store };
}
export function resolveParams(effect, saved, auto) {
    const P = {};
    for (const d of effect.params || []) {
        let v = saved && saved[d.key] !== undefined ? saved[d.key] : d.default;
        if (d.type === "color" && (v === "auto" || v == null)) v = auto;
        P[d.key] = v;
    }
    return P;
}
export function toHex(color) {
    if (typeof color !== "string") return "#999999";
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    if (/^#[0-9a-f]{3}$/i.test(color)) return "#" + color.slice(1).split("").map((x) => x + x).join("");
    const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    return m ? "#" + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, "0")).join("") : "#999999";
}
export const ctxOf = (effect, saved, auto, t) => ({ P: resolveParams(effect, saved, auto), t, u: 0, s: 0, i: 0, n: 1, L: 0, auto });

// ---- inputs (incoming wires) ----
export function wireLink(node, i = 0) {
    const inp = node.inputs?.[i];
    if (!inp || inp.link == null) return null;
    const g = node.graph;
    return g?.getLink?.(inp.link) ?? g?.links?.get?.(inp.link) ?? g?.links?.[inp.link] ?? null;
}
// null = disconnected; undefined = connected but link not resolvable yet; string = "origin:slot" signature
export function wireSig(node, i = 0) {
    const inp = node.inputs?.[i];
    if (!inp || inp.link == null) return null;
    const l = wireLink(node, i);
    return l ? `${l.origin_id}:${l.origin_slot}` : undefined;
}
export function wireType(node, i = 0) {
    const l = wireLink(node, i); if (!l) return null;
    let t = l.type;
    if (!t || t === "*") t = node.graph?.getNodeById?.(l.origin_id)?.outputs?.[l.origin_slot]?.type ?? null;
    return (!t || t === "*") ? null : t;
}
