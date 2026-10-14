// ============================================================
// NodeStructure/components/layout.js
// Containers: the builder KNOWS HOW TO ARRANGE, not what things mean.
// ============================================================

import { mkEl, num } from "./index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, E, N, S, B, FLEX } from "../catalog/kit.js";

function applyStack(el, node, h) {
    const dir = h.val(node.dir) === "row" ? "row" : "column";
    el.style.flexDirection = dir;
    const gap = h.val(node.gap);
    if (gap !== undefined) el.style.gap = typeof gap === "number" ? gap + "px" : String(gap);
    const align = h.val(node.align);
    if (align) el.style.alignItems = String(align);
    const justify = h.val(node.justify);
    if (justify) el.style.justifyContent = String(justify);
    if (h.val(node.wrap) === true) el.style.flexWrap = "wrap";
    if (h.val(node.grow) === true) el.style.flex = "1 1 0";
    const pad = h.val(node.pad);
    if (pad !== undefined) el.style.padding = typeof pad === "number" ? pad + "px" : String(pad);
}

function stack(node, h) {
    const el = mkEl("div", "ns-stack");
    applyStack(el, node, h);
    return { el, update: () => applyStack(el, node, h) };
}

piece(C("stack_box", {
    scopo: "Contenitore flex verticale (o orizzontale con dir) senza aspetto proprio.", natura: "funziona", estado: "stable", archetipo: "container",
    tag: ["layout", "flex"], alias: ["stack"], props: { ...FLEX },
    esempio: ex({ t: "stack_box", gap: 4, children: [{ t: "label_element", text: "a" }, { t: "label_element", text: "b" }] }),
}), stack);

piece(C("row_box", {
    scopo: "Contenitore flex orizzontale con elementi allineati al centro.", estado: "stable", archetipo: "container",
    tag: ["layout", "flex"], alias: ["row"], uses: ["stack_box"], props: { ...FLEX },
    esempio: ex({ t: "row_box", children: [{ t: "label_element", text: "x" }, { t: "spacer_element" }, { t: "label_element", text: "y" }] }),
}), (node, h) => {
    const n = { ...node, dir: node.dir ?? "row" };
    const el = mkEl("div", "ns-stack ns-row");
    if (n.align === undefined) el.style.alignItems = "center";
    applyStack(el, n, h);
    return { el, update: () => applyStack(el, n, h) };
});

piece(C("group_box", {
    scopo: "Riquadro con sfondo (panel), incassato (inset) o trasparente (plain).", natura: "estetica", estado: "stable", archetipo: "container",
    tag: ["layout", "aspetto"], alias: ["box"], uses: ["stack_box"],
    props: { ...FLEX, variant: E(["panel", "inset", "plain"], "aspetto del riquadro", "panel") },
    esempio: ex({ t: "group_box", variant: "inset", children: [{ t: "label_element", text: "dentro" }] }),
}), (node, h) => {
    const variant = String(h.val(node.variant) || "panel").replace(/[^\w-]/g, "");
    const el = mkEl("div", "ns-box ns-box-" + variant);
    applyStack(el, node, h);
    return { el, update: () => applyStack(el, node, h) };
});

piece(C("spacer_element", {
    scopo: "Spazio elastico che spinge gli altri elementi ai lati.", natura: "estetica", estado: "stable", archetipo: "leaf",
    tag: ["layout"], alias: ["spacer"], esempio: ex({ t: "row_box", children: [{ t: "spacer_element" }] }),
}), () => ({ el: mkEl("div", "ns-spacer") }));

piece(C("separator_element", {
    scopo: "Spazio verticale FISSO (altezza dichiarata in px) tra due box; non si allunga mai col nodo. Con line disegna anche una linea.", natura: "estetica", estado: "draft", archetipo: "leaf",
    tag: ["layout", "spazio"], props: { size: N("altezza in px (fissa)", 6), line: B("disegna una linea sottile al centro", false) },
    css: ".ns-separator{flex:0 0 auto;width:100%;position:relative;pointer-events:none}.ns-separator-line::after{content:\"\";position:absolute;left:0;right:0;top:50%;height:1px;background:var(--ns-border)}",
    esempio: ex({ t: "stack_box", children: [{ t: "label_element", text: "a" }, { t: "separator_element", size: 8 }, { t: "label_element", text: "b" }] }),
}), (node, h) => {
    const el = mkEl("div", "ns-separator");
    const apply = () => {
        const s = h.val(node.size);
        const px = typeof s === "number" && s >= 0 ? s : 6;
        el.style.height = px + "px"; el.style.minHeight = px + "px"; el.style.maxHeight = px + "px";
        el.classList.toggle("ns-separator-line", h.val(node.line) === true);
    };
    apply();
    return { el, update: apply };
});

piece(C("divider_element", {
    scopo: "Linea sottile di separazione.", natura: "estetica", estado: "stable", archetipo: "leaf",
    tag: ["layout", "aspetto"], alias: ["divider"], esempio: ex({ t: "divider_element" }),
}), () => ({ el: mkEl("div", "ns-divider") }));

piece(C("grid_box", {
    scopo: "Griglia: numero fisso di colonne oppure auto-riempimento con larghezza minima.", estado: "stable", archetipo: "container",
    tag: ["layout", "grid"], alias: ["grid"],
    props: { cols: N("numero di colonne (assente = auto-fill)"), min: N("larghezza minima colonna in auto (px)", 130), gap: N("spazio (px)", 6) },
    esempio: ex({ t: "grid_box", cols: 2, children: [{ t: "label_element", text: "1" }, { t: "label_element", text: "2" }] }),
}), (node, h) => {
    const el = mkEl("div", "ns-grid");
    const apply = () => {
        const cols = h.val(node.cols);
        const min = num(h, node.min, 130);
        el.style.gridTemplateColumns = typeof cols === "number"
            ? `repeat(${Math.max(1, Math.floor(cols))}, minmax(0, 1fr))`
            : `repeat(auto-fill, minmax(${min}px, 1fr))`;
        const gap = h.val(node.gap);
        if (gap !== undefined) el.style.gap = typeof gap === "number" ? gap + "px" : String(gap);
    };
    apply();
    return { el, update: apply };
});
void S;
