// ============================================================
// SurvivalKit/shields/proxy.js
// ------------------------------------------------------------
// Non-destructive wrapping of global functions. We wrap, we never tear.
//   app.graphToPrompt = proxyWrap(app.graphToPrompt, { apply })
// The Proxy survives later patches from other extensions
// (rgthree, BCNodes, etc.): the caller never loses the chain.
// v0.1.0 — 2026-10-09
// ============================================================

export function proxyWrap(original, { apply, construct, get, set } = {}) {
    if (typeof original !== "function") return original;
    const handlers = {};
    if (typeof apply === "function") handlers.apply = apply;
    if (typeof construct === "function") handlers.construct = construct;
    if (typeof get === "function") handlers.get = get;
    if (typeof set === "function") handlers.set = set;
    return new Proxy(original, handlers);
}

// Applies a proxy to an object's property (e.g. app.graphToPrompt).
// Returns the installed proxy, or the original if there was nothing there.
export function patch(target, prop, { apply, construct } = {}) {
    if (!target) return null;
    const orig = target[prop];
    if (typeof orig !== "function") return null;
    const wrapped = proxyWrap(orig, { apply, construct });
    target[prop] = wrapped;
    return wrapped;
}

// Chains a handler.apply BEFORE calling the original. We go first.
// Typical usage:
//   chainApply(app, "queuePrompt", (target, thisArg, args) => {
//       console.log("queuePrompt args", args);
//   });
export function chainApply(target, prop, beforeApply) {
    return patch(target, prop, {
        apply(original, thisArg, args) {
            try { beforeApply?.(target, thisArg, args); } catch (e) {
                console.warn(`[SurvivalKit/proxy] chainApply '${prop}' error:`, e);
            }
            return original.apply(thisArg, args);
        },
    });
}