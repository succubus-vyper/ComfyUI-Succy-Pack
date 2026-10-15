// ============================================================
// SurvivalKit/core/lifecycle.js
// ------------------------------------------------------------
// Wraps ComfyUI's native hooks for every registered type — tightly.
// Uses persistence/serialize to read/restore natives.
// v0.1.0 — 2026-10-09
// ============================================================

import { app } from "../../../../scripts/app.js";
import { NodeState } from "./node-state.js";
import { logger } from "./log.js";

const log = logger("lifecycle");
import { readNatives, restoreNatives, persistNatives, parseObject } from "../persistence/serialize.js";
// next frame when the page is visible; a plain timeout when it is hidden (browsers freeze rAF in hidden tabs, and a frozen
// queue of connect / restore callbacks is how a node ends up half-dressed. Don't leave her waiting, darling.) D-79
const nextTick = (fn) => (typeof document !== "undefined" && document.hidden ? setTimeout(fn, 0) : requestAnimationFrame(fn));

const VERSION_TAG = "__succyLifecycleInstalled";

export class Lifecycle {
    constructor({ registry, perf, dom, heal, state, services, cache }) {
        this.registry = registry;
        this.perf = perf;
        this.dom = dom;
        this.heal = heal;
        this.state = state;
        this.services = services;
        this.cache = cache || null;
    }

    install(type, config) {
        if (!globalThis.__succyConfigs) globalThis.__succyConfigs = new Map();
        globalThis.__succyConfigs.set(type, config);
        if (!globalThis.__succyKitPerf) globalThis.__succyKitPerf = this.perf;

        const self = this;

        app.registerExtension({
            name: `Succy.SurvivalKit.${type}.${Date.now()}`,

            beforeRegisterNodeDef: (nodeType, nodeData) => {
                if (nodeData.name !== type) return;
                if (!config.nativeOrder || config.nativeOrder.length === 0) {
                    // Only inputs that become widgets. Custom widget types not
                    // listed here: declare an explicit nativeOrder in the config.
                    const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
                    const isWidget = (spec) => {
                        if (!Array.isArray(spec)) return false;
                        if (spec[1]?.forceInput) return false;
                        return Array.isArray(spec[0]) || WIDGET_TYPES.has(spec[0]);
                    };
                    const pick = (group) => Object.entries(group ?? {})
                        .filter(([, spec]) => isWidget(spec)).map(([k]) => k);
                    const extracted = [
                        ...pick(nodeData?.input?.required),
                        ...pick(nodeData?.input?.optional),
                    ];
                    if (extracted.length > 0) config.nativeOrder = extracted;
                }
                self._wrapHooks(nodeType, config);
            },

            loadedGraphNode: (node) => {
                if (node?.type !== type) return;
                NodeState.set(node, "removed", false);
                self._onLoaded(node, config);
            },

            afterConfigureGraph: () => {
                setTimeout(() => self.heal.healAll(type, false), 0);
                self._scheduleStrictHeal(type);
            },
        });

        log.log(`lifecycle installato per '${type}'`);
    }

    _scheduleStrictHeal(type) {
        if (!this._strictHealPending) this._strictHealPending = new Set();
        if (this._strictHealPending.has(type)) return;
        this._strictHealPending.add(type);

        const self = this;
        const startedAt = Date.now();
        const DEADLINE = 5000;

        const finish = () => {
            self._strictHealPending.delete(type);
            try { self.heal.healAll(type, true); } catch (_) {}
        };

        const allReadyOrRemoved = () => {
            let any = false;
            for (const node of self.registry.iterate(type)) {
                any = true;
                if (NodeState.get(node, "removed", false)) continue;
                if (!NodeState.get(node, "ready", false)) return false;
            }
            return any;
        };

        const tick = () => {
            if (Date.now() - startedAt > DEADLINE) { finish(); return; }
            if (allReadyOrRemoved()) { finish(); return; }
            self.perf.onIdle(tick, { timeout: 500 });
        };

        self.perf.onIdle(tick, { timeout: 500 });
    }

    _persistNames(node, config) {
        const st = NodeState.all(node);
        if (st?.persistNatives?.length) return st.persistNatives;
        return config.persistNatives?.length
            ? config.persistNatives
            : config.nativeOrder;
    }

    _wrapHooks(nodeType, config) {
        if (nodeType.prototype[VERSION_TAG]) return;
        const type = config.type;
        const self = this;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            try {
                NodeState.ensure(this);
                NodeState.set(this, "removed", false);
                config.onNodeCreated(this, config);
            } catch (e) {
                console.error(`[SurvivalKit/${type}] onNodeCreated error:`, e);
            }
            let ret;
            if (origOnNodeCreated) {
                try { ret = origOnNodeCreated.apply(this, arguments); } catch (_) {}
            }
            // defaultSize used to be dead weight: LiteGraph always has its own computeSize, so the newborn came out
            // only as wide as its widgets. Now a fresh node gets at least the declared width; a loaded or pasted one
            // gets its saved size right after, from configure(). She starts with room to breathe.
            try {
                const dw = Number(config.defaultSize?.[0]) || 0, dh = Number(config.defaultSize?.[1]) || 0;
                // height too (D-106): a free-height node (Crop) is born at its declared size; derived nodes snap back to theirs anyway
                if (this.size && ((dw && this.size[0] < dw) || (dh && this.size[1] < dh))) this.setSize?.([Math.max(this.size[0], dw), Math.max(this.size[1], dh)]);
            } catch (_) {}
            return ret;
        };

        const origOnAdded = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function () {
            try {
                NodeState.set(this, "removed", false);
                self.registry.add(this, type);
                if (self.registry.size(type) === 1) self.dom.installGlobalWheelGuard();
            } catch (e) {
                console.error(`[SurvivalKit/${type}] onAdded error:`, e);
            }
            if (origOnAdded) {
                try { origOnAdded.apply(this, arguments); } catch (_) {}
            }
            const nodeId = this.id;
            const ownerGraph = this.graph || null;
            queueMicrotask(() => {
                const live = self.registry.liveNode(nodeId, ownerGraph);
                if (!live || NodeState.get(live, "removed", false)) return;
                self.heal.scheduleSetup(live, config);
            });
        };

        const origConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            try {
                NodeState.set(this, "removed", false);
                this.properties = this.properties || {};
                if (info?.properties && typeof info.properties === "object") {
                    // succy_state/succy_natives can arrive from the workflow
                    // file either as an object (old format) or as a
                    // JSON string (new format). parseObject normalizes,
                    // then we ALWAYS write it back as a string so Vue doesn't
                    // wrap the value in a reactive Proxy. Hands off, Vue.
                    const ssObj = parseObject(info.properties.succy_state, null);
                    if (ssObj) this.properties.succy_state = JSON.stringify(ssObj);
                    const snObj = parseObject(info.properties.succy_natives, null);
                    if (snObj) this.properties.succy_natives = JSON.stringify(snObj);
                }

                const names = self._persistNames(this, config);

                // 1. widgets_values_named
                if (info?.widgets_values_named && typeof info.widgets_values_named === "object") {
                    for (const [name, val] of Object.entries(info.widgets_values_named)) {
                        const w = this._succyFindWidget(name);
                        if (w && val !== null && val !== undefined) w.value = val;
                    }
                } else if (Array.isArray(info?.widgets_values)) {
                    // 2. positional
                    const vals = info.widgets_values;
                    const n = Math.min(vals.length, names.length);
                    for (let i = 0; i < n; i++) {
                        const w = this._succyFindWidget(names[i]);
                        if (w && vals[i] !== null && vals[i] !== undefined) w.value = vals[i];
                    }
                }

                // 3. fallback succy_natives
                restoreNatives(this, names);

                // 4. fallback legacy succy_values
                const legacy = this.properties?.succy_values;
                if (legacy && typeof legacy === "object") {
                    for (const name of names) {
                        const w = this._succyFindWidget(name);
                        if (!w) continue;
                        if (w.value === undefined || w.value === null || w.value === "") {
                            if (legacy[name] !== undefined) w.value = legacy[name];
                        }
                    }
                }

                this.widgets_values = names.map((name) => {
                    const w = this._succyFindWidget(name);
                    return w ? w.value : undefined;
                });
            } catch (e) {
                console.error(`[SurvivalKit/${type}] configure error:`, e);
            }
            let ret;
            if (origConfigure) {
                try { ret = origConfigure.apply(this, arguments); } catch (e) {
                    console.warn(`[SurvivalKit/${type}] original configure failed:`, e);
                }
            }
            // Post-pass: LGraphNode.configure copies info.properties as-is
            // (legacy plain objects) and applies widgets_values by index.
            try {
                const ss = parseObject(this.properties?.succy_state, null);
                if (ss) this.properties.succy_state = JSON.stringify(ss);
                const sn = parseObject(this.properties?.succy_natives, null);
                if (sn) this.properties.succy_natives = JSON.stringify(sn);
                const named = info?.widgets_values_named;
                if (named && typeof named === "object") {
                    for (const [name, val] of Object.entries(named)) {
                        const w = this._succyFindWidget(name);
                        if (w && val !== null && val !== undefined) w.value = val;
                    }
                }
            } catch (e) {
                console.warn(`[SurvivalKit/${type}] configure post-pass error:`, e);
            }
            return ret;
        };

        const origSerialize = nodeType.prototype.serialize;
        nodeType.prototype.serialize = function () {
            let o = {};
            try { o = origSerialize ? origSerialize.apply(this, arguments) : {}; } catch (_) {}
            try {
                const names = self._persistNames(this, config);
                const values = readNatives(this, names);
                const legacy = this.properties?.succy_values;
                if (legacy && typeof legacy === "object") {
                    for (const name of names) {
                        if (values[name] === undefined && legacy[name] !== undefined) values[name] = legacy[name];
                    }
                }
                const positional = names.map((n) => values[n]);
                o.widgets_values = positional;
                this.widgets_values = positional;
            } catch (e) {
                console.warn(`[SurvivalKit/${type}] serialize error:`, e);
            }
            return o;
        };

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            if (origOnSerialize) {
                try { origOnSerialize.apply(this, arguments); } catch (_) {}
            }
            try {
                const names = self._persistNames(this, config);
                const values = readNatives(this, names);
                this.properties = this.properties || {};
                try { self.state.sync(this); } catch (_) {}
                persistNatives(this, names, values);
                if (o) {
                    o.properties = { ...(o.properties || {}), ...this.properties };
                    o.widgets_values_named = values;
                }
            } catch (e) {
                console.warn(`[SurvivalKit/${type}] onSerialize error:`, e);
            }
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try {
                NodeState.set(this, "removed", true);

                self.heal.releaseResources(this);

                const ctx = NodeState.get(this, "ctx", null);
                if (ctx) {
                    try { config.onCleanup(ctx, config); } catch (e) {
                        console.warn(`[SurvivalKit/${type}] onCleanup error:`, e);
                    }
                }

                self.registry.remove(this);
                self.perf.flushAll();
                self.state.release(this);
                if (self.cache) self.cache.scheduleCleanup(this, 5000);
                self.heal.destroy(this);
                self.services.destroy(this);
            } catch (e) {
                console.error(`[SurvivalKit/${type}] onRemoved error:`, e);
            }
            if (origOnRemoved) {
                try { origOnRemoved.apply(this, arguments); } catch (_) {}
            }
        };

		const origOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (size) {
			if (origOnResize) {
				try { origOnResize.apply(this, arguments); } catch (_) {}
			}
			if (NodeState.get(this, "internalResize", false)) return;
			if (!size || !size[0]) return;

			// Minimum width, always. Size matters.
			const w = Math.max(size[0], config.minWidth);
			if (w !== size[0]) size[0] = w;

			// Height that follows computeSize (formerly an instance wrapper in Succy_X).
			// Now it lives on the prototype: no instance-side wrapper, no
			// fragility if LiteGraph resets onResize during configure().
			if (config.heightFollowsComputeSize) {
				try {
					const target = this.computeSize?.([size[0], 0]);
					if (target && target[1] > 0) size[1] = target[1];
				} catch (_) {}
			}

			if (!NodeState.get(this, "ready", false)) return;
			const ctx = NodeState.get(this, "ctx", null);
			if (!ctx) return;
			try { config.onResize(ctx, size, config); } catch (e) {
				console.warn(`[SurvivalKit/${type}] onResize error:`, e);
			}
		};

        const origOnDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function () {
            try { this._succyEnforceCollapse?.(); } catch (_) {}
            if (origOnDrawForeground) {
                try { return origOnDrawForeground.apply(this, arguments); } catch (_) {}
            }
        };

        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (t, index, connected, link_info) {
            if (origOnConnectionsChange) {
                try { origOnConnectionsChange.apply(this, arguments); } catch (_) {}
            }
            const nodeId = this.id;
            const ownerGraph = this.graph || null;
            nextTick(() => {
                const live = self.registry.liveNode(nodeId, ownerGraph);
                if (!live || NodeState.get(live, "removed", false)) return;
                if (!NodeState.get(live, "ready", false)) return;
                const ctx = NodeState.get(live, "ctx", null);
                if (!ctx) return;
                try { config.onConnect(ctx, t, index, config); } catch (e) {
                    console.warn(`[SurvivalKit/${type}] onConnect error:`, e);
                }
            });
        };

        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            if (origOnExecuted) {
                try { origOnExecuted.apply(this, arguments); } catch (_) {}
            }
            if (!NodeState.get(this, "ready", false)) return;
            const ctx = NodeState.get(this, "ctx", null);
            if (!ctx) return;

            try { config.onExecute(ctx, message, config); } catch (e) {
                console.warn(`[SurvivalKit/${type}] onExecute error:`, e);
            }

            try {
                const cfg = NodeState.get(this, "config", null);
                const keys = Object.entries(cfg?.state || {})
                    .filter(([_, spec]) => spec.policy === "on-execute")
                    .map(([k]) => k);
                if (keys.length) self.state.flush(this);
            } catch (_) {}
        };

        const origOnDblClick = nodeType.prototype.onDblClick;
        nodeType.prototype.onDblClick = function (e, pos, canvas) {
            if (origOnDblClick) {
                try { origOnDblClick.apply(this, arguments); } catch (_) {}
            }
            const ctx = NodeState.get(this, "ctx", null);
            if (!ctx) return;
            try { self.state.flush(this); } catch (_) {}
            try { config.onDblClick?.(ctx, e, pos, canvas); } catch (_) {}
        };

        const origComputeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (out) {
            let size = origComputeSize ? origComputeSize.apply(this, arguments) : [...config.defaultSize];
            if (!size) size = [...config.defaultSize];
            size[0] = Math.max(size[0] || 0, config.minWidth);
            return size;
        };

        nodeType.prototype._succyFindWidget = function (name) {
            return this.widgets?.find((w) => w.name === name) ?? null;
        };

        nodeType.prototype._succyEnforceCollapse = function () {
            const collapsed = !!this.flags?.collapsed;
            const st = NodeState.all(this);
            if (!st) return;
            for (const w of st.kitDom) {
                const el = w?.element;
                if (!el) continue;
                if (collapsed) {
                    if (el._succyCollapseHid) continue;
                    el._succyCollapseHid = true;
                    el._succyCollapsePrev = el.style.display;
                    el.style.display = "none";
                } else if (el._succyCollapseHid) {
                    el._succyCollapseHid = false;
                    el.style.display = el._succyCollapsePrev || "";
                }
            }
        };

        nodeType.prototype[VERSION_TAG] = true;
    }

    _onLoaded(node, config) {
        const keep = new Set(config.keepVisible || []);
        for (const w of node.widgets || []) {
            if (!w?.name) continue;
            if (w._succyKitDom) continue;
            if (keep.has(w.name)) continue;
            this.dom.hideNativeWidget(w);
        }

        const self = this;
        const nodeId = node.id;
        const ownerGraph = node.graph || null;
        queueMicrotask(() => {
            const live = self.registry.liveNode(nodeId, ownerGraph);
            if (!live || NodeState.get(live, "removed", false)) return;
            if (NodeState.get(live, "ready", false)) self.heal.heal(live, false, config);
            else self.heal.scheduleSetup(live, config);
        });
    }
}