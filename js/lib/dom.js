// ============================================================
// lib/dom.js
// ------------------------------------------------------------
// Minimal DOM helpers. Pure, no framework.
// v0.1.0 — 2026-10-09
// ============================================================

export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === "class" || k === "className") node.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else if (k === "dataset" && typeof v === "object") Object.assign(node.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") {
            node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) node.setAttribute(k, "");
        else if (v === false || v == null) continue;
        else node.setAttribute(k, v);
    }
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
        if (c == null || c === false) continue;
        node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
}

export function qs(sel, root = document) {
    return root.querySelector(sel);
}

export function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
}

export function on(target, type, handler, opts) {
    if (!target) return () => {};
    target.addEventListener(type, handler, opts);
    return () => target.removeEventListener(type, handler, opts);
}

export function off(target, type, handler, opts) {
    target?.removeEventListener(type, handler, opts);
}

export function clear(node) {
    while (node?.firstChild) node.removeChild(node.firstChild);
}

export function frag(children = []) {
    const f = document.createDocumentFragment();
    for (const c of children) if (c != null) f.append(c);
    return f;
}

export function isConnected(node) {
    return !!(node && node.isConnected);
}