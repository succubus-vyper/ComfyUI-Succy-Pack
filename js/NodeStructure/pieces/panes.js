// ============================================================
// pieces/panes.js — notice_box, section_box, pane_box
//   Everything that used to live as CSS/DOM inside the nodes (.pa-*, .rr-lock, .rr-sec).
// ============================================================
import { mkEl, safeUrl } from "../components/index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, E, S, R, FLEX } from "../catalog/kit.js";

// ---------- notice_box ----------
piece(C("notice_box", {
    scopo: "Riquadro di avviso colorato (info, warn, error) che contiene altri pezzi.", natura: "estetica", estado: "draft", archetipo: "container",
    tag: ["layout", "stato", "avviso"], props: { ...FLEX, tone: E(["info", "warn", "error"], "tono", "warn") },
    css: `
.ns-notice{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--ns-c-warn-tint, rgba(255,184,77,.35));border-radius:6px;background:var(--ns-c-warn-tint, rgba(255,184,77,.08));font-size:11px;color:var(--ns-warn);min-width:0}
.ns-notice-info{border-color:var(--ns-c-accent-tint, rgba(74,158,255,.35));background:var(--ns-c-accent-tint, rgba(74,158,255,.08));color:var(--ns-accent-fg)}
.ns-notice-error{border-color:var(--ns-c-danger-tint, rgba(224,112,112,.4));background:var(--ns-c-danger-tint, rgba(224,112,112,.08));color:var(--ns-danger)}
`,
    esempio: ex({ t: "notice_box", tone: "warn", children: [{ t: "label_element", variant: "warn", text: "attenzione" }] }),
}), (node, h) => {
    const el = mkEl("div", "ns-notice");
    let cur = "";
    const apply = () => {
        const t = String(h.val(node.tone) || "warn").replace(/[^\w-]/g, "");
        const want = t === "warn" ? "" : t;
        if (want !== cur) { if (cur) el.classList.remove("ns-notice-" + cur); if (want) el.classList.add("ns-notice-" + want); cur = want; }
        if (h.val(node.dir) === "row") el.style.flexDirection = "row";
    };
    apply();
    return { el, update: apply };
});

// ---------- section_box ----------
piece(C("section_box", {
    scopo: "Sezione con titolo in maiuscoletto e contenuto sotto (impaginazione dei pannelli).", natura: "estetica", estado: "draft", archetipo: "container",
    tag: ["layout", "aspetto"], uses: ["label_element", "stack_box"], props: { title: S("titolo della sezione"), gap: { type: "number", desc: "spazio tra i figli (px)", default: 6 } },
    css: `.ns-section{display:flex;flex-direction:column;gap:6px;min-width:0}.ns-section-body{display:flex;flex-direction:column;gap:6px;min-width:0}`,
    esempio: ex({ t: "section_box", title: "Titolo", children: [{ t: "label_element", text: "contenuto" }] }),
}), (node, h) => {
    const el = mkEl("div", "ns-section");
    const head = mkEl("span", "ns-label ns-label-section");
    const body = mkEl("div", "ns-section-body");
    el.append(head, body);
    const apply = () => {
        const t = h.val(node.title);
        const s = t == null ? "" : String(t);
        if (head.textContent !== s) head.textContent = s;
        head.style.display = s ? "" : "none";
        const g = h.val(node.gap); if (g !== undefined) body.style.gap = typeof g === "number" ? g + "px" : String(g);
    };
    apply();
    return { el, container: body, update: apply };
});

// ---------- pane_box ----------
// Stateful "preview" box: empty | text | image | expired image. Images
// that error out (404) become "expired" (module-level memory: survives undo and workflow switches). Nothing lasts forever.
const EXPIRED = new Set();
export const paneExpired = (src) => EXPIRED.has(src);

piece(C("pane_box", {
    scopo: "Riquadro anteprima a stati (vuoto, testo, immagine, immagine scaduta) con barra strumenti al passaggio del mouse.", natura: "estetica", estado: "draft", archetipo: "container",
    tag: ["anteprima", "stato", "testo", "immagine"], uses: ["image_element"],
    props: {
        mode: { ...R("'empty' | 'text' | 'image' (valore o $ref)"), required: true }, text: R("testo da mostrare (mode text)"), src: R("URL immagine (mode image)"), info: R("riga di info sotto l'immagine"),
        emptyText: S("testo dello stato vuoto", "Waiting for queue..."), expiredTitle: S("titolo immagine scaduta", "Image Expired"), expiredSub: S("sottotitolo immagine scaduta", "Queue Again"),
        fit: E(["contain", "cover", "fill"], "adattamento immagine", "contain"),
    },
    css: `
.ns-pane{display:flex;flex-direction:column;height:100%;box-sizing:border-box;padding:10px;gap:8px;background:var(--ns-bg-2);border:1px solid var(--ns-border);border-radius:6px;position:relative;overflow:hidden}
.ns-pane-text{flex:1 1 0;min-height:0;margin:0;padding:10px;background:var(--ns-c-pane-bg, #0e0e0e);color:var(--ns-c-text, #ddd);border-radius:4px;line-height:1.5;overflow-y:auto;word-break:break-word;white-space:pre-wrap;user-select:text;cursor:text;font:12px monospace}
.ns-pane-empty{flex:1 1 0;display:flex;align-items:center;justify-content:center;background:var(--ns-c-pane-bg, #0e0e0e);border-radius:4px;color:var(--ns-c-text-5, #444);font:10px monospace;letter-spacing:1px;text-transform:uppercase}
.ns-pane-imgwrap{position:relative;flex:1 1 0;min-height:0;background:var(--ns-c-pane-bg, #0e0e0e);border-radius:4px;overflow:hidden}
.ns-pane-imgwrap img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;user-select:none}
.ns-pane-info{flex:0 0 auto;font:10px monospace;color:var(--ns-c-text-4, #666);text-align:center;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-pane-tools{position:absolute;top:14px;right:14px;display:flex;flex-direction:row;gap:4px;z-index:20;opacity:0;transition:opacity .2s}
.ns-pane:hover .ns-pane-tools{opacity:1}
.ns-pane.ns-nogrip>.ns-grip{display:none}
.ns-pane:not([data-ns-pane="text"]):not([data-ns-pane="empty"])>.ns-grip{display:none}
.ns-pane-expired{flex:1 1 0;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border-radius:4px;border:1px dashed var(--ns-c-warn-tint, rgba(255,170,0,.35));background:repeating-linear-gradient(135deg,var(--ns-c-warn-tint, rgba(255,170,0,.055)) 0 10px,transparent 10px 20px),var(--ns-c-pane-bg, #0e0e0e);background-size:28.28px 28.28px;animation:ns-stripes 3s linear infinite;animation-play-state:var(--ns-anim,running)}
.ns-pane-exp-title{color:var(--ns-c-warn, #ffb84d);font:bold 15px monospace;letter-spacing:3px;text-transform:uppercase}
.ns-pane-exp-sub{padding:3px 10px;color:var(--ns-c-warn, #ffb84d);background:var(--ns-c-warn-tint, rgba(255,170,0,.12));border:1px solid var(--ns-c-warn-tint, rgba(255,170,0,.3));border-radius:3px;font:bold 10px monospace;letter-spacing:4px;text-transform:uppercase}
@keyframes ns-stripes{from{background-position:0 0}to{background-position:28.28px 0}}
`,
    esempio: ex({ t: "pane_box", mode: "text", text: "ciao", children: [{ t: "button_element", text: "x", attrs: { "data-ns-for": "text image" } }] }),
}), (node, h) => {
    const { rt } = h;
    const el = mkEl("div", "ns-pane");
    const txt = mkEl("pre", "ns-pane-text ns-scroll");
    const empty = mkEl("div", "ns-pane-empty");
    const wrap = mkEl("div", "ns-pane-imgwrap");
    const img = mkEl("img"); img.draggable = false; wrap.appendChild(img);
    const exp = mkEl("div", "ns-pane-expired");
    const expT = mkEl("span", "ns-pane-exp-title"), expS = mkEl("span", "ns-pane-exp-sub");
    exp.append(expT, expS);
    const info = mkEl("div", "ns-pane-info");
    const tools = mkEl("div", "ns-pane-tools");
    el.append(txt, empty, wrap, exp, info, tools);
    try { rt.ctx.utils.scrollable(txt); } catch (_) {}

    let lastSrc = "";
    const show = (node_, on) => { const v = on ? "1" : "0"; if (node_.getAttribute("data-ns-vis") !== v) node_.setAttribute("data-ns-vis", v); };
    const currentSrc = () => safeUrl(h.val(node.src));
    const apply = () => {
        const mode = String(h.val(node.mode) || "empty");
        const src = mode === "image" ? currentSrc() : "";
        const state = mode === "text" ? "text" : (mode === "image" && src ? (EXPIRED.has(src) ? "expired" : "image") : "empty");
        if (el.dataset.nsPane !== state) el.dataset.nsPane = state;
        const t = h.val(node.text);
        const ts = t == null ? "" : String(t);
        if (state === "text" && txt.textContent !== ts) txt.textContent = ts;
        const et = h.val(node.emptyText); const ets = typeof et === "string" ? et : "Waiting for queue...";
        if (empty.textContent !== ets) empty.textContent = ets;
        const xt = h.val(node.expiredTitle), xs = h.val(node.expiredSub);
        const xts = typeof xt === "string" ? xt : "Image Expired", xss = typeof xs === "string" ? xs : "Queue Again";
        if (expT.textContent !== xts) expT.textContent = xts;
        if (expS.textContent !== xss) expS.textContent = xss;
        if (src !== lastSrc) { lastSrc = src; if (src && state === "image") img.src = src; else if (!src) img.removeAttribute("src"); }
        img.style.objectFit = String(h.val(node.fit) || "contain").replace(/[^\w-]/g, "");
        const i = h.val(node.info); const is = i == null ? "" : String(i);
        if (info.textContent !== is) info.textContent = is;
        show(txt, state === "text"); show(empty, state === "empty"); show(wrap, state === "image"); show(exp, state === "expired"); show(info, state === "image" && !!is);
        for (const c of tools.querySelectorAll("[data-ns-for]")) show(c, String(c.getAttribute("data-ns-for")).split(/\s+/).includes(state));
    };
    h.listen(img, "load", () => { const s = img.getAttribute("src"); if (s) EXPIRED.delete(s); el.dispatchEvent(new CustomEvent("ns-load", { detail: { img } })); apply(); });
    h.listen(img, "error", () => {
        const s = img.getAttribute("src");
        if (!s || s !== currentSrc()) return;            // error from an src that's old news by now
        EXPIRED.add(s);
        el.dispatchEvent(new CustomEvent("ns-error", { detail: { img } }));
        apply();
    });
    apply();
    return { el, container: tools, update: apply, handlesText: true };
});
