// ============================================================
// pieces/wire.js — the "Connections" page of the reroute menu (D-85) and the tab switch it lives in
//   component: wire_box   what a native reroute carries: IN = the source (name #id, ✕ unplugs, click = picker),
//                         OUT = the destinations (paged list, ✕ unplugs each, + = picker to hang one more)
//   io:        tab_system which page of a tabbed menu is showing -> $live.tab_system.is.<page> (feeds `visible`)
// DRAWING only here. The wires themselves (who may plug where, undo, floating wires, "the reroute always survives")
// live in SurvivalKit.inputLink.reroute* (shields/input-link.js). The pickers are the very same ones the chips use
// (kind:"picker", D-61/64), opened OVER the menu (opts.over) so the page stays put. We never keep what we draw:
// every pass re-reads the real wires, and the page is only redone when what it shows has actually changed.
// Glue: { t: "wire_box" } in a menu of an extension whose subject is a reroute · { t:"segmented_element", bind:"$state.tab" } + visible:"$live.tab_system.is.<page>"
// ============================================================
import { piece } from "../catalog/registry.js";
import { C, ex, N } from "../catalog/kit.js";
import { mkEl } from "../components/index.js";

const IL = () => globalThis.SurvivalKit?.inputLink || null;
const HINT = "✓, double-click or Enter to connect · ✕ to disconnect · Esc to close";

const WIRE_CSS = `
.ns-wire{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden;padding-bottom:8px}
.ns-wire-sec{flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px 6px;font:600 11px var(--nsm-font);letter-spacing:.08em;text-transform:uppercase;color:var(--nsm-text-muted)}
.ns-wire-fill{flex:1}
.ns-wire-add{flex:none;height:22px;min-width:26px;padding:0 8px;border-radius:11px;border:1px solid var(--nsm-line-strong);background:var(--nsm-field);color:var(--nsm-text-dim);font:600 13px/1 var(--nsm-font);cursor:pointer}
.ns-wire-add:hover:not(:disabled){background:var(--nsm-accent-soft);border-color:var(--nsm-accent);color:var(--nsm-accent-soft-text)}
.ns-wire-add:disabled{opacity:.35;cursor:not-allowed}
.ns-wire-row{flex:none;display:flex;align-items:center;gap:6px;min-height:34px;box-sizing:border-box;margin:0 10px 4px;padding:0 6px 0 10px;border:1px solid var(--nsm-line);border-radius:7px;background:var(--nsm-surface);color:var(--nsm-text-dim)}
.ns-wire-row.ns-wire-pick{cursor:pointer}
.ns-wire-row.ns-wire-pick:hover{background:var(--nsm-surface-hover);border-color:var(--nsm-accent)}
.ns-wire-row.ns-wire-off{opacity:.6}
.ns-wire-row.ns-wire-none .ns-wire-txt{color:var(--nsm-text-faint);font-style:italic}
.ns-wire-sym{flex:none;width:16px;color:var(--nsm-text-muted);font:12px var(--nsm-mono)}
.ns-wire-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px var(--nsm-font)}
.ns-wire-txt b{font-weight:600;color:var(--nsm-text-strong)}
.ns-wire-sub{flex:0 1 auto;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--nsm-text-faint);font:10px var(--nsm-mono)}
.ns-wire-x{flex:none;width:22px;height:22px;padding:0;border-radius:6px;border:0;background:rgba(240,90,100,.14);color:var(--nsm-danger-strong,#f06a74);font:13px system-ui;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.ns-wire-x:hover{background:var(--nsm-danger-strong,#f06a74);color:#1a0d0e}
.ns-wire-note{flex:none;padding:6px 14px;font:11px/1.45 var(--nsm-font);color:var(--nsm-text-muted)}
.ns-wire-msg{flex:none;color:var(--nsm-danger);font:11px var(--nsm-font)}
.ns-wire-msg:not(:empty){padding:6px 14px}
`;

// ---------- wire_box ----------
piece(C("wire_box", {
    scopo: "Pagina 'Connections' di un reroute nativo: sorgente (IN) e destinazioni (OUT), con ✕ per scollegare e picker per cambiare/aggiungere.",
    natura: "funziona", dominio: "graph", estado: "draft", archetipo: "renderer-host",
    tag: ["fili", "filo", "reroute", "menu"], css: WIRE_CSS,
    props: { pageSize: N("destinazioni per pagina (OUT)", 5) },
    esempio: ex({ t: "wire_box" }),
}), (node, h) => {
    const rt = h.rt, subj = rt.node;
    const el = mkEl("div", "ns-wire");
    const per = Math.max(1, Math.floor(Number(h.val(node.pageSize)) || 5));
    let page = 0, sig = "", msg = "";
    const rid = () => subj?.reroute?.id;
    const gr = () => subj?.graph;
    const read = () => { const il = IL(), g = gr(), id = rid(); return il && g && id != null ? il.rerouteWires(g, id) : null; };
    const say = (t) => { msg = t || ""; };
    const ok = (r) => { say(r.ok ? "" : r.why || "Not done"); rt.update(); return r.ok; };
    const text = (tag, cls, t) => { const e = mkEl(tag, cls); e.textContent = t; return e; };
    const typeOf = (d) => (d?.type && d.type !== "*" ? String(d.type) : "any");

    // ---- pickers (the chip ones, opened over the menu) ----
    const openIn = (anchor, d) => {
        const il = IL(), g = gr(), id = rid();
        if (!il || !g || id == null) return;
        rt.api.openMenu("wire:in", { anchor, over: true, spec: {
            kind: "picker", look: "v2", dismiss: "explicit", title: `Source of reroute #${id}`, chip: typeOf(d),
            placeholder: "Filter by name or #id…", empty: "No compatible sources on this level", hint: HINT,
            groups: { on: "Connected", "": "Sources" },
            items: () => {
                const all = il.rerouteSources(g, id);
                const cur = all.find((s) => s.current);
                const row = (s, on) => ({
                    key: (on ? "on:" : "") + s.key, label: `${s.title} #${s.nodeId}`, bold: s.multi ? s.outName : "",
                    sub: s.outType && s.outType !== "*" ? String(s.outType) : "", state: s.current && !on ? "current" : "", group: on ? "on" : "",
                    src: { nodeId: s.nodeId, out: s.out },
                });
                return [...(cur ? [row(cur, true)] : []), ...all.filter((s) => !s.current).map((s) => row(s, false))];
            },
            preview: (it) => il.screenRect(g, { nodeId: it.src.nodeId }),
            pick: (it) => { const r = il.rerouteSetSource(g, id, it.src); if (r.ok) { say(""); rt.update(); } return r.ok ? true : r.why; },
        } });
    };
    const openOut = (anchor, d) => {
        const il = IL(), g = gr(), id = rid();
        if (!il || !g || id == null) return;
        rt.api.openMenu("wire:out", { anchor, over: true, spec: {
            kind: "picker", look: "v2", dismiss: "explicit", title: `Add a destination to #${id}`, chip: typeOf(d),
            placeholder: "Filter by name or #id…", empty: "No compatible inputs on this level", hint: HINT,
            warn: "⚠ Inputs marked ⚠ already have a wire: picking one REPLACES it ⚠",
            groups: { on: "Connected", "": "Inputs" },
            items: () => {
                const on = il.rerouteDests(g, id).filter((x) => !x.gone).map((x) => ({
                    key: "on:" + x.key, label: `${x.title} #${x.nodeId}`, bold: x.inName, sym: x.via != null ? "↳" : "",
                    sub: x.via != null ? `reroute ${x.via}` : "", group: "on", removable: true, dst: { nodeId: x.nodeId, inp: x.inp },
                }));
                const t = il.rerouteTargets(g, id).filter((x) => !x.current).map((x) => ({
                    key: x.key, label: `${x.title} #${x.nodeId}`, bold: x.multi ? x.inName : "", sym: x.occupied ? "⚠" : "",
                    state: x.occupied ? "warn" : "", sub: x.occupied ? `replaces ← ${x.occupied.title} #${x.occupied.nodeId}` : "", dst: { nodeId: x.nodeId, inp: x.inp },
                }));
                return [...on, ...t];
            },
            preview: (it) => il.screenRect(g, { nodeId: it.dst.nodeId }),
            pick: (it) => { const r = il.rerouteAddDest(g, id, it.dst); if (r.ok) { say(""); rt.update(); } return r.ok ? true : r.why; },
            unpick: (it) => { const r = il.rerouteDropDest(g, id, it.dst); rt.update(); return r.ok ? true : r.why; },
        } });
    };

    // ---- drawing (the listeners live on the elements: they go away with them when the page is redone) ----
    const section = (title, right) => {
        const s = mkEl("div", "ns-wire-sec");
        s.append(text("span", "", title), mkEl("span", "ns-wire-fill"));
        if (right) s.append(right);
        return s;
    };
    const xBtn = (title, fn) => {
        const b = text("button", "ns-wire-x", "✕"); b.type = "button"; b.title = title;
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
        return b;
    };
    const draw = () => {
        const d = read();
        const pages = d ? Math.max(1, Math.ceil(d.dests.length / per)) : 1;
        page = Math.max(0, Math.min(page, pages - 1));
        const s = d ? JSON.stringify([d.source, d.dests, d.type, d.canChange, d.canDrop, d.lastOne, d.canAdd, d.why, page, msg]) : "none";
        if (s === sig) return;
        sig = s;
        el.textContent = "";
        const g = gr(), id = rid();
        if (!d || !g || id == null) { el.append(text("div", "ns-wire-note", "Open this page on a reroute to see what it carries.")); return; }

        // IN: the source
        el.append(section("From"));
        const src = d.source;
        const inRow = mkEl("div", "ns-wire-row" + (d.canChange ? " ns-wire-pick" : " ns-wire-off") + (src ? "" : " ns-wire-none"));
        inRow.append(text("span", "ns-wire-sym", ""));
        const t = mkEl("span", "ns-wire-txt");
        if (src) { t.append(document.createTextNode(`${src.title}${src.gone ? "" : " #" + src.nodeId} `)); const b = mkEl("b"); b.textContent = `(${src.outName})`; t.append(b); }
        else t.textContent = "No source";
        inRow.append(t);
        if (src && src.outType && src.outType !== "*") inRow.append(text("span", "ns-wire-sub", String(src.outType)));
        inRow.title = d.canChange ? "Choose another source" : d.why || "";
        // ✕ like everywhere else (D-87). If nothing hangs after her, unplugging the source makes the reroute go away and the menu closes by itself
        if (d.canDrop) inRow.append(xBtn(d.lastOne ? "Unplug (nothing else hangs on this reroute: she goes away)" : "Unplug the source (the wires after her stay, floating)", () => ok(IL().rerouteDropSource(g, id))));
        inRow.addEventListener("click", () => { if (d.canChange) openIn(inRow, d); else if (d.why) { say(d.why); rt.update(); } });
        el.append(inRow);

        // OUT: the destinations (5 per page, « 1/2 »)
        const add = text("button", "ns-wire-add", "+"); add.type = "button"; add.disabled = !d.canAdd; add.title = d.canAdd ? "Hang one more destination on this reroute" : "A reroute needs a source before it can feed anything new";
        add.addEventListener("click", (e) => { e.stopPropagation(); openOut(add, d); });
        el.append(section(`To (${d.dests.length})`, add));
        if (!d.dests.length) el.append(text("div", "ns-wire-note", "Nothing is plugged in after this reroute."));
        for (const x of d.dests.slice(page * per, (page + 1) * per)) {
            const row = mkEl("div", "ns-wire-row" + (x.gone ? " ns-wire-off" : ""));
            row.append(text("span", "ns-wire-sym", x.via != null ? "↳" : ""));
            const tx = mkEl("span", "ns-wire-txt");
            tx.append(document.createTextNode(`${x.title}${x.gone ? "" : " #" + x.nodeId} `));
            const b = mkEl("b"); b.textContent = `(${x.inName})`; tx.append(b);
            row.append(tx);
            const sub = x.via != null ? `via reroute ${x.via}` : x.floating ? "no source" : "";
            if (sub) row.append(text("span", "ns-wire-sub", sub));
            row.append(xBtn("Disconnect", () => ok(IL().rerouteDropDest(g, id, { nodeId: x.nodeId, inp: x.inp }))));
            el.append(row);
        }
        if (pages > 1) {
            const pg = mkEl("div", "ns-pick-pager");
            const prev = text("button", "ns-pick-pg", "«"), info = text("span", "ns-pick-pgi", `${page + 1}/${pages}`), next = text("button", "ns-pick-pg", "»");
            prev.type = next.type = "button"; prev.title = "Previous page"; next.title = "Next page";
            prev.disabled = page <= 0; next.disabled = page >= pages - 1;
            prev.addEventListener("click", () => { page--; rt.update(); });
            next.addEventListener("click", () => { page++; rt.update(); });
            pg.append(prev, info, next);
            el.append(pg);
        }
        if (d.why && !d.canChange) el.append(text("div", "ns-wire-note", d.why));
        const m = mkEl("div", "ns-wire-msg"); m.textContent = msg;
        el.append(m);
    };
    draw();
    // somebody may rewire from the canvas while the page is open: we look again, but only redo the page when something changed
    h.bag.interval(() => { if (!rt.destroyed) draw(); }, 600);
    return { el, update: draw };
});

// ---------- tab_system ----------
piece(C("tab_system", {
    scopo: "Pagina attiva di un menu a tab (stato 'tab'): $live.tab_system.is.<pagina> e' true solo per quella; serve a `visible`.",
    natura: "funziona", dominio: "ui", estado: "draft", tag: ["menu", "tab", "dati"], props: {},
    esempio: ex({ t: "label_element", text: "{{$live.tab_system.current}}" }, { state: { tab: { policy: "ui", default: "fx" } } }),
}), (api) => {
    const cur = String(api.state.get("tab") ?? "");
    return { current: cur, is: new Proxy({}, { get: (_, k) => typeof k === "string" && k === cur }) };
});
