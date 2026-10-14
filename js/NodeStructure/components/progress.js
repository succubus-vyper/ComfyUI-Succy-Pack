// ============================================================
// NodeStructure/components/progress.js — the kit's DISPLAY module: progress_element (D-102) + status_element (D-82, moved here D-103)
// ONE animated display for anything that advances or fills up from its inputs: a header with badge + state pill,
// a "hero" (ring with a number, title, subtitle), a strip of cells (or a striped bar when there are too many),
// a row of slots that light up, and a note line. Every part shows only if the data carries it.
// Data = ONE object from a ref (usually a kit io piece, e.g. $live.loop_system.view):
//   { state: idle|running|done|stopped, pill, num, title, sub, frac: 0..1|null, spin, meter: { label, value, bar, tone, labelTone, size },
//     cells: { n, done, cur, cols, labels[] } | null, slots: [bool] | null, slotPrefix, note: { text, tone } | null }
// Look = the `fx` JSON (accent colour, which parts and which animations): no CSS in the node, ever.
// The meter (caption + bar + big value, the face of Pause and Clean VRAM) is ONE part of it: progress_element shows it when the
// data carries `meter`, and status_element is that same meter on its own (same props, same look as before).
// Born from the old Succy Loop "hero ring" — same face, now everybody can wear it.
// Succubus was here — she likes watching things go round. And round. And round.
// ============================================================
import { mkEl } from "./index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, R, J, S, E } from "../catalog/kit.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const RING_C = 163.4;           // 2·π·26
const STATES = ["idle", "running", "done", "stopped"];
const PILL = { idle: "IDLE", running: "RUNNING", done: "DONE", stopped: "STOPPED" };
const FX_DEFAULT = { accent: "#7cbcff", ring: true, cells: true, glow: true, animate: true, maxCells: 24 };

const rgbOf = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return "124,188,255";
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};

const TONES = ["info", "warn", "danger", "ok", "orange", "calm", "mute"];
const safeTone = (t, def) => (TONES.includes(String(t)) ? String(t) : def);

// ---------- meter: caption, optional bar, big value, coloured by a TONE (--ns-t-* palette) ----------
const METER_CSS = `
.ns-status{display:flex;flex-direction:column;justify-content:center;gap:5px;padding:10px;min-height:44px;background:#0e0e0e;border-radius:4px;box-shadow:inset 0 0 5px rgba(0,0,0,.5);text-align:center;box-sizing:border-box;min-width:0}
.ns-status-label{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--ns-t-mute);transition:color .2s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-status-bar{width:100%;height:6px;background:rgba(255,255,255,.05);border-radius:3px;overflow:hidden}
.ns-status-bar>i{display:block;height:100%;width:0;background:var(--ns-t-info);transition:width .3s ease,background .3s ease}
.ns-status-value{font-weight:bold;line-height:1;color:var(--ns-t-info);transition:color .2s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-status-l .ns-status-value{font-size:20px;min-height:20px}
.ns-status-m .ns-status-value{font-size:13px}
.ns-status-value:empty,.ns-status-label:empty,.ns-status-bar[hidden]{display:none}
.ns-status-l{padding:12px 10px 10px 10px;gap:4px}
`;

function makeMeter() {
    const el = mkEl("div", "ns-status");
    const label = mkEl("div", "ns-status-label");
    const bar = mkEl("div", "ns-status-bar"); const fill = mkEl("i"); bar.appendChild(fill);
    const value = mkEl("div", "ns-status-value");
    el.append(label, bar, value);
    const s = { size: "", tone: "", ltone: "", txtL: null, txtV: null, pct: null };
    // m = { label, value, bar, tone, labelTone, size } — plain values
    const apply = (m) => {
        const size = m.size === "l" ? "l" : "m";
        if (size !== s.size) { el.classList.remove("ns-status-" + (s.size || "m")); el.classList.add("ns-status-" + size); s.size = size; }
        const tone = safeTone(m.tone, "info");
        const ltone = safeTone(m.labelTone, "mute");
        const t = String(m.label ?? ""), v = String(m.value ?? "");
        if (t !== s.txtL) { s.txtL = t; label.textContent = t; }
        if (v !== s.txtV) { s.txtV = v; value.textContent = v; }
        if (tone !== s.tone) { s.tone = tone; value.style.color = `var(--ns-t-${tone})`; fill.style.background = `var(--ns-t-${tone})`; }
        if (ltone !== s.ltone) { s.ltone = ltone; label.style.color = `var(--ns-t-${ltone})`; }
        const raw = m.bar;
        const n = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
        const pct = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
        if (pct !== s.pct) { s.pct = pct; bar.hidden = pct === null; fill.style.width = (pct ?? 0) + "%"; }
    };
    return { el, apply };
}

piece(C("status_element", {
    scopo: "Display scuro di stato: caption, barra 0-100 opzionale e valore grande, colorati da un tono (info, warn, danger...).",
    natura: "estetica", estado: "draft", archetipo: "leaf",
    tag: ["stato", "barra", "display"], css: METER_CSS,
    props: {
        label: R("riga piccola in maiuscolo (testo o ref)"),
        value: R("valore grande (testo o ref); vuoto = nascosto"),
        bar: R("percentuale 0-100 della barra (numero o ref); vuoto/non numerico = barra nascosta"),
        tone: R("tono del valore e della barra (info warn danger ok orange calm mute)"),
        labelTone: R("tono della riga piccola (default mute)"),
        size: E(["l", "m"], "l = valore a 20px (countdown), m = 13px (lettura)", "m"),
    },
    esempio: ex({ t: "status_element", label: "READY TO USE", value: "12s", bar: 40, tone: "warn", size: "l" }),
}), (node, h) => {
    const m = makeMeter();
    const update = () => m.apply({ label: h.val(node.label), value: h.val(node.value), bar: h.val(node.bar), tone: h.val(node.tone), labelTone: h.val(node.labelTone), size: h.val(node.size) });
    update();
    return { el: m.el, update, handlesText: true };
});

// ---------- progress: head, hero ring, cells, slots, note (+ the meter) ----------
const CSS = METER_CSS + `
.ns-pg{--a:#7cbcff;--a-rgb:124,188,255;--ok:#4ade80;--ok-rgb:74,222,128;--bad:#ff6b6b;--bad-rgb:255,107,107;
 display:flex;flex-direction:column;gap:8px;padding:10px;box-sizing:border-box;min-width:0;width:100%;
 background:radial-gradient(120% 90% at 0% 0%,rgba(var(--a-rgb),.10),transparent 55%),linear-gradient(180deg,#1c1c1f,#141416);
 border-radius:8px;border:1px solid rgba(var(--a-rgb),.18);box-shadow:inset 0 0 18px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.4);
 font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12px;color:#e8e8ea;transition:border-color .3s,box-shadow .3s}
.ns-pg *{box-sizing:border-box}
.ns-pg.is-running{border-color:rgba(var(--a-rgb),.55)}
.ns-pg.fx-glow.is-running{box-shadow:inset 0 0 18px rgba(0,0,0,.55),0 0 14px rgba(var(--a-rgb),.25)}
.ns-pg.is-done{--a:var(--ok);--a-rgb:var(--ok-rgb);border-color:rgba(var(--ok-rgb),.45)}
.ns-pg.is-stopped{--a:var(--bad);--a-rgb:var(--bad-rgb);border-color:rgba(var(--bad-rgb),.45)}
.ns-pg-head{display:flex;align-items:center;gap:8px}
.ns-pg-badge{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:13px;color:#111;background:var(--a);transition:background .3s,box-shadow .3s}
.fx-glow .ns-pg-badge{box-shadow:0 0 10px rgba(var(--a-rgb),.55)}
.ns-pg-name{flex:1;min-width:0;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#cfcfd4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-pg-pill{font-size:9px;font-weight:700;letter-spacing:1px;padding:3px 8px;border-radius:999px;color:var(--a);background:rgba(var(--a-rgb),.12);border:1px solid rgba(var(--a-rgb),.35)}
.is-idle .ns-pg-pill{color:#7a7a82;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.10)}
.ns-pg-hero{display:flex;align-items:center;gap:12px;padding:8px 10px;background:rgba(0,0,0,.38);border-radius:8px;border:1px solid rgba(255,255,255,.05);box-shadow:inset 0 0 10px rgba(0,0,0,.5)}
.ns-pg-ring{position:relative;width:64px;height:64px;flex:none}
.ns-pg-ring svg{width:64px;height:64px;transform:rotate(-90deg);overflow:visible}
.ns-pg-ring .bg{fill:none;stroke:rgba(255,255,255,.07);stroke-width:6}
.ns-pg-ring .fg{fill:none;stroke:var(--a);stroke-width:6;stroke-linecap:round;stroke-dasharray:163.4;stroke-dashoffset:163.4;transition:stroke-dashoffset .45s cubic-bezier(.3,.8,.3,1),stroke .3s}
.fx-glow .ns-pg-ring .fg{filter:drop-shadow(0 0 4px rgba(var(--a-rgb),.8))}
.ns-pg-ring.spin .fg{stroke-dashoffset:112}
.ns-pg-num{position:absolute;inset:0;display:grid;place-items:center;font-size:17px;font-weight:800;color:#f2f2f5;letter-spacing:-.5px}
.fx-glow .ns-pg-num{text-shadow:0 0 10px rgba(var(--a-rgb),.6)}
.is-idle .ns-pg-num{color:#8a8a92;text-shadow:none}
.ns-pg-txt{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.ns-pg-title{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--a);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.is-idle .ns-pg-title{color:#7a7a82}
.ns-pg-sub{font-size:11px;color:#a4a4ac;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-pg-strip{height:40px;display:flex;gap:3px;align-items:stretch;padding:4px;background:rgba(0,0,0,.35);border-radius:6px;border:1px solid rgba(255,255,255,.05);overflow:hidden}
.ns-pg-strip.grid{display:grid;gap:2px}
.ns-pg-cell{flex:1;min-width:0;border-radius:3px;background:rgba(255,255,255,.06);display:grid;place-items:center;font-size:9px;font-weight:700;color:#6c6c74;transition:background .2s,color .2s,box-shadow .2s,transform .2s}
.ns-pg-cell.past{background:rgba(var(--a-rgb),.45);color:#fff}
.ns-pg-cell.cur{background:var(--a);color:#111;transform:scale(1.08)}
.fx-glow .ns-pg-cell.cur{box-shadow:0 0 10px rgba(var(--a-rgb),.9)}
.ns-pg-msg{margin:auto;font-size:10px;letter-spacing:.5px;color:#74747c;text-align:center}
.ns-pg-bar{flex:1;align-self:center;height:10px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden}
.ns-pg-bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,rgba(var(--a-rgb),.5),var(--a));transition:width .4s}
.fx-glow .ns-pg-bar>i{box-shadow:0 0 8px rgba(var(--a-rgb),.7)}
.ns-pg-slots{display:grid;gap:5px}
.ns-pg-slot{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 0 5px;border-radius:6px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.06);transition:all .2s}
.ns-pg-slot i{width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.10);transition:all .2s}
.ns-pg-slot span{font-size:8px;letter-spacing:.6px;color:#6c6c74;font-weight:700}
.ns-pg-slot.on{border-color:rgba(var(--a-rgb),.5);background:rgba(var(--a-rgb),.10)}
.ns-pg-slot.on i{background:var(--a)}
.fx-glow .ns-pg-slot.on i{box-shadow:0 0 8px rgba(var(--a-rgb),.9)}
.ns-pg-slot.on span{color:var(--a)}
.ns-pg-note{display:flex;align-items:center;justify-content:center;padding:7px;border-radius:6px;font-size:10px;font-weight:700;letter-spacing:1px;background:rgba(0,0,0,.32);border:1px solid rgba(255,255,255,.07);color:#7a7a82;transition:all .2s;text-align:center}
.ns-pg-note.t{color:var(--a);border-color:rgba(var(--a-rgb),.45);background:rgba(var(--a-rgb),.10)}
.ns-pg-note.f{color:var(--ok);border-color:rgba(var(--ok-rgb),.45);background:rgba(var(--ok-rgb),.10)}
.ns-pg-note.warn{color:#ffb84d;border-color:rgba(255,184,77,.35);background:rgba(255,184,77,.06)}
.ns-pg [hidden]{display:none!important}
.fx-anim.is-running .ns-pg-badge{animation:nsPgSpin 1.4s linear infinite}
.fx-anim.is-running .ns-pg-pill{animation:nsPgPulse 1.1s ease-in-out infinite}
.fx-anim .ns-pg-ring.spin svg{animation:nsPgSpin 1.6s linear infinite}
.fx-anim .ns-pg-cell.cur{animation:nsPgPulse 1s ease-in-out infinite}
.fx-anim.is-running .ns-pg-bar>i{background-size:24px 24px;background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.18) 0 6px,transparent 6px 12px),linear-gradient(90deg,rgba(var(--a-rgb),.5),var(--a));animation:nsPgStripes .8s linear infinite}
@keyframes nsPgSpin{to{transform:rotate(360deg)}}
@keyframes nsPgPulse{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes nsPgStripes{to{background-position:24px 0,0 0}}
`;

piece(C("progress_element", {
    scopo: "Display animato di avanzamento: testa, anello con numero, misuratore, celle o barra, slot accesi e nota; aspetto da JSON fx.",
    natura: "estetica", estado: "draft", archetipo: "leaf",
    tag: ["stato", "avanzamento", "display", "animazione"], css: CSS,
    props: {
        data: { ...R("oggetto vista {state, pill, num, title, sub, frac, spin, meter, cells, slots, slotPrefix, note} (di solito un pezzo io)"), required: true },
        name: S("nome nella testa (vuoto = testa senza nome)", ""),
        icon: S("glifo del badge nella testa (vuoto = niente badge)", ""),
        fx: J("aspetto {accent:'#rrggbb', ring, cells, glow, animate, maxCells}", FX_DEFAULT),
    },
    esempio: ex({ t: "progress_element", name: "Loop", icon: "↻", data: { state: "running", num: "3", title: "PASS 3 OF 8", sub: "5 to go", frac: 0.375, cells: { n: 8, done: 3, cur: true } } }),
}), (node, h) => {
    const fx = { ...FX_DEFAULT, ...(node.fx && typeof node.fx === "object" ? node.fx : {}) };
    const el = mkEl("div", "ns-pg is-idle");
    el.style.setProperty("--a", /^#[0-9a-f]{6}$/i.test(fx.accent) ? fx.accent : FX_DEFAULT.accent);
    el.style.setProperty("--a-rgb", rgbOf(fx.accent));
    el.classList.toggle("fx-glow", fx.glow !== false);
    el.classList.toggle("fx-anim", fx.animate !== false);

    // head
    const head = mkEl("div", "ns-pg-head");
    const badge = mkEl("div", "ns-pg-badge"); const name = mkEl("div", "ns-pg-name"); const pill = mkEl("div", "ns-pg-pill");
    head.append(badge, name, pill);
    // hero
    const hero = mkEl("div", "ns-pg-hero");
    const ring = mkEl("div", "ns-pg-ring");
    const svg = document.createElementNS(SVG_NS, "svg"); svg.setAttribute("viewBox", "0 0 64 64");
    const bg = document.createElementNS(SVG_NS, "circle"), fg = document.createElementNS(SVG_NS, "circle");
    for (const c of [bg, fg]) { c.setAttribute("cx", "32"); c.setAttribute("cy", "32"); c.setAttribute("r", "26"); }
    bg.setAttribute("class", "bg"); fg.setAttribute("class", "fg");
    svg.append(bg, fg);
    const numEl = mkEl("div", "ns-pg-num");
    ring.append(svg, numEl);
    const txt = mkEl("div", "ns-pg-txt"); const title = mkEl("div", "ns-pg-title"); const sub = mkEl("div", "ns-pg-sub");
    txt.append(title, sub); hero.append(ring, txt);
    // strip, slots, note
    const strip = mkEl("div", "ns-pg-strip");
    const slots = mkEl("div", "ns-pg-slots");
    const note = mkEl("div", "ns-pg-note");
    const meter = makeMeter();
    el.append(head, hero, meter.el, strip, slots, note);

    const s = { state: "", key: "", cells: [], fill: null, slotN: -1, slotEls: [], k: {} };
    const put = (k, v, fn) => { if (s.k[k] !== v) { s.k[k] = v; fn(v); } };

    const renderStrip = (c, state) => {
        if (!c || fx.cells === false) { strip.hidden = true; s.key = ""; return; }
        strip.hidden = false;
        const n = Math.max(0, Number(c.n) || 0);
        const labels = Array.isArray(c.labels) ? c.labels : null;
        const key = `${n}|${c.cols || 0}|${labels ? labels.join(",") : ""}|${c.msg || ""}`;
        if (key !== s.key) {
            s.key = key; s.cells = []; s.fill = null; strip.textContent = ""; strip.classList.remove("grid"); strip.style.gridTemplateColumns = "";
            if (!n) { strip.appendChild(Object.assign(mkEl("div", "ns-pg-msg"), { textContent: c.msg || "" })); }
            else if (n > (Number(fx.maxCells) || 24)) {
                const bar = mkEl("div", "ns-pg-bar"); s.fill = mkEl("i"); bar.appendChild(s.fill);
                strip.append(bar, Object.assign(mkEl("div", "ns-pg-msg"), { textContent: c.msg || `${n} steps` }));
            } else {
                if (c.cols) { strip.classList.add("grid"); strip.style.gridTemplateColumns = `repeat(${Math.max(1, c.cols)}, 1fr)`; }
                for (let i = 0; i < n; i++) {
                    const cell = mkEl("div", "ns-pg-cell");
                    if (labels && labels[i] !== undefined) cell.textContent = String(labels[i]);
                    strip.appendChild(cell); s.cells.push(cell);
                }
            }
        }
        const done = Math.max(0, Number(c.done) || 0);
        if (s.fill) { s.fill.style.width = `${n ? Math.min(100, (done / n) * 100) : 0}%`; return; }
        const finished = state === "done";
        s.cells.forEach((cell, i) => {
            cell.classList.toggle("past", finished || i < done);
            cell.classList.toggle("cur", !finished && !!c.cur && state === "running" && i === done);
        });
    };

    const renderSlots = (list, prefix) => {
        if (!Array.isArray(list)) { slots.hidden = true; return; }
        slots.hidden = false;
        if (list.length !== s.slotN) {
            s.slotN = list.length; s.slotEls = []; slots.textContent = "";
            slots.style.gridTemplateColumns = `repeat(${Math.max(1, list.length)}, 1fr)`;
            list.forEach((_, i) => {
                const c = mkEl("div", "ns-pg-slot"); c.append(mkEl("i"), Object.assign(mkEl("span"), { textContent: `${prefix ?? ""}${i}` }));
                slots.appendChild(c); s.slotEls.push(c);
            });
        }
        list.forEach((on, i) => s.slotEls[i].classList.toggle("on", !!on));
    };

    const apply = () => {
        const d = h.val(node.data) || {};
        const state = STATES.includes(d.state) ? d.state : "idle";
        if (state !== s.state) { for (const x of STATES) el.classList.toggle("is-" + x, x === state); s.state = state; }
        const nm = String(h.val(node.name) ?? ""), ic = String(h.val(node.icon) ?? "");
        put("name", nm, (v) => { name.textContent = v; });
        put("icon", ic, (v) => { badge.textContent = v; badge.hidden = !v; });
        put("pill", String(d.pill ?? PILL[state]), (v) => { pill.textContent = v; });
        head.hidden = !nm && !ic;
        put("num", String(d.num ?? ""), (v) => { numEl.textContent = v; });
        put("title", String(d.title ?? ""), (v) => { title.textContent = v; });
        put("sub", String(d.sub ?? ""), (v) => { sub.textContent = v; });
        ring.hidden = fx.ring === false;
        const spin = !!d.spin && state === "running";
        ring.classList.toggle("spin", spin);
        const f = Number(d.frac);
        put("frac", spin ? "" : String(Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0), (v) => { fg.style.strokeDashoffset = v === "" ? "" : String(RING_C * (1 - Number(v))); });
        hero.hidden = d.num === undefined && d.title === undefined && d.sub === undefined;
        meter.el.hidden = !d.meter;
        if (d.meter) meter.apply(d.meter);
        renderStrip(d.cells, state);
        renderSlots(d.slots, d.slotPrefix);
        const nt = d.note && d.note.text ? d.note : null;
        note.hidden = !nt;
        if (nt) put("note", `${nt.tone || ""}|${nt.text}`, () => { note.className = `ns-pg-note ${nt.tone || ""}`.trim(); note.textContent = String(nt.text); });
    };
    apply();
    return { el, update: apply, handlesText: true };
});
