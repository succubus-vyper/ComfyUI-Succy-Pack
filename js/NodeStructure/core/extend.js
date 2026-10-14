// ============================================================
// NodeStructure/core/extend.js — GRAPH EXTENSIONS (not nodes)
// ------------------------------------------------------------
//   NodeStructure.extend("Succy.NativeReroutes", {
//     subject: "reroute",                       // which graph objects the menus work on
//     config:  { effects_system: { route: "/succy/reroute/effects" } },
//     state:   { effect: {policy:"immediate", default:""}, ... },   // PER-OBJECT state (SurvivalKit graphStore)
//     spec:    { v: 1, behaviors: [...], menus: { fx: {...} } },
//   });
// Same "glue" protocol as the nodes: the extension file contains ONLY JSON config + state + spec.
// Allowed behaviors: those tagged "estensione" in their card. No regions (there's no body to dress).
// Menus: when a behavior (e.g. open_float_native) opens a menu on an object, the kit creates a real
// Runtime with a "subject" (fake node: {id, graph, reroute}) as api.node and a state that reads/writes
// THAT object's data in the SurvivalKit; the Runtime is destroyed when the menu closes. Brief, but intense.
// State with policy "ui" = memory only (e.g. the cards' page). See DECISIONS D-44 / D-53.
// ============================================================
import { normalizeSpec, checkRefs } from "./parser.js";
import { checkConfig, registerNodeInfo } from "./define.js";
import { Runtime, INSTANCES, makeApi } from "./runtime.js";
import { getBehavior } from "../behaviors/index.js";
import { get as getPiece } from "../catalog/registry.js";
import { FloatMenu } from "../menu/float-menu.js";
import { Bag } from "../util/tracker.js";
import { deepClone } from "../util/json.js";
import { subjectOf } from "../fx/chain.js";

export const EXTS = new Map();   // name -> { def, errors, warnings, rt, openFor }
const SUBJECTS = ["reroute"];

const memStore = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => { m.set(k, v); }, delete: (k) => m.delete(k), flush() {} }; };
const slug = (s) => String(s).replace(/[^\w-]+/g, "_");

export function extend(name, def = {}) {
    if (!name || typeof name !== "string") throw new Error("NodeStructure.extend: missing name");
    EXTS.get(name)?.rt?.dispose();
    const errors = [];
    for (const k of Object.keys(def)) if (!["config", "spec", "state", "subject"].includes(k)) errors.push(`${k}: un'estensione dichiara solo subject, config, state e spec`);
    if (def.subject !== undefined && !SUBJECTS.includes(def.subject)) errors.push(`subject '${def.subject}' non supportato (${SUBJECTS.join("|")})`);
    const d = { type: name, actions: {}, live: {}, hooks: {}, natives: [], state: { ...(def.state || {}), __ns_born: { policy: "ui", default: 0 }, __ns_over: { policy: "ui", default: "" } },
        config: def.config, extension: true, subject: def.subject || null, minWidth: 0 };
    const res = normalizeSpec(def.spec || {}, { extension: true });
    errors.push(...res.errors);
    if (res.spec) errors.push(...checkRefs(res.refs, d));
    errors.push(...checkConfig(d));
    for (const b of res.spec?.behaviors || []) {
        const card = getPiece(b.type)?.card;
        if (!card?.tag?.includes("estensione")) errors.push(`behavior '${b.type}': non e' utilizzabile in un'estensione (manca il tag 'estensione' nella scheda)`);
    }
    if (res.spec?.menus && Object.keys(res.spec.menus).length && !d.subject) errors.push("menus: serve 'subject' (su quale oggetto lavora il menu)");
    registerNodeInfo(name, d, res);
    const template = res.spec;
    // per-object data namespace: the one declared by the painting behavior (paint_link_native.ns)
    const nsDecl = (res.spec?.behaviors || []).find((b) => typeof b.ns === "string" && b.ns)?.ns || "reroutes";

    // ---- behavior runtime (one per extension) ----
    const bag = new Bag("ext:" + name);
    const warned = new Set();
    let cur = null;                                   // runtime of the subject whose menu is open
    const proto = { type: name };                     // subjects' prototype: open() leads to the extension's menu
    const ext = {
        name, def: d, ns: nsDecl,
        // opens `menu` on object r (native reroute); opts: {point:{x,y}} | {anchor}
        openFor(r, menu, opts = {}) {
            if (!template?.menus?.[menu] || !r) return null;
            const g = globalThis.app?.canvas?.graph;
            if (!g?.reroutes?.has?.(r.id)) return null;
            try { cur?.dispose(); } catch (_) {}
            const S = subjectOf(g, r, proto);
            const ctxBag = new Bag(`ext:${name}:subject`);
            const ui = memStore();
            const gs = () => globalThis.SurvivalKit?.graphStore;
            const ns = () => ext.ns || "reroutes";
            const isUi = (k) => d.state[k]?.policy === "ui";
            const ctx = {
                node: S, key: `ext-${slug(name)}-rr${r.id}`, id: S.id, graph: g,
                state: {
                    get: (k) => { if (isUi(k)) return ui.get(k, d.state[k]?.default); const v = gs()?.get(g, ns(), r.id)?.[k]; return v !== undefined ? v : d.state[k]?.default; },
                    set: (k, v) => { if (isUi(k)) { ui.set(k, v); return; } gs()?.set(g, ns(), r.id, { [k]: v === d.state[k]?.default ? undefined : v }); },
                    delete: (k) => { if (isUi(k)) ui.delete(k); else gs()?.set(g, ns(), r.id, { [k]: undefined }); },
                    flush() {},
                },
                cache: memStore(), local: memStore(), log() {},
                perf: globalThis.SurvivalKit?.perf,
                utils: {
                    onDocument: (t, fn, o) => ctxBag.listen(document, t, fn, o),
                    scrollable() {}, withInternalResize: (fn) => fn(), getNative: () => null, setNative: () => false,
                    showNative() {}, hideNative() {}, liveNode: () => S, orderWidgets() {},
                },
            };
            const rt = new Runtime(ctx, d, deepClone(template));
            rt.bag.add(() => ctxBag.dispose());
            rt.ext = ext;
            INSTANCES.set(S, rt);
            rt.api = makeApi(rt);
            cur = rt;
            rt.bag.add(() => { if (cur === rt) cur = null; });
            const entry = FloatMenu.open(rt, menu, { ...opts, reopen: true, onClose: () => { try { rt.dispose(); } catch (_) {} } });
            if (!entry) { rt.dispose(); return null; }
            // D-87: the subject can die while its menu is open (the last wire leaves and the core prunes the reroute, undo, another
            // level of the graph...). A menu hanging on a corpse is the orphan we don't do: it closes by itself, within a heartbeat.
            rt.bag.interval(() => {
                const now = globalThis.app?.canvas?.graph;
                if (now !== g || !g.reroutes?.has?.(r.id)) { try { FloatMenu.close(rt, menu); } catch (e) { console.warn("[NodeStructure] extend: closing the menu of a dead subject:", e); } try { rt.dispose(); } catch (_) {} }
            }, 250);
            rt.update(true);
            return rt;
        },
        current: () => cur,
    };
    proto.open = function (menu, opts) { return ext.openFor(this.reroute, menu, opts); };
    const rt = {
        type: name, node: null, def: d, bag, destroyed: false, extension: true, ext,
        api: { cfg: (piece) => (d.config && d.config[piece]) || {}, type: name },
        warnOnce(key, e) { if (warned.has(key)) return; warned.add(key); console.warn(`[NodeStructure] extension ${name}: ${key}`, e); },
        dispose() { if (this.destroyed) return; this.destroyed = true; try { cur?.dispose(); } catch (_) {} bag.dispose(); },
    };
    if (errors.length) console.error(`[NodeStructure] extension '${name}' NOT valid:\n - ${errors.join("\n - ")}`);
    else for (const b of res.spec.behaviors || []) {
        try { getBehavior(b.type)(rt, b); } catch (e) { rt.warnOnce("behavior " + b.type, e); }
    }
    EXTS.set(name, { def: d, errors, warnings: res.warnings, rt, openFor: ext.openFor, current: ext.current });
    return { name, errors, dispose: () => rt.dispose() };
}
