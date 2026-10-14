// ============================================================
// NodeStructure/core/runtime.js
// ------------------------------------------------------------
// Per-node runtime instance: builds regions (DOM widgets), tree,
// bindings, behaviors, menus; declares heights to LiteGraph; releases
// everything in dispose().
//
// RULES:
//  - spec per INSTANCE (JSON clone of the template), never on the prototype;
//  - no custom properties on the node: the instance lives in a WeakMap — no fingerprints;
//  - fully rebuildable from setupUI (no hidden state);
//  - no objects in node.properties: only what the kit writes
//    (JSON strings).
// ============================================================

import { deepClone, safeParse, stable } from "../util/json.js";
import { Bag } from "../util/tracker.js";
import { renderTree } from "./renderer.js";
import { createHost } from "./host.js";
import { declareHeights, regionHeight, regionState, isRegionHidden } from "./heights.js";
import { getBehavior } from "../behaviors/index.js";
import { FloatMenu } from "../menu/float-menu.js";
import { AnimGate } from "../runtime/anim-gate.js";
import { runAction } from "./binding.js";
import { impl, names as pieceNames } from "../catalog/registry.js";
import { envInfo } from "./env.js";

export const INSTANCES = new WeakMap();   // node -> Runtime
const ALL = new Set();                    // only for stats()/leak check; removed on dispose

export const OVERRIDE_PROPS = new Set(["visible", "text", "title", "disabled", "class"]);
const WARNED = new Set();

export class Runtime {
    constructor(ctx, def, spec) {
        this.ctx = ctx;
        this.node = ctx.node;
        this.def = def;
        this.spec = spec;
        this.bag = new Bag(`rt:${def.type}:${ctx.key}`);
        this.regions = new Map();      // id -> { spec, host, root, tree, widget, mode }
        this.rstate = new Map();       // id -> volatile region state (heights.js)
        this.menus = new Map();        // name -> open entry (float-menu)
        this.menuGuards = false;
        this.slotApis = new Map();
        this.scratch = new Map();      // the node's non-persistent objects (range, handle...)
        this.onUpdate = new Set();
        this.onRestore = new Set();
        this.onUndo = new Set();
        this.onNodeResize = new Set();
        this.onConnect = new Set();
        this.onExecute = new Set();
        this.onDraw = new Set();
        this.widthWant = new Map();    // who -> minimum width (px) requested by a piece (e.g. table_box, D-67)
        this._wantPrev = null;         // sum requested last round: the node grows/shrinks by the difference
        this.nodeMenu = null;
        this.destroyed = false;
        this._ov = {};
        this._upd = null;
        this._lay = null;
        this.api = null;
        ALL.add(this);
    }

    warnOnce(key, e) {
        const k = this.def.type + ":" + key;
        if (WARNED.has(k)) return;
        WARNED.add(k);
        console.warn(`[NodeStructure] ${this.def.type}: ${key}`, e ?? "");
    }

    // ---- element access (ids unique per region; searches all of them) ----
    el(id) {
        for (const r of this.regions.values()) { const e = r.tree?.el(id); if (e) return e; }
        return null;
    }
    region(id) { return this.spec.regions.find((r) => r.id === id) || null; }

    setRegionHidden(id, why, hidden) {
        const r = this.regions.get(id);
        if (!r) return;
        const st = regionState(this, id);
        const had = st.hiddenBy.has(why);
        if (hidden && !had) st.hiddenBy.add(why); else if (!hidden && had) st.hiddenBy.delete(why); else return;
        this.applyRegionVisibility(r);
        this.relayout();
    }

    applyRegionVisibility(r) {
        const hidden = isRegionHidden(this, r.spec);
        const v = hidden ? "0" : "1";
        if (r.host.getAttribute("data-ns-vis") !== v) r.host.setAttribute("data-ns-vis", v);
        const w = r.widget?.element;
        if (w && w !== r.host) w.style.display = hidden ? "none" : "";
    }

    // ---- update (batched on a tracked rAF) ----
    update(now = false) {
        // A handle kept from a runtime that a re-mount (setup/heal) has replaced must not talk into the void: the change
        // already reached the node (natives live on the node), so the node's CURRENT runtime gets the update. Seen live
        // after a long selfTest: setup landed late, the old api did native.set, nobody flushed (T9). Succubus: you
        // whispered to my ex, darling — I'll take the message myself.
        if (this.destroyed) { const cur = this.node ? INSTANCES.get(this.node) : null; if (cur && cur !== this) cur.update(now); return; }
        if (now) { if (this._upd) { this._upd(); this._upd = null; } this._flush(); return; }
        if (this._upd) return;
        this._upd = this.bag.raf(() => { this._upd = null; this._flush(); });
    }

    _flush() {
        if (this.destroyed) return;
        this.reloadOverrides();
        for (const r of this.regions.values()) {
            try { r.tree.update(); } catch (e) { this.warnOnce("tree.update", e); }
            this.applyRegionVisibility(r);
        }
        for (const m of this.menus.values()) { try { m.update?.(); } catch (e) { this.warnOnce("menu.update", e); } }
        for (const fn of [...this.onUpdate]) { try { fn(); } catch (e) { this.warnOnce("onUpdate", e); } }
        this.relayout();
    }

    // ---- node height: from what is DECLARED, not from the DOM ----
    relayout() {
        if (this.destroyed || this._lay) return;
        this._lay = this.bag.raf(() => { this._lay = null; this.relayoutNow(); });
    }

    relayoutNow() {
        if (this.destroyed) return;
        const n = this.node;
        const fixed = this.def.node?.fixedSize;
        try {
            if (fixed) {
                if (n.size?.[0] !== fixed[0] || n.size?.[1] !== fixed[1]) this.ctx.utils.withInternalResize(() => n.setSize?.([fixed[0], fixed[1]]));
                return;
            }
            const minW = this.def.minWidth ?? 200;
            let w = Math.max(n.size?.[0] ?? 0, minW);
            // width asked for by the pieces (D-67): grows/shrinks by the DIFFERENCE (extra room given by hand stays)
            if (this.widthWant.size) {
                const want = Math.max(...this.widthWant.values());
                const prev = this._wantPrev;
                w = prev != null && want !== prev ? Math.max(minW, want, w + (want - prev)) : Math.max(w, want);
                this._wantPrev = want;
            }
            const target = n.computeSize?.([w, 0]);
            if (!target) return;
            const th = target[1];
            const mode = this.spec.layout?.heightMode || "derived";
            let nh = n.size?.[1] ?? th;
            if (mode === "derived" || nh < th) nh = th;
            if (Math.abs((n.size?.[1] ?? 0) - nh) > 0.5 || Math.abs((n.size?.[0] ?? 0) - w) > 0.5) {
                this.ctx.utils.withInternalResize(() => n.setSize?.([w, nh]));
                n.setDirtyCanvas?.(true, true);
            }
        } catch (e) { this.warnOnce("relayout", e); }
    }

    // calls the hooks registered by the behaviors (rt.onConnect / rt.onExecute)
    fire(name, ...args) {
        for (const fn of [...(this[name] || [])]) { try { fn(...args); } catch (e) { this.warnOnce("fire:" + name, e); } }
    }

    // ---- hooks from the kit ----
    onResize(size) {
        if (this.destroyed || !size) return;
        const fixed = this.def.node?.fixedSize;
        if (fixed) { size[0] = fixed[0]; size[1] = fixed[1]; return; }
        for (const fn of [...this.onNodeResize]) { try { fn(size); } catch (e) { this.warnOnce("onNodeResize", e); } }
        if ((this.spec.layout?.heightMode || "derived") === "derived") {
            try { const t = this.node.computeSize?.([size[0], 0]); if (t && t[1] > 0) size[1] = t[1]; } catch (_) {}
        }
    }

    // overrides live in the kit's state: after a restore (unpack/undo/configure) they may have
    // arrived AFTER mount, so they get re-read and re-applied to the elements already built
    get overrides() { if (!this.destroyed && this.ctx) this.reloadOverrides(); return this._ov; }
    set overrides(v) { this._ov = v; }

    reloadOverrides() {
        const raw = this.ctx.state.get("__ns_over");
        if (raw === this._overRaw) return;
        this._overRaw = raw;
        const over = safeParse(raw, null);
        if (!over || typeof over !== "object" || Array.isArray(over)) return;
        if (JSON.stringify(over) === JSON.stringify(this._ov)) return;
        this._ov = over;
        for (const [id, props] of Object.entries(over)) { const el = this.el(id); if (el) patchElement(el, props); }
    }

    restore(state) {
        if (this.destroyed) return;
        this.reloadOverrides();
        for (const fn of [...this.onRestore]) { try { fn(state); } catch (e) { this.warnOnce("onRestore", e); } }
        this.update(true);
    }

    undoRestore() {
        if (this.destroyed) return;
        const run = () => { if (this.destroyed) return; for (const fn of [...this.onUndo]) { try { fn(); } catch (_) {} } this.update(true); };
        this.bag.raf(() => { run(); this.bag.timeout(run, 80); });
    }

    dblClick(e, pos) {
        const nm = this.nodeMenu;
        if (!nm || nm.on !== "dblclick") return false;
        this.api.openMenu(nm.menu, { point: { x: e?.clientX ?? 200, y: e?.clientY ?? 200 } });
        return true;
    }

    dispose() {
        if (this.destroyed) return;
        this.destroyed = true;
        try { FloatMenu.closeAllFor(this); } catch (_) {}
        for (const r of this.regions.values()) { try { r.tree.dispose(); } catch (_) {} try { r.host.remove(); } catch (_) {} }
        this.regions.clear();
        this.onUpdate.clear(); this.onRestore.clear(); this.onUndo.clear(); this.onNodeResize.clear(); this.onConnect.clear(); this.onExecute.clear(); this.onDraw.clear();
        this.slotApis.clear(); this.scratch.clear(); this.menus.clear();
        this.bag.dispose();
        if (INSTANCES.get(this.node) === this) INSTANCES.delete(this.node);
        ALL.delete(this);
    }
}

// ------------------------------------------------------------
function applyOverridesToSpec(spec, over) {
    if (!over || typeof over !== "object") return;
    const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (n.id && over[n.id]) for (const [k, v] of Object.entries(over[n.id])) if (OVERRIDE_PROPS.has(k)) n[k] = v;
        if (Array.isArray(n.children)) n.children.forEach(walk);
        if (n.item) walk(n.item);
    };
    for (const r of spec.regions) walk(r.tree);
}

function patchElement(el, props) {
    if ("visible" in props) el.setAttribute("data-ns-vis", props.visible === false || props.visible === "0" ? "0" : "1");
    if ("text" in props && typeof props.text === "string" && !props.text.startsWith("$") && !props.text.includes("{{")) el.textContent = props.text;
    if ("title" in props && typeof props.title === "string") el.title = props.title;
    if ("disabled" in props) { if ("disabled" in el) el.disabled = !!props.disabled; el.classList.toggle("ns-disabled", !!props.disabled); }
    if ("class" in props && typeof props.class === "string") for (const c of props.class.split(/\s+/).filter(Boolean)) el.classList.add(c);
}

function showToast(rt, text, ms = 2000) {
    let host = document.getElementById("succy-ns-toast-host");
    if (!host) {
        host = document.createElement("div");
        host.id = "succy-ns-toast-host";
        host.className = "ns-toast-host ns-root";
        host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:999998;pointer-events:none;";
        document.body.appendChild(host);
    }
    const t = document.createElement("div");
    t.className = "ns-toast";
    t.style.cssText = "padding:8px 14px;background:rgba(20,20,30,.95);border:1px solid rgba(74,158,255,.4);border-left:3px solid #4a9eff;border-radius:6px;color:#eee;font:11px monospace;box-shadow:0 4px 16px rgba(0,0,0,.6);";
    t.textContent = String(text);
    host.appendChild(t);
    const remove = () => { try { t.remove(); } catch (_) {} if (!host.childElementCount) { try { host.remove(); } catch (_) {} } };
    rt.bag.add(remove);
    rt.bag.timeout(remove, ms);
}

export function makeApi(rt) {
    const { ctx } = rt;
    const api = {
        ctx, node: ctx.node, key: ctx.key, id: ctx.id, type: rt.def.type,
        state: {
            get: (k) => ctx.state.get(k),
            set: (k, v) => { ctx.state.set(k, v); rt.update(); },
            flush: () => ctx.state.flush(),
        },
        native: {
            get: (n) => ctx.utils.getNative(n)?.value,
            widget: (n) => ctx.utils.getNative(n),
            set: (n, v) => { const ok = ctx.utils.setNative(n, v); rt.update(); if (ok) { try { rt.def.hooks?.onNative?.(api, n, v); } catch (e) { rt.warnOnce("onNative", e); } } return ok; },
            show: (n) => { const r = ctx.utils.showNative(n); rt.relayout(); return r; },
            hide: (n) => { const r = ctx.utils.hideNative(n); rt.relayout(); return r; },
        },
        cache: ctx.cache, local: ctx.local, perf: ctx.perf, utils: ctx.utils, log: ctx.log,
        scratch: rt.scratch,
        env: envInfo,

        el: (id) => rt.el(id),
        slot: (name) => rt.slotApis.get(name) ?? null,
        region: (id) => rt.regions.get(id) || null,
        refresh: (now = false) => rt.update(now),
        relayout: () => rt.relayout(),
        liveNode: () => ctx.utils.liveNode(ctx.id, ctx.graph),
        spec: () => deepClone(rt.spec),

        openMenu: (name, opts) => FloatMenu.open(rt, name, opts),
        closeMenu: (name) => FloatMenu.close(rt, name),
        isMenuOpen: (name) => FloatMenu.isOpen(rt, name),

        // persistent spec overrides (visible/text/title/disabled/class per id)
        patch(id, props) {
            if (!props || typeof props !== "object") return;
            const clean = {};
            for (const [k, v] of Object.entries(props)) if (OVERRIDE_PROPS.has(k) && (typeof v === "string" || typeof v === "boolean")) clean[k] = v;
            rt.overrides[id] = { ...(rt.overrides[id] || {}), ...clean };
            ctx.state.set("__ns_over", JSON.stringify(rt.overrides));
            const el = rt.el(id);
            if (el) patchElement(el, clean);
        },
        unpatch(id) {
            delete rt.overrides[id];
            ctx.state.set("__ns_over", JSON.stringify(rt.overrides));
        },
        overrides: () => JSON.parse(JSON.stringify(rt.overrides)),

        // tracked resources: released on dispose
        whenConnected(el, cb, tries = 40) {
            const poll = (n) => {
                if (rt.destroyed) return;
                if (el.isConnected) { try { cb(el); } catch (e) { rt.warnOnce("whenConnected", e); } return; }
                if (n <= 0) return;
                rt.bag.timeout(() => poll(n - 1), 50);
            };
            poll(tries);
        },
        after: (fn, ms) => rt.bag.timeout(fn, ms),
        every: (fn, ms) => rt.bag.interval(fn, ms),
        raf: (fn) => rt.bag.raf(fn),
        listen: (t, ev, fn, o) => rt.bag.listen(t, ev, fn, o),
        onDispose: (fn) => rt.bag.add(fn),
        // a piece asks for a minimum node width (px); null removes it. The node grows/shrinks by the difference — it adapts to what you ask.
        wantWidth: (who, px) => { if (px == null) rt.widthWant.delete(who); else rt.widthWant.set(who, Math.ceil(Number(px) || 0)); rt.relayout(); },
        toast: (text, ms) => showToast(rt, text, ms),
        runAction: (ref, ev, el, item) => runAction(rt, ref, ev, el, item),

        // the node's JSON configuration for a kit piece (define({config:{piece:{...}}}))
        cfg: (piece) => rt.def.config?.[piece] || {},
        // kit io sources callable from node code: api.io.sig_input(item?)
        // kit actions callable from node code (glue): api.act.reset_node({key, value, width})
        act: new Proxy({}, { get: (_, name) => { const f = impl(String(name), "action"); return typeof f === "function" ? (args) => f(api, null, null, undefined, args) : undefined; }, has: (_, name) => pieceNames("action").has(String(name)) }),
        io: new Proxy({}, { get: (_, name) => { const f = impl(String(name), "io"); return f ? (item) => f(api, item) : undefined; }, has: (_, name) => pieceNames("io").has(String(name)) }),
    };
    return api;
}

// ------------------------------------------------------------
// mount(): called by setupUI. Always rebuilds from scratch.
// ------------------------------------------------------------
export function mount(ctx, def, template) {
    const node = ctx.node;
    const prev = INSTANCES.get(node);
    if (prev) prev.dispose();                       // setupUI may be called again (heal): no leftovers

    const spec = deepClone(template);               // per instance
    const rt = new Runtime(ctx, def, spec);
    INSTANCES.set(node, rt);
    rt.api = makeApi(rt);

    // persisted overrides (JSON string in the kit's state)
    const over = safeParse(ctx.state.get("__ns_over"), null);
    rt._overRaw = ctx.state.get("__ns_over");
    if (over && typeof over === "object" && !Array.isArray(over)) { rt.overrides = over; applyOverridesToSpec(spec, over); }

    // born: animation continuity after undo/tab/reload
    let born = ctx.state.get("__ns_born");
    if (!born) { born = Date.now(); ctx.state.set("__ns_born", born); }

    let firstHost = null;
    for (const rs of spec.regions) {
        const { host, root, mode } = createHost(rt, rs, spec);
        root.style.setProperty("--ns-born", `-${Math.max(0, (Date.now() - born) / 1000).toFixed(3)}s`);
        const tree = renderTree(rt, rs.tree, "region:" + rs.id);
        root.appendChild(tree.root);
        const region = { spec: rs, host, root, tree, widget: null, mode };
        rt.regions.set(rs.id, region);
        const w = ctx.addDomWidget("ns_" + rs.id, host);
        region.widget = w;
        declareHeights(rt, w, rs);
        if (!firstHost) firstHost = host;

        if (rs.height && typeof rs.height === "object" && rs.height.auto) {
            const st = regionState(rt, rs.id);
            const measure = () => {
                if (rt.destroyed) return;
                if (host.getAttribute("data-ns-vis") === "0" || host.getAttribute("data-ns-col") === "1") return;
                const h = Math.ceil(root.offsetHeight);
                if (h > 0 && h !== st.autoH) { st.autoH = h; rt.relayout(); }
            };
            ctx.perf.observeResize(root, measure);     // kit: tracked and released by the kit
            rt.bag.add(() => { try { ctx.perf.unobserveResize(root); } catch (_) {} });
        }
    }

    if (def.order?.length) ctx.utils.orderWidgets(def.order);

    // behaviors
    for (const b of spec.behaviors || []) {
        const attach = getBehavior(b.type);
        if (!attach) { rt.warnOnce("behavior:" + b.type, `behavior '${b.type}' not registered`); continue; }
        try { attach(rt, b); } catch (e) { rt.warnOnce("behavior-attach:" + b.type, e); }
    }

    try { def.hooks?.onSetup?.(rt.api); } catch (e) { rt.warnOnce("onSetup", e); }
    rt.update(true);
    for (const r of rt.regions.values()) rt.applyRegionVisibility(r);
    rt.relayoutNow();
    rt.relayout();

    return { root: firstHost, rt, hosts: [...rt.regions.values()].map((r) => r.host) };
}

// ---- stats for the leak check ----
export function runtimeStats() {
    let menus = 0;
    for (const r of ALL) menus += r.menus.size;
    return { instances: ALL.size, openMenus: menus, bags: Bag.stats(), anim: AnimGate.stats() };
}
export const liveRuntimes = () => [...ALL];
void stable;
