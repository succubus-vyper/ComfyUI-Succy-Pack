// ============================================================
// NodeStructure/components/crop-tools.js — two small tools for the Crop menu (D-120)
//   swatch_element  a scrolling list of choices, each with a little picture (brush tips for now). One value, click to pick.
//   boxlock_element     the rectangle drawn small: freeze its WIDTH or its HEIGHT (the frozen sides turn red, same as on the canvas) and
//                        type the Multiple it snaps to. Both live in the node's state / natives; the canvas just reads them.
// The node never touches the DOM: it only names the pieces and the refs. Succubus was here — pick a tip, lock a side, keep it tight.
// ============================================================
import { mkEl } from "./index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, N, R, J } from "../catalog/kit.js";
import { parseRef } from "../core/parser.js";
import { writeRef } from "../core/binding.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const CSS = `
.ns-sw{display:flex;flex-direction:column;gap:2px;max-height:var(--ns-sw-h,132px);overflow-y:auto;padding:2px;border:1px solid var(--nsm-line-strong, #444);border-radius:7px;background:var(--nsm-field, #0f1011);box-sizing:border-box}
.ns-sw-row{flex:none;display:flex;align-items:center;gap:10px;padding:3px 8px 3px 4px;border-radius:5px;cursor:pointer;color:var(--nsm-text-dim, #ccc);font:12px var(--nsm-font, system-ui);min-width:0}
.ns-sw-row:hover{background:var(--nsm-hover, rgba(255,255,255,.07))}
.ns-sw-row.on{background:var(--nsm-accent-soft, rgba(124,188,255,.18));color:var(--nsm-text, #fff)}
.ns-sw-pic{flex:none;width:34px;height:34px;display:grid;place-items:center;border-radius:5px;background:#1a1b1d}
.ns-sw-pic i{display:block;width:20px;height:20px;background:#fff}
.ns-sw-txt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ns-bl{display:flex;flex-direction:column;align-items:stretch;gap:6px;min-width:0}
.ns-bl-stage{position:relative;display:grid;place-items:center;height:112px;border-radius:7px;background:var(--nsm-field, #0f1011);border:1px solid var(--nsm-line-strong, #444);box-sizing:border-box;overflow:hidden}
.ns-bl-rect{position:relative;display:grid;place-items:center;box-sizing:border-box;border-radius:3px;background:rgba(124,188,255,.10);min-width:96px;min-height:58px}
.ns-bl-e{position:absolute;background:#7cbcff;cursor:pointer;transition:background .12s}
.ns-bl-e.t,.ns-bl-e.b{left:0;right:0;height:4px}.ns-bl-e.t{top:0}.ns-bl-e.b{bottom:0}
.ns-bl-e.l,.ns-bl-e.r{top:0;bottom:0;width:4px}.ns-bl-e.l{left:0}.ns-bl-e.r{right:0}
.ns-bl-e.hot{background:#ff5a5a}
.ns-bl-rect.both{background:rgba(255,90,90,.12)}
.ns-bl-mul{display:flex;flex-direction:column;align-items:center;gap:2px;font:10px var(--nsm-font, system-ui);color:var(--nsm-text-dim, #aaa);text-transform:uppercase;letter-spacing:.4px}
.ns-bl-mul input{width:54px;height:22px;box-sizing:border-box;text-align:center;border:1px solid var(--nsm-line-strong, #444);border-radius:5px;background:var(--nsm-raised, #1b1c1e);color:var(--nsm-text, #e0e0e0);font:12px var(--nsm-font, system-ui);outline:none}
.ns-bl-mul input:focus{border-color:#7cbcff}
.ns-bl-bar{display:flex;gap:6px;flex-wrap:wrap}
.ns-bl-lock{flex:1 1 90px;min-width:0;height:26px;box-sizing:border-box;padding:0 8px;border-radius:6px;border:1px solid var(--nsm-line-strong, #444);background:var(--nsm-raised, #1b1c1e);color:var(--nsm-text-dim, #ccc);font:12px var(--nsm-font, system-ui);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-bl-lock:hover{border-color:#7cbcff}
.ns-bl-lock.hot{border-color:#ff5a5a;color:#ff9a9a;background:rgba(255,90,90,.12)}
`;

// ---------- swatch_element ----------
piece(C("swatch_element", {
    scopo: "Lista a scroll di scelte con una mini anteprima ciascuna (es. le punte del pennello); un valore, click per sceglierlo.",
    natura: "funziona", dominio: "ui", estado: "draft", archetipo: "trigger",
    tag: ["controllo", "scelta", "anteprima", "pennello"], css: CSS,
    props: {
        options: J("[{value, label, bg?, radius?, shadow?}]: bg/radius/shadow = come e' fatta la miniatura (CSS: background, border-radius, box-shadow)"),
        rows: N("righe visibili prima dello scroll", 4),
    },
    esempio: ex({ t: "swatch_element", options: [{ value: "a", label: "Round", radius: "50%" }, { value: "b", label: "Square" }], bind: "$cache.b" }),
}), (node, h) => {
    const el = mkEl("div", "ns-sw");
    const rows = Math.max(1, Number(node.rows) || 4);
    el.style.setProperty("--ns-sw-h", rows * 40 + 4 + "px");
    let cur, sig = "", onCommit = null;
    const paint = () => { for (const r of el.children) r.classList.toggle("on", r._v === cur); };
    const build = () => {
        const opts = Array.isArray(h.val(node.options)) ? h.val(node.options) : [];
        const s = JSON.stringify(opts);
        if (s !== sig) {
            sig = s; el.textContent = "";
            for (const o of opts) {
                const row = mkEl("div", "ns-sw-row"); row._v = o.value;
                const pic = mkEl("span", "ns-sw-pic"), shape = mkEl("i");
                if (o.bg) shape.style.background = String(o.bg);
                if (o.radius) shape.style.borderRadius = String(o.radius);
                if (o.shadow) shape.style.boxShadow = String(o.shadow);
                pic.appendChild(shape);
                const txt = mkEl("span", "ns-sw-txt"); txt.textContent = String(o.label ?? o.value);
                row.append(pic, txt);
                h.listen(row, "click", (e) => { e.stopPropagation(); cur = o.value; paint(); onCommit?.(); });
                h.listen(row, "pointerdown", (e) => e.stopPropagation());
                el.appendChild(row);
            }
        }
        paint();
    };
    build();
    return { el, update: build, handlesText: true, value: { get: () => cur, set: (v) => { cur = v; paint(); }, events: [], onCommit: (fn) => { onCommit = fn; } } };
});

// ---------- boxlock_element ----------
piece(C("boxlock_element", {
    scopo: "Il rettangolo del Crop disegnato in piccolo: blocca larghezza o altezza (lati rossi) e scrivi il Multiple a cui si aggancia.",
    natura: "funziona", dominio: "ui", estado: "draft", archetipo: "trigger",
    tag: ["rettangolo", "lock", "multiple", "crop"], css: CSS, uses: ["marquee_element"],
    props: {
        w: R("larghezza del rettangolo, 0 = fino al bordo (ref)"), h: R("altezza del rettangolo, 0 = fino al bordo (ref)"),
        imgW: R("larghezza dell'immagine (ref), per dare le misure quando w = 0"), imgH: R("altezza dell'immagine (ref)"),
        lockW: R("ref scritto: vero = larghezza bloccata (lati sinistro e destro rossi)"),
        lockH: R("ref scritto: vero = altezza bloccata (sopra e sotto rossi)"),
        snap: R("ref scritto: il Multiple a cui si aggancia il rettangolo (es. $native.box_snap)"),
    },
    esempio: ex({ t: "boxlock_element", w: 512, h: 384, lockW: "$cache.lw", lockH: "$cache.lh", snap: "$cache.s" }),
}), (node, h) => {
    const { rt } = h;
    const wrap = mkEl("div", "ns-bl");
    const stage = mkEl("div", "ns-bl-stage"), rect = mkEl("div", "ns-bl-rect");
    const E = Object.fromEntries(["t", "b", "l", "r"].map((k) => { const e = mkEl("div", "ns-bl-e " + k); rect.appendChild(e); return [k, e]; }));
    const mul = mkEl("div", "ns-bl-mul"), mulTxt = mkEl("span"), inp = mkEl("input");
    mulTxt.textContent = "Multiply by"; inp.type = "number"; inp.min = "1"; inp.max = "256"; inp.step = "1";
    mul.append(mulTxt, inp); rect.appendChild(mul); stage.appendChild(rect);
    const bar = mkEl("div", "ns-bl-bar"), bW = mkEl("button", "ns-bl-lock"), bH = mkEl("button", "ns-bl-lock");
    bW.type = bH.type = "button";
    bar.append(bW, bH); wrap.append(stage, bar);

    const refs = { lw: parseRef(node.lockW), lh: parseRef(node.lockH), snap: parseRef(node.snap) };
    const num = (v) => { const n = Number(h.val(v)); return Number.isFinite(n) ? n : 0; };
    const flip = (ref, cur) => { writeRef(rt, ref, !cur); rt.update?.(); };
    for (const k of ["l", "r"]) h.listen(E[k], "click", (e) => { e.stopPropagation(); flip(refs.lw, !!h.val(node.lockW)); });
    for (const k of ["t", "b"]) h.listen(E[k], "click", (e) => { e.stopPropagation(); flip(refs.lh, !!h.val(node.lockH)); });
    h.listen(bW, "click", (e) => { e.stopPropagation(); flip(refs.lw, !!h.val(node.lockW)); });
    h.listen(bH, "click", (e) => { e.stopPropagation(); flip(refs.lh, !!h.val(node.lockH)); });
    for (const el of [stage, bar]) h.listen(el, "pointerdown", (e) => e.stopPropagation());
    const commit = () => { const n = clamp(Math.round(Number(inp.value) || 1), 1, 256); inp.value = String(n); writeRef(rt, refs.snap, n); rt.update?.(); };
    h.listen(inp, "change", (e) => { e.stopPropagation(); commit(); });
    h.listen(inp, "keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { commit(); inp.blur(); } });

    const update = () => {
        const W = num(node.w) || num(node.imgW), H = num(node.h) || num(node.imgH);
        const lw = !!h.val(node.lockW), lh = !!h.val(node.lockH);
        // the little rectangle keeps the real proportions (within reason) so the lock buttons mean something
        const asp = W > 0 && H > 0 ? clamp(W / H, 0.45, 2.4) : 1.33;
        const ph = clamp(Math.round(92 / Math.max(1, asp > 1.7 ? asp / 1.7 : 1)), 58, 92);
        rect.style.height = ph + "px"; rect.style.width = Math.min(Math.round(ph * asp), 220) + "px";
        for (const k of ["l", "r"]) E[k].classList.toggle("hot", lw);
        for (const k of ["t", "b"]) E[k].classList.toggle("hot", lh);
        rect.classList.toggle("both", lw && lh);
        bW.classList.toggle("hot", lw); bH.classList.toggle("hot", lh);
        bW.textContent = `${lw ? "🔒" : "🔓"} W ${W > 0 ? Math.round(W) : "?"}`;
        bH.textContent = `${lh ? "🔒" : "🔓"} H ${H > 0 ? Math.round(H) : "?"}`;
        bW.title = "Freeze the WIDTH: the sides can't be dragged (move stays free)"; bH.title = "Freeze the HEIGHT: top and bottom can't be dragged (move stays free)";
        const s = Math.max(1, Math.round(num(node.snap)) || 1);
        if (document.activeElement !== inp && inp.value !== String(s) && !inp.matches(":focus")) inp.value = String(s);
    };
    update();
    return { el: wrap, update, handlesText: true };
});
