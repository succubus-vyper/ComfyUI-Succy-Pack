// ============================================================
// pieces/chip.js — chip selectors on inputs and outputs (D-61/62/64, the pack's "guest star")
//   behavior: chip_input   chip in place of an input's name; dropdown = compatible sources (reroutes ↳¹²);
//                          today's wire on top with a red ✕ to unplug it.
//   behavior: chip_output  chip in place of an output's name (the text does NOT change: an output has many wires);
//                          dropdown = compatible inputs; today's wires on top (✕ to unplug them); inputs already
//                          taken by others are ⚠ (picking them REPLACES their wire — yes, we steal partners); "Via" bar for reroutes.
// Rows: green ✓ on the right (hover/highlighted), double click or Enter = connect. Delete = unplug the connected row.
// DRAWING only here. Compatibility, wires, Vue Nodes DOM: SurvivalKit.inputLink (shields/input-link.js).
// The chip saves nothing: it always re-reads the real wires. NORMAL inputs/outputs only (never converted widgets).
// Glue: one line per socket -> { type: "chip_input", input: "text" } / { type: "chip_output", output: "output" }
// Health: NodeStructure.chips.stats() (the Governor's "Input chips" HEALTH light).
// ============================================================
import { piece } from "../catalog/registry.js";
import { C, exb, S, B, N, J } from "../catalog/kit.js";
import { mkEl } from "../components/index.js";
import { supNum } from "../menu/float-menu.js";
import { Tip } from "../menu/tip.js";

// registry of live chips (only real nodes in a graph): for the Governor light and the selfTest
const CHIPS = new Set();      // { rt, side, slot, input, drawn, why, el }

const CHIP_CSS = `
.ns-chip-label{display:none!important}
.ns-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0;height:16px;box-sizing:border-box;padding:0 7px;margin:0 2px;border-radius:8px;border:1px solid var(--ns-c-chip-line, rgba(255,255,255,.18));background:var(--ns-c-chip-bg, rgba(255,255,255,.06));color:var(--ns-c-text, #d6d6d6);font:11px/1 system-ui,sans-serif;white-space:nowrap;cursor:pointer;user-select:none;pointer-events:auto;transition:background .12s,border-color .12s}
.ns-chip:hover{background:var(--ns-c-accent-tint, rgba(122,162,247,.22));border-color:var(--ns-c-accent, #7aa2f7)}
.ns-chip[data-on="1"]{border-color:var(--ns-c-accent, #7aa2f7)}
.ns-chip-in b{font-weight:700}
.ns-chip-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:calc(var(--ns-chip-max,12) * 1ch + 2px)}
.ns-chip-in.ns-mq{display:inline-block;animation:ns-pick-mq var(--ns-mq-s,3s) ease-in-out .3s infinite alternate}
.ns-chip-c{font-size:8px;opacity:.7}
.ns-pick{width:340px;max-height:min(420px,80vh);display:flex;flex-direction:column}
.ns-pick .ns-panel-head{height:40px;box-sizing:border-box;padding:0 6px 0 12px;gap:8px;display:flex;align-items:center;background:var(--nsm-head);border-bottom:1px solid var(--nsm-line)}
.ns-pick .ns-pv2-fill{flex:1}
.ns-pick-bar{display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--nsm-line)}
.ns-pick-q{flex:1;min-width:0;height:28px;box-sizing:border-box;padding:0 8px;border:1px solid var(--nsm-line-strong);border-radius:6px;background:var(--nsm-field);color:var(--nsm-text);font:12px var(--nsm-font);outline:none}
.ns-pick-q:focus{box-shadow:0 0 0 3px var(--nsm-focus);border-color:var(--nsm-accent)}
.ns-pick-list{flex:1;min-height:40px;overflow-y:auto;overflow-x:hidden;padding:4px 0}
.ns-pick-row{display:flex;align-items:center;gap:6px;height:28px;padding:0 10px;cursor:pointer;color:var(--nsm-text-dim)}
.ns-pick-row:hover{background:var(--nsm-surface-hover)}
.ns-pick-row.ns-hi{background:var(--nsm-accent-soft);color:var(--nsm-accent-soft-text)}
.ns-pick-row.ns-cur .ns-pick-in{font-weight:600;color:var(--nsm-text-strong)}
.ns-pick-sym{flex:none;width:18px;color:var(--nsm-text-muted);font:12px var(--nsm-mono)}
.ns-pick-txt{flex:1;min-width:0;overflow:hidden;white-space:nowrap}
.ns-pick-in{display:inline-block;white-space:nowrap;font:12px var(--nsm-font)}
.ns-pick-in.ns-mq{animation:ns-pick-mq var(--ns-mq-s,3s) ease-in-out .4s infinite alternate}
@keyframes ns-pick-mq{from{transform:translateX(0)}to{transform:translateX(var(--ns-mq,0))}}
.ns-pick-sub{flex:0 1 auto;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--nsm-text-faint);font:10px var(--nsm-mono)}
.ns-pick-empty{padding:12px;color:var(--nsm-text-muted);font:12px var(--nsm-font)}
.ns-pick-hint{flex:none;padding:6px 12px;border-top:1px solid var(--nsm-line);color:var(--nsm-text-faint);font:11px var(--nsm-font)}
.ns-pick-in b{font-weight:700;color:var(--nsm-text-strong)}
.ns-pick-row.ns-warn{color:var(--nsm-warn,#f0b45a)}
.ns-pick-row.ns-warn{height:auto;min-height:28px;padding-top:3px;padding-bottom:3px;flex-wrap:wrap;row-gap:0}
.ns-pick-row.ns-warn .ns-pick-sub{order:5;flex-basis:100%;max-width:none;padding-left:24px;color:var(--nsm-warn,#f0b45a);opacity:.85}
.ns-pick-go,.ns-pick-x{flex:none;width:22px;height:22px;padding:0;border-radius:6px;border:0;font:13px system-ui;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.ns-pick-go{visibility:hidden;background:var(--nsm-ok-soft,rgba(80,200,120,.16));color:var(--nsm-ok,#5fd38d)}
.ns-pick-row:hover .ns-pick-go,.ns-pick-row.ns-hi .ns-pick-go{visibility:visible}
.ns-pick-go:hover{background:var(--nsm-ok,#5fd38d);color:#0d1a12}
.ns-pick-x{background:rgba(240,90,100,.14);color:var(--nsm-danger-strong,#f06a74)}
.ns-pick-x:hover{background:var(--nsm-danger-strong,#f06a74);color:#1a0d0e}
.ns-pick-group{padding:6px 12px 2px;font:600 10px var(--nsm-font);letter-spacing:.08em;text-transform:uppercase;color:var(--nsm-text-faint)}
.ns-pick-via{display:flex;align-items:center;gap:4px;padding:0 8px 8px;flex-wrap:wrap}
.ns-pick-via-l{font:11px var(--nsm-font);color:var(--nsm-text-muted);margin-right:4px}
.ns-pick-via-b{height:22px;padding:0 8px;border-radius:11px;border:1px solid var(--nsm-line-strong);background:var(--nsm-field);color:var(--nsm-text-dim);font:11px var(--nsm-mono);cursor:pointer}
.ns-pick-via-b.ns-on{background:var(--nsm-accent-soft);color:var(--nsm-accent-soft-text);border-color:var(--nsm-accent)}
.ns-pick-warn{flex:none;padding:6px 12px;border-top:1px solid var(--nsm-line);color:var(--nsm-warn,#f0b45a);font:600 11px var(--nsm-font);text-align:center}
.ns-pick-msg{flex:none;padding:0 12px;color:var(--nsm-danger);font:11px var(--nsm-font)}
.ns-pick-msg:not(:empty){padding:6px 12px;border-top:1px solid var(--nsm-line)}
.ns-pick-ping{position:fixed;display:none;box-sizing:border-box;pointer-events:none;z-index:999989;border:2px solid var(--nsm-accent);border-radius:8px;animation:ns-pick-ping 1s ease-in-out infinite}
.ns-pick-ping.ns-round{border-radius:50%}
@keyframes ns-pick-ping{0%,100%{opacity:.25;box-shadow:0 0 0 0 var(--nsm-focus)}50%{opacity:1;box-shadow:0 0 0 6px var(--nsm-focus)}}
`;

const IL = () => globalThis.SurvivalKit?.inputLink || null;
const nameOf = (s) => String(s?.label || s?.localized_name || s?.name || "");
const rrSym = (rank, count) => (count ? (count === 1 ? "↳" : "↳" + supNum(rank)) : "");
const HINT = "✓, double-click or Enter to connect · ✕ to disconnect · Esc to close";

// ---------------- INPUT dropdown ----------------
function openInput(rt, p, anchor) {
    const il = IL(), node = rt.node;
    if (!il || !node?.graph) return;
    const i = il.slotIndex(node, p.input);
    if (i < 0) return;
    const inp = node.inputs[i];
    rt.api.openMenu("chip:" + p.input, {
        anchor,
        spec: {
            kind: "picker", look: "v2", dismiss: "explicit",
            title: nameOf(inp), chip: inp.type && inp.type !== "*" ? String(inp.type) : "any",
            placeholder: "Filter by name or #id…", empty: "No compatible sources on this level", hint: HINT,
            groups: { on: "Connected", "": "Sources" },
            items: () => {
                const all = il.sources(node, i, { types: p.types });
                const cur = all.find((s) => s.current);
                const row = (s, on) => ({
                    key: (on ? "on:" : "") + s.key, label: `${s.title} #${s.nodeId}`, bold: s.multi ? s.outName : "",
                    sym: rrSym(s.rank, s.count), sub: s.rerouteId != null ? `reroute ${s.rerouteId}` : "",
                    state: s.current && !on ? "current" : "", group: on ? "on" : "", removable: !!on,
                    src: { nodeId: s.nodeId, out: s.out, rerouteId: s.rerouteId },
                });
                // today's wire sits ONLY on top (Connected, with ✕): it isn't repeated below
                return [...(cur ? [row(cur, true)] : []), ...all.filter((s) => !s.current).map((s) => row(s, false))];
            },
            preview: (it) => il.screenRect(node.graph, it.src),
            pick: (it) => { const r = il.connect(node, i, it.src); if (r.ok) rt.update(); return r.ok ? true : r.why; },
            unpick: () => { const r = il.disconnect(node, i); rt.update(); return r.ok ? true : r.why; },
        },
    });
}

// ---------------- OUTPUT dropdown ----------------
function openOutput(rt, p, anchor) {
    const il = IL(), node = rt.node;
    if (!il || !node?.graph) return;
    const o = il.outIndex(node, p.output);
    if (o < 0) return;
    const out = node.outputs[o];
    rt.api.openMenu("chipo:" + p.output, {
        anchor,
        spec: {
            kind: "picker", look: "v2", dismiss: "explicit",
            title: nameOf(out), chip: out.type && out.type !== "*" ? String(out.type) : "any",
            placeholder: "Filter by name or #id…", empty: "No compatible inputs on this level", hint: HINT,
            warn: "⚠ Inputs marked ⚠ already have a wire: picking one REPLACES it ⚠",
            groups: { on: "Connected", "": "Inputs" },
            via: {
                options: () => [{ key: "direct", label: "direct" }, ...il.outReroutes(node, o).map((r) => ({ key: r.id, label: `${rrSym(r.rank, r.count)} ${r.id}` }))],
                preview: (k) => (k === "direct" ? il.screenRect(node.graph, { nodeId: node.id }) : il.screenRect(node.graph, { rerouteId: k })),
            },
            items: () => {
                const on = il.outLinks(node, o).map((l) => ({
                    key: "on:" + l.linkId, label: `${l.title} #${l.nodeId}`, bold: l.inName, sym: l.rerouteId != null ? "↳" : "",
                    sub: l.rerouteId != null ? `reroute ${l.rerouteId}` : "", group: "on", removable: true, dst: { nodeId: l.nodeId, inp: l.inp },
                }));
                // a widget with a reroute hung on it (D-69) shows its name + ↳: the wire slips in through that reroute
                const t = il.targets(node, o, { types: p.types }).filter((d) => !d.current).map((d) => ({
                    key: d.key, label: `${d.title} #${d.nodeId}`, bold: d.multi || d.via != null ? d.inName : "",
                    sym: d.occupied ? "⚠" : d.via != null ? "↳" : "", state: d.current ? "current" : d.occupied ? "warn" : "",
                    sub: d.occupied ? `replaces ← ${d.occupied.title} #${d.occupied.nodeId}` : d.via != null ? `widget, via reroute ${d.via}` : "", dst: { nodeId: d.nodeId, inp: d.inp },
                }));
                return [...on, ...t];
            },
            preview: (it) => il.screenRect(node.graph, { nodeId: it.dst.nodeId }),
            pick: (it, via) => { const r = il.connectOut(node, o, it.dst, via === "direct" || via == null ? null : via); if (r.ok) rt.update(); return r.ok ? true : r.why; },
            unpick: (it) => { const t = node.graph.getNodeById?.(it.dst.nodeId); const r = t ? il.disconnect(t, it.dst.inp) : { ok: false, why: "node is gone" }; rt.update(); return r.ok ? true : r.why; },
        },
    });
}

// ---------------- chip (shared) ----------------
function chipBehavior(side) {
    return (rt, p) => {
        const node = rt.node;
        const slot = side === "in" ? p.input : p.output;
        if (!node?.graph || !slot) return;                        // catalog examples / nodes outside a graph: no chip
        const st = { rt, side, slot, input: slot, drawn: false, why: "not drawn yet", el: null };
        CHIPS.add(st);
        const open = (anchor) => (side === "in" ? openInput : openOutput)(rt, p, anchor);
        st.open = () => chip && open(chip);
        let chip = null, txt = null, txtIn = null, dom = null;
        const idx = (il) => (side === "in" ? il.slotIndex(node, slot) : il.outIndex(node, slot));
        const build = () => {
            chip = mkEl("span", "ns-chip" + (side === "out" ? " ns-chip-out" : "")); chip.setAttribute("role", "button"); chip.tabIndex = 0;
            txt = mkEl("span", "ns-chip-t");
            txtIn = mkEl("span", "ns-chip-in"); txt.append(txtIn);
            chip.style.setProperty("--ns-chip-max", String(Number(p.max) > 0 ? Number(p.max) : 12));
            const caret = mkEl("span", "ns-chip-c"); caret.textContent = "▾";
            chip.append(txt, caret);
            // the canvas/Vue must not see the click (no node dragging, no hand-drawn wire)
            for (const ev of ["pointerdown", "mousedown", "dblclick", "contextmenu"]) rt.bag.listen(chip, ev, (e) => e.stopPropagation());
            // truncated text: on hover it scrolls to show it all — a slow reveal (measured on the container: the inline span has scrollWidth 0)
            rt.bag.listen(chip, "mouseenter", () => { const over = txt.scrollWidth - txt.clientWidth; if (over > 2) { txtIn.style.setProperty("--ns-mq", -over + "px"); txtIn.style.setProperty("--ns-mq-s", Math.max(1.2, over / 40) + "s"); txtIn.classList.add("ns-mq"); } });
            rt.bag.listen(chip, "mouseleave", () => txtIn.classList.remove("ns-mq"));
            Tip.attach(rt.bag, chip, tipContent);                 // ONE hover only: the kit's (D-63)
            rt.bag.listen(chip, "click", (e) => { e.preventDefault(); e.stopPropagation(); open(chip); });
            rt.bag.listen(chip, "keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); open(chip); } });
            st.el = chip;
        };
        const tipContent = () => {
            const il = IL(), i = il ? idx(il) : -1;
            if (i < 0) return null;
            if (side === "in") {
                const inp = node.inputs[i], cur = il.current(node, i);
                const from = cur ? node.graph?.getNodeById?.(cur.nodeId) : null;
                const src = !cur ? "Not connected" : from ? [`← ${il.titleOf(from)} #${from.id} (`, { b: nameOf(from.outputs?.[cur.out]) }, `)${cur.rerouteId != null ? ` · via reroute ${cur.rerouteId}` : ""}`] : `← missing node #${cur.nodeId}`;
                return { title: nameOf(inp), chip: inp.type && inp.type !== "*" ? String(inp.type) : "any", body: [il.slotTooltip(node, i), src], hint: "Click to choose the source" };
            }
            const out = node.outputs[i], links = il.outLinks(node, i);
            const lines = links.length ? links.slice(0, 8).map((l) => `→ ${l.title} #${l.nodeId} · ${l.inName}`) : ["Not connected"];
            if (links.length > 8) lines.push(`… +${links.length - 8} more`);
            return { title: nameOf(out), chip: out.type && out.type !== "*" ? String(out.type) : "any", body: [il.outTooltip(node, i), lines.join("\n")], hint: "Click to connect it to an input" };
        };
        const unhook = () => {
            if (dom?.label) dom.label.classList.remove("ns-chip-label");
            try { chip?.remove(); } catch (_) {}
            dom = null;
        };
        const sync = () => {
            if (rt.destroyed) return;
            const il = IL();
            if (!il) { st.drawn = false; st.why = "SurvivalKit.inputLink missing"; return; }
            const i = idx(il);
            // socket the node adds/removes by itself (e.g. Preview: width/height only with images): missing, not an error
            if (i < 0) { st.drawn = false; st.hidden = true; st.why = `${side === "in" ? "input" : "output"} '${slot}' not on the node now`; unhook(); return; }
            if (side === "in" && node.inputs[i]?.widget) { st.drawn = false; st.hidden = false; st.why = `'${slot}' is a widget input: chips are for normal inputs only`; unhook(); return; }
            if (!il.vueNodesOn()) { st.drawn = false; st.hidden = false; st.why = "Vue Nodes off (chip needs it)"; unhook(); return; }
            const d = il.slotDom(node, i, side);
            if (!d) {
                // node off screen / collapsed / inside another level: Vue doesn't draw it, not an error
                const g = globalThis.app?.canvas?.graph;
                const hidden = g !== node.graph || node.flags?.collapsed || !document.querySelector(il.VUE.node(node.id));
                st.drawn = false; st.why = hidden ? "node not on screen" : "slot not found in Vue DOM (input-link.js VUE)";
                st.hidden = hidden;
                return;
            }
            st.hidden = false;
            if (!chip) build();
            if (!dom || dom.row !== d.row || !chip.isConnected) {
                unhook();
                dom = d;
                if (d.label) d.label.after(chip); else d.box.append(chip);
            }
            if (d.label && !d.label.classList.contains("ns-chip-label")) d.label.classList.add("ns-chip-label");   // Vue may redo the classes
            let shown, bold = "", on, broken = false;
            if (side === "in") {
                const inp = node.inputs[i], cur = il.current(node, i);
                const from = cur ? node.graph.getNodeById?.(cur.nodeId) : null;
                // unplugged: default (config `label` or the input's name); plugged: title of the source node (follows renames)
                shown = from ? il.titleOf(from) : String(p.label || nameOf(inp));
                // D-98: plugged = "Node (**output**)" — outputs rename themselves now (Pick Combo, Multi Math), so say which one
                if (from) bold = nameOf(from.outputs?.[cur.out]);
                on = !!cur; broken = !!(cur && !from);
            } else {
                // output: the text does NOT change (it can have many wires); the connected ones are in its hover
                const links = il.outLinks(node, i);
                shown = String(p.label || nameOf(node.outputs[i]));
                on = links.length > 0; broken = links.some((l) => l.gone);
            }
            const key = shown + "\u0000" + bold;
            if (txtIn.dataset.k !== key) {
                txtIn.dataset.k = key; txtIn.textContent = shown;
                if (bold) { const b = mkEl("b", ""); b.textContent = bold; txtIn.append(" (", b, ")"); }
            }
            const onS = on ? "1" : "0";
            if (chip.dataset.on !== onS) chip.dataset.on = onS;
            st.drawn = true;
            st.broken = broken;
            st.why = broken ? "wire to a missing node" : "";
        };
        rt.api.after(sync, 0); rt.api.after(sync, 300);
        rt.api.every(sync, 700);                                     // safety net only: the watcher below does the real work
        // D-88: Vue rebuilds slot rows on undo/redo, shape changes, mounting... Timers lose that race (the naked native label
        // flashed for 12-47 ms), so the kit tells us the moment it touches the rows and we re-dress BEFORE the paint.
        { const off = IL()?.watchSlots?.(node, sync); if (off) rt.bag.add(off); }
        rt.onConnect.add(sync); rt.onRestore.add(sync); rt.onUpdate.add(sync);
        rt.bag.add(() => { unhook(); CHIPS.delete(st); });
    };
}

const COMMON = {
    label: S("testo del chip (ingresso: quando e' scollegato; uscita: sempre). Default: nome della presa"),
    max: N("lettere visibili del chip prima del taglio (poi … e scorre al passaggio)", 12),
    types: J("tipi ammessi dall'altra parte (es. [\"STRING\",\"IMAGE\"]); vuoto = tutti i compatibili"),
};
piece(C("chip_input", {
    scopo: "Chip al posto del nome di un ingresso: tendina filtrata delle sorgenti compatibili, ✓/Invio mette un filo vero.",
    natura: "funziona", dominio: "graph", estado: "draft", tag: ["comportamento", "input", "filo", "reroute", "menu"], css: CHIP_CSS,
    props: {
        input: { ...S("nome dell'ingresso (come in Python)"), required: true }, ...COMMON,
        wireless: B("wifi: collegamento senza filo (PREPARATO, oggi ignorato: SurvivalKit.inputLink.wireless.enabled=false)", false),
    },
    esempio: exb({ t: "label_element", text: "chip" }, [{ type: "chip_input", input: "i" }]),
}), chipBehavior("in"));
piece(C("chip_output", {
    scopo: "Chip al posto del nome di un'uscita: tendina degli ingressi compatibili (⚠ = gia' occupati), ✓ mette un filo vero.",
    natura: "funziona", dominio: "graph", estado: "draft", tag: ["comportamento", "output", "filo", "reroute", "menu"],
    props: { output: { ...S("nome dell'uscita (come in Python)"), required: true }, ...COMMON },
    esempio: exb({ t: "label_element", text: "chip" }, [{ type: "chip_output", output: "o" }]),
}), chipBehavior("out"));

// health and diagnostics (Governor + selfTest + console: NodeStructure.chips.stats())
const tag = (c) => `${c.rt.node?.type} #${c.rt.node?.id} ${c.side === "out" ? "out:" : ""}${c.slot}`;
export const Chips = {
    stats() {
        const all = [...CHIPS].filter((c) => !c.rt.destroyed);
        const bad = all.filter((c) => !c.drawn && !c.hidden);
        const broken = all.filter((c) => c.broken);
        return {
            users: all.length, drawn: all.filter((c) => c.drawn).length, hidden: all.filter((c) => c.hidden).length,
            notDrawable: bad.map((c) => `${tag(c)}: ${c.why}`),
            broken: broken.map(tag),
        };
    },
    of: (node, slot, side = "in") => [...CHIPS].find((c) => c.rt.node === node && c.side === side && (slot == null || c.slot === slot)) || null,
    open: (node, slot, side = "in") => { const c = Chips.of(node, slot, side); if (c?.el) c.open(); return !!c?.el; },
};
