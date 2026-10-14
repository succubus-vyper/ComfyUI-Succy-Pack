// ============================================================
// NodeStructure/components/controls.js
// Basic controls. Every control with a `value` gets tied up with `bind`
// (the renderer reads/writes the ref: the component doesn't know where it lives).
// ============================================================

import { mkEl, num, normOptions } from "./index.js";
import { piece } from "../catalog/registry.js";
import { FloatMenu } from "../menu/float-menu.js";
let SELECT_SEQ = 0;
import { C, ex, E, N, S, B, R, J } from "../catalog/kit.js";

const TXT_CSS = `
.ns-label-mono{font:10px monospace;color:#8a8;text-transform:none;letter-spacing:0}
.ns-label-section{font:bold 10px monospace;letter-spacing:.8px;text-transform:uppercase;color:#888}
.ns-label-warn{color:var(--ns-warn);text-transform:none;letter-spacing:0;white-space:normal;font-size:11px}
.ns-label-error{color:var(--ns-danger);text-transform:none;letter-spacing:0;white-space:pre-wrap;font:10px monospace}
.ns-label-hint{color:var(--ns-fg-faint);text-transform:none;letter-spacing:0;font-size:10px;white-space:normal}
.ns-label-value{color:var(--ns-fg);text-transform:none;letter-spacing:0;font-size:11px}
.ns-empty{color:#444;font:10px monospace;letter-spacing:1px;text-transform:uppercase}
.ns-pre-console{padding:10px;background:#0e0e0e;color:#ddd;border-radius:4px;line-height:1.5;font:12px monospace;user-select:text}
`;
const PLAIN = (v) => String(v || "").replace(/[^\w-]/g, "");

// ---------- text ----------
piece(C("label_element", {
    scopo: "Etichetta di testo breve, con varianti di aspetto (caption, mono, section, warn, error, hint, value).", natura: "estetica", estado: "stable", archetipo: "leaf",
    tag: ["testo"], alias: ["label"], css: TXT_CSS,
    props: { variant: E(["caption", "mono", "section", "warn", "error", "hint", "value"], "aspetto del testo", "caption") },
    esempio: ex({ t: "label_element", variant: "section", text: "titolo" }),
}), (node, h) => {
    const el = mkEl("span", "ns-label");
    let cur = "";
    const apply = () => {
        const v = PLAIN(h.val(node.variant));
        const want = v && v !== "caption" ? v : "";
        if (want === cur) return;
        if (cur) el.classList.remove("ns-label-" + cur);
        if (want) el.classList.add("ns-label-" + want);
        cur = want;
    };
    apply();
    return { el, update: apply };
});
piece(C("text_element", {
    scopo: "Blocco di testo che va a capo; mostra `empty` (attenuato) quando e' vuoto.", natura: "estetica", estado: "stable", archetipo: "leaf",
    tag: ["testo"], alias: ["text"], props: { empty: S("testo mostrato quando il contenuto e' vuoto") },
    esempio: ex({ t: "text_element", text: "ciao", empty: "niente" }),
}), (node, h) => emptyAware("div", "ns-text", node, h));
piece(C("pre_element", {
    scopo: "Testo a spaziatura fissa (log, JSON); variante console = fondo scuro; `empty` quando vuoto.", natura: "estetica", estado: "stable", archetipo: "leaf",
    tag: ["testo", "mono"], alias: ["pre"], props: { empty: S("testo mostrato quando il contenuto e' vuoto"), variant: E(["plain", "console"], "aspetto", "plain") },
    esempio: ex({ t: "pre_element", variant: "console", text: "riga", empty: "-" }),
}), (node, h) => emptyAware("div", "ns-pre", node, h));
// text with a placeholder: the renderer writes node.text (handlesText=false); here we dress it up in update()
function emptyAware(tag, cls, node, h) {
    const el = mkEl(tag, cls);
    let cur = "";
    const apply = () => {
        const v = PLAIN(h.val(node.variant));
        const want = v && v !== "plain" ? v : "";
        if (want !== cur) { if (cur) el.classList.remove("ns-pre-" + cur); if (want) el.classList.add("ns-pre-" + want); cur = want; }
        const ph = h.val(node.empty);
        if (typeof ph === "string") {
            const isEmpty = !el.textContent || el.dataset.nsPh === "1";
            const real = h.val(node.text);
            const realStr = real === undefined || real === null ? "" : String(real);
            if (!realStr) { if (el.textContent !== ph) el.textContent = ph; el.dataset.nsPh = "1"; el.classList.add("ns-empty"); }
            else { if (isEmpty && el.dataset.nsPh === "1") el.textContent = realStr; delete el.dataset.nsPh; el.classList.remove("ns-empty"); }
        }
    };
    apply();
    return { el, update: apply };
}
piece(C("badge_element", {
    scopo: "Piccola etichetta a pillola con tono (accent, warn).", natura: "estetica", estado: "stable", archetipo: "leaf",
    tag: ["testo", "stato"], alias: ["badge"], props: { tone: E(["accent", "warn"], "colore", undefined) },
    esempio: ex({ t: "badge_element", tone: "accent", text: "ok" }),
}), (node, h) => {
    const el = mkEl("span", "ns-badge");
    let cur = "";
    const apply = () => {      // classList (NOT className): doesn't wipe out class/classIf set by the renderer
        const tone = String(h.val(node.tone) || "").replace(/[^\w-]/g, "");
        if (tone === cur) return;
        if (cur) el.classList.remove("ns-badge-" + cur);
        if (tone) el.classList.add("ns-badge-" + tone);
        cur = tone;
    };
    apply();
    return { el, update: apply };
});

// ---------- button ----------
piece(C("button_element", {
    scopo: "Pulsante: testo (o icona), variante, glifo di riserva e due testi legati a uno stato.", natura: "funziona", estado: "stable", archetipo: "trigger",
    tag: ["controllo", "click"], alias: ["button"],
    props: {
        variant: E(["ghost", "primary", "icon"], "aspetto", undefined), icon: S("testo/icona al posto di text"),
        glyph: S("testo mostrato quando text e' vuoto"), state: R("stato booleano che sceglie fra labels"), labels: J("[testoSeVero, testoSeFalso] usati con state"),
    },
    esempio: ex({ t: "button_element", text: "ok", glyph: "x", state: "$state.flag", labels: ["on", "off"] }, { state: { flag: { policy: "ui", default: true } } }),
}), (node, h) => {
    const el = mkEl("button", "ns-btn");
    el.type = "button";
    let cur = "";
    const apply = () => {      // classList (NOT className): doesn't wipe out class/classIf set by the renderer
        const v = String(h.val(node.variant) || "").replace(/[^\w-]/g, "");
        if (v !== cur) { if (cur) el.classList.remove("ns-btn-" + cur); if (v) el.classList.add("ns-btn-" + v); cur = v; }
        const ic = h.val(node.icon);
        if (ic !== undefined && node.text === undefined) el.textContent = String(ic);
        if (node.labels !== undefined && node.state !== undefined) {         // two texts bound to one state
            const lb = h.val(node.labels), on = !!h.val(node.state);
            if (Array.isArray(lb)) { const t = String(on ? lb[0] : lb[1] ?? ""); if (el.textContent !== t) el.textContent = t; }
        } else if (node.glyph !== undefined && !el.textContent) el.textContent = String(h.val(node.glyph) ?? "");
    };
    apply();
    return { el, update: apply };
});

// ---------- toggle (checkbox with label) ----------
piece(C("toggle_element", {
    scopo: "Casella on/off con etichetta, legabile con bind.", estado: "stable", archetipo: "trigger",
    tag: ["controllo", "bool"], alias: ["toggle"], props: { label: S("etichetta") },
    esempio: ex({ t: "toggle_element", label: "attivo", bind: "$cache.t" }),
}), (node, h) => {
    const el = mkEl("label", "ns-toggle");
    const inp = mkEl("input");
    inp.type = "checkbox";
    const lab = mkEl("span", "ns-toggle-label");
    el.append(inp, lab);
    const apply = () => { lab.textContent = String(h.val(node.label) ?? ""); };
    apply();
    return {
        el, update: apply, handlesText: true,
        value: { get: () => inp.checked, set: (v) => { inp.checked = !!v; }, events: ["change"] },
        input: inp,
    };
});

// ---------- input / textarea / number ----------
const TEXTPROPS = { placeholder: S("segnaposto"), readonly: B("sola lettura", false), mono: B("font monospazio", false), stopKeys: B("non far uscire i tasti dal campo", false), when: E(["input", "change"], "quando scrivere nel bind", "input") };
function textLike(tag, cls) {
    return (node, h) => {
        const inp = mkEl(tag, cls);
        if (tag === "input") inp.type = "text";
        const apply = () => {
            const ph = h.val(node.placeholder);
            if (ph !== undefined) inp.placeholder = String(ph);
            const ro = h.val(node.readonly);
            inp.readOnly = ro === true;
            if (h.val(node.mono) === true) inp.classList.add("ns-mono");
        };
        apply();
        const stop = h.val(node.stopKeys) === true;
        if (stop) for (const ev of ["keydown", "keyup", "keypress"]) h.listen(inp, ev, (e) => e.stopPropagation());
        const commit = h.val(node.when) === "change" ? "change" : "input";
        return {
            el: inp, update: apply, handlesText: true,
            value: { get: () => inp.value, set: (v) => { inp.value = v == null ? "" : String(v); }, events: commit === "input" ? ["input", "change"] : ["change"] },
        };
    };
}
piece(C("input_element", {
    scopo: "Campo di testo a una riga, legabile con bind.", estado: "stable", archetipo: "trigger",
    tag: ["controllo", "testo"], alias: ["input"], props: TEXTPROPS,
    esempio: ex({ t: "input_element", bind: "$cache.v", placeholder: "..." }),
}), textLike("input", "ns-input"));
piece(C("textarea_element", {
    scopo: "Campo di testo multiriga, legabile con bind.", estado: "stable", archetipo: "trigger",
    tag: ["controllo", "testo"], alias: ["textarea"], props: TEXTPROPS,
    esempio: ex({ t: "textarea_element", bind: "$cache.v" }),
}), textLike("textarea", "ns-input ns-textarea"));

piece(C("number_element", {
    scopo: "Campo numerico con min/max/step, legabile con bind.", estado: "stable", archetipo: "trigger",
    tag: ["controllo", "numero"], alias: ["number"], props: { min: N("minimo"), max: N("massimo"), step: N("passo") },
    esempio: ex({ t: "number_element", min: 0, max: 9, bind: "$cache.n" }),
}), (node, h) => {
    const inp = mkEl("input", "ns-input ns-number");
    inp.type = "number";
    const apply = () => {
        for (const k of ["min", "max", "step"]) {
            const v = h.val(node[k]);
            if (v !== undefined) inp.setAttribute(k, String(v)); else inp.removeAttribute(k);
        }
    };
    apply();
    return {
        el: inp, update: apply, handlesText: true,
        value: {
            get: () => (inp.value === "" ? 0 : Number(inp.value)),
            set: (v) => { inp.value = v == null ? "" : String(v); },
            events: ["input", "change"],
        },
    };
});

// ---------- stepper:  [-] [ n ] [+] ----------
piece(C("stepper_element", {
    scopo: "Numero con pulsanti - e +, limiti e passo; legabile con bind.", estado: "stable", archetipo: "trigger",
    tag: ["controllo", "numero"], alias: ["stepper"], props: { min: N("minimo"), max: N("massimo"), step: N("passo", 1), int: B("solo interi", true) },
    esempio: ex({ t: "stepper_element", min: 0, max: 9, bind: "$cache.n" }),
}), (node, h) => {
    const el = mkEl("div", "ns-stepper");
    const minus = mkEl("button", "ns-step"); minus.type = "button"; minus.textContent = "−";
    const inp = mkEl("input", "ns-step-input"); inp.type = "text"; inp.inputMode = "numeric";
    const plus = mkEl("button", "ns-step"); plus.type = "button"; plus.textContent = "+";
    el.append(minus, inp, plus);
    const lim = () => ({ min: num(h, node.min, -Infinity), max: num(h, node.max, Infinity), step: num(h, node.step, 1), int: h.val(node.int) !== false });
    const clamp = (x) => {
        const { min, max, int } = lim();
        let n = Number(x);
        if (!Number.isFinite(n)) n = 0;
        if (int) n = Math.floor(n);
        return Math.max(min, Math.min(max, n));
    };
    let onCommit = null;
    const bump = (d) => { inp.value = String(clamp((Number(inp.value) || 0) + d * lim().step)); onCommit?.(); };
    h.listen(minus, "click", (e) => { e.stopPropagation(); bump(-1); });
    h.listen(plus, "click", (e) => { e.stopPropagation(); bump(1); });
    h.listen(inp, "change", () => { inp.value = String(clamp(inp.value)); });
    return {
        el, handlesText: true,
        value: {
            get: () => clamp(inp.value),
            set: (v) => { inp.value = String(clamp(v)); },
            events: ["change"],
            // the renderer registers its commit here for the +/- clicks
            onCommit: (fn) => { onCommit = fn; },
        },
    };
});

// ---------- select ----------
piece(C("select_element", {
    scopo: "Menu a tendina con opzioni statiche o da ref; legabile con bind.", estado: "stable", archetipo: "trigger",
    tag: ["controllo", "scelta"], alias: ["select"], props: { options: J("[valore | {value,label}] oppure ref a una lista") },
    esempio: ex({ t: "select_element", options: ["a", "b"], bind: "$cache.s" }),
}), (node, h) => {
    // OUR OWN dropdown (not <select>): the native popup can't be styled consistently across browsers/OSes.
    // The button opens a kit menu (dark list, keyboard, click-outside/Esc handled by float-menu). We dress it ourselves.
    const el = mkEl("button", "ns-select");
    el.type = "button";
    const lab = mkEl("span", "ns-select-label"), caret = mkEl("span", "ns-select-caret");
    caret.textContent = "▾";
    el.append(lab, caret);
    const menuName = "select:" + (++SELECT_SEQ);
    let list = [], cur, want, sig = "";
    const apply = () => {
        const opts = normOptions(h.val(node.options));
        const c = want !== undefined ? want : cur;
        // the current value must stay selectable even if it isn't in the list
        list = (c !== undefined && !opts.some((o) => o.value === c)) ? [...opts, { value: c, label: String(c) }] : opts;
        if (c !== undefined) cur = c;
        const o = list.find((x) => x.value === cur);
        const t = o ? o.label : (cur === undefined ? "" : String(cur));
        if (lab.textContent !== t) lab.textContent = t;
        sig = JSON.stringify(list);
    };
    apply();
    const choose = (v) => { cur = v; want = undefined; apply(); el.dispatchEvent(new Event("change", { bubbles: true })); };
    h.listen(el, "click", (e) => {
        e.stopPropagation();
        apply();
        FloatMenu.open(h.rt, menuName, {
            anchor: el,
            spec: { kind: "list", items: list.map((o) => ({ label: o.label, checked: o.value === cur, action: () => choose(o.value) })) },
        });
    });
    return {
        el, update: apply, handlesText: true,
        value: {
            get: () => cur,
            set: (v) => { want = v; cur = v; apply(); },
            events: ["change"],
        },
    };
});

// ---------- segmented: group of mutually exclusive buttons ----------
piece(C("segmented_element", {
    scopo: "Gruppo di pulsanti esclusivi (scelta singola); legabile con bind.", estado: "stable", archetipo: "trigger",
    tag: ["controllo", "scelta"], alias: ["segmented"], props: { options: J("[valore | {value,label}] oppure ref a una lista") },
    esempio: ex({ t: "segmented_element", options: [{ value: false, label: "Off" }, { value: true, label: "On" }], bind: "$cache.b" }),
}), (node, h) => {
    const el = mkEl("div", "ns-seg");
    let sig = "", cur, onCommit = null;
    const build = () => {
        const opts = normOptions(h.val(node.options));
        const s = JSON.stringify(opts);
        if (s !== sig) {
            sig = s;
            el.textContent = "";
            opts.forEach((o) => {
                const b = mkEl("button", "ns-seg-btn"); b.type = "button"; b.textContent = o.label;
                if (o.tone) b.classList.add("ns-tone-" + String(o.tone).replace(/[^\w-]/g, ""));      // D-82: per-option colour (soft/hard/nuke...)
                if (o.fx) b.classList.add("ns-tone-fx");
                b._v = o.value;
                h.listen(b, "click", (e) => { e.stopPropagation(); cur = o.value; paint(); onCommit?.(); });
                el.appendChild(b);
            });
        }
        paint();
    };
    const paint = () => { for (const b of el.children) b.classList.toggle("ns-active", b._v === cur); };
    build();
    return {
        el, update: build, handlesText: true,
        value: { get: () => cur, set: (v) => { cur = v; paint(); }, events: [], onCommit: (fn) => { onCommit = fn; } },
    };
});

// ---------- combo: dropdown with filter (field_element kind select) ----------
// Closed: up/down arrows = previous/next entry (applied right away: you "flick through" the effects); a letter opens it with the filter.
// Open: typing = filters; arrows = highlight AND apply; Enter/click = confirm and close; Esc = close (the menu stays open);
// click outside = close. The popup is position:fixed inside the same shadow root as the menu (so it doesn't get cut off).
const COMBO_CSS = `
.ns-combo{display:flex;align-items:center;gap:6px;text-align:left;cursor:pointer;min-width:0}
.ns-combo .ns-select-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ns-combo:focus-visible{outline:none;box-shadow:0 0 0 3px var(--nsm-focus, rgba(122,162,247,.35))}
.ns-combo-pop{position:fixed;z-index:999999;display:flex;flex-direction:column;min-width:160px;max-height:260px;box-sizing:border-box;padding:4px;gap:4px;background:var(--nsm-raised, var(--ns-c-menu-bg, #1b1c1e));border:1px solid var(--nsm-line-strong, var(--ns-border, #444));border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.5);pointer-events:auto;font:12px var(--nsm-font, system-ui)}
.ns-combo-filter{flex:none;height:26px;box-sizing:border-box;padding:0 8px;border:1px solid var(--nsm-line-strong, #444);border-radius:6px;background:var(--nsm-field, #0f1011);color:var(--nsm-text, #e0e0e0);font:12px var(--nsm-font, system-ui);outline:none}
.ns-combo-list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column}
.ns-combo-item{flex:none;padding:5px 8px;border-radius:5px;color:var(--nsm-text-dim, #ccc);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-combo-item:hover{background:var(--nsm-surface-hover, rgba(255,255,255,.06))}
.ns-combo-item.ns-hi{background:var(--nsm-accent-soft, rgba(74,158,255,.2));color:var(--nsm-text-strong, #fff)}
.ns-combo-item.ns-on{font-weight:600}
.ns-combo-empty{padding:6px 8px;color:var(--nsm-text-faint, #777)}
`;
function combo(h, getOpts, getCur, choose) {
    const btn = mkEl("button", "ns-select ns-combo"); btn.type = "button";
    const lab = mkEl("span", "ns-select-label"), caret = mkEl("span", "ns-select-caret"); caret.textContent = "▾";
    btn.append(lab, caret);
    let pop = null, list = [], hi = -1, off = [];
    const idxOf = (v) => getOpts().findIndex((o) => o.value === v);
    btn._paint = () => { const o = getOpts().find((x) => x.value === getCur()); const t = o ? o.label : (getCur() == null ? "" : String(getCur())); if (lab.textContent !== t) lab.textContent = t; };
    const step = (d) => { const o = getOpts(); if (!o.length) return; let i = idxOf(getCur()); i = i < 0 ? 0 : (i + d + o.length) % o.length; choose(o[i].value); };
    const close = () => { if (!pop) return; for (const f of off) { try { f(); } catch (_) {} } off = []; try { pop.remove(); } catch (_) {} pop = null; try { btn.focus({ preventScroll: true }); } catch (_) {} };
    const open = (seed = "") => {
        if (pop) return;
        pop = mkEl("div", "ns-combo-pop");
        const inp = mkEl("input", "ns-combo-filter"); inp.type = "text"; inp.placeholder = "Filter…"; inp.value = seed; inp.spellcheck = false;
        const box = mkEl("div", "ns-combo-list");
        pop.append(inp, box);
        (btn.getRootNode() instanceof ShadowRoot ? btn.getRootNode() : document.body).appendChild(pop);
        const r = btn.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(r.left, innerWidth - Math.max(r.width, 160) - 8)) + "px";
        pop.style.width = Math.max(r.width, 160) + "px";
        const below = innerHeight - r.bottom - 8;
        if (below >= 160 || below >= r.top - 8) { pop.style.top = (r.bottom + 4) + "px"; pop.style.maxHeight = Math.max(120, Math.min(260, below - 4)) + "px"; }
        else { pop.style.bottom = (innerHeight - r.top + 4) + "px"; pop.style.maxHeight = Math.max(120, Math.min(260, r.top - 12)) + "px"; }
        const paint = () => {
            const q = inp.value.trim().toLowerCase();
            list = getOpts().filter((o) => !q || o.label.toLowerCase().includes(q) || String(o.value).toLowerCase().includes(q));
            box.textContent = "";
            if (!list.length) { const e = mkEl("div", "ns-combo-empty"); e.textContent = "No match"; box.append(e); return; }
            list.forEach((o, i) => {
                const it = mkEl("div", "ns-combo-item"); it.textContent = o.label;
                if (o.value === getCur()) it.classList.add("ns-on");
                if (i === hi) it.classList.add("ns-hi");
                it.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); choose(o.value); close(); });
                box.append(it);
            });
            box.children[hi]?.scrollIntoView?.({ block: "nearest" });
        };
        hi = Math.max(0, getOpts().findIndex((o) => o.value === getCur()));
        if (seed) hi = 0;
        paint();
        inp.addEventListener("input", () => { hi = 0; paint(); });
        inp.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault(); if (!list.length) return;
                hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
                choose(list[hi].value, "live"); paint();
            } else if (e.key === "Enter") { e.preventDefault(); if (list[hi]) choose(list[hi].value); close(); }
            else if (e.key === "Escape") { e.preventDefault(); close(); }
        });
        for (const t of ["pointerdown", "mousedown", "click", "wheel", "keyup", "dblclick"]) pop.addEventListener(t, (e) => e.stopPropagation(), t === "wheel" ? { passive: true } : undefined);
        const root = pop.getRootNode();
        const outside = (e) => { const p = e.composedPath?.() || []; if (!p.includes(pop) && !p.includes(btn)) close(); };
        root.addEventListener("pointerdown", outside, true);
        off.push(() => root.removeEventListener("pointerdown", outside, true));
        try { inp.focus({ preventScroll: true }); inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {}
    };
    h.listen(btn, "click", (e) => { e.stopPropagation(); pop ? close() : open(); });
    h.listen(btn, "keydown", (e) => {
        if (pop) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); step(e.key === "ArrowDown" ? 1 : -1); }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); open(); }
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); open(e.key); }
    });
    h.bag.add(close);
    return btn;
}

// ---------- field: label row + control picked from the data ----------
// kind: range | color | select | toggle | number | text
// (the component decides what to draw: no `if` in the JSON)
piece(C("field_element", {
    scopo: "Riga etichetta + controllo scelto dal dato (range, color, rgba, select, toggle, number, text).", estado: "stable", archetipo: "trigger",
    tag: ["controllo", "form"], alias: ["field"], css: COMBO_CSS,
    props: {
        kind: E(["range", "color", "rgba", "select", "toggle", "number", "text"], "quale controllo disegnare (rgba = colore + opacita', valore #rrggbbaa)", "text"), label: S("etichetta"),
        min: N("minimo"), max: N("massimo"), step: N("passo"), options: J("opzioni per kind=select"),
    },
    esempio: ex({ t: "field_element", kind: "range", label: "x", min: 0, max: 1, step: 0.1, bind: "$cache.f" }),
}), (node, h) => {
    const el = mkEl("div", "ns-field");
    const lab = mkEl("label", "ns-field-label");
    const body = mkEl("div", "ns-field-body");
    el.append(lab, body);
    let kind = null, ctl = null, valEl = null, onCommit = null, cur;
    const decs = () => { const s = Number(h.val(node.step)); return Number.isFinite(s) && String(s).includes(".") ? String(s).split(".")[1].length : 0; };
    const toHex = (c) => {
        if (typeof c !== "string") return "#999999";
        if (/^#[0-9a-f]{6}$/i.test(c)) return c;
        if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + c.slice(1).split("").map((x) => x + x).join("");
        const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        return m ? "#" + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, "0")).join("") : "#999999";
    };
    const build = () => {
        const k = String(h.val(node.kind) || "text");
        lab.textContent = String(h.val(node.label) ?? "");
        if (k === kind) {
            if (k === "select") rebuildSelect();
            return;
        }
        kind = k; body.textContent = ""; valEl = null;
        el.classList.toggle("ns-field-wide", k === "toggle");
        if (k === "range") {
            ctl = mkEl("input"); ctl.type = "range";
            valEl = mkEl("span", "ns-field-val");
            body.append(ctl, valEl);
            h.listen(ctl, "input", () => { cur = Number(ctl.value); valEl.textContent = cur.toFixed(decs()); fillPct(); });
            // click on the value -> type it by hand (Enter confirms, Esc cancels, outside = confirm); clamped to min/max
            valEl.title = "Click to type a value";
            valEl.style.cursor = "text";
            h.listen(valEl, "click", (e) => {
                e.stopPropagation();
                if (body.querySelector(".ns-field-val-edit")) return;
                const inp = mkEl("input", "ns-field-val-edit"); inp.type = "text"; inp.inputMode = "decimal";
                inp.value = valEl.textContent; inp.style.width = Math.max(44, valEl.offsetWidth + 14) + "px";
                valEl.style.display = "none"; body.append(inp); inp.focus(); inp.select();
                let done = false;
                const finish = (ok) => {
                    if (done) return; done = true;
                    const v = Number(String(inp.value).replace(",", "."));
                    inp.remove(); valEl.style.display = "";
                    if (!ok || !Number.isFinite(v)) return;
                    const mn = ctl.min !== "" ? Number(ctl.min) : -Infinity, mx = ctl.max !== "" ? Number(ctl.max) : Infinity;
                    cur = Math.min(mx, Math.max(mn, v));
                    ctl.value = String(cur); valEl.textContent = Number(cur).toFixed(decs()); fillPct();
                    onCommit?.();
                };
                inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") finish(true); else if (ev.key === "Escape") finish(false); });
                inp.addEventListener("blur", () => finish(true));
                for (const t of ["pointerdown", "mousedown", "click", "dblclick", "wheel"]) inp.addEventListener(t, (ev) => ev.stopPropagation());
            });
            h.listen(ctl, "change", () => { cur = Number(ctl.value); });
        } else if (k === "color") {
            ctl = mkEl("input"); ctl.type = "color"; body.append(ctl);
            h.listen(ctl, "change", () => { cur = ctl.value; });
            h.listen(ctl, "input", () => { cur = ctl.value; onCommit?.("live"); });      // live preview while choosing — a little peek before committing
        } else if (k === "rgba") {
            // color + opacity (0..255 slider below): value "#rrggbbaa"
            ctl = mkEl("input"); ctl.type = "color";
            const al = mkEl("input", "ns-field-alpha"); al.type = "range"; al.min = "0"; al.max = "255"; al.step = "1"; al.title = "Opacity";
            ctl._alpha = al; body.append(ctl, al);
            const rgba = () => ctl.value + Number(al.value).toString(16).padStart(2, "0");
            const fillA = () => { try { al.style.setProperty("--p", ((Number(al.value) / 255) * 100).toFixed(1) + "%"); } catch (_) {} };
            h.listen(ctl, "input", () => { cur = rgba(); onCommit?.("live"); });
            h.listen(ctl, "change", () => { cur = rgba(); });
            h.listen(al, "input", () => { cur = rgba(); fillA(); onCommit?.("live"); });
            h.listen(al, "change", () => { cur = rgba(); onCommit?.(); });
            ctl._fillA = fillA;
        } else if (k === "toggle") {
            ctl = mkEl("input"); ctl.type = "checkbox"; body.append(ctl);
            h.listen(ctl, "change", () => { cur = ctl.checked; });
        } else if (k === "select") {
            ctl = combo(h, () => ctl._ns || [], () => cur, (v, mode) => { cur = v; paintValue(); onCommit?.(mode); });
            body.append(ctl); rebuildSelect();
        } else if (k === "number") {
            ctl = mkEl("input", "ns-input"); ctl.type = "number"; body.append(ctl);
            h.listen(ctl, "change", () => { cur = Number(ctl.value); });
        } else {
            ctl = mkEl("input", "ns-input"); ctl.type = "text"; body.append(ctl);
            h.listen(ctl, "change", () => { cur = ctl.value; });
        }
        if (k !== "select") h.listen(ctl, "change", () => onCommit?.());
        if (k === "range") h.listen(ctl, "input", () => onCommit?.("live"));
        paintAttrs();
    };
    const rebuildSelect = () => {
        const opts = normOptions(h.val(node.options));
        const s = JSON.stringify(opts);
        if (ctl._sig === s) return;
        ctl._sig = s; ctl._ns = opts; ctl._paint?.();
    };
    const paintAttrs = () => {
        if (kind === "range" || kind === "number") for (const a of ["min", "max", "step"]) {
            const v = h.val(node[a]); if (v !== undefined) ctl.setAttribute(a, String(v)); else ctl.removeAttribute(a);
        }
    };
    // track fill (menu v2: --p); harmless elsewhere
    const fillPct = () => { try { const mn = Number(ctl.min || 0), mx = Number(ctl.max || 100); ctl.style.setProperty("--p", (((Number(ctl.value) - mn) / ((mx - mn) || 1)) * 100).toFixed(1) + "%"); } catch (_) {} };
    const paintValue = () => {
        if (!ctl) return;
        if (kind === "range") { ctl.value = String(cur ?? 0); valEl.textContent = Number(cur ?? 0).toFixed(decs()); fillPct(); }
        else if (kind === "color") ctl.value = toHex(cur);
        else if (kind === "rgba") {
            const s = typeof cur === "string" ? cur.trim().toLowerCase() : "";
            const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
            ctl.value = m ? "#" + m[1] : toHex(cur);
            ctl._alpha.value = String(m && m[2] ? parseInt(m[2], 16) : 255);
            ctl._fillA();
        }
        else if (kind === "toggle") ctl.checked = !!cur;
        else if (kind === "select") ctl._paint();
        else ctl.value = cur == null ? "" : String(cur);
    };
    build();
    return {
        el, handlesText: true,
        update: () => { build(); paintAttrs(); },
        value: {
            get: () => cur,
            set: (v) => { cur = v; paintValue(); },
            events: [],
            onCommit: (fn) => { onCommit = fn; },
        },
    };
});
