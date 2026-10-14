// ============================================================
// NodeStructure/core/binding.js
// ------------------------------------------------------------
// Resolves the spec's references against a runtime `rt`:
//   $native.k  native widget (ctx.utils.getNative / setNative)
//   $state.k   the kit's persistent state (ctx.state)
//   $cache.k   in-memory cache (survives Ctrl+Z)
//   $local.k   localStorage (survives reload)
//   $live.fn   injected function: fn(api, item) -> value
//   $actions.fn injected function: fn(api, event, el, item)
//   $item.path current element of an `each`
// The builder doesn't know what the values mean: it just reads and writes them. No questions asked.
// ============================================================

import { parseRef, parseTemplate, hasTemplate } from "./parser.js";
import { impl } from "../catalog/registry.js";

const WARNED = new Set();
function warnOnce(key, ...args) {
    if (WARNED.has(key)) return;
    WARNED.add(key);
    console.warn("[NodeStructure]", ...args);
}

function dig(obj, path) {
    let cur = obj;
    for (const seg of String(path).split(".")) {
        if (cur == null) return undefined;
        cur = cur[seg];
    }
    return cur;
}

export function readRef(rt, ref, item) {
    if (!ref) return undefined;
    const { ctx, def } = rt;
    try {
        switch (ref.kind) {
            case "native": return ctx.utils.getNative(ref.key)?.value;
            case "state":  return ctx.state.get(ref.key);
            case "cache":  return ctx.cache.get(ref.key);
            case "local":  return ctx.local.get(ref.key);
            case "item":   return dig(item, ref.key);
            case "live": {
                // KIT FIRST: a catalog io piece; then the node's local recipe. `$live.a.b` = field b of a's value.
                const [head, ...rest] = ref.key.split(".");
                const fn = impl(head, "io") || def.live?.[head];
                if (typeof fn !== "function") { warnOnce(def.type + ":live:" + head, `$live.${head} not defined (${def.type})`); return undefined; }
                const v = fn(rt.api, item);
                return rest.length ? dig(v, rest.join(".")) : v;
            }
            default: return undefined;
        }
    } catch (e) {
        warnOnce(def.type + ":read:" + ref.raw, `reading ${ref.raw} failed (${def.type}):`, e);
        return undefined;
    }
}

// Value of a prop: literal, ref, or "{{$ref}}" template.
export function evalValue(rt, v, item) {
    if (typeof v !== "string") return v;
    if (v.startsWith("\\$")) return v.slice(1);
    if (v.startsWith("$")) {
        const r = parseRef(v);
        return r ? readRef(rt, r, item) : v;
    }
    if (hasTemplate(v)) {
        let out = "";
        for (const p of parseTemplate(v)) {
            if (p.lit !== undefined) out += p.lit;
            else {
                const x = readRef(rt, p.ref, item);
                out += x === undefined || x === null ? "" : String(x);
            }
        }
        return out;
    }
    return v;
}

export function writeRef(rt, ref, value) {
    if (!ref) return false;
    const { ctx, api } = rt;
    try {
        switch (ref.kind) {
            case "native": return api.native.set(ref.key, value);
            case "state":  api.state.set(ref.key, value); return true;
            case "cache":  ctx.cache.set(ref.key, value); rt.update(); return true;
            case "local":  ctx.local.set(ref.key, value); rt.update(); return true;
            default: return false;      // item / live: read-only (use `commit`) — look but don't touch
        }
    } catch (e) {
        warnOnce(rt.def.type + ":write:" + ref.raw, `writing ${ref.raw} failed:`, e);
        return false;
    }
}

// Action: KIT FIRST (catalog `action` piece), then the local recipe. A name clash is an error at define().
export function actionFn(rt, refStr) {
    const r = parseRef(refStr);
    if (!r || r.kind !== "actions") return null;
    const fn = impl(r.key, "action") || rt.def.actions?.[r.key];
    if (typeof fn !== "function") { warnOnce(rt.def.type + ":act:" + r.key, `$actions.${r.key} not defined (${rt.def.type})`); return null; }
    return fn;
}

// deep value: strings -> evalValue (ref/template); literal arrays/objects -> copy; does NOT go inside ref results
export function evalDeep(rt, v, item, depth = 0) {
    if (depth > 8) return undefined;
    if (typeof v === "string") return evalValue(rt, v, item);
    if (Array.isArray(v)) return v.map((x) => evalDeep(rt, x, item, depth + 1));
    if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = evalDeep(rt, v[k], item, depth + 1); return o; }
    return v;
}

// handler: "$actions.x" or { do:"$actions.x", args:{...} }
export function handlerParts(h) {
    if (typeof h === "string") return { ref: h, args: undefined };
    if (h && typeof h === "object") return { ref: h.do, args: h.args };
    return { ref: undefined, args: undefined };
}

export function runAction(rt, handler, ev, el, item) {
    // function: only for trees SYNTHESIZED by the kit (never from a spec: the parser refuses anything that isn't JSON)
    if (typeof handler === "function") {
        if (rt.destroyed) return undefined;
        try { return handler(rt.api, ev, el, item); } catch (e) { console.warn(`[NodeStructure] internal handler (${rt.def.type}) failed:`, e); return undefined; }
    }
    const { ref, args } = handlerParts(handler);
    const fn = actionFn(rt, ref);
    if (!fn || rt.destroyed) return undefined;
    try { return fn(rt.api, ev, el, item, args === undefined ? undefined : evalDeep(rt, args, item)); }
    catch (e) { console.warn(`[NodeStructure] action ${ref} (${rt.def.type}) failed:`, e); return undefined; }
}
