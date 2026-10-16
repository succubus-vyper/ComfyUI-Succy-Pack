// ============================================================
// SurvivalKit/shields/node-ports.js
// ------------------------------------------------------------
// Shape-shifting sockets (D-66): a node that has 1 or N outputs depending on what you put into it
// (e.g. Preview: text = 1 output, image = output/width/height/megapixels).
// Everything that touches LiteGraph's APIs to add/remove/retype outputs lives HERE:
//   inputType(node, i)          the type actually coming in (link or source output), null if "anything"/unknown
//   setOutputs(node, want)      brings the outputs to the list [[name, type], ...]: keeps matching ones,
//                               retypes, adds, removes from the end. A removed output UNPLUGS its wires
//                               (agreed with the user): no warnings, just a log for the Governor.
//   showInputs(node, specs, on) shows / hides ready-made sockets [{name,type}] as a group (EXT chip mode, D-86)
//   setComboValues(w, values)   entries of a native dropdown
//   events / stats()            log of the latest changes ("Dynamic outputs" HEALTH light)
// The "when" and the "which shape" live in the builder: NodeStructure/pieces/ports.js (behavior shape_output).
// v0.1.0 — 2026-10-13 · v0.2.0: setOutputs(..., {byName}) wires follow the output's name (D-67)
// v0.4.0 (D-86): showInputs() = a socket group that shows or hides as one (EXT chip mode).
// v0.3.0 (D-70/71): growInputs() = multi-input sockets that open the next one when you plug the last one;
//   inputSource() = who feeds an input (for names); setOutputs accepts [name, type, label] (shown name != wire name).
// ============================================================

const MAX_EVENTS = 20;
const events = [];              // { t, who, added, removed, retyped, detached:[name] }
let totals = { calls: 0, changes: 0, detached: 0 };

const linkOf = (g, id) => (id == null ? null : (g?.links?.get?.(id) ?? g?.links?.[id] ?? null));
const norm = (t) => (t == null || t === "" || t === "*" ? null : String(t));

export function inputType(node, i = 0) {
    const inp = node?.inputs?.[i];
    if (!inp || inp.link == null) return null;
    const g = node.graph, l = linkOf(g, inp.link);
    if (!l) return null;
    let t = norm(l.type);
    if (!t) t = norm(g?.getNodeById?.(l.origin_id)?.outputs?.[l.origin_slot]?.type);
    return t;
}

// Who feeds input `i`: { node, output, name } or null. `name` is what a human would call it: the output's own name when it
// says something ("seed"), otherwise the source node's title (outputs called "INT" or "output" tell you nothing, darling).
const GENERIC = new Set(["", "*", "output", "out", "value", "result"]);
export function inputSource(node, i = 0) {
    const inp = node?.inputs?.[i];
    if (!inp || inp.link == null) return null;
    const g = node.graph, l = linkOf(g, inp.link);
    const src = l ? g?.getNodeById?.(l.origin_id) : null;
    if (!src) return null;
    const out = src.outputs?.[l.origin_slot];
    const own = String(out?.label || out?.localized_name || out?.name || "").trim();
    const generic = GENERIC.has(own.toLowerCase()) || own === String(out?.type || "");
    const title = String(src.title || src.type || "").trim();
    return { node: title, output: own, name: generic ? title : own };
}

// R2 (D-124): the NODE that feeds an input (by index or name) -> { node, slot } or null. Native reroutes are not nodes: the
// link already names the real origin. A subgraph input pin is not followed (null): the caller says "wire it here".
export function inputNode(node, which = 0) {
    const i = typeof which === "number" ? which : (node?.inputs || []).findIndex((x) => x?.name === which);
    const inp = node?.inputs?.[i];
    if (!inp || inp.link == null) return null;
    const g = node.graph, l = linkOf(g, inp.link);
    const src = l ? g?.getNodeById?.(l.origin_id) : null;
    return src ? { node: src, slot: l.origin_slot } : null;
}

// R2 (D-124): a node "as it is now", the shape the Python routes eat (D-117): { id, type, widgets: {name: value}, linked: [input names] }.
// The kit's own widgets (ns_*) stay out.
export function snapshot(node) {
    if (!node) return null;
    const widgets = Object.fromEntries((node.widgets || []).filter((w) => w?.name && !String(w.name).startsWith("ns_")).map((w) => [w.name, w.value]));
    const linked = (node.inputs || []).filter((i) => i?.link != null).map((i) => i.name);
    return { id: node.id, type: node.type, widgets, linked };
}

// Multi-input sockets (D-70). `names` = ordered socket names. Visible = (highest PLUGGED index + 2), at least `min`,
// at most names.length. Unplugging NEVER shifts anything: a plugged C stays C even if A and B go away, and the empty
// A and B stay put (just like the user asked: no swapping upwards). Only trailing UNPLUGGED sockets are dropped.
export function growInputs(node, names, { min = 2, type = "*" } = {}) {
    const res = { changed: false, want: 0, hi: -1 };
    if (!node || !Array.isArray(names) || !names.length) return res;
    if (typeof node.addInput !== "function" || typeof node.removeInput !== "function") return res;   // not a real LiteGraph node (test stub): nothing to grow
    node.inputs = node.inputs || [];
    let hi = -1;
    names.forEach((n, i) => { const inp = node.inputs.find((x) => x.name === n); if (inp && inp.link != null) hi = i; });
    const want = Math.min(names.length, Math.max(Math.max(0, min), hi + 2));
    res.want = want; res.hi = hi;
    try {
        for (let i = 0; i < want; i++) if (!node.inputs.some((x) => x.name === names[i])) { node.addInput(names[i], type); res.changed = true; }
        for (let k = node.inputs.length - 1; k >= 0; k--) {
            const inp = node.inputs[k], idx = names.indexOf(inp?.name);
            if (idx >= want && inp.link == null) { node.removeInput(k); res.changed = true; }
        }
    } catch (e) { console.warn("[SurvivalKit] node-ports growInputs:", e); }
    if (res.changed) {
        totals.changes++;
        log({ who: `${node.type} #${node.id}`, added: [], removed: [], retyped: [], detached: [], moved: [], grow: want });
        try { node.setDirtyCanvas?.(true, true); node.graph?.setDirtyCanvas?.(true, true); } catch (e) { console.warn("[SurvivalKit] node-ports redraw:", e); }
    }
    return res;
}

// EXT chip mode (D-86): a group of sockets that is either THERE or NOT, no half measures. on=true adds the missing ones,
// on=false takes them away (a plugged one loses its wire with it: switching back to the widget is a clean break-up, no
// lingering exes). Same trick as growInputs: the Python declares them optional, the frontend decides when they show.
// Succubus rule: a socket that isn't being used has no business hanging out in public. Dressed, or not at all.
export function showInputs(node, specs, on) {
    const res = { changed: false, added: [], removed: [] };
    if (!node || !Array.isArray(specs) || !specs.length) return res;
    if (typeof node.addInput !== "function" || typeof node.removeInput !== "function") return res;   // test stub, nothing to dress
    node.inputs = node.inputs || [];
    try {
        for (const sp of specs) {
            const k = node.inputs.findIndex((x) => x.name === sp.name);
            if (on && k < 0) { node.addInput(sp.name, sp.type || "*"); res.added.push(sp.name); res.changed = true; }
            else if (!on && k >= 0) { node.removeInput(k); res.removed.push(sp.name); res.changed = true; }
        }
    } catch (e) { console.warn("[SurvivalKit] node-ports showInputs:", e); }
    if (res.changed) {
        totals.changes++;
        log({ who: `${node.type} #${node.id}`, added: res.added, removed: res.removed, retyped: [], detached: [], moved: [], grow: -1 });
        try { node.setDirtyCanvas?.(true, true); node.graph?.setDirtyCanvas?.(true, true); } catch (e) { console.warn("[SurvivalKit] node-ports redraw:", e); }
    }
    return res;
}

// Shown name of an output (Vue shows label/localized_name) without touching the wire name. Only when a label is given.
function applyLabel(o, label, res) {
    if (label == null || !o) return;
    const s = String(label);
    if (o.label !== s || (o.localized_name != null && o.localized_name !== s)) {
        o.label = s; if (o.localized_name != null) o.localized_name = s;
        res.changed = true; (res.labeled = res.labeled || []).push(o.name);
    }
}

function log(e) {
    events.push({ t: Date.now(), ...e });
    if (events.length > MAX_EVENTS) events.shift();
}

// byName (D-67): outputs are recognised by NAME, not position. An output that stays but changes place
// (e.g. Pick Combo: cmb1,cmb2,index -> cmb1,cmb2,cmb3,index) takes its wires along; unwanted outputs get
// removed (wires unplugged), new ones are added, then the order is fixed and origin_slots are corrected.
// WARNING (frontend 1.53, tested live): `output.links` is deprecated and DERIVED from the link store by POSITION
// (link.origin_slot). Moving the output object doesn't move the wires: you move the links' origin_slots.
function linksFrom(node) {
    const g = node.graph, out = [];
    const all = g?.links instanceof Map ? g.links.values() : Object.values(g?.links || {});
    for (const l of all) if (l && String(l.origin_id) === String(node.id)) out.push(l);
    return out;
}
function setOutputsByName(node, want, res) {
    const names = new Set(want.map((w) => w[0]));
    for (let k = node.outputs.length - 1; k >= 0; k--) {
        const o = node.outputs[k];
        if (names.has(o?.name)) continue;
        const n = linksFrom(node).filter((l) => l.origin_slot === k).length;
        if (n) { res.detached.push(o?.name); totals.detached += n; }
        node.removeOutput(k);                     // unplugs its wires and shifts the origin_slots of the outputs after it
        res.removed.push(o?.name); res.changed = true;
    }
    for (const [name, type] of want) if (!node.outputs.some((o) => o.name === name)) { node.addOutput(name, type); res.added.push(name); res.changed = true; }
    const order = want.map(([name]) => node.outputs.find((o) => o.name === name));
    if (order.some((o, i) => node.outputs[i] !== o)) {
        const oldIdx = new Map(node.outputs.map((o, i) => [o, i]));
        const links = linksFrom(node).map((l) => [l, l.origin_slot]);        // snapshot BEFORE the move — say cheese
        node.outputs.splice(0, node.outputs.length, ...order);              // same array: whoever's watching it stays hooked
        const newOf = new Map(order.map((o, i) => [oldIdx.get(o), i]));
        res.moved = [];
        for (const [l, from] of links) {
            const to = newOf.get(from);
            if (to === undefined || to === from) continue;
            l.origin_slot = to;
            const nm = order[to]?.name; if (nm && !res.moved.includes(nm)) res.moved.push(nm);
        }
        res.changed = true;
    }
    let mine = null;                                                        // our wires, scanned once and only if a type really changed
    want.forEach(([name, type, label], i) => {
        const o = node.outputs[i];
        if (o && o.type !== type) {
            o.type = type; res.changed = true; res.retyped.push(name);
            mine = mine || linksFrom(node);
            for (const l of mine) if (l.origin_slot === i) l.type = type;
        }
        applyLabel(o, label, res);
    });
}

// want = [[name, type], ...]  -> { changed, detached:[name] }   ·   opts.byName: see above
export function setOutputs(node, want, who = "", opts = {}) {
    totals.calls++;
    const res = { changed: false, detached: [], added: [], removed: [], retyped: [] };
    if (!node || !Array.isArray(want)) return res;
    node.outputs = node.outputs || [];
    const g = node.graph;
    if (opts.byName) {
        if (new Set(want.map((w) => w[0])).size !== want.length) { console.warn("[SurvivalKit] node-ports setOutputs byName: duplicate output names", want.map((w) => w[0])); return res; }
        try { setOutputsByName(node, want, res); } catch (e) { console.warn("[SurvivalKit] node-ports setOutputs byName:", e); }
        return done(node, res, who);
    }
    try {
        // 1) the ones that stay: name and type (wires already attached take the new type too)
        for (let i = 0; i < want.length && i < node.outputs.length; i++) {
            const o = node.outputs[i], [name, type, label] = want[i];
            // the name SHOWN (Vue) is localized_name/label: rename them together, otherwise the old name sticks around (D-67)
            if (o.name !== name || (o.localized_name != null && o.localized_name !== name)) {
                if (o.label != null && (o.label === o.name || o.label === o.localized_name)) o.label = name;   // user's label: it stays. Her rules.
                o.name = name; if (o.localized_name != null) o.localized_name = name; res.changed = true;
            }
            if (o.type !== type) {
                o.type = type; res.changed = true; res.retyped.push(name);
                for (const l of linksFrom(node)) if (l.origin_slot === i) l.type = type;     // `o.links` is deprecated (D-79): ask the link store
            }
            applyLabel(o, label, res);
        }
        // 2) to remove (from the end): wires get unplugged
        while (node.outputs.length > want.length) {
            const k = node.outputs.length - 1, o = node.outputs[k];
            { const n = linksFrom(node).filter((l) => l.origin_slot === k).length; if (n) { res.detached.push(o.name); totals.detached += n; } }
            node.removeOutput(k);
            res.removed.push(o?.name); res.changed = true;
        }
        // 3) to add
        for (let i = node.outputs.length; i < want.length; i++) {
            node.addOutput(want[i][0], want[i][1]);
            res.added.push(want[i][0]); res.changed = true;
        }
    } catch (e) { console.warn("[SurvivalKit] node-ports setOutputs:", e); }
    return done(node, res, who);
}

function done(node, res, who) {
    if (res.changed) {
        totals.changes++;
        if (res.moved?.length) totals.moved = (totals.moved || 0) + res.moved.length;
        log({ who: who || `${node.type} #${node.id}`, added: res.added, removed: res.removed, retyped: res.retyped, detached: res.detached, moved: res.moved || [] });
        try { node.setDirtyCanvas?.(true, true); node.graph?.setDirtyCanvas?.(true, true); } catch (e) { console.warn("[SurvivalKit] node-ports redraw:", e); }
    }
    return res;
}

export function setComboValues(w, values) {
    if (!w || !Array.isArray(values)) return false;
    w.options = w.options || {};
    const cur = w.options.values;
    if (Array.isArray(cur) && cur.length === values.length && cur.every((v, i) => v === values[i])) return false;
    w.options.values = values.slice();
    return true;
}

export function stats() {
    return { ...totals, last: events[events.length - 1] || null, events: events.slice() };
}

// health (Governor): are the APIs we use still there?
export function probe() {
    const proto = globalThis.LiteGraph?.LGraphNode?.prototype;
    const miss = ["addOutput", "removeOutput", "addInput", "removeInput"].filter((k) => typeof proto?.[k] !== "function");
    return { ok: !miss.length, missing: miss };
}

export const NodePorts = { version: "0.5.0", inputType, inputSource, inputNode, snapshot, growInputs, showInputs, setOutputs, setComboValues, stats, probe };
