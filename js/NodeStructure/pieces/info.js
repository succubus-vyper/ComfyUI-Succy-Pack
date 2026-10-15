// ============================================================
// NodeStructure/pieces/info.js — the little (i) in a node's title bar (D-121), for EVERY node that wants one
//   info_node   behavior: puts a small round "i" button in the node HEADER (Vue Nodes: a real DOM button in the header row; classic canvas:
//               a LiteGraph title button). Click = opens the menu named by `menu` (spec.menus), anchored to the button.
//   infoMenu()  helper that builds that menu's spec from plain data: { title, about, keys:[{keys, does}], notes:[text] }.
// The node only hands over TEXT. Zero DOM in the node. Succubus was here — every good toy comes with instructions. Read them. Slowly.
// ============================================================
import { piece } from "../catalog/registry.js";
import { B, C, S } from "../catalog/kit.js";

// the button lives in the HEADER (Vue's own light DOM), so this CSS is global — which is what a piece's `css` is
const CSS = `
.ns-info-btn{all:unset;box-sizing:border-box;flex:none;width:20px;height:20px;margin:0 16px 0 4px;display:grid;place-items:center;border-radius:50%;cursor:pointer;
  font:15px/1 'Segoe UI Symbol','Apple Symbols',sans-serif;color:#ff7ac8;transition:all .12s}
.ns-info-btn.ns-hov{opacity:0}
[data-node-id]:hover .ns-info-btn.ns-hov,.ns-info-btn.ns-hov:focus-visible{opacity:1}
.ns-info-btn:hover{color:#ffb0dc;transform:scale(1.2);text-shadow:0 0 8px rgba(255,122,200,.8)}
`;

const sec = (text) => ({ t: "label_element", variant: "section", text });
const hint = (text) => ({ t: "label_element", variant: "hint", text });

// the menu spec for an info panel, from data only (text wraps: no fixed widths inside)
export function infoMenu({ title = "Info", about = "", keys = [], notes = [], width = 340 } = {}) {
    return {
        kind: "menu_float_panel", look: "v2", size: "fit", width, dock: "free", dismiss: "outside", title,
        tree: { t: "stack_box", gap: 8, style: { padding: "10px 12px 12px" }, children: [
            ...(about ? [hint(about)] : []),
            ...(keys.length ? [sec("Shortcuts"), ...keys.map((k) => ({ t: "row_box", gap: 8, style: { alignItems: "flex-start" }, children: [
                { t: "badge_element", tone: "accent", text: k.keys, style: { flex: "none" } },
                { ...hint(k.does), style: { flex: "1 1 0", minWidth: "0" } },
            ] }))] : []),
            ...(notes.length ? [sec("Good to know"), ...notes.map(hint)] : []),
        ] },
    };
}

piece(C("info_node", {
    scopo: "Bottone (i) nella testata del nodo: apre il pannello info (spec.menus.<menu>) con descrizione e scorciatoie.",
    natura: "funziona", dominio: "ui", estado: "draft", tag: ["comportamento", "info", "titolo"], uses: ["menu_float_panel"], css: CSS,
    props: { menu: S("nome del menu in spec.menus (costruibile con NodeStructure.infoMenu)", "info"), tip: S("tooltip del bottone", "About this node and its shortcuts"), hover: B("true = il cuore appare solo quando il mouse e sul nodo", false) },
    esempio: { spec: { v: 1, regions: [{ id: "r", height: 40, tree: { t: "label_element", text: "x" } }],
        menus: { info: infoMenu({ title: "x", about: "y", keys: [{ keys: "A", does: "b" }] }) }, behaviors: [{ type: "info_node", menu: "info" }] } },
}), (rt, p) => {
    const name = p.menu || "info";
    const node = () => rt.api.liveNode?.() || rt.node;
    let btn = null, mo = null, obsOn = null, last = { x: 200, y: 200 };
    const open = (anchor) => rt.api.openMenu(name, anchor ? { anchor } : { point: { x: last.x + 10, y: last.y + 10 } });
    const make = () => {
        const b = document.createElement("button"); b.type = "button"; b.className = p.hover ? "ns-info-btn ns-hov" : "ns-info-btn"; b.textContent = "\u2665"; b.title = p.tip || "About this node and its shortcuts";
        for (const ev of ["pointerdown", "dblclick", "mousedown"]) b.addEventListener(ev, (e) => e.stopPropagation());
        b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); open(b); });
        return b;
    };
    // Vue Nodes: the header row is Vue's own DOM and may be patched at any time: put the button back if it goes missing
    const ensure = () => {
        const n = node(); if (!n || n.id == null) return;
        const header = document.querySelector(`[data-node-id="${n.id}"] .lg-node-header`);
        const row = header?.firstElementChild;
        if (!row) return;
        if (!btn) btn = make();
        if (btn.parentElement !== row) row.appendChild(btn);
        if (obsOn !== header) { mo?.disconnect(); obsOn = header; mo = new MutationObserver(() => { if (btn && btn.parentElement !== row) ensure(); }); mo.observe(header, { childList: true, subtree: true }); }
    };
    // classic canvas: a LiteGraph title button (Vue Nodes ignore it, so no double)
    let tb = null;
    const n0 = node();
    if (typeof n0?.addTitleButton === "function") {
        tb = n0.addTitleButton({ name: "succy_info", text: "\u2665", fgColor: "#ff7ac8" });
        tb.onClick = () => open(null);
        const track = (e) => { last = { x: e.clientX, y: e.clientY }; };
        window.addEventListener("pointermove", track, { passive: true, capture: true });
        rt.bag.add(() => window.removeEventListener("pointermove", track, true));
    }
    ensure();
    for (const ms of [50, 400, 1500, 4000]) rt.api.after?.(ensure, ms);
    rt.onRestore?.add?.(ensure);
    rt.bag.add(() => {
        btn?.remove(); mo?.disconnect();
        const n = node(); if (tb && Array.isArray(n?.title_buttons)) n.title_buttons = n.title_buttons.filter((b) => b !== tb);
    });
});
