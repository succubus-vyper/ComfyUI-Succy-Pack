// ============================================================
// pieces/composite.js — composite pieces: cards_box, form_box, editor_element
//   (they used to be CSS+DOM+logic inside the Reroute and Succy_X nodes)
// ============================================================
import { mkEl, num } from "../components/index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, E, N, S, B, R, K, J, PC } from "../catalog/kit.js";
import { Bag } from "../util/tracker.js";
import { stable } from "../util/json.js";
import { runAction, evalDeep } from "../core/binding.js";
import { impl } from "../catalog/registry.js";
import { FloatMenu } from "../menu/float-menu.js";
import { toHex } from "../fx/chain.js";
import { Tip } from "../menu/tip.js";

let UID = 0;

// ---------------- cards_box ----------------
piece(C("cards_box", {
    scopo: "Griglia di card selezionabili con paginazione e miniatura a canvas (renderer del catalogo) per card.", natura: "estetica", estado: "draft", archetipo: "renderer-host",
    tag: ["scelta", "cards", "paginazione"], uses: ["canvas_element", "button_element"],
    props: {
        items: { ...R("lista di {id,label,desc,on} (da un $live del kit)"), required: true }, title: R("titolo a sinistra dell'intestazione"), pageSize: N("card per pagina", 6),
        pageState: K("chiave di stato per la pagina (se vuota: pagina dell'elemento selezionato)"), cols: N("colonne", 3),
        pick: J("handler al click: '$actions.x' o {do, args}; riceve la card come $item"), renderer: PC("renderer", "renderer della miniatura"), args: J("argomenti del renderer"),
    },
    css: `
.ns-cards{display:flex;flex-direction:column;gap:6px;min-width:0}
.ns-cards-head{display:flex;align-items:center;gap:6px}
.ns-cards-grid{display:grid;gap:6px}
.ns-card{display:flex;flex-direction:column;gap:3px;padding:4px;border:1px solid var(--ns-border);border-radius:6px;cursor:pointer;background:var(--ns-bg-2);min-width:0}
.ns-card:hover{border-color:var(--ns-border-hi)}
.ns-card-prev{height:34px;width:100%;display:block}
.ns-card-name{font-size:10px;color:#ccc;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`,
    esempio: ex({ t: "cards_box", items: "$live.cards", pageSize: 2, pageState: "pg", title: "Scelta", pick: { do: "$actions.nop" } },
        { live: { cards: () => [{ id: "a", label: "A", on: true }, { id: "b", label: "B" }, { id: "c", label: "C" }] }, actions: { nop() {} }, state: { pg: { policy: "ui" } } }),
}), (node, h) => {
    const { rt } = h;
    const el = mkEl("div", "ns-cards");
    const head = mkEl("div", "ns-cards-head");
    const ttl = mkEl("span", "ns-label ns-label-section");
    const sp = mkEl("div", "ns-spacer");
    const prev = mkEl("button", "ns-btn"); prev.type = "button"; prev.textContent = "◀"; prev.title = "Previous page";
    const pg = mkEl("span", "ns-label");
    const next = mkEl("button", "ns-btn"); next.type = "button"; next.textContent = "▶"; next.title = "Next page";
    head.append(ttl, sp, prev, pg, next);
    const grid = mkEl("div", "ns-cards-grid");
    el.append(head, grid);

    let sig = "", bag = null, pages = 1, page = 0;
    h.bag.add(() => { bag?.dispose(); bag = null; });
    const rendFn = typeof node.renderer === "string" ? impl(node.renderer, "renderer") : null;

    const calc = (list) => {
        const size = Math.max(1, Math.floor(num(h, node.pageSize, 6)));
        pages = Math.max(1, Math.ceil(list.length / size));
        let p = node.pageState ? rt.ctx.state.get(node.pageState) : undefined;
        if (!Number.isInteger(p)) { const i = list.findIndex((x) => x && x.on); p = i >= 0 ? Math.floor(i / size) : 0; }
        page = Math.min(Math.max(0, p), pages - 1);
        return { size, slice: list.slice(page * size, page * size + size) };
    };
    const step = (d) => { if (!node.pageState) return; rt.api.state.set(node.pageState, (page + d + pages) % pages); };
    h.listen(prev, "click", (e) => { e.stopPropagation(); step(-1); });
    h.listen(next, "click", (e) => { e.stopPropagation(); step(1); });

    const apply = () => {
        let list = h.val(node.items); if (!Array.isArray(list)) list = [];
        const { slice } = calc(list);
        const t = h.val(node.title); const ts = t == null ? "" : String(t);
        if (ttl.textContent !== ts) ttl.textContent = ts;
        const showHead = pages > 1 || !!ts;
        head.style.display = showHead ? "" : "none";
        for (const b of [prev, next, pg]) b.style.display = pages > 1 ? "" : "none";
        pg.textContent = `${page + 1}/${pages}`;
        grid.style.gridTemplateColumns = `repeat(${Math.max(1, Math.floor(num(h, node.cols, 3)))}, minmax(0,1fr))`;
        let s; try { s = stable(slice); } catch (_) { s = String(slice.length); }
        if (s === sig) return;
        sig = s;
        bag?.dispose(); bag = new Bag("cards");
        grid.textContent = "";
        for (const item of slice) {
            const card = mkEl("div", "ns-card" + (item.on ? " ns-on" : ""));
            if (item.desc) card.title = String(item.desc);
            if (rendFn) {
                const cv = mkEl("canvas", "ns-card-prev"); card.appendChild(cv);
                const args = node.args ? evalDeep(rt, node.args, item) : undefined;
                rt.ctx.perf.acquireCanvas(cv, { fps: 30, render: (dt, g, w, hh) => { try { rendFn(rt.api, dt, g, w, hh, item, args); } catch (e) { rt.warnOnce("cards:" + node.renderer, e); } } });
                bag.add(() => { try { rt.ctx.perf.releaseCanvas(cv); } catch (_) {} });
            }
            const nm = mkEl("div", "ns-card-name"); nm.textContent = String(item.label ?? item.id ?? ""); card.appendChild(nm);
            bag.listen(card, "click", (e) => { if (node.pick) runAction(rt, node.pick, e, card, item); rt.update(); });
            grid.appendChild(card);
        }
    };
    apply();
    return { el, update: apply, handlesText: true };
});

// ---------------- form_box ----------------
piece(C("form_box", {
    scopo: "Form generato da uno schema di campi; valori in un JSON per scope dentro una chiave di stato; auto del colore e reset.", natura: "funziona", estado: "draft", archetipo: "renderer-host",
    tag: ["form", "parametri", "stato"], uses: ["field_element", "button_element", "stack_box", "row_box"],
    props: {
        fields: { ...R("schema: [{key,label,type,min,max,step,options,default,hasAuto}]"), required: true },
        state: { ...K("chiave di stato (stringa JSON {scope:{key:valore}})"), required: true }, scope: { ...R("sotto-chiave del JSON (es. id effetto)"), required: true },
        unless: R("se vero il form e' in sola lettura"), autoColor: R("colore usato quando un campo color e' 'auto'"), resetLabel: S("testo del pulsante di reset", "Reset"), change: B("segna il grafo modificato a fine modifica", true),
        cols: N("griglia fissa: colonne (con rows)", 2), rows: N("griglia fissa: righe per pagina; se manca il form e' una lista (vecchio aspetto)"), rowsSmall: N("righe per pagina nella taglia S del menu v2 (1 colonna)", 4),
        colsSmall: N("colonne nella taglia S del menu v2", 1), foot: B("griglia fissa: mostra il piede (pagine + reset)", true),
    },
    esempio: ex({ t: "form_box", fields: "$live.f", state: "vals", scope: "s1", autoColor: "#88aa99" },
        { live: { f: () => [{ key: "w", label: "Width", type: "range", min: 0, max: 10, step: 1, default: 3 }, { key: "c", label: "Color", type: "color", default: "auto", hasAuto: true }] }, state: { vals: { policy: "immediate", default: "" } } }),
}), (node, h) => {
    const { rt } = h;
    const read = () => { let o = {}; try { o = JSON.parse(rt.ctx.state.get(node.state) || "{}"); } catch (_) {} return o && typeof o === "object" && !Array.isArray(o) ? o : {}; };
    const locked = () => !!h.val(node.unless);
    const sc = () => String(h.val(node.scope) ?? "");
    const write = (fn, final) => {
        const cur = read(); fn(cur);
        rt.api.state.set(node.state, JSON.stringify(cur));
        if (final && node.change !== false) { try { rt.node.graph?.change?.(); } catch (_) {} }
    };
    // fixed paged grid (menu v2): the form doesn't change height when the parameters change (D-57). Keeps its figure.
    const grid = Number.isFinite(Number(node.rows));
    let page = 0, pages = 1, lastScope = null, hostEl = null;
    const perPage = () => {
        const small = !!hostEl?.closest?.("[data-ns-size=S]");
        const c = small ? Math.max(1, Math.floor(Number(node.colsSmall ?? 1))) : Math.max(1, Math.floor(Number(node.cols ?? 2)));
        const r = small ? Math.max(1, Math.floor(Number(node.rowsSmall ?? 4))) : Math.max(1, Math.floor(Number(node.rows)));
        return c * r;
    };
    const rows = () => {
        const all = allRows();
        if (!grid) return all;
        const sp = sc(); if (sp !== lastScope) { lastScope = sp; page = 0; }
        const n = perPage(); pages = Math.max(1, Math.ceil(all.length / n)); page = Math.min(page, pages - 1);
        return all.slice(page * n, page * n + n);
    };
    const allRows = () => {
        const fs = h.val(node.fields); if (!Array.isArray(fs)) return [];
        const mine = read()[sc()] || {}; const auto = h.val(node.autoColor);
        return fs.map((d) => {
            const cur = mine[d.key] !== undefined ? mine[d.key] : d.default;
            const isAuto = d.type === "color" && (cur === "auto" || cur == null);
            return { ...d, _auto: isAuto, _v: d.type === "color" ? toHex(isAuto ? auto : cur) : cur };
        });
    };
    const resetOne = (api, ev, el, item) => { if (!grid || locked() || !item) return; write((p) => { const b = p[sc()]; if (b) delete b[item.key]; }, true); };
    if (grid) {
        const tree = { t: "stack_box", class: "ns-form-grid", each: rows, item: { t: "row_box", classIf: { "ns-form-off": "$item.hidden" }, on: { dblclick: resetOne }, children: [
            { t: "field_element", kind: "$item.type", label: "$item.label", min: "$item.min", max: "$item.max", step: "$item.step", options: "$item.options", bind: "$item._v",
                commit: (api, ev, el, item) => { if (locked() || !item) return; write((p) => { (p[sc()] = p[sc()] || {})[item.key] = ev.value; }, ev.final); } },
            { t: "button_element", text: "Auto", visible: "$item.hasAuto", classIf: { "ns-on": "$item._auto" },
                on: { click: (api, ev, el, item) => { if (locked() || !item) return; write((p) => { const b = (p[sc()] = p[sc()] || {}); b[item.key] = item._auto ? toHex(h.val(node.autoColor)) : "auto"; }, true); } } },
        ] } };
        const wrap = mkEl("div", "ns-form");
        if (Number(node.colsSmall) > 1) wrap.dataset.nsColsS = String(Math.floor(Number(node.colsSmall)));
        const gEl = h.render(tree, h.item);
        hostEl = wrap;
        const foot = mkEl("div", "ns-form-foot");
        const prev = mkEl("button", "ns-btn ns-btn-ghost"); prev.type = "button"; prev.textContent = "‹"; prev.title = "Previous parameters";
        const pg = mkEl("span", "ns-form-pg");
        const next = mkEl("button", "ns-btn ns-btn-ghost"); next.type = "button"; next.textContent = "›"; next.title = "Next parameters";
        const fill = mkEl("span", "ns-spacer"); fill.style.flex = "1";
        const reset = mkEl("button", "ns-btn"); reset.type = "button"; reset.textContent = String(node.resetLabel ?? "Reset"); reset.title = "Reset all parameters of this effect (double-click one parameter to reset only that)";
        foot.append(prev, pg, next, fill, reset);
        wrap.append(gEl, foot);
        if (node.foot === false) foot.style.display = "none";
        const paintFoot = () => { const many = pages > 1; for (const b of [prev, pg, next]) b.style.visibility = many ? "" : "hidden"; pg.textContent = `${page + 1}/${pages}`; };
        h.listen(prev, "click", (e) => { e.stopPropagation(); page = (page - 1 + pages) % pages; rt.update(); });
        h.listen(next, "click", (e) => { e.stopPropagation(); page = (page + 1) % pages; rt.update(); });
        h.listen(reset, "click", (e) => { e.stopPropagation(); if (locked()) return; write((p) => { delete p[sc()]; }, true); });
        paintFoot();
        return { el: wrap, handlesText: true, update: paintFoot };
    }
    const tree = { t: "stack_box", gap: 6, children: [
        { t: "stack_box", gap: 6, each: rows, item: { t: "row_box", children: [
            { t: "field_element", kind: "$item.type", label: "$item.label", min: "$item.min", max: "$item.max", step: "$item.step", options: "$item.options", bind: "$item._v",
                commit: (api, ev, el, item) => { if (locked() || !item) return; write((p) => { (p[sc()] = p[sc()] || {})[item.key] = ev.value; }, ev.final); } },
            { t: "button_element", text: "auto", visible: "$item.hasAuto", classIf: { "ns-on": "$item._auto" },
                on: { click: (api, ev, el, item) => { if (locked() || !item) return; write((p) => { const b = (p[sc()] = p[sc()] || {}); b[item.key] = item._auto ? toHex(h.val(node.autoColor)) : "auto"; }, true); } } },
        ] } },
        { t: "button_element", text: String(node.resetLabel ?? "Reset"), on: { click: () => { if (locked()) return; write((p) => { delete p[sc()]; }, true); } } },
    ] };
    return { el: h.render(tree, h.item), handlesText: true };
});

// ---------------- editor_element ----------------
function serializeEditor(editor) {
    let out = "";
    (function walk(el) {
        for (const c of el.childNodes) {
            if (c.nodeType === Node.TEXT_NODE) out += c.textContent;
            else if (c.nodeType === Node.ELEMENT_NODE) {
                if (c.classList?.contains("ns-token")) out += c.dataset.val || "";
                else if (c.tagName === "BR") out += "\n";
                else {
                    const isBlock = c.tagName === "DIV" || c.tagName === "P";
                    if (isBlock && out && !out.endsWith("\n")) out += "\n";
                    walk(c);
                    if (isBlock && !out.endsWith("\n")) out += "\n";
                }
            }
        }
    })(editor);
    return out.replace(/ /g, " ").replace(/[​-‍﻿]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
// `labelOf(key)` = the text a token SHOWS (D-71); the stored value stays "@key" so renames never touch the data.
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function deserializeEditor(txt, labelOf = (k) => k) {
    if (!txt) return "";
    let safe = String(txt).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    safe = safe.replace(/@(\w+)/g, (_, k) => `<span class="ns-token" contenteditable="false" data-val="@${k}">${escHtml(labelOf(k))}</span>`);
    return safe.replace(/\n/g, "<br>");
}

piece(C("editor_element", {
    scopo: "Editor di testo ricco minimo: token @, menu dei token, modale 'Edit Text' (doppio click); si lega con bind.", natura: "funziona", estado: "draft", archetipo: "trigger",
    tag: ["testo", "editor", "token"], uses: ["menu_float_list", "menu_float_panel", "textarea_element"],
    props: {
        tokens: R("[{key,label,hint?}] proposti dopo '@': lista fissa o ref (es. $live.tok1) riletta dal vivo; il token mostra sempre la label corrente (D-71)"), placeholder: S("segnaposto", "Type @ for tokens..."), modalTitle: S("titolo della modale", "Edit Text"), modalWidth: N("larghezza modale", 700),
    },
    css: `
.ns-editor{min-height:40px;max-height:600px;height:60px;overflow-y:auto;padding:8px 8px 12px 8px;background:var(--ns-bg-2);border:1px solid var(--ns-border);border-radius:4px;color:#e0e0e0;font:12px monospace;line-height:1.4;white-space:pre-wrap;outline:none;cursor:text}
.ns-editor:focus{border-color:var(--ns-border-hi);background:var(--ns-bg-3)}
.ns-editor:empty::before{content:attr(data-placeholder);color:#555;font-style:italic;pointer-events:none}
.ns-token{display:inline-block;max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;padding:0 5px;margin:0 2px;background:rgba(255,184,77,.18);border:1px solid rgba(255,184,77,.4);border-radius:4px;color:#ffb84d;font:bold 10px monospace;text-transform:uppercase;user-select:all}
.ns-modal-ta{min-height:260px;font:12px monospace;resize:vertical}
`,
    esempio: ex({ t: "editor_element", id: "ed", bind: "$cache.txt", tokens: [{ key: "date", label: "@date" }] }),
}), (node, h) => {
    const { rt } = h;
    const uid = ++UID;
    const el = mkEl("div", "ns-editor ns-scroll");
    el.contentEditable = "true";
    el.setAttribute("data-placeholder", String(node.placeholder ?? "Type @ for tokens..."));
    try { rt.ctx.utils.scrollable(el); } catch (_) {}
    const rangeKey = "ed-range:" + uid, modalKey = "__ed_modal_" + uid, varsName = "ed-vars-" + uid, modalName = "ed-modal-" + uid;
    // tokens are re-read every time (D-71): a fixed list or a ref the glue recomputes (inputs' names, equations' labels)
    const tokensNow = () => { let t; try { t = h.val(node.tokens); } catch (_) { t = null; } return Array.isArray(t) ? t.filter((x) => x && x.key != null) : []; };
    const labelOf = (k) => { const t = tokensNow().find((x) => String(x.key) === String(k)); return String(t?.label ?? k); };
    h.bag.add(() => { rt.scratch.delete(rangeKey); });

    // Rewrites what each token SHOWS when its label changed (label typed, wire plugged, source renamed). Only touches the
    // text of tokens that actually changed: the caret never notices, and nothing is dispatched (the stored "@key" is intact).
    const relabel = () => {
        if (!el.isConnected) return;
        const cur = tokensNow();
        for (const s of el.querySelectorAll(".ns-token")) {
            const k = (s.dataset.val || "").slice(1), t = cur.find((x) => String(x.key) === k);
            const lab = String(t?.label ?? k);
            if (s.textContent !== lab) s.textContent = lab;
        }
    };
    rt.onUpdate.add(relabel); rt.onConnect.add(relabel); rt.onRestore.add(relabel);
    rt.api.every(relabel, 1000);                                   // a source renamed while wired: it shows up on the next beat, no fuss

    // hover on a token: full name + where it comes from (the token itself may be ellipsised)
    const tokenTip = (s) => {
        const k = (s.dataset.val || "").slice(1), t = tokensNow().find((x) => String(x.key) === k);
        return { title: String(t?.label ?? k), chip: k, body: t?.hint ? [String(t.hint)] : [] };
    };
    h.listen(el, "mouseover", (e) => { const s = e.target?.closest?.(".ns-token"); if (s && el.contains(s)) Tip.show(s, () => tokenTip(s)); });
    h.listen(el, "mouseout", (e) => { const s = e.target?.closest?.(".ns-token"); if (s) Tip.hide(s); });

    const insertToken = (api, ev, btn, item) => {
        const range = rt.scratch.get(rangeKey);
        try {
            el.focus();
            if (range) {
                if (range.startOffset > 0) { const r2 = range.cloneRange(); r2.setStart(range.startContainer, range.startOffset - 1); r2.deleteContents(); }
                const span = document.createElement("span");
                span.className = "ns-token"; span.setAttribute("contenteditable", "false");
                span.setAttribute("data-val", `@${item.key}`); span.textContent = String(item.label ?? item.key);
                range.insertNode(span);
                // NO space after the token (D-77): you decide if there is one. A zero-width anchor keeps the caret usable after a
                // non-editable span; serializeEditor strips it, so it never reaches the data. Discreet, like a good lover.
                const sp = document.createTextNode("\u200B");
                if (span.nextSibling) span.parentNode.insertBefore(sp, span.nextSibling); else span.parentNode.appendChild(sp);
                range.setStartAfter(sp); range.collapse(true);
                const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
            }
        } catch (_) {}
        el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    h.listen(el, "input", () => {
        const sel = window.getSelection();
        const tokens = tokensNow();
        if (!tokens.length || !sel || sel.rangeCount === 0) return;
        const r = sel.getRangeAt(0);
        if (r.startContainer.nodeType !== Node.TEXT_NODE) return;
        if (!r.startContainer.textContent.slice(0, r.startOffset).endsWith("@")) return;
        rt.scratch.set(rangeKey, r.cloneRange());
        let rect = r.getBoundingClientRect();
        if (!rect || (rect.left === 0 && rect.top === 0 && rect.width === 0)) rect = el.getBoundingClientRect();
        FloatMenu.open(rt, varsName, {
            point: { x: Math.max(10, rect.left), y: rect.bottom + 4 }, reopen: true,
            spec: { kind: "list", items: tokens.map((t) => ({ label: String(t.label ?? t.key), key: t.key, action: insertToken })) },
        });
    });
    h.listen(el, "dblclick", (e) => {
        e.stopPropagation();
        rt.ctx.cache.set(modalKey, serializeEditor(el));
        const done = (ok) => { if (ok) { el.innerHTML = deserializeEditor(rt.ctx.cache.get(modalKey) || "", labelOf); el.dispatchEvent(new Event("input", { bubbles: true })); } FloatMenu.close(rt, modalName); };
        FloatMenu.open(rt, modalName, {
            reopen: true,
            spec: { kind: "panel", modal: true, title: String(node.modalTitle ?? "Edit Text"), width: Number(node.modalWidth) || 700, tree: { t: "stack_box", children: [
                { t: "textarea_element", class: "ns-modal-ta", bind: "$cache." + modalKey, stopKeys: true },
                { t: "row_box", justify: "flex-end", children: [
                    { t: "button_element", text: "Cancel", on: { click: () => done(false) } },
                    { t: "button_element", text: "OK", variant: "primary", on: { click: () => done(true) } },
                ] },
            ] } },
        });
    });
    return {
        el, handlesText: true,
        value: {
            get: () => serializeEditor(el),
            set: (v) => { const raw = v == null ? "" : String(v); if (serializeEditor(el).trim() !== raw.trim()) el.innerHTML = deserializeEditor(raw, labelOf); },
            events: ["input"],
        },
    };
});
