// ============================================================
// lib/events.js
// ------------------------------------------------------------
// Timing helpers and one-shot listeners. Pure.
// v0.1.0 — 2026-10-09
// ============================================================

export function once(target, type, handler, opts) {
    if (!target) return;
    const wrapper = (e) => {
        target.removeEventListener(type, wrapper, opts);
        handler(e);
    };
    target.addEventListener(type, wrapper, opts);
}

export function captureOnce(target, type, handler) {
    once(target, type, handler, { capture: true });
}

export function delegate(root, selector, type, handler) {
    if (!root) return () => {};
    const listener = (e) => {
        const t = e.target?.closest?.(selector);
        if (t && root.contains(t)) handler(e, t);
    };
    root.addEventListener(type, listener);
    return () => root.removeEventListener(type, listener);
}

export function debounce(fn, ms = 200) {
    let t = null;
    let lastArgs = null;
    const wrapped = (...args) => {
        lastArgs = args;
        if (t) clearTimeout(t);
        t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
    wrapped.cancel = () => { if (t) { clearTimeout(t); t = null; } };
    // flush(): fires the pending call right away with the last args (if any). No more teasing.
    // flush(...args): fires with explicit args.
    wrapped.flush = (...args) => {
        const pending = t !== null;
        if (t) { clearTimeout(t); t = null; }
        if (args.length) fn(...args);
        else if (pending && lastArgs) fn(...lastArgs);
    };
    return wrapped;
}

export function throttle(fn, ms = 100) {
    let last = 0;
    let pending = null;
    let pendingArgs = null;
    const wrapped = (...args) => {
        const now = performance.now();
        if (now - last >= ms) {
            last = now;
            fn(...args);
        } else {
            pendingArgs = args;
            if (!pending) {
                pending = setTimeout(() => {
                    pending = null;
                    last = performance.now();
                    fn(...pendingArgs);
                }, ms - (now - last));
            }
        }
    };
    wrapped.cancel = () => {
        if (pending) { clearTimeout(pending); pending = null; }
        pendingArgs = null;
    };
    return wrapped;
}