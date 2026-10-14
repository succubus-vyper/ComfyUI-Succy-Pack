// ============================================================
// NodeStructure/behaviors/builtin.js
// collapse_box | resize_element | resize_mask | open_float | gate_mask |
// follow_mask | persist_element
// ============================================================

import { piece } from "../catalog/registry.js";
import { C, exb, E, N, S, K, ID, J, R } from "../catalog/kit.js";
import { parseRef } from "../core/parser.js";
import { evalValue } from "../core/binding.js";
import { regionHeight, readPersisted, writePersisted, regionState } from "../core/heights.js";
import { AnimGate } from "../runtime/anim-gate.js";

const stateRef = (key) => ({ kind: "state", key, raw: "$state." + key });

// ---- collapse -------------------------------------------------
// { type:"collapse", state, trigger:elId, hide:[elId|"region:id"], target?:elId, rootClass? }
piece(C("collapse_box", {
    scopo: "Piega/apre una box: nasconde elementi o regioni e commuta una classe, stato persistito.", natura: "funziona", estado: "stable",
    tag: ["comportamento", "piega"], alias: ["collapse"],
    props: {
        state: { ...K("chiave di stato bool"), required: true }, trigger: { ...ID("elemento che al click piega/apre"), required: true },
        hide: J("lista di id elemento oppure 'region:<id>' da nascondere"), target: ID("elemento che riceve la classe"), rootClass: S("classe commutata", "ns-collapsed"),
        glyphs: J("[testoAperto, testoChiuso] scritto sul trigger"),
    },
    esempio: exb({ t: "stack_box", id: "b", children: [{ t: "button_element", id: "t", text: "x" }, { t: "label_element", id: "body", text: "corpo" }] },
        [{ type: "collapse_box", state: "col", trigger: "t", hide: ["body"], target: "b", glyphs: ["▼", "▶"] }], { state: { col: { policy: "ui", default: false } } }),
}), (rt, p) => {
    // D-89 — the "operative, not essential" rule, for EVERY node that folds: anything wearing the class `ns-op` goes away
    // while folded (EXT door switches, hints, debug toggles and panes...). Nodes just tag the element, nobody has to remember
    // it in a hide list. Folded = the essentials only, honey: the rest is for when she's undressed (Expanded). Succubus.
    let opFor = null;
    const sweepOps = (c) => {
        if (opFor === c) return;
        opFor = c;
        for (const r of rt.regions.values()) r.tree?.root?.querySelectorAll?.(".ns-op").forEach((e) => e.setAttribute("data-ns-col", c ? "1" : "0"));
    };
    rt.onRestore.add(() => { opFor = null; });
    const apply = () => {
        const c = rt.ctx.state.get(p.state) === true;
        sweepOps(c);
        if (Array.isArray(p.glyphs)) { const g = rt.el(p.trigger); const t = String((c ? p.glyphs[1] : p.glyphs[0]) ?? ""); if (g && g.textContent !== t) g.textContent = t; }
        for (const h of p.hide || []) {
            if (typeof h !== "string") continue;
            if (h.startsWith("region:")) rt.setRegionHidden(h.slice(7), "collapse", c);
            else rt.el(h)?.setAttribute("data-ns-col", c ? "1" : "0");
        }
        if (p.target) rt.el(p.target)?.classList.toggle(p.rootClass || "ns-collapsed", c);
    };
    rt.onUpdate.add(apply);
    const trg = rt.el(p.trigger);
    if (trg) rt.bag.listen(trg, "click", (e) => {
        e.stopPropagation();
        rt.api.state.set(p.state, !(rt.ctx.state.get(p.state) === true));
    });
});

// ---- resize-grip ----------------------------------------------
// { type:"resize-grip", container:elId, state, min, max, mode:"element"|"region",
//   target?:elId (mode element), region?:id (mode region), persist?:"triple"|"state" }
const RESIZE_PROPS = {
    container: { ...ID("elemento (box) che ospita la maniglia"), required: true }, state: { ...K("chiave di stato numerica (altezza)"), required: true },
    min: N("altezza minima", 40), max: N("altezza massima", 600), mode: E(["element", "region"], "cosa ridimensiona", "element"),
    target: ID("elemento ridimensionato (mode element)"), region: S("id regione ridimensionata (mode region)"), persist: E(["triple", "state"], "persistenza", "triple"),
};
const RESIZE_EX = { state: { h: { policy: "ui" } } };
const resizeGrip = (forced) => (rt, p0) => {
    const p = forced ? { ...p0, mode: p0.mode || forced } : p0;
    const container = rt.el(p.container);
    if (!container) { rt.warnOnce("grip:" + p.container, `resize-grip: container '${p.container}' not found`); return; }
    if (container.querySelector(":scope > .ns-grip")) return;
    const mode = p.mode === "region" ? "region" : "element";
    const triple = p.persist !== "state";
    const ref = stateRef(p.state);
    const min = Number.isFinite(p.min) ? p.min : 40;
    const max = Number.isFinite(p.max) ? p.max : 600;
    const target = mode === "element" ? rt.el(p.target || p.container) : null;
    const rst = mode === "region" ? regionState(rt, p.region) : null;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    const grip = document.createElement("div");
    grip.className = "ns-grip";
    grip.title = "Drag to resize";
    container.appendChild(grip);

    let active = false, startY = 0, startH = 0, lastH = 0;
    const clampH = (v) => Math.max(min, Math.min(max, v));
    const applyH = (h) => {
        if (target) target.style.height = h + "px";
        else if (rst) rst.dragH = h;
        rt.relayout();
    };
    rt.bag.listen(grip, "pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        active = true; startY = e.clientY;
        if (target) startH = target.offsetHeight;
        else { const g0 = regionHeight(rt, rt.region(p.region)); startH = g0.value - (g0.plus || 0); }
        lastH = startH;
        grip.classList.add("ns-active");
        try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    });
    rt.bag.listen(grip, "pointermove", (e) => {
        if (!active) return;
        e.preventDefault(); e.stopPropagation();
        lastH = clampH(startH + (e.clientY - startY));
        applyH(lastH);
    });
    const up = (e) => {
        if (!active) return;
        active = false;
        grip.classList.remove("ns-active");
        try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
        if (rst) rst.dragH = null;
        if (lastH !== startH) writePersisted(rt, ref, lastH, triple);
        rt.update();
    };
    rt.bag.listen(grip, "pointerup", up);
    rt.bag.listen(grip, "pointercancel", up);

    // applies the persisted value (priority cache > local > state)
    const restore = () => {
        if (active) return;
        const v = readPersisted(rt, ref, triple);
        if (typeof v === "number" && v > 0 && target) target.style.height = clampH(v) + "px";
    };
    rt.onUpdate.add(restore);
    rt.onRestore.add(restore);
    rt.onUndo.add(restore);
};
piece(C("resize_element", {
    scopo: "Maniglia di trascinamento che ridimensiona in altezza UN elemento; persiste in cache>local>state.", estado: "stable",
    tag: ["comportamento", "resize"], alias: ["resize-grip"], props: RESIZE_PROPS,
    esempio: exb({ t: "stack_box", id: "c", children: [{ t: "label_element", id: "e", text: "x" }] }, [{ type: "resize_element", container: "c", target: "e", state: "h" }], RESIZE_EX),
}), resizeGrip("element"));
piece(C("resize_mask", {
    scopo: "Maniglia che ridimensiona in altezza un'intera maschera (regione) del nodo.", estado: "stable",
    tag: ["comportamento", "resize"], props: RESIZE_PROPS,
    esempio: exb({ t: "stack_box", id: "c", children: [{ t: "label_element", text: "x" }] }, [{ type: "resize_mask", container: "c", region: "r", state: "h" }], RESIZE_EX),
}), resizeGrip("region"));

// ---- float-menu -----------------------------------------------
// { type:"float-menu", menu, on:"click"|"dblclick"|"contextmenu", trigger:elId|"node" }
piece(C("open_float", {
    scopo: "Apre un menu/pannello flottante (spec.menus) al click, doppio click o tasto destro di un elemento o del nodo.", estado: "stable",
    tag: ["comportamento", "menu"], alias: ["float-menu"], uses: ["menu_float_list", "menu_float_panel"],
    props: { menu: { ...S("nome del menu in spec.menus"), required: true }, on: E(["click", "dblclick", "contextmenu"], "evento", "click"), trigger: { ...S("id elemento oppure 'node'"), required: true } },
    esempio: { spec: { v: 1, regions: [{ id: "r", height: 40, tree: { t: "button_element", id: "b", text: "menu" } }], menus: { m: { kind: "menu_float_list", items: [{ label: "uno", action: "$actions.nop" }] } },
        behaviors: [{ type: "open_float", menu: "m", trigger: "b" }] }, actions: { nop() {} } },
}), (rt, p) => {
    const on = p.on || "click";
    if (p.trigger === "node") { rt.nodeMenu = { menu: p.menu, on }; return; }
    const trg = rt.el(p.trigger);
    if (!trg) { rt.warnOnce("fm:" + p.trigger, `float-menu: trigger '${p.trigger}' not found`); return; }
    rt.bag.listen(trg, on, (e) => {
        e.preventDefault(); e.stopPropagation();
        rt.api.openMenu(p.menu, on === "contextmenu" ? { point: { x: e.clientX, y: e.clientY } } : { anchor: trg });
    });
});

// ---- anim-gate ------------------------------------------------
// { type:"anim-gate", region?:id }   (default: first region)
piece(C("gate_mask", {
    scopo: "Ferma le animazioni CSS di una maschera quando non e' visibile/selezionata (budget condiviso fra nodi).", natura: "funziona", dominio: "runtime", estado: "stable",
    tag: ["comportamento", "animazioni", "performance"], alias: ["anim-gate"], props: { region: S("id regione (default: la prima)") },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "gate_mask" }]),
}), (rt, p) => {
    const reg = rt.regions.get(p.region) || rt.regions.values().next().value;
    if (!reg) return;
    AnimGate.register(rt, reg.root);
    rt.bag.add(() => AnimGate.unregister(rt));
});

// ---- region-follows-node --------------------------------------
// The user resizes the NODE -> the "expanded below" region takes up the slack. It stretches to please.
// { type:"region-follows-node", region, state, min, max, persist? }
piece(C("follow_mask", {
    scopo: "Quando l'utente ridimensiona il nodo, la maschera 'espansa sotto' prende la differenza di altezza (solo se `when` e' vero).", estado: "stable",
    tag: ["comportamento", "resize", "layout"], alias: ["region-follows-node"],
    props: { region: { ...S("id regione che segue"), required: true }, state: { ...K("chiave di stato numerica"), required: true }, min: N("minimo"), max: N("massimo"), persist: E(["triple", "state"], "persistenza", "state"),
        when: R("se definito e falso la maschera NON segue il nodo (altezza del nodo bloccata)") },
    esempio: { spec: { v: 1, regions: [{ id: "r", height: { bind: "$state.h", default: 80, min: 40, max: 300 }, tree: { t: "label_element", text: "x" } }], behaviors: [{ type: "follow_mask", region: "r", state: "h" }] }, state: { h: { policy: "ui" } } },
}), (rt, p) => {
    const ref = stateRef(p.state);
    const triple = p.persist === "triple";
    rt.onNodeResize.add((size) => {
        const reg = rt.region(p.region);
        if (!reg) return;
        if (p.when !== undefined && !evalValue(rt, p.when)) return;
        const g = regionHeight(rt, reg);
        if (g.hidden) return;
        const plus = g.plus || 0;
        const min = Number.isFinite(p.min) ? p.min : g.min - plus;
        const max = Number.isFinite(p.max) ? p.max : (Number.isFinite(g.max) ? g.max - plus : 640);
        let chrome;
        try { chrome = rt.node.computeSize([size[0], 0])[1] - g.value; } catch (_) { return; }
        const area = Math.round(size[1] - chrome - plus);
        const cv = globalThis.app?.canvas;
        const userDrag = cv?.resizing_node === rt.node || cv?.resizingNode === rt.node;
        if (area > min + 1 || userDrag) writePersisted(rt, ref, Math.max(min, Math.min(max, area)), triple);
    });
});

// ---- persist-scroll -------------------------------------------
// { type:"persist-scroll", target:elId, state }   (state with "threshold" policy)
piece(C("persist_element", {
    scopo: "Ricorda e ripristina la posizione di scroll di un elemento (stato con policy threshold).", estado: "stable",
    tag: ["comportamento", "scroll"], alias: ["persist-scroll"], props: { target: { ...ID("elemento scorrevole"), required: true }, state: { ...K("chiave di stato numerica"), required: true } },
    esempio: exb({ t: "pre_element", id: "t", scrollable: true, text: "x" }, [{ type: "persist_element", target: "t", state: "sc" }], { state: { sc: { policy: "threshold", px: 20 } } }),
}), (rt, p) => {
    const t = rt.el(p.target);
    if (!t) return;
    rt.bag.listen(t, "scroll", () => rt.ctx.state.set(p.state, t.scrollTop), { passive: true });
    rt.onRestore.add(() => {
        const v = rt.ctx.state.get(p.state);
        if (typeof v === "number" && v > 0) rt.bag.raf(() => { t.scrollTop = v; });
    });
});

void parseRef;
