// ============================================================
// NodeStructure/core/heights.js
// ------------------------------------------------------------
// KIT LESSON: node.size[1] does NOT follow the real height of the DOM
// widgets (196 with an editor of 283 or 60). So the builder DECLARES to
// LiteGraph the height of every region (computeSize, computeLayoutSize,
// options.getMin/MaxHeight) and computes the node's height from those
// declarations, not from the DOM. Never trust what they show, trust what they declare.
//
// region.height:
//   25                              fixed
//   {value:25}                      fixed
//   {bind:"$state.k", default, min, max, triple, flex}
//                                   from state (triple: cache > local > state, like Succy_X)
//   {live:"$live.fn", min, max}     from a function
//   {auto:true, min, max}           measured from the content (ResizeObserver)
//   plus:N, active:"$ref"           FIXED part (px) added to bind; if `active` is false only plus remains
//   flex:true                       the widget may grow beyond the declared value
// ============================================================

import { parseRef } from "./parser.js";
import { evalValue } from "./binding.js";

export const HIDDEN_H = -4; // same trick as ctx.utils.hideNative: cancels LiteGraph's +4

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function readPersisted(rt, ref, triple) {
    const { ctx } = rt;
    if (!ref) return undefined;
    if (triple && (ref.kind === "state" || ref.kind === "cache" || ref.kind === "local")) {
        const c = ctx.cache.get(ref.key);
        if (typeof c === "number") return c;
        const l = ctx.local.get(ref.key);
        if (typeof l === "number") return l;
        const s = ctx.state.get(ref.key);
        return s;
    }
    if (ref.kind === "state") return ctx.state.get(ref.key);
    if (ref.kind === "cache") return ctx.cache.get(ref.key);
    if (ref.kind === "local") return ctx.local.get(ref.key);
    if (ref.kind === "native") return ctx.utils.getNative(ref.key)?.value;
    return undefined;
}

export function writePersisted(rt, ref, value, triple) {
    const { ctx } = rt;
    if (!ref) return;
    if (ref.kind === "state") {
        ctx.state.set(ref.key, value);
        if (triple) { ctx.cache.set(ref.key, value); ctx.local.set(ref.key, value); }
    } else if (ref.kind === "cache") ctx.cache.set(ref.key, value);
    else if (ref.kind === "local") ctx.local.set(ref.key, value);
}

// Volatile per-region state (WeakMap-free: it lives in the runtime, not on the node).
export function regionState(rt, id) {
    let s = rt.rstate.get(id);
    if (!s) { s = { hiddenBy: new Set(), autoH: null, dragH: null }; rt.rstate.set(id, s); }
    return s;
}

export function isRegionHidden(rt, region) {
    const st = regionState(rt, region.id);
    if (st.hiddenBy.size) return true;
    if (region.visible === undefined || region.visible === true) return false;
    if (region.visible === false) return true;
    return !evalValue(rt, region.visible);
}

// Declared height of the region, right now.
export function regionHeight(rt, region) {
    const hidden = isRegionHidden(rt, region);
    const h = region.height;
    const st = regionState(rt, region.id);
    let min = 0, max = Infinity, flex = false, value, plus = 0;

    if (h === undefined) { value = 60; min = 0; }
    else if (typeof h === "number") { value = h; min = h; max = h; }
    else {
        min = Number.isFinite(h.min) ? h.min : 0;
        max = Number.isFinite(h.max) ? h.max : Infinity;
        flex = !!h.flex;
        if (st.dragH != null) value = st.dragH;
        else if (h.auto) value = st.autoH ?? h.default ?? Math.max(min, 40);
        else if (h.live) value = Number(evalValue(rt, h.live));
        else if (h.bind) {
            const v = readPersisted(rt, parseRef(h.bind), !!h.triple);
            value = (typeof v === "number" && v > 0) ? v : (h.default ?? min);
        } else value = h.value ?? h.default ?? min;
        if (!Number.isFinite(value)) value = h.default ?? min;
        value = clamp(value, min, max);
        // plus: FIXED part (px) added to the variable part (bind/min/max). `active` false = only the fixed part.
        if (Number.isFinite(h.plus) && h.plus > 0) {
            if (h.active !== undefined && !evalValue(rt, h.active)) { value = h.plus; min = h.plus; max = h.plus; plus = h.plus; }
            else { value += h.plus; min += h.plus; max += h.plus; plus = h.plus; }
        }
    }
    return { hidden, value: hidden ? 0 : value, min: hidden ? 0 : min, max, flex, auto: !!(h && h.auto), plus };
}

// Declares the heights to the LiteGraph/ComfyUI widget. Recomputed on every LiteGraph
// call (they read the current state): no cache to invalidate.
export function declareHeights(rt, widget, region) {
    if (!widget) return;
    const get = () => regionHeight(rt, region);
    widget.computeSize = (width) => { const g = get(); return [width ?? 0, g.hidden ? HIDDEN_H : g.value]; };
    widget.computeLayoutSize = () => {
        const g = get();
        if (g.hidden) return { minHeight: 0, maxHeight: 0, minWidth: 0 };
        return g.flex
            ? { minHeight: g.min || g.value, minWidth: 0 }
            : { minHeight: g.value, maxHeight: g.value, minWidth: 0 };
    };
    widget.options = {
        ...(widget.options || {}),
        getMinHeight: () => { const g = get(); return g.hidden ? 0 : (g.flex ? (g.min || g.value) : g.value); },
        getMaxHeight: () => { const g = get(); return g.hidden ? 0 : (g.flex ? undefined : g.value); },
        getHeight: () => get().value,
    };
}
