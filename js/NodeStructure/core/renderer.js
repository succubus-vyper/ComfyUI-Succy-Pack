// ============================================================
// NodeStructure/core/renderer.js
// ------------------------------------------------------------
// Builds the DOM from a normalized tree node.
// For each node: classes, style, attributes, visibility, binding,
// events, children, `each`. The renderer doesn't know what the
// values mean: it reads/writes refs and fires actions.
//
// Everything it creates (listeners, observers, timers) goes into the tree's
// bag: tree.dispose() releases it. No hidden state, no secrets:
// a tree can be rebuilt from (rt, node) whenever needed.
// ============================================================

import { getComponent, mkEl } from "../components/index.js";
import { evalValue, readRef, writeRef, runAction } from "./binding.js";
import { parseRef } from "./parser.js";
import { Bag } from "../util/tracker.js";
import { stable } from "../util/json.js";

const SIG_CAP = 60000;

export class Tree {
    constructor(rt, label) {
        this.rt = rt;
        this.bag = new Bag("tree:" + label);
        this.els = new Map();      // id -> Element
        this.effects = [];
        this.root = null;
        this.disposed = false;
    }

    update() {
        if (this.disposed) return;
        for (const fn of this.effects.slice()) {
            try { fn(); } catch (e) { this.rt.warnOnce("effect:" + this.root?.className, e); }
        }
    }

    el(id) { return this.els.get(id) || null; }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.effects.length = 0;
        this.bag.dispose();
        this.els.clear();
        try { this.root?.remove(); } catch (_) {}
        this.root = null;
    }
}

export function renderTree(rt, node, label = "tree") {
    const tree = new Tree(rt, label);
    const R = { tree, bag: tree.bag, effects: tree.effects, inEach: false };
    tree.root = renderNode(rt, R, node, null);
    return tree;
}

function splitClass(s) { return String(s || "").split(/\s+/).filter(Boolean); }

function sameVal(a, b) {
    if (a === b) return true;
    if (typeof a === "object" && typeof b === "object" && a && b) { try { return stable(a) === stable(b); } catch (_) { return false; } }
    return false;
}

function renderNode(rt, R, node, item) {
    const factory = getComponent(node.t);
    if (!factory) {
        const miss = mkEl("div", "ns-missing");
        miss.textContent = `[component '${node.t}' missing]`;
        return miss;
    }
    const h = {
        rt, bag: R.bag, item,
        val: (v) => evalValue(rt, v, item),
        listen: (el, ev, fn, opts) => R.bag.listen(el, ev, fn, opts),
        tree: R.tree,
        // composition: a piece builds its insides out of other pieces (card.uses); the tree is synthesized by the kit
        render: (n, it = item) => renderNode(rt, R, n, it),
    };
    let comp;
    try { comp = factory(node, h); }
    catch (e) {
        console.warn(`[NodeStructure] component '${node.t}' failed (${rt.def.type}):`, e);
        const miss = mkEl("div", "ns-missing"); miss.textContent = `[errore in '${node.t}']`;
        return miss;
    }
    const el = comp.el;
    const container = comp.container || el;
    const effects = R.effects;

    // classes / id
    for (const c of splitClass(node.class)) el.classList.add(c);
    if (node.id && !R.inEach) { R.tree.els.set(node.id, el); el.dataset.nsId = node.id; }
    if (node.scrollable) { try { rt.ctx.utils.scrollable(el); } catch (_) {} }

    // static/dynamic attributes
    if (node.attrs) {
        for (const [k, v] of Object.entries(node.attrs)) {
            const dyn = typeof v === "string" && (v.startsWith("$") || v.includes("{{"));
            const put = () => { const x = evalValue(rt, v, item); if (x === undefined || x === null || x === false) el.removeAttribute(k); else el.setAttribute(k, x === true ? "" : String(x)); };
            put();
            if (dyn) effects.push(put);
        }
    }

    // title
    if (node.title !== undefined) {
        const put = () => { const t = evalValue(rt, node.title, item); if (el.title !== t) el.title = t ?? ""; };
        put(); if (typeof node.title === "string" && (node.title.startsWith("$") || node.title.includes("{{"))) effects.push(put);
    }

    // text
    if (node.text !== undefined && !comp.handlesText) {
        const dyn = typeof node.text === "string" && (node.text.startsWith("$") || node.text.includes("{{"));
        let last;
        const put = () => { const t = evalValue(rt, node.text, item); const s = t === undefined || t === null ? "" : String(t); if (s !== last) { last = s; el.textContent = s; } };
        put(); if (dyn) effects.push(put);
    }

    // style (literals once; dynamic ones on every update)
    if (node.style) {
        for (const [k, v] of Object.entries(node.style)) {
            const dyn = typeof v === "string" && (v.startsWith("$") || v.includes("{{"));
            const put = () => {
                const x = evalValue(rt, v, item);
                const s = x === undefined || x === null ? "" : (typeof x === "number" && !k.startsWith("--") && !/^(opacity|zIndex|flex|flexGrow|flexShrink|order|lineHeight|fontWeight)$/.test(k) ? x + "px" : String(x));
                if (k.startsWith("--")) { if (s) el.style.setProperty(k, s); else el.style.removeProperty(k); }
                else el.style[k] = s;
            };
            put(); if (dyn) effects.push(put);
        }
    }

    // classIf
    if (node.classIf) {
        for (const [cls, ref] of Object.entries(node.classIf)) {
            const r = parseRef(ref);
            const names = splitClass(cls);
            effects.push(() => { const on = !!readRef(rt, r, item); for (const n of names) el.classList.toggle(n, on); });
        }
    }

    // visible / disabled
    if (node.visible !== undefined && node.visible !== true) {
        const put = () => { const v = typeof node.visible === "boolean" ? node.visible : !!evalValue(rt, node.visible, item); const s = v ? "1" : "0"; if (el.getAttribute("data-ns-vis") !== s) el.setAttribute("data-ns-vis", s); };
        put(); if (typeof node.visible === "string") effects.push(put);
    }
    if (node.disabled !== undefined) {
        const put = () => { const d = typeof node.disabled === "boolean" ? node.disabled : !!evalValue(rt, node.disabled, item); if ("disabled" in el) el.disabled = d; el.classList.toggle("ns-disabled", d); };
        put(); if (typeof node.disabled === "string") effects.push(put);
    }

    // events -> actions
    if (node.on) {
        for (const [ev, ref] of Object.entries(node.on)) {
            R.bag.listen(el, ev, (e) => {
                runAction(rt, ref, e, el, item);
                rt.update();
            });
        }
    }

    // component update (dynamic props)
    if (typeof comp.update === "function") {
        effects.push(() => comp.update());
    }

    // two-way bind — it takes two
    if (node.bind && comp.value) {
        const ref = parseRef(node.bind);
        let last;
        let writing = false;
        const commit = (mode) => {
            if (writing) return;
            writing = true;
            try {
                const v = comp.value.get();
                last = v;
                writeRef(rt, ref, v);                       // `$item.*` ref: read-only (writeRef returns false)
                if (node.commit) runAction(rt, node.commit, { value: v, final: mode !== "live" }, el, item);
            } finally { writing = false; }
        };
        for (const ev of comp.value.events || []) R.bag.listen(comp.el, ev, commit);
        comp.value.onCommit?.(commit);
        effects.push(() => {
            const v = readRef(rt, ref, item);
            if (v === undefined) return;
            const act = el.getRootNode?.()?.activeElement;
            const focused = !!act && (act === comp.el || comp.el.contains(act));
            const textual = typeof v === "string" || typeof v === "number";
            if (focused && textual && String(comp.value.get() ?? "") !== String(v) && sameVal(last, comp.value.get())) {
                // the user is typing: don't overwrite until it's committed. Never interrupt a lady.
                return;
            }
            if (sameVal(v, last) && sameVal(comp.value.get(), v)) return;
            last = v;
            comp.value.set(v);
        });
    }

    // children / each
    if (node.each) {
        renderEach(rt, R, node, container, item);
    } else if (Array.isArray(node.children)) {
        for (const c of node.children) container.appendChild(renderNode(rt, R, c, item));
    }
    return el;
}

function renderEach(rt, R, node, container, parentItem) {
    // Item keys starting with "_" are VOLATILE: they don't go into the signature
    // (changing them does NOT rebuild the children: controls in use, e.g. a slider
    // being dragged, stay alive); the item is updated in place and re-read via `$item._x`.
    // PER-ELEMENT rebuild (D-60): if only one item changes only that one is redone; the others (e.g. an open
    // dropdown, a slider being dragged) stay alive. If the length changes everything is redone.
    const strip = (it) => {
        if (!it || typeof it !== "object" || Array.isArray(it)) return it;
        const o = {};
        for (const k of Object.keys(it)) if (k[0] !== "_") o[k] = it[k];
        return o;
    };
    const sigOf = (it) => { let x; try { x = stable(strip(it)); } catch (_) { x = String(Math.random()); } return x.length > SIG_CAP ? x.slice(0, SIG_CAP) : x; };
    let slots = [];          // [{ sig, item, bag, effects, el }]
    const drop = (sl) => { try { sl.bag.dispose(); } catch (_) {} };
    R.bag.add(() => { for (const sl of slots) drop(sl); slots = []; });
    const mk = (it, i) => ((it && typeof it === "object" && !Array.isArray(it)) ? { index: i, ...it } : { value: it, index: i });
    const build = (it, i) => {
        const bag = new Bag("each"), effects = [];
        const item = mk(it, i);
        const el = renderNode(rt, { tree: R.tree, bag, effects, inEach: true }, node.item, item);
        return { sig: sigOf(it), item, bag, effects, el };
    };

    const rebuild = () => {
        let list = typeof node.each === "function" ? node.each(parentItem) : evalValue(rt, node.each, parentItem);
        if (!Array.isArray(list)) list = [];
        if (list.length !== slots.length) {
            for (const sl of slots) drop(sl);
            while (container.firstChild) container.removeChild(container.firstChild);
            slots = list.map(build);
            for (const sl of slots) container.appendChild(sl.el);
        } else {
            list.forEach((it, i) => {
                const old = slots[i], sg = sigOf(it);
                if (sg !== old.sig) {
                    const nw = build(it, i);
                    try { container.replaceChild(nw.el, old.el); } catch (_) { container.appendChild(nw.el); }
                    drop(old);
                    slots[i] = nw;
                } else if (it && typeof it === "object") Object.assign(old.item, mk(it, i));
            });
        }
        for (const sl of slots) for (const fn of sl.effects.slice()) { try { fn(); } catch (e) { rt.warnOnce("each-effect", e); } }
    };
    R.effects.push(rebuild);
}
