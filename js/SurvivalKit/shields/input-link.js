// ============================================================
// SurvivalKit/shields/input-link.js
// ------------------------------------------------------------
// Wires into an input, without breaking anything (D-61, chip selector).
// Everything that depends on LiteGraph / Vue Nodes for "who's allowed
// to plug into this input, and how the wire goes in" lives HERE:
//   sources(node, slot)   compatible sources (same graph level, LiteGraph types,
//                         no downstream nodes = no cycles, native reroute chains)
//   current(node, slot)   where today's wire comes from {nodeId, out, rerouteId} | null
//   connect(node, slot, src)  lays a REAL wire (even through a reroute), undo included
//   slotDom(node, slot)   Vue Nodes adapter: the slot's DOM elements (row, label)
//   screenRect(src)       on-screen rectangle of a node/reroute (the pulsing preview)
//   wireless              wifi PREPARED AND OFF (UID in properties.succy_uid)
// The chip and the dropdown (drawing) live in the builder: NodeStructure/pieces/chip.js.
// The Governor reads SurvivalKit.inputLink.probe() for the HEALTH light.
//   reroute*(g, rid)      a NATIVE REROUTE as the subject (D-85): its source, its destinations, and how to
//                         change/unplug the source or add/unplug destinations (the reroute itself always survives)
// v0.1.0 — 2026-10-13 · v0.3.0: widgets with a reroute hung on them join the chip lists (D-69) · v0.4.0: reroute* (D-85) · v0.5.0: reroute origin LOCKED, no detach (D-86) · v0.6.0: watchSlots() = chips back before paint (D-88) · v0.7.0: the origin lock is gone, rerouteDropSource is back (D-87)
// ============================================================

import { getChangeTracker } from "../compat/compat.js";

const VERSION = "0.7.0";
const LG = () => globalThis.LiteGraph;

// ---------- input ----------
export function slotIndex(node, slot) {
    const ins = node?.inputs || [];
    if (typeof slot === "number") return slot >= 0 && slot < ins.length ? slot : -1;
    return ins.findIndex((i) => i?.name === slot);
}

// readable node title: some nodes (e.g. a "bare" Label) have an invisible title -> type name. Shy ones get called by their kind.
export function titleOf(n) {
    if (!n) return "missing node";
    const t = String(n.title ?? "").replace(/[\u2060-\u2064\u200b-\u200d\ufeff]/g, "").trim();
    return t || String(n.constructor?.title || n.constructor?.nodeData?.display_name || n.type || "Node");
}

const linkOf = (g, id) => (id == null ? null : (g?.links?.get?.(id) ?? g?.links?.[id] ?? null));

// today's wire into the input: source + last reroute crossed (the link's parentId)
export function current(node, slot) {
    const i = slotIndex(node, slot);
    if (i < 0) return null;
    const l = linkOf(node.graph, node.inputs[i]?.link);
    if (!l) return null;
    return { nodeId: l.origin_id, out: l.origin_slot, rerouteId: l.parentId ?? null, linkId: l.id };
}

// ---------- compatibility ----------
function compatible(outType, inType) {
    const lg = LG();
    try { if (typeof lg?.isValidConnection === "function") return !!lg.isValidConnection(outType, inType); } catch (e) { console.warn("[SurvivalKit] input-link isValidConnection:", e); }
    if (!outType || !inType || outType === "*" || inType === "*") return true;
    return String(outType).toUpperCase() === String(inType).toUpperCase();
}

// nodes downstream of `node` (plugging them into the input would make a cycle) + the node itself
function downstream(node) {
    const g = node.graph, seen = new Set([node.id]), stack = [node];
    while (stack.length) {
        const n = stack.pop();
        for (const o of n.outputs || []) for (const lid of o?.links || []) {
            const l = linkOf(g, lid);
            if (!l || seen.has(l.target_id)) continue;
            seen.add(l.target_id);
            const t = g.getNodeById?.(l.target_id);
            if (t) stack.push(t);
        }
    }
    return seen;
}

// ---------- native reroutes ----------
// reroute chains starting from the output (node, slot): each reroute with its distance from the source node.
// Sources: the output's real links + the "floating" links (reroutes hooked to the output but going nowhere).
function reroutesOf(g, nodeId, out) {
    const rr = g?.reroutes;
    if (!(rr instanceof Map) || !rr.size) return [];
    const links = [];
    const n = g.getNodeById?.(nodeId);
    for (const lid of n?.outputs?.[out]?.links || []) { const l = linkOf(g, lid); if (l) links.push(l); }
    const fl = g.floatingLinks;
    if (fl && typeof fl.values === "function") for (const l of fl.values()) if (l && l.origin_id === nodeId && l.origin_slot === out) links.push(l);
    const found = new Map();                                     // id -> { id, depth, x }
    for (const l of links) {
        const chain = [];
        let id = l.parentId, guard = 0;
        while (id != null && rr.has(id) && guard++ < 256) { chain.push(id); id = rr.get(id).parentId; }
        chain.reverse();                                           // [0] = the closest to the source node
        chain.forEach((rid, k) => {
            const r = rr.get(rid), depth = k + 1, prev = found.get(rid);
            if (!prev || depth < prev.depth) found.set(rid, { id: rid, depth, x: Number(r?.pos?.[0]) || 0 });
        });
    }
    // order along the chain (1 = closest to the node), same level from left to right
    return [...found.values()].sort((a, b) => a.depth - b.depth || a.x - b.x || a.id - b.id);
}

// ---------- sources ----------
// [{ key, nodeId, title, out, outName, outType, multi, rerouteId, rank, count, current, dist }]
// rank/count: numbering of reroutes on the same output (count 0 = direct wire). Order: closest node first.
export function sources(node, slot, opts = {}) {
    const i = slotIndex(node, slot);
    const okType = typeFilter(opts.types);
    const g = node?.graph;
    if (i < 0 || !g) return [];
    const inType = node.inputs[i]?.type;
    const skip = downstream(node);
    const cur = current(node, i);
    const cx = (node.pos?.[0] ?? 0), cy = (node.pos?.[1] ?? 0);
    const list = [];
    const nodes = g._nodes || g.nodes || [];
    for (const n of nodes) {
        if (!n || skip.has(n.id) || !n.outputs?.length) continue;
        const outs = [];
        n.outputs.forEach((o, k) => { if (o && compatible(o.type, inType) && okType(o.type)) outs.push(k); });
        if (!outs.length) continue;
        const dist = Math.hypot((n.pos?.[0] ?? 0) - cx, (n.pos?.[1] ?? 0) - cy);
        const title = titleOf(n);
        for (const k of outs) {
            const o = n.outputs[k];
            const base = { nodeId: n.id, title, out: k, outName: String(o.label || o.localized_name || o.name || k), outType: o.type, multi: outs.length > 1, dist };
            const isCur = (rid) => !!cur && cur.nodeId === n.id && cur.out === k && (cur.rerouteId ?? null) === rid;
            list.push({ ...base, key: `${n.id}:${k}`, rerouteId: null, rank: 0, count: 0, current: isCur(null) });
            const rrs = reroutesOf(g, n.id, k);
            rrs.forEach((r, j) => list.push({ ...base, key: `${n.id}:${k}:r${r.id}`, rerouteId: r.id, rank: j + 1, count: rrs.length, current: isCur(r.id) }));
        }
    }
    // closest node first; same source: direct wire first, then reroutes in chain order
    list.sort((a, b) => a.dist - b.dist || a.nodeId - b.nodeId || a.out - b.out || a.rank - b.rank);
    return list;
}

// type filter (chip config, e.g. Preview: readable types only). null = all. "*" in the list = also accepts "anything goes" sockets
function typeFilter(types) {
    if (!Array.isArray(types) || !types.length) return () => true;
    const set = new Set(types.map((t) => String(t).toUpperCase()));
    return (t) => String(t ?? "*").split(",").some((x) => set.has(x.trim().toUpperCase() || "*"));
}
const isNormalInput = (inp) => !!inp && !inp.widget;            // "normal" inputs (sockets); never converted widgets

// Widget sockets are off-limits... unless the user hung a native reroute on them (D-69): then the widget
// is fair game for the chip lists, and the wire goes in THROUGH that reroute. Returns the reroute id or null.
// Two ways a reroute sits on a widget: a real link whose last hop is a reroute (parentId), or a "floating"
// link (reroute dragged out of the widget socket, no source yet) whose target is this node+slot.
export function widgetReroute(n, k) {
    const g = n?.graph, inp = n?.inputs?.[k];
    if (!g || !inp?.widget) return null;
    const l = linkOf(g, inp.link);
    if (l && l.parentId != null && g.reroutes?.has?.(l.parentId)) return l.parentId;
    const fl = g.floatingLinks;
    if (fl && typeof fl.values === "function") for (const f of fl.values()) {
        if (f && String(f.target_id) === String(n.id) && Number(f.target_slot) === k && f.parentId != null && g.reroutes?.has?.(f.parentId)) return f.parentId;
    }
    return null;
}
const isTargetInput = (n, k) => isNormalInput(n?.inputs?.[k]) || widgetReroute(n, k) != null;

// nodes upstream of `node` (plugging them into an output would make a cycle) + the node itself
function upstream(node) {
    const g = node.graph, seen = new Set([node.id]), stack = [node];
    while (stack.length) {
        const n = stack.pop();
        for (const inp of n.inputs || []) {
            const l = linkOf(g, inp?.link);
            if (!l || seen.has(l.origin_id)) continue;
            seen.add(l.origin_id);
            const o = g.getNodeById?.(l.origin_id);
            if (o) stack.push(o);
        }
    }
    return seen;
}

// ---------- outputs (chip_output) ----------
export function outIndex(node, slot) {
    const outs = node?.outputs || [];
    if (typeof slot === "number") return slot >= 0 && slot < outs.length ? slot : -1;
    return outs.findIndex((o) => o?.name === slot);
}
// today's wires out of the output: [{ linkId, nodeId, title, inp, inName, rerouteId }]
export function outLinks(node, slot) {
    const o = outIndex(node, slot), g = node?.graph;
    if (o < 0 || !g) return [];
    const res = [];
    for (const lid of node.outputs[o]?.links || []) {
        const l = linkOf(g, lid); if (!l) continue;
        const t = g.getNodeById?.(l.target_id); const ti = t?.inputs?.[l.target_slot];
        res.push({ linkId: l.id, nodeId: l.target_id, title: titleOf(t), inp: l.target_slot, inName: String(ti?.label || ti?.localized_name || ti?.name || l.target_slot), rerouteId: l.parentId ?? null, gone: !t });
    }
    return res;
}
// reroutes already carrying this output (for "Via: ↳¹ ↳²"): [{ id, rank, count }]
export function outReroutes(node, slot) {
    const o = outIndex(node, slot);
    if (o < 0 || !node?.graph) return [];
    const rr = reroutesOf(node.graph, node.id, o);
    return rr.map((r, j) => ({ id: r.id, rank: j + 1, count: rr.length }));
}
// compatible destinations: NORMAL inputs of nodes on the same level, not upstream. Only willing partners.
// Widgets join the party only with a reroute hung on them (D-69): `via` = that reroute id.
// [{ key, nodeId, title, inp, inName, inType, multi, current, occupied:{nodeId,title,out,outName}|null, dist, via }]
export function targets(node, slot, opts = {}) {
    const o = outIndex(node, slot), g = node?.graph;
    if (o < 0 || !g) return [];
    const outType = node.outputs[o]?.type;
    const okType = typeFilter(opts.types);
    const skip = upstream(node);
    const cx = node.pos?.[0] ?? 0, cy = node.pos?.[1] ?? 0;
    const list = [];
    for (const n of g._nodes || g.nodes || []) {
        if (!n || skip.has(n.id) || !n.inputs?.length) continue;
        const ins = [];
        n.inputs.forEach((inp, k) => { if (isTargetInput(n, k) && compatible(outType, inp.type) && okType(inp.type)) ins.push(k); });
        if (!ins.length) continue;
        const dist = Math.hypot((n.pos?.[0] ?? 0) - cx, (n.pos?.[1] ?? 0) - cy);
        const title = titleOf(n);
        for (const k of ins) {
            const inp = n.inputs[k], l = linkOf(g, inp.link);
            const mine = !!l && l.origin_id === node.id && l.origin_slot === o;
            let occupied = null;
            if (l && !mine) { const s = g.getNodeById?.(l.origin_id); const so = s?.outputs?.[l.origin_slot]; occupied = { nodeId: l.origin_id, title: titleOf(s), out: l.origin_slot, outName: String(so?.label || so?.name || "") }; }
            list.push({ key: `${n.id}:in${k}`, nodeId: n.id, title, inp: k, inName: String(inp.label || inp.localized_name || inp.name || k), inType: inp.type, multi: ins.length > 1, current: mine, occupied, dist, via: inp.widget ? widgetReroute(n, k) : null });
        }
    }
    list.sort((a, b) => a.dist - b.dist || a.nodeId - b.nodeId || a.inp - b.inp);
    return list;
}
// wire from the output into an input (replaces whatever wire was on that input), even via reroute
export function connectOut(node, slot, dst, rerouteId = null) {
    const o = outIndex(node, slot), g = node?.graph;
    if (o < 0 || !g) return { ok: false, why: "output not found" };
    const t = g.getNodeById?.(dst?.nodeId);
    if (!t) return { ok: false, why: "target node is gone" };
    if (!isTargetInput(t, dst.inp)) return { ok: false, why: "not a normal input (widgets need a reroute hung on them)" };
    // widget target: the wire MUST go through the reroute hanging on the widget, whatever "Via" said
    const wr = t.inputs[dst.inp]?.widget ? widgetReroute(t, dst.inp) : null;
    return connect(t, dst.inp, { nodeId: node.id, out: o, rerouteId: wr ?? rerouteId });
}
// unplugs the wire going into an input (undo included)
export function disconnect(node, slot) {
    const i = slotIndex(node, slot), g = node?.graph;
    if (i < 0 || !g || node.inputs[i]?.link == null) return { ok: false, why: "nothing to disconnect" };
    try { node.disconnectInput(i); } catch (e) { console.warn("[SurvivalKit] input-link disconnect:", e); return { ok: false, why: String(e?.message || e) }; }
    checkpoint(g);
    return { ok: true, why: "" };
}
// description of an output written in the Python (output_tooltips), or ""
export function outTooltip(node, slot) {
    const o = outIndex(node, slot);
    if (o < 0) return "";
    const out = node.outputs[o];
    if (out?.tooltip) return String(out.tooltip);
    const t = node.constructor?.nodeData?.output_tooltips?.[o];
    return typeof t === "string" ? t : "";
}

// ---------- connecting ----------
function checkpoint(g) {
    try { g?.setDirtyCanvas?.(true, true); } catch (_) {}
    try { globalThis.app?.canvas?.setDirty?.(true, true); } catch (_) {}
    try {
        const ct = getChangeTracker();
        if (typeof ct?.captureCanvasState === "function") ct.captureCanvasState();
        else if (typeof ct?.checkState === "function") ct.checkState();
    } catch (e) { console.warn("[SurvivalKit] input-link checkpoint:", e); }
}

// lays the wire: src = { nodeId, out, rerouteId? } (one row of sources()). -> { ok, why, linkId }
export function connect(node, slot, src) {
    const i = slotIndex(node, slot);
    const g = node?.graph;
    if (i < 0 || !g) return { ok: false, why: "input not found" };
    const from = g.getNodeById?.(src?.nodeId);
    if (!from) return { ok: false, why: "source node is gone" };
    if (downstream(node).has(from.id)) return { ok: false, why: "would create a loop" };
    const o = from.outputs?.[src.out];
    if (!o || !compatible(o.type, node.inputs[i].type)) return { ok: false, why: "type not compatible" };
    let rid = src.rerouteId ?? undefined;
    if (rid != null && !g.reroutes?.has?.(rid)) return { ok: false, why: "reroute is gone" };
    let link = null;
    try { link = from.connect(src.out, node, i, rid); }
    catch (e) { console.warn("[SurvivalKit] input-link connect:", e); return { ok: false, why: String(e?.message || e) }; }
    if (!link) return { ok: false, why: "LiteGraph refused the connection" };
    checkpoint(g);
    return { ok: true, why: "", linkId: link.id };
}

// ---------- native reroutes as the subject (D-85, "Connections" page of the reroute menu) ----------
// A native reroute is not a node: it carries the wires that slip through it (reroute.linkIds = real links,
// reroute.floatingLinkIds = floating ones, which show "-1" in the missing end: a STRING, mind you).
// Source = where those wires start, destinations = where they end. Everything below goes through the real
// LiteGraph calls (connect(..., afterRerouteId), disconnectInput(slot, keepReroutes), LLink.disconnect("input")),
// so undo works and the reroute itself is never thrown away: we only play with what hangs on it. Discretion guaranteed.
// Checked on frontend 1.53 (live): re-source = reconnect every wire with its own parentId; unplug the source =
// LLink.disconnect("input") (the wires turn floating, the destinations stay); unplug a destination = disconnectInput(slot, true).
const NOEND = (v) => v == null || String(v) === "-1";
const lost = (id) => (Number(id) === -10 ? "Subgraph input" : Number(id) === -20 ? "Subgraph output" : "missing node");
const slotName = (s, k) => String(s?.label || s?.localized_name || s?.name || k);

function rrWires(g, rid) {
    const r = g?.reroutes?.get?.(rid);
    if (!r) return null;
    const real = [], floating = [];
    for (const id of r.linkIds || []) { const l = linkOf(g, id); if (l) real.push(l); }
    for (const id of r.floatingLinkIds || []) { const l = g.floatingLinks?.get?.(id) ?? null; if (l) floating.push(l); }
    return { r, real, floating };
}
const withTarget = (w) => [...w.real, ...w.floating.filter((l) => !NOEND(l.target_id))];     // wires that still end somewhere
const outFloat = (w) => w.floating.filter((l) => NOEND(l.target_id) && !NOEND(l.origin_id));  // source, but no destination (yet)
const rrTypeOf = (w) => { for (const l of [...w.real, ...w.floating]) if (l?.type && l.type !== "*") return String(l.type); return "*"; };
function rrRoot(g, r) { let cur = r, guard = 0; while (cur?.parentId != null && guard++ < 64) { const p = g.reroutes.get(cur.parentId); if (!p) break; cur = p; } return cur; }

// where the wires through the reroute start: { nodeId, out, title, outName, outType, gone, floating } | null
export function rerouteSource(g, rid) {
    const w = rrWires(g, rid);
    if (!w) return null;
    const l = w.real[0] ?? outFloat(w)[0];
    if (!l || NOEND(l.origin_id)) return null;
    const n = g.getNodeById?.(l.origin_id), o = n?.outputs?.[l.origin_slot];
    return { nodeId: l.origin_id, out: l.origin_slot, title: n ? titleOf(n) : lost(l.origin_id), outName: slotName(o, l.origin_slot), outType: o?.type ?? l.type ?? "*", gone: !n, floating: !w.real.length };
}

// where they end: [{ key, linkId, floating, nodeId, title, inp, inName, via, gone }]   (via = a child reroute carrying that wire, else null)
export function rerouteDests(g, rid) {
    const w = rrWires(g, rid);
    if (!w) return [];
    const list = [];
    const add = (l, floating) => {
        if (NOEND(l.target_id)) return;
        const t = g.getNodeById?.(l.target_id), ti = t?.inputs?.[l.target_slot];
        list.push({ key: (floating ? "f" : "l") + l.id, linkId: l.id, floating, nodeId: l.target_id, title: t ? titleOf(t) : lost(l.target_id), inp: l.target_slot, inName: slotName(ti, l.target_slot), via: l.parentId != null && l.parentId !== rid ? l.parentId : null, gone: !t });
    };
    for (const l of w.real) add(l, false);
    for (const l of w.floating) add(l, true);
    return list;
}

// D-87 (the lock of D-86 is gone, the user didn't care for it): the origin of a reroute can be unplugged like anything else, ✕ everywhere.
// Natural core behavior, no tricks: with destinations hanging after her the wires turn floating and she stays; with nothing
// hanging after her the core prunes her on the spot (verified live) — and whoever shows her (the menu) closes by itself, see
// NodeStructure/core/extend.js. Succubus: when the last one leaves, the lights go out. No lingering, no ghosts.
// everything the page needs in one go. canChange / canDrop: only on the FIRST reroute of a chain — a child shares the source
// of the whole tree, so editing it from a branch would split the tree (no, thanks). canAdd: there has to be a source to copy.
export function rerouteWires(g, rid) {
    const w = rrWires(g, rid);
    if (!w) return null;
    const source = rerouteSource(g, rid), dests = rerouteDests(g, rid);
    const root = w.r.parentId == null, rootId = rrRoot(g, w.r)?.id;
    const live = !!source && !source.gone;
    const why = !root ? `The source belongs to the first reroute of the chain (#${rootId}).` : !source && !dests.length ? "Nothing hangs on this reroute yet." : source?.gone ? `The source is a ${String(source.title).toLowerCase()}: it can't be changed from here.` : "";
    return { id: rid, parentId: w.r.parentId ?? null, type: rrTypeOf(w), source, dests, why,
        canChange: root && (withTarget(w).length > 0 || outFloat(w).length > 0), canDrop: root && live, canAdd: live,
        lastOne: root && live && !dests.length };       // nothing hangs after her: unplugging the source makes her disappear
}

// candidate sources for the whole tree: compatible with EVERY destination, never downstream of one of them (no loops).
// [{ key, nodeId, title, out, outName, outType, multi, current, dist }]
export function rerouteSources(g, rid, opts = {}) {
    const w = rrWires(g, rid);
    if (!w) return [];
    const okType = typeFilter(opts.types);
    const dst = withTarget(w).map((l) => ({ node: g.getNodeById?.(l.target_id), slot: l.target_slot })).filter((d) => d.node);
    const ltype = rrTypeOf(w);
    const skip = new Set();
    for (const d of dst) for (const id of downstream(d.node)) skip.add(id);
    const cur = rerouteSource(g, rid);
    const cx = Number(w.r.pos?.[0]) || 0, cy = Number(w.r.pos?.[1]) || 0;
    const list = [];
    for (const n of g._nodes || g.nodes || []) {
        if (!n || skip.has(n.id) || !n.outputs?.length) continue;
        const outs = [];
        n.outputs.forEach((o, k) => {
            if (!o || !okType(o.type)) return;
            if (dst.length ? dst.every((d) => compatible(o.type, d.node.inputs?.[d.slot]?.type)) : compatible(o.type, ltype)) outs.push(k);
        });
        if (!outs.length) continue;
        const title = titleOf(n), dist = Math.hypot((n.pos?.[0] ?? 0) - cx, (n.pos?.[1] ?? 0) - cy);
        for (const k of outs) {
            const o = n.outputs[k];
            list.push({ key: `${n.id}:${k}`, nodeId: n.id, title, out: k, outName: slotName(o, k), outType: o.type, multi: outs.length > 1, dist, current: !!cur && String(cur.nodeId) === String(n.id) && cur.out === k });
        }
    }
    list.sort((a, b) => a.dist - b.dist || String(a.nodeId).localeCompare(String(b.nodeId), undefined, { numeric: true }) || a.out - b.out);
    return list;
}

// new source for every wire through the reroute (all or nothing: checked BEFORE touching anything). One undo step.
export function rerouteSetSource(g, rid, src) {
    const w = rrWires(g, rid);
    if (!w) return { ok: false, why: "reroute is gone" };
    if (w.r.parentId != null) return { ok: false, why: "change the source on the first reroute of the chain" };
    const from = g.getNodeById?.(src?.nodeId), o = from?.outputs?.[src?.out];
    if (!from || !o) return { ok: false, why: "source node is gone" };
    const todo = withTarget(w);
    if (!todo.length) {
        // no destination: the only wire is the floating one hanging from the old source -> it just changes its origin
        if (!outFloat(w).length) return { ok: false, why: "nothing hangs on this reroute yet" };
        if (typeof w.r.setFloatingLinkOrigin !== "function") return { ok: false, why: "this ComfyUI can't move a floating wire" };
        try { w.r.setFloatingLinkOrigin(from, src.out); } catch (e) { console.warn("[SurvivalKit] input-link rerouteSetSource (floating):", e); return { ok: false, why: String(e?.message || e) }; }
        checkpoint(g);
        return { ok: true, why: "", n: 0 };
    }
    const plan = [];
    for (const l of todo) {
        const t = g.getNodeById?.(l.target_id), ti = t?.inputs?.[l.target_slot];
        if (!t || !ti) return { ok: false, why: "a destination node is gone" };
        if (!compatible(o.type, ti.type)) return { ok: false, why: `${titleOf(t)} #${t.id} doesn't take ${o.type}` };
        if (downstream(t).has(from.id)) return { ok: false, why: "would create a loop" };
        plan.push({ t, slot: l.target_slot, after: l.parentId ?? undefined });
    }
    let n = 0;
    for (const p of plan) {
        let link = null;
        try { link = from.connect(src.out, p.t, p.slot, p.after); }
        catch (e) { console.warn("[SurvivalKit] input-link rerouteSetSource:", e); checkpoint(g); return { ok: false, why: String(e?.message || e), n }; }
        if (!link) { checkpoint(g); return { ok: false, why: "LiteGraph refused a connection", n }; }
        n++;
    }
    checkpoint(g);
    return { ok: true, why: "", n };
}

// unplug the source (first reroute of the chain only). Destinations hanging after her: their wires turn floating and she stays
// (LLink.disconnect "input" keeps the reroutes); nothing after her: only the floating wire from the origin is left, we remove it
// and the core prunes her. One undo step. Result: { ok, why, gone } — gone = she's not there any more (the menu closes itself).
export function rerouteDropSource(g, rid) {
    const w = rrWires(g, rid);
    if (!w) return { ok: false, why: "reroute is gone", gone: true };
    if (w.r.parentId != null) return { ok: false, why: "unplug the source on the first reroute of the chain" };
    if (!rerouteSource(g, rid)) return { ok: false, why: "nothing to unplug" };
    try {
        for (const l of w.real.slice()) l.disconnect(g, "input");
        for (const l of outFloat(w).slice()) g.removeFloatingLink?.(l);
    } catch (e) { console.warn("[SurvivalKit] input-link rerouteDropSource:", e); checkpoint(g); return { ok: false, why: String(e?.message || e) }; }
    checkpoint(g);
    return { ok: true, why: "", gone: !g.reroutes?.has?.(rid) };
}
// inputs the reroute could feed too: NORMAL inputs (widgets would need their own reroute: not here), compatible with the source,
// never upstream of it. [{ key, nodeId, title, inp, inName, inType, multi, current, occupied, dist }]
export function rerouteTargets(g, rid, opts = {}) {
    const w = rrWires(g, rid), src = rerouteSource(g, rid);
    if (!w || !src || src.gone) return [];
    const from = g.getNodeById?.(src.nodeId), o = from?.outputs?.[src.out];
    if (!from || !o) return [];
    const okType = typeFilter(opts.types), skip = upstream(from);
    const mine = new Set(rerouteDests(g, rid).map((d) => `${d.nodeId}:${d.inp}`));
    const cx = Number(w.r.pos?.[0]) || 0, cy = Number(w.r.pos?.[1]) || 0;
    const list = [];
    for (const n of g._nodes || g.nodes || []) {
        if (!n || skip.has(n.id) || !n.inputs?.length) continue;
        const ins = [];
        n.inputs.forEach((inp, k) => { if (isNormalInput(inp) && compatible(o.type, inp.type) && okType(inp.type)) ins.push(k); });
        if (!ins.length) continue;
        const title = titleOf(n), dist = Math.hypot((n.pos?.[0] ?? 0) - cx, (n.pos?.[1] ?? 0) - cy);
        for (const k of ins) {
            const inp = n.inputs[k], l = linkOf(g, inp.link), cur = mine.has(`${n.id}:${k}`);
            let occupied = null;
            if (l && !cur) { const s = g.getNodeById?.(l.origin_id), so = s?.outputs?.[l.origin_slot]; occupied = { nodeId: l.origin_id, title: titleOf(s), out: l.origin_slot, outName: slotName(so, "") }; }
            list.push({ key: `${n.id}:in${k}`, nodeId: n.id, title, inp: k, inName: slotName(inp, k), inType: inp.type, multi: ins.length > 1, current: cur, occupied, dist });
        }
    }
    list.sort((a, b) => a.dist - b.dist || String(a.nodeId).localeCompare(String(b.nodeId), undefined, { numeric: true }) || a.inp - b.inp);
    return list;
}

// a new destination hung on THIS reroute (replaces whatever wire that input had)
export function rerouteAddDest(g, rid, dst) {
    const src = rerouteSource(g, rid);
    if (!src || src.gone) return { ok: false, why: "this reroute has no source to copy" };
    const from = g.getNodeById?.(src.nodeId), t = g.getNodeById?.(dst?.nodeId);
    if (!from || !t) return { ok: false, why: "node is gone" };
    if (!isNormalInput(t.inputs?.[dst.inp])) return { ok: false, why: "not a normal input" };
    return connect(t, dst.inp, { nodeId: from.id, out: src.out, rerouteId: rid });
}

// unplugs one destination; the reroute stays (if it was the last one, the wire turns floating from the source)
export function rerouteDropDest(g, rid, dst) {
    const t = g?.getNodeById?.(dst?.nodeId);
    if (!t) return { ok: false, why: "node is gone" };
    if (!t.inputs?.[dst.inp]) return { ok: false, why: "input not found" };
    try { t.disconnectInput(dst.inp, true); }
    catch (e) { console.warn("[SurvivalKit] input-link rerouteDropDest:", e); return { ok: false, why: String(e?.message || e) }; }
    checkpoint(g);
    return { ok: true, why: "" };
}

// ---------- Vue Nodes adapter ----------
// Structure (frontend 1.53): [data-node-id=N] ... .lg-slot.lg-slot--input > (svg dot[data-slot-key="N-in-i"]) + (div > span label)
// If the frontend changes, fix it ONLY here (the "Input chips" HEALTH light says "slot not found").
export const VUE = { node: (id) => `[data-node-id="${id}"]`, dot: (id, i) => `[data-slot-key="${id}-in-${i}"]`, dotOut: (id, i) => `[data-slot-key="${id}-out-${i}"]`, row: ".lg-slot", label: "span", nativeTip: ".p-tooltip" };

// description of the input written in the Python (INPUT_TYPES ... {"tooltip": "..."}), or ""
export function slotTooltip(node, slot) {
    const i = slotIndex(node, slot);
    if (i < 0) return "";
    const inp = node.inputs[i];
    if (inp?.tooltip) return String(inp.tooltip);
    const d = node.constructor?.nodeData?.input;
    const spec = d?.required?.[inp?.name] ?? d?.optional?.[inp?.name];
    return typeof spec?.[1]?.tooltip === "string" ? spec[1].tooltip : "";
}
export function vueNodesOn() { return !!LG()?.vueNodesMode; }
export function slotDom(node, slot, side = "in") {
    const i = side === "out" ? outIndex(node, slot) : slotIndex(node, slot);
    if (i < 0 || !node) return null;
    const root = document.querySelector(VUE.node(node.id));
    if (!root) return null;
    const dot = root.querySelector(side === "out" ? VUE.dotOut(node.id, i) : VUE.dot(node.id, i));
    const row = dot?.closest?.(VUE.row);
    if (!row) return null;
    // label = the row's text span that is NOT inside the dot
    const label = [...row.querySelectorAll(VUE.label)].find((s) => !s.closest("svg") && !s.contains(dot) && !dot.contains(s)) || null;
    return { root, row, dot, label, box: label?.parentElement || row };
}

// ---------- slot watcher (D-88) ----------
// Vue Nodes throws the slot rows away and builds them again whenever it feels like it (undo/redo, a socket added or
// removed, LOD, a node mounting). Whoever decorates a row (the chip) has to be BACK before the browser paints, otherwise
// the naked native label flashes for a frame or three — measured live on the user's PC: 12-47 ms per wave, two waves on
// Ctrl+Z (Vue's own rebuild, then shape_output's). Timers can't win that race; a MutationObserver callback is a microtask,
// so it runs right after Vue's patch and before the paint. One observer for the whole page, started with the first
// subscriber and stopped with the last. Our own decorations (.ns-chip going in and out) are not news, so no feedback loop.
// Succubus: she doesn't wait for the next heartbeat to put her clothes back on. She's dressed before anyone blinks.
const SLOT_SUBS = new Map();          // node id (string) -> Set<fn>
let slotMO = null;
const slotRows = (n) => n.nodeType === 1 && (n.matches?.(".lg-slot") || !!n.querySelector?.(".lg-slot"));
const isChip = (n) => n.nodeType === 1 && n.classList?.contains("ns-chip");
function slotFlush(records) {
    const ids = new Set();
    for (const m of records) {
        if (m.type !== "childList") continue;
        const own = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (!own || own.closest?.(".ns-chip")) continue;                           // inside a chip: ours
        const root = own.closest?.("[data-node-id]");
        const add = [...m.addedNodes], del = [...m.removedNodes];
        if (add.every(isChip) && del.every(isChip)) continue;                      // only chips moved: ours
        if (root) {
            // slot rows rebuilt, or something went on/off inside one (a label re-rendered)
            if (own.closest(".lg-slot") || add.some(slotRows) || del.some(slotRows)) ids.add(root.dataset.nodeId);
            continue;
        }
        for (const n of add) {                                                     // a whole node mounted
            if (n.nodeType !== 1) continue;
            if (n.dataset?.nodeId) ids.add(n.dataset.nodeId);
            else n.querySelectorAll?.("[data-node-id]").forEach((e) => ids.add(e.dataset.nodeId));
        }
    }
    for (const id of ids) {
        const subs = SLOT_SUBS.get(id);
        if (subs) for (const fn of [...subs]) { try { fn(); } catch (e) { console.warn("[SurvivalKit] input-link watchSlots:", e); } }
    }
}
// fn() runs (synchronously, before paint) every time Vue touches this node's slot rows. Returns the unsubscribe function.
export function watchSlots(node, fn) {
    if (!node || typeof fn !== "function" || typeof MutationObserver === "undefined" || !document.body) return () => {};
    const id = String(node.id);
    let set = SLOT_SUBS.get(id);
    if (!set) SLOT_SUBS.set(id, (set = new Set()));
    set.add(fn);
    if (!slotMO) { slotMO = new MutationObserver(slotFlush); slotMO.observe(document.body, { childList: true, subtree: true }); }
    return () => {
        const s = SLOT_SUBS.get(id);
        if (s) { s.delete(fn); if (!s.size) SLOT_SUBS.delete(id); }
        if (!SLOT_SUBS.size && slotMO) { slotMO.disconnect(); slotMO = null; }
    };
}
export const slotWatchStats = () => ({ nodes: SLOT_SUBS.size, subs: [...SLOT_SUBS.values()].reduce((a, s) => a + s.size, 0), observing: !!slotMO });

// ---------- coordinates (pulsing preview) ----------
export function screenRect(g, src) {
    try {
        const cv = globalThis.app?.canvas;
        if (!cv?.ds || !cv.canvas || !g || cv.graph !== g) return null;
        const b = cv.canvas.getBoundingClientRect();
        const toScr = (x, y) => { const p = cv.ds.convertOffsetToCanvas([x, y]); return [b.left + p[0], b.top + p[1]]; };
        if (src?.rerouteId != null) {
            const r = g.reroutes?.get?.(src.rerouteId);
            if (!r) return null;
            const R = (Number(r.constructor?.radius) || 10) + 6;
            const [x0, y0] = toScr(r.pos[0] - R, r.pos[1] - R), [x1, y1] = toScr(r.pos[0] + R, r.pos[1] + R);
            return { left: x0, top: y0, width: x1 - x0, height: y1 - y0, round: true };
        }
        const n = g.getNodeById?.(src?.nodeId);
        if (!n?.pos || !n.size) return null;
        const th = LG()?.NODE_TITLE_HEIGHT ?? 30;
        const [x0, y0] = toScr(n.pos[0], n.pos[1] - th), [x1, y1] = toScr(n.pos[0] + n.size[0], n.pos[1] + n.size[1]);
        return { left: x0, top: y0, width: x1 - x0, height: y1 - y0, round: false };
    } catch (e) { console.warn("[SurvivalKit] input-link screenRect:", e); return null; }
}

// ---------- wifi (D-61): PREPARED, OFF ----------
// When it turns on: no wire; the link only slips into the prompt at Queue time (inject), referenced via
// properties.succy_uid (ComfyUI has no node UUIDs). Today enabled=false: uid() writes nothing.
export const wireless = {
    enabled: false,
    uid(node) {
        if (!this.enabled || !node) return null;
        node.properties = node.properties || {};
        if (!node.properties.succy_uid) node.properties.succy_uid = (globalThis.crypto?.randomUUID?.() || `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
        return node.properties.succy_uid;
    },
    inject(prompt) { return prompt; },          // to be written the day it gets switched on (see D-61). Patience, it'll be worth it.
};

// ---------- health (read by the Governor) ----------
export function probe() {
    const lg = LG(), proto = lg?.LGraphNode?.prototype;
    const g = globalThis.app?.canvas?.graph;
    const miss = [];
    if (typeof lg?.isValidConnection !== "function") miss.push("LiteGraph.isValidConnection");
    if (typeof proto?.connect !== "function") miss.push("LGraphNode.connect");
    else if (proto.connect.length < 4 && typeof proto.connectSlots !== "function") miss.push("connect(…, afterRerouteId)");
    if (g && !(g.reroutes instanceof Map)) miss.push("graph.reroutes Map");
    return { ok: miss.length === 0, missing: miss, vue: vueNodesOn(), wireless: wireless.enabled };
}

export const InputLink = { version: VERSION, titleOf, slotIndex, current, sources, connect, disconnect, slotDom, watchSlots, slotWatchStats, slotTooltip,
    outIndex, outLinks, outReroutes, targets, connectOut, outTooltip, vueNodesOn, screenRect, wireless, probe, VUE, widgetReroute,
    rerouteWires, rerouteSource, rerouteDests, rerouteSources, rerouteSetSource, rerouteDropSource, rerouteTargets, rerouteAddDest, rerouteDropDest };
