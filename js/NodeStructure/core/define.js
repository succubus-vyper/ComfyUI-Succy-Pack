// ============================================================
// NodeStructure/core/define.js
// ------------------------------------------------------------
// NodeStructure.define(type, def): the node declares a SPEC (JSON)
// plus the injected JS recipes; the builder translates them into the config
// for SurvivalKit.register (the only kit surface used). The node confesses, the builder obliges.
//
// def = {
//   spec,                     // pure JSON (validated)
//   actions: { name(api, ev, el, item) },
//   live:    { name(api, item) -> value },
//   state:   { key:{policy,...} },      // SurvivalKit schema (static per type)
//   natives: ["text","count"],          // persistNatives (REAL widgets)
//   packed:  { widget, defaults:{name:default} },   // virtual natives packed as JSON into ONE real hidden widget (D-79, see packed.js)
//   hooks:   { onSetup, onExecute, onConnect, onRestore, onResize, onNative(api,name,value),
//              onChannel, onCleanup, onNodeCreated, onDblClick },
//   config:  { <piece>: {...} },        // JSON configuration of the kit pieces used by the node (api.cfg)
//   order:   ["ns_top","combo_test",...],   // widget order (optional)
//   minWidth, defaultSize, channels, nativeOrder, keepVisible,
//   node:    { virtual, fixedSize:[w,h], noCollapse, blankSlots, noTitle, title, bare }   (bare = node with no frame colors — naked and proud)
// }
// ============================================================

import { normalizeSpec, checkRefs } from "./parser.js";
import { mount, INSTANCES } from "./runtime.js";
import { nodeInfo, resolve } from "../catalog/registry.js";
import { findNonJson } from "../util/json.js";
import { installPacked } from "./packed.js";

export const DEFS = new Map(); // type -> { def, errors, warnings, template }

const BUILTIN_STATE = {
    __ns_born: { policy: "ui", default: 0 },
    __ns_over: { policy: "immediate", default: "" },
};

// literal text: a leading "$" or "{{" would be read as references
const lit = (s) => String(s).replace(/\{\{|\}\}/g, "").replace(/^\$/, "\\$");

function errorSpec(type, errors) {
    return {
        v: 1,
        regions: [{
            id: "err", height: 70,
            tree: { t: "box", variant: "inset", children: [
                { t: "label", text: `NodeStructure: invalid spec (${type})`, style: { color: "#e07070" } },
                { t: "pre", text: lit(errors.slice(0, 4).join("\n")) },
            ] },
        }],
    };
}


// node config: pure JSON; the keys are catalog pieces; the "*Key" fields are declared state keys
export function checkConfig(d) {
    const errs = [];
    if (d.config === undefined) return errs;
    if (!d.config || typeof d.config !== "object" || Array.isArray(d.config)) return ["config deve essere un oggetto {pezzo: {...}}"];
    for (const v of findNonJson(d.config, "config")) errs.push(`${v.path}: valore non-JSON (${v.why})`);
    for (const [piece, c] of Object.entries(d.config)) {
        if (!resolve(piece)) { errs.push(`config.${piece}: non e' un pezzo del catalogo`); continue; }
        if (c && typeof c === "object") for (const [k, v] of Object.entries(c)) if (/Key$/.test(k) && typeof v === "string" && !(v in d.state)) errs.push(`config.${piece}.${k}: chiave di stato '${v}' non dichiarata in def.state`);
    }
    return errs;
}

// source of the file that called define() (for the "no handmade CSS/DOM in nodes" check)
function callerSrc() {
    try {
        const lines = String(new Error().stack || "").split("\n");
        for (const l of lines) {
            const m = /(https?:\/\/[^\s)]+?\.js)(?::\d+)?(?::\d+)?\)?$/.exec(l.trim());
            if (m && !/\/NodeStructure\//.test(m[1])) return m[1];
        }
    } catch (_) {}
    return "";
}

// a node's piece usage + debt + glue (computed, they end up in the catalog)
export function registerNodeInfo(type, d, res) {
    const info = nodeInfo(type);
    info.pieces.clear(); info.debt = []; info.aliasUsed = [...(res.aliasUsed || [])];
    info.src = callerSrc();
    for (const n of res.used || []) info.pieces.set(n, 1);
    for (const k of res.refs?.actions || []) { const c = resolve(k, "action"); if (c) info.pieces.set(c, (info.pieces.get(c) || 0) + 1); }
    for (const k of res.refs?.live || []) { const c = resolve(k, "io"); if (c) info.pieces.set(c, (info.pieces.get(c) || 0) + 1); }
    for (const k of Object.keys(d.config || {})) { const c = resolve(k); if (c) info.pieces.set(c, info.pieces.get(c) || 1); }
    if (res.spec) {
        const walk = (n, where) => {
            if (!n || typeof n !== "object") return;
            if (n.t === "slot_element") info.debt.push(`slot_element${n.id ? " '" + n.id + "'" : ""} (DOM a mano nel nodo)`);
            if (n.t === "raw_element") info.debt.push(`raw_element${n.id ? " '" + n.id + "'" : ""} (DOM a mano nel nodo)`);
            if (n.t === "canvas_element" && typeof n.render === "string") info.debt.push(`canvas_element con render ${n.render} (disegno scritto nel nodo: promuovere a renderer)`);
            (n.children || []).forEach((c) => walk(c, where));
            if (n.item) walk(n.item, where);
        };
        for (const r of res.spec.regions) walk(r.tree, r.id);
        for (const m of Object.values(res.spec.menus || {})) if (m.tree) walk(m.tree, "menu");
    }
    info.glue = { actions: Object.keys(d.actions || {}), live: Object.keys(d.live || {}), hooks: Object.keys(d.hooks || {}) };
}

function applyNodeFlags(node, def) {
    const f = def.node;
    if (!f) return;
    // one step at a time: with the new frontend some properties are getter-only (e.g. title_mode) and in a
    // (strict) module assigning them THROWS: a single try used to skip everything after it (D-60, `bare` never applied).
    const step = (fn) => { try { fn(); } catch (_) {} };
    // bare: only the content shows (frame and title transparent; Vue Nodes reads them live)
    if (f.bare) step(() => { node.color = "rgba(0,0,0,0)"; node.bgcolor = "rgba(0,0,0,0)"; node.boxcolor = "rgba(0,0,0,0)"; if (typeof f.title !== "string") node.title = "\u2063"; });
    if (f.blankSlots) step(() => { for (const sl of [...(node.inputs || []), ...(node.outputs || [])]) if (sl) sl.label = " "; });
    if (f.virtual) step(() => { node.isVirtualNode = true; });          // LiteGraph flag (not custom): the node stays out of the prompt
    if (f.fixedSize || f.noResize) step(() => { node.resizable = false; });
    if (f.noCollapse || f.virtual) step(() => { node.collapsable = false; });
    if (typeof f.title === "string") step(() => { node.title = f.title; });
    if (f.noTitle) step(() => { node.title_mode = globalThis.LiteGraph?.NO_TITLE ?? 1; });
}

export function define(type, def, { kit = globalThis.SurvivalKit } = {}) {
    if (!kit || typeof kit.register !== "function") throw new Error("NodeStructure.define: SurvivalKit not available (import it first)");
    if (!type || typeof type !== "string") throw new Error("NodeStructure.define: missing type");
    if (!def || typeof def !== "object") throw new Error("NodeStructure.define: missing def");

    const d = {
        ...def,
        type,
        actions: def.actions || {},
        live: def.live || {},
        hooks: def.hooks || {},
        natives: [...(Array.isArray(def.natives) ? def.natives : []), ...(def.packed?.widget && !(def.natives || []).includes(def.packed.widget) ? [def.packed.widget] : [])],
        state: { ...(def.state || {}), ...BUILTIN_STATE },
        minWidth: def.minWidth ?? 200,
    };

    const raw = typeof def.spec === "function" ? def.spec() : def.spec;
    const res = normalizeSpec(raw, {});
    const errors = [...res.errors];
    if (res.spec) errors.push(...checkRefs(res.refs, d));
    errors.push(...checkConfig(d));
    registerNodeInfo(type, d, res);
    let template = res.spec;
    if (errors.length) {
        console.error(`[NodeStructure] spec '${type}' NOT valid:\n - ${errors.join("\n - ")}`);
        template = normalizeSpec(errorSpec(type, errors), {}).spec
            || { v: 1, regions: [{ id: "err", height: 40, tree: { t: "label", text: "NodeStructure: invalid spec" }, }] };   // last safety net: never null
    }
    for (const w of res.warnings) console.warn(`[NodeStructure] ${type}: ${w}`);
    DEFS.set(type, { def: d, errors, warnings: res.warnings, template });

    const rtOf = (ctx) => INSTANCES.get(ctx.node) || null;
    const H = d.hooks;
    const call = (name, ctx, ...args) => {
        const rt = rtOf(ctx);
        if (!rt || typeof H[name] !== "function") return;
        try { H[name](rt.api, ...args); } catch (e) { console.warn(`[NodeStructure] hook ${name} (${type}) failed:`, e); }
    };

    const config = {
        minWidth: d.minWidth,
        defaultSize: d.defaultSize || [d.minWidth, 100],
        nativeOrder: d.nativeOrder || [],
        persistNatives: d.natives,
        keepVisible: d.keepVisible || [],
        channels: d.channels || ["heal", "undo", "redo"],
        state: d.state,

        onNodeCreated(node) {
            applyNodeFlags(node, d);
            if (typeof H.onNodeCreated === "function") { try { H.onNodeCreated(node); } catch (e) { console.warn(`[NodeStructure] onNodeCreated (${type}):`, e); } }
        },

        setupUI(ctx) {
            applyNodeFlags(ctx.node, d);
            if (d.packed) installPacked(ctx, d.packed);                 // BEFORE mount: the first render already reads virtual natives
            const out = mount(ctx, d, template);
            // ComfyUI/Vue may put title/colors back AFTER creation (new node from list/search):
            // so the flags get reapplied shortly after mounting (runtime timers: released on dispose). We insist, gently.
            if (d.node && out?.rt) for (const ms of [0, 150, 600]) out.rt.api.after(() => applyNodeFlags(ctx.node, d), ms);
            return out;
        },

        refreshFromNative(ctx) {
            applyNodeFlags(ctx.node, d);
            const rt = rtOf(ctx);
            if (!rt) return;
            rt.update(true);
            call("refreshFromNative", ctx);
        },

        onRestore(ctx, st) {
            applyNodeFlags(ctx.node, d);
            const rt = rtOf(ctx);
            if (!rt) return;
            rt.restore(st);
            call("onRestore", ctx, st);
        },

        onResize(ctx, size) {
            const rt = rtOf(ctx);
            if (!rt) return;
            rt.onResize(size);
            call("onResize", ctx, size);
        },

        onExecute(ctx, message) {
            const rt = rtOf(ctx);
            if (!rt) return;
            call("onExecute", ctx, message);
            rt.fire("onExecute", message);
            rt.update();
        },

        onConnect(ctx, t, index) {
            const rt = rtOf(ctx);
            if (!rt) return;
            call("onConnect", ctx, t, index);
            rt.fire("onConnect", t, index);
            rt.update();
        },

        onChannel(ctx, ch, payload) {
            const rt = rtOf(ctx);
            if (!rt) return;
            if (ch === "undo" || ch === "redo") rt.undoRestore();
            call("onChannel", ctx, ch, payload);
        },

        onDblClick(ctx, e, pos, canvas) {
            const rt = rtOf(ctx);
            if (!rt) return;
            if (!rt.dblClick(e, pos)) call("onDblClick", ctx, e, pos, canvas);
        },

        onCleanup(ctx) {
            const rt = rtOf(ctx);
            if (!rt) return;
            call("onCleanup", ctx);
            rt.dispose();
        },
    };

    kit.register(type, config);
    return { type, errors, warnings: res.warnings };
}
