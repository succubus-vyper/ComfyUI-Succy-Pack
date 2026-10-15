// ============================================================
// SurvivalKit/core/heal.js
// ------------------------------------------------------------
// Node setup + healing. Unified ctx builder.
// Local and serialize are injected (no inline duplicates).
// v0.1.1 — 2026-10-10
// ============================================================

import { NodeState } from "./node-state.js";
import { nodeKey } from "./keys.js";
import { Log } from "./log.js";
import { restoreNatives, persistNatives, readNatives } from "../persistence/serialize.js";
import { addDOMWidget } from "../compat/compat.js";

export class Heal {
    constructor({ registry, perf, services, state, dom, cache, local }) {
        this.registry = registry;
        this.perf = perf;
        this.services = services;
        this.state = state;
        this.dom = dom || null;
        this.cache = cache || null;
        this.local = local || null;
        this._busy = new Set();
        this._setupDone = new Set();
    }

    scheduleSetup(node, config, attempt = 0) {
        if (!node || NodeState.get(node, "removed", false)) return;
        if (node.type !== config.type) return;

        const key = nodeKey(node);
        if (this._busy.has(key)) return;
        if (this._setupDone.has(key)) return;

        const firstNative = config.nativeOrder[0];
        if (firstNative && !node.widgets?.find((w) => w.name === firstNative)) {
            if (attempt > 40) {
                console.warn(`[SurvivalKit] setup #${node.id} given up`);
                return;
            }
            const self = this;
            setTimeout(() => {
                const live = self.registry.liveNode(node.id, node.graph);
                if (!live || NodeState.get(live, "removed", false)) return;
                self.scheduleSetup(live, config, attempt + 1);
            }, 50);
            return;
        }

        this._busy.add(key);
        try {
            const ok = this._doSetup(node, config);
            if (ok) this._setupDone.add(key);
        } catch (e) {
            console.error(`[SurvivalKit] setup error #${node.id}:`, e);
        } finally {
            this._busy.delete(key);
        }
    }

    _doSetup(node, config) {
        // Leftovers from a previous failed attempt: no duplicates. We like company, not crowds.
        this.services.destroy(node);
        this.releaseResources(node);
        this._purgeOldDom(node, config);

        const keep = new Set(config.keepVisible || []);
        for (const w of node.widgets || []) {
            if (!w?.name) continue;
            if (w._succyKitDom) continue;
            if (keep.has(w.name)) continue;
            this.dom.hideNativeWidget(w);
        }

        this.state.init(node, config);

        const persistList = Array.isArray(config.persistNatives)
            ? config.persistNatives.slice()
            : [];
        NodeState.set(node, "persistNatives", persistList);

        const ctx = this._makeCtx(node, config);
        NodeState.set(node, "config", config);
        NodeState.set(node, "ctx", ctx);

        if (config.channels?.length && typeof config.onChannel === "function") {
            this.services.subscribe(node, config.channels, (ch, payload) => {
                try { config.onChannel(ctx, ch, payload); } catch (e) {
                    console.warn(`[SurvivalKit] onChannel error #${node.id} '${ch}':`, e);
                }
            });
        }

        NodeState.set(node, "domFailed", false);
        let dom = null;
        let setupOk = false;
        try {
            dom = config.setupUI(ctx) || {};
            setupOk = true;
        } catch (e) {
            console.error(`[SurvivalKit] setupUI error #${node.id}:`, e);
            dom = {};
        }

        if (setupOk && NodeState.get(node, "domFailed", false)) {
            setupOk = false;
            console.warn(`[SurvivalKit] setup #${node.id}: addDOMWidget failed, UI incomplete`);
        }

        NodeState.set(node, "dom", dom);
        NodeState.set(node, "root", dom.root || null);
        NodeState.set(node, "ready", setupOk);
        ctx.dom = dom;

        if (!setupOk) {
            console.warn(`[SurvivalKit] setup #${node.id} incompleto, ritento al prossimo heal`);
            return false;
        }

        restoreNatives(node, persistList.length ? persistList : config.nativeOrder);

        try { config.refreshFromNative(ctx); } catch (e) {
            console.warn(`[SurvivalKit] refreshFromNative error #${node.id}:`, e);
        }

        this.state.scheduleRestore(node, config);
        this.state.tryApplyRestore(node, config);
        this._rehideNatives(node, config);

        try { node.arrange?.(); } catch (_) {}
        try { node.setDirtyCanvas?.(true, true); } catch (_) {}

        return true;
    }

    _rehideNatives(node, config) {
        const st = NodeState.all(node);
        if (!st) return;
        const keep = new Set(config.keepVisible || []);
        const shown = st.visibleNatives || new Set();
        for (const w of node.widgets || []) {
            if (!w?.name) continue;
            if (w._succyKitDom) continue;
            if (keep.has(w.name)) continue;
            if (shown.has(w.name)) continue;
            try { this.dom.enforceNativeHidden(w); } catch (_) {}
        }
    }

    heal(node, strict, config) {
        if (!node || NodeState.get(node, "removed", false)) return;
        if (node.type !== config.type) return;

        const key = nodeKey(node);
        if (this._busy.has(key)) return;

        if (!this._setupDone.has(key)) {
            this.scheduleSetup(node, config);
            return;
        }

        if (!this._uiHealthy(node)) {
            try { this.services.emit("heal", { node, strict, mode: "full" }); } catch (_) {}
            this._doFullHeal(node, config, key);
            return;
        }

        // Soft heal. We do NOT check root.isConnected: ComfyUI mounts
        // DOM widgets asynchronously (on the next canvas draw),
        // so root.isConnected can be false for tens of ms or
        // more without anything being broken. The real bug (DOM
        // removed by a third-party extension) is handled by _uiHealthy, which
        // checks ready + root + dom, not the connection to the document.
        try { this.services.emit("heal", { node, strict, mode: "soft" }); } catch (_) {}
        try {
            const ctx = NodeState.get(node, "ctx", null) || this._makeCtx(node, config);
            ctx.dom = NodeState.get(node, "dom", null);
            config.refreshFromNative(ctx);
            this.state.scheduleRestore(node, config);
            this.state.tryApplyRestore(node, config);
            this._rehideNatives(node, config);
            node._succyEnforceCollapse?.();
        } catch (e) {
            console.warn(`[SurvivalKit] soft heal error #${node.id}:`, e);
        }
    }

    _doFullHeal(node, config, key) {
        this._busy.add(key);
        try {
            const ctx = NodeState.get(node, "ctx", null);
            if (ctx) {
                try { config.onCleanup(ctx, config); } catch (_) {}
            }
            this._purgeOldDom(node, config);
            this.state.destroy(node);
            this.services.destroy(node);
            this.releaseResources(node);
            NodeState.set(node, "ready", false);
            NodeState.set(node, "ctx", null);
            NodeState.set(node, "dom", null);
            NodeState.set(node, "root", null);
            try { this.cache?.scheduleCleanup(node); } catch (_) {}

            this._setupDone.delete(key);
        } finally {
            this._busy.delete(key);
        }
        this.scheduleSetup(node, config);
    }

    healAll(type, strict = false) {
        const config = globalThis.__succyConfigs?.get(type);
        if (!config) return;
        for (const node of this.registry.iterate(type)) {
            try { this.heal(node, strict, config); } catch (_) {}
        }
    }

    _uiHealthy(node) {
        if (!NodeState.get(node, "ready", false)) return false;
        if (!NodeState.get(node, "root", null)) return false;
        if (!NodeState.get(node, "dom", null)) return false;
        // Kit widgets removed by third parties: compare by name (Proxy-safe).
        const kit = NodeState.get(node, "kitDom", null);
        if (kit && kit.size && Array.isArray(node.widgets)) {
            for (const w of kit) {
                if (!w?.name) continue;
                if (!node.widgets.some((x) => x?.name === w.name)) return false;
            }
        }
        return true;
    }

    _purgeOldDom(node, config) {
        if (node.widgets) {
            for (let i = node.widgets.length - 1; i >= 0; i--) {
                const w = node.widgets[i];
                if (w?._succyKitDom) {
                    try { node.widgets.splice(i, 1); } catch (_) {}
                }
            }
        }
        try {
            document
                .querySelectorAll(`[data-succy-node-key="${nodeKey(node)}"]`)
                .forEach((el) => el.remove());
        } catch (_) {}
    }

    _makeCtx(node, config) {
        const self = this;
        return {
            node,
            id: node.id,
            key: nodeKey(node),
            graph: node.graph,
            config,

            perf: {
                acquireRAF: (name, fn) => {
                    const id = `${nodeKey(node)}:${name}`;
                    self.perf.acquireRAF(id, fn);
                    NodeState.ensure(node).rafs.add(id);
                },
                releaseRAF: (name) => {
                    const id = `${nodeKey(node)}:${name}`;
                    self.perf.releaseRAF(id);
                    NodeState.ensure(node).rafs.delete(id);
                },
                observeResize: (el, cb) => {
                    self.perf.observeResize(el, cb);
                    NodeState.ensure(node).resizeEls.add(el);
                },
                unobserveResize: (el) => {
                    self.perf.unobserveResize(el);
                    NodeState.ensure(node).resizeEls.delete(el);
                },
                stats: () => self.perf.stats(),
                acquireCanvas: (canvas, opts) => {
                    self.perf.acquireCanvas(canvas, opts);
                    NodeState.ensure(node).canvases.add(canvas);
                },
                releaseCanvas: (canvas) => {
                    self.perf.releaseCanvas(canvas);
                    NodeState.ensure(node).canvases.delete(canvas);
                },
            },

            dom: null,

            state: {
                get: (k) => self.state.get(node, k),
                set: (k, v) => self.state.set(node, k, v),
                flush: () => self.state.flush(node),
            },

            persistNative: (names) => {
                const st = NodeState.all(node);
                if (!st) return;
                if (!st.persistNatives) st.persistNatives = [];
                if (Array.isArray(names)) {
                    for (const n of names) {
                        if (!st.persistNatives.includes(n)) st.persistNatives.push(n);
                    }
                }
                const list = st.persistNatives.length
                    ? st.persistNatives
                    : (config.persistNatives?.length ? config.persistNatives : config.nativeOrder);
                persistNatives(node, list, readNatives(node, list));
                self.perf.scheduleChange(node);
            },

            cache: {
                get: (key, def) => self.cache ? self.cache.get(node, key, def) : def,
                set: (key, value) => self.cache?.set(node, key, value),
                has: (key) => self.cache ? self.cache.has(node, key) : false,
                delete: (key) => self.cache?.delete(node, key),
            },

            local: {
                get: (key, def) => self.local ? self.local.get(node, key, def) : def,
                set: (key, value) => self.local?.set(node, key, value),
                delete: (key) => self.local?.delete(node, key),
            },

            utils: {
                liveNode: (id, g) => self.registry.liveNode(id, g),

                getNative: (name) => node.widgets?.find((x) => x.name === name) || null,

                setNative: (name, value) => {
                    const w = node.widgets?.find((x) => x.name === name);
                    if (!w) return false;
                    if (Object.is(w.value, value)) return true;
                    w.value = value;
                    try { w.callback?.(value, globalThis.app?.canvas, node); } catch (_) {}
                    self.perf.scheduleChange(node);
                    return true;
                },

                showNative: (names) => {
                    const list = Array.isArray(names) ? names : [names];
                    const st = NodeState.ensure(node);
                    let touched = false;
                    for (const name of list) {
                        st.visibleNatives.add(name);
                        const w = node.widgets?.find((x) => x.name === name);
                        if (!w) continue;
                        if (w._succyOrigSaved) {
                            w.type = w._succyOrigType;
                            w.computeSize = w._succyOrigComputeSize;
                            w.draw = w._succyOrigDraw;
                            w.mouse = w._succyOrigMouse;
                            w.hidden = w._succyOrigHidden ?? false;
                        } else {
                            w.hidden = false;
                        }
                        if (w.options) w.options.hidden = false;
                        if (w.element) {
                            w.element.style.display = "";
                            w.element.style.visibility = "";
                            w.element.style.position = "";
                            w.element.style.pointerEvents = "";
                            w.element.style.left = "";
                        }
                        w.last_y = -1;
                        touched = true;
                    }
                    if (!touched) return false;
                    try { node.arrange?.(); } catch (_) {}
                    try {
                        // grow only (D-106): shrinking here threw away the height a free-height node (Crop) was given by hand or
                        // by its saved workflow; derived nodes get their exact height from NodeStructure's relayout anyway
                        const sz = node.computeSize?.();
                        if (sz && node.size && sz[1] > node.size[1]) node.setSize?.([node.size[0], sz[1]]);
                    } catch (_) {}
                    try { node.setDirtyCanvas?.(true, true); } catch (_) {}
                    return true;
                },

                hideNative: (names) => {
                    const list = Array.isArray(names) ? names : [names];
                    const st = NodeState.ensure(node);
                    let touched = false;
                    for (const name of list) {
                        st.visibleNatives.delete(name);
                        const w = node.widgets?.find((x) => x.name === name);
                        if (w && self.dom?.enforceNativeHidden) {
                            self.dom.enforceNativeHidden(w);
                            w.last_y = -1;
                            touched = true;
                        }
                    }
                    if (!touched) return false;
                    try { node.arrange?.(); } catch (_) {}
                    try {
                        // grow only (D-106): shrinking here threw away the height a free-height node (Crop) was given by hand or
                        // by its saved workflow; derived nodes get their exact height from NodeStructure's relayout anyway
                        const sz = node.computeSize?.();
                        if (sz && node.size && sz[1] > node.size[1]) node.setSize?.([node.size[0], sz[1]]);
                    } catch (_) {}
                    try { node.setDirtyCanvas?.(true, true); } catch (_) {}
                    return true;
                },

                shield: (el) => {
                    if (!el) return;
                    el.setAttribute("data-succy-shield", "");
                    if (self.dom?.shield) {
                        self.dom.shield(el, {
                            id: node.id,
                            graph: node.graph,
                            utils: { liveNode: (id, g) => self.registry.liveNode(id, g) },
                        });
                    }
                },

                stopEvents: (el, events) => self.dom.stopEvents(el, events),
                scrollable: (el) => self.dom.scrollable(el),

                orderWidgets: (order) => {
                    if (!Array.isArray(order) || !order.length) return;
                    if (!node.widgets) return;
                    const byName = new Map();
                    for (const w of node.widgets) byName.set(w.name, w);
                    const rest = node.widgets.filter((w) => !order.includes(w.name));
                    node.widgets.length = 0;
                    for (const name of order) {
                        const w = byName.get(name);
                        if (w) node.widgets.push(w);
                    }
                    for (const w of rest) node.widgets.push(w);
                },

                withInternalResize: (fn) => {
                    const prev = NodeState.get(node, "internalResize", false);
                    NodeState.set(node, "internalResize", true);
                    try { return fn(); }
                    finally { NodeState.set(node, "internalResize", prev); }
                },

                onDocument: (ev, fn, opts) => {
                    document.addEventListener(ev, fn, opts);
                    const st = NodeState.ensure(node);
                    if (!st.docListeners) st.docListeners = [];
                    st.docListeners.push({ ev, fn, opts });
                },
            },

            addDomWidget: (name, el) => {
                el.dataset.succyNodeKey = nodeKey(node);
                el.setAttribute("data-succy-shield", "");
                self.dom.shield(el, {
                    id: node.id,
                    graph: node.graph,
                    utils: { liveNode: (id, g) => self.registry.liveNode(id, g) },
                });
                const w = addDOMWidget(node, name, "SUCCY_DOM", el, {
                    getValue: () => 1,
                    setValue: () => {},
                });
                if (w) {
                    w.serialize = false;
                    w.options = { ...(w.options || {}), serialize: false };
                    w._succyKitDom = true;
                    NodeState.ensure(node).kitDom.add(w);
                } else {
                    NodeState.set(node, "domFailed", true);
                }
                return w;
            },

            log: (...args) => {
                Log.emit(config.type, `[${config.type}#${node.id}]`, args);
            },
        };
    }

    // Single cleanup: used by _doSetup, _doFullHeal and lifecycle.onRemoved.
    releaseResources(node) {
        const st = NodeState.all(node);
        if (!st) return;
        for (const w of st.kitDom) {
            try { this.dom.unshield(w?.element); } catch (_) {}
        }
        st.kitDom.clear();
        for (const el of st.resizeEls) {
            try { this.perf.unobserveResize(el); } catch (_) {}
        }
        st.resizeEls.clear();
        for (const id of st.rafs) {
            try { this.perf.releaseRAF(id); } catch (_) {}
        }
        st.rafs.clear();
        for (const canvas of st.canvases) {
            try { this.perf.releaseCanvas(canvas); } catch (_) {}
        }
        st.canvases.clear();
        if (Array.isArray(st.docListeners)) {
            for (const { ev, fn, opts } of st.docListeners) {
                try { document.removeEventListener(ev, fn, opts); } catch (_) {}
            }
            st.docListeners.length = 0;
        }
    }

    destroy(node) {
        const key = nodeKey(node);
        this._setupDone.delete(key);
        this._busy.delete(key);
        NodeState.del(node);
    }
}