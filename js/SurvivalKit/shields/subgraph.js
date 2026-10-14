// ============================================================
// SurvivalKit/shields/subgraph.js
// ------------------------------------------------------------
// ComfyUI runs structuredClone on node objects that contain DOM
// or functions. Shield that sanitizes on DataCloneError.
// v0.1.0 — 2026-10-09 · v0.2.0 — 2026-10-12: before/after hooks for graph data (D-54)
// ============================================================

import { cloneSafe } from "../../lib/clone.js";
import { proxyWrap } from "./proxy.js";
import { logger } from "../core/log.js";

const log = logger("shield");

export class SubgraphShield {
    constructor() {
        this._installed = false;
        this._patchDepth = 0;
        this.hooks = new Set();          // { before(name, graph, args) -> token, after(name, graph, args, result, token) }
    }

    // other kit modules (graph-store.js) hook into convert/unpack so their data survives the ride
    addHook(h) { if (h) this.hooks.add(h); return () => this.hooks.delete(h); }

    install() {
        if (this._installed) return;
        this._installed = true;

        const self = this;
        const tryInstall = () => {
            const proto = (globalThis.LGraph ?? globalThis.LiteGraph?.LGraph)?.prototype;
            if (!proto) return false;

            const methods = ["convertToSubgraph", "unpackSubgraph"];
            let done = 0;
            for (const name of methods) {
                const orig = proto[name];
                if (typeof orig !== "function") continue;
                if (orig.__succyShielded) { done++; continue; }
                const wrapped = proxyWrap(orig, {
                    apply(target, thisArg, args) {
                        return self._runGuarded(target, thisArg, args, name);
                    },
                });
                wrapped.__succyShielded = true;
                proto[name] = wrapped;
                done++;
                log.log(`SubgraphShield: patch '${name}'`);
            }
            return done === methods.length;
        };

        if (tryInstall()) {
            log.log("SubgraphShield installato");
            return;
        }

        let tries = 0;
        const timer = setInterval(() => {
            if (tryInstall() || ++tries > 50) {
                clearInterval(timer);
                if (tries > 50) console.warn("[SurvivalKit] SubgraphShield: LGraph never showed up");
            }
        }, 200);
    }

    _runGuarded(fn, thisArg, args, name) {
        const self = this;
        const tokens = [];
        if (this._patchDepth === 0) for (const h of this.hooks) { try { tokens.push([h, h.before?.(name, thisArg, args)]); } catch (e) { console.warn("[SurvivalKit] SubgraphShield hook before:", e); } }
        const origClone = globalThis.structuredClone;
        this._patchDepth++;

        if (this._patchDepth === 1) {
            globalThis.structuredClone = function (value, options) {
                try {
                    return origClone.call(globalThis, value, options);
                } catch (_) {
                    try {
                        const clean = cloneSafe(value);
                        return origClone.call(globalThis, clean, options);
                    } catch (e2) {
                        console.warn("[SurvivalKit] SubgraphShield: sanitize failed:", e2);
                        return null;
                    }
                }
            };
        }

        let res, ok = false;
        try {
            res = fn.apply(thisArg, args);
            ok = true;
            return res;
        } finally {
            this._patchDepth--;
            if (this._patchDepth === 0) {
                globalThis.structuredClone = origClone;
            }
            if (ok) for (const [h, t] of tokens) { try { h.after?.(name, thisArg, args, res, t); } catch (e) { console.warn("[SurvivalKit] SubgraphShield hook after:", e); } }
        }
    }
}