// ============================================================
// pieces/fx.js — io sources and renderers for the "effects/chain/wires" domain
//   io: effects_system deck_system params_system self_node chain_link source_link type_link sig_input
//   renderer: dot_element preview_link particles_element
//   behavior: feed_system sync_output paint_link paint_link_native snap_link_native bind_input
// ============================================================
import { piece, impl } from "../catalog/registry.js";
import { C, exb, ex, E, N, S, B, J, K, PC } from "../catalog/kit.js";
import { INSTANCES } from "../core/runtime.js";
import { getStore, loadEffects, FALLBACK } from "../fx/store.js";
import { drawLinkLayers, drawSkin, TAU } from "../fx/engine.js";
import * as ch from "../fx/chain.js";
import { attachWires, attachNative } from "../fx/overlay.js";
import { DECOR } from "../fx/native.js";
import { Governor } from "../../Governor/governor.js";

const FXEX = (extra = {}) => ({ config: { effects_system: { route: "/__none__" } }, state: { effect: { policy: "immediate", default: "" }, params: { policy: "immediate", default: "" }, propagate: { policy: "immediate", default: true }, skin: { policy: "immediate", default: true }, page: { policy: "ui" } }, ...extra });
const LIVE_EX = (live, extra) => ex({ t: "label_element", text: `{{$live.${live}}}` }, FXEX(extra));

// ---------- io ----------
const effectsSystem = (api) => {
    const rt = INSTANCES.get(api.node); const c = ch.cfgFor(rt);
    const st = ch.styleOf(api.node);
    const store = getStore(c.route);
    return {
        loading: !store.loaded, count: store.list.length, hasErrors: store.errors.length > 0, errorsText: "effects errors:\n" + store.errors.join("\n"),
        effectId: st.effect.id, effectName: st.effect.name, hasParams: (st.effect.params || []).length > 0,
        effectsLabel: `Effect (${store.list.length})`, settingsLabel: `${st.effect.name} settings`,
    };
};
effectsSystem.ensure = (api) => {
    const rt = INSTANCES.get(api.node); const store = getStore(ch.cfgFor(rt).route);
    const refresh = () => api.refresh();
    store.listeners.add(refresh); api.onDispose(() => store.listeners.delete(refresh));
    if (!store.loaded) loadEffects(store.route);
};
effectsSystem.reload = (api) => loadEffects(ch.cfgFor(INSTANCES.get(api.node)).route, true);
piece(C("effects_system", {
    scopo: "Stato dello store effetti (caricamento, conteggio, errori) e dell'effetto scelto dal nodo; reload/ensure.", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["effetti", "dati"], props: {},
    esempio: LIVE_EX("effects_system.effectName"),
}), effectsSystem);

piece(C("deck_system", {
    scopo: "Elenco di una pagina di effetti come item {id,label,desc,on} per cards_box (paginazione da config).", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["effetti", "dati", "cards"], uses: ["effects_system"], props: {},
    esempio: ex({ t: "cards_box", items: "$live.deck_system", pageState: "page" }, FXEX()),
}), (api) => {
    const rt = INSTANCES.get(api.node); const c = ch.cfgFor(rt);
    const st = ch.styleOf(api.node);
    const list = st.store.list.length ? st.store.list : [FALLBACK];
    return list.map((e) => ({ id: e.id, label: `${e.icon ? e.icon + " " : ""}${e.name}`, desc: e.description || e.name, on: e.id === st.effect.id }));
});

piece(C("params_system", {
    scopo: "Schema dei parametri dell'effetto scelto (key,label,type,min,max,step,options,default,hasAuto) per form_box.", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["effetti", "dati", "form"], uses: ["effects_system"], props: {},
    esempio: ex({ t: "form_box", fields: "$live.params_system", state: "params", scope: "$live.effects_system.effectId" }, FXEX()),
}), (api) => {
    const st = ch.styleOf(api.node);
    return (st.effect.params || []).map((d) => ({
        key: d.key, label: d.label || d.key, type: ["range", "color", "select", "toggle", "number"].includes(d.type) ? d.type : "text",
        min: d.min, max: d.max, step: d.step, options: d.options, default: d.default, hasAuto: d.type === "color" && (d.default === "auto" || d.auto === true),
    }));
});

piece(C("self_node", {
    scopo: "Dati del nodo corrente ({id, type}) per titoli e testi.", natura: "funziona", dominio: "graph", estado: "draft",
    tag: ["nodo", "dati"], props: {}, esempio: ex({ t: "label_element", text: "#{{$live.self_node.id}}" }),
}), (api) => ({ id: api.node.id, type: api.type, node: api.node }));

piece(C("chain_link", {
    scopo: "Catena di nodi dello stesso tipo (o di reroute nativi): testo, presenza, ids, se ha un padre, numero a valle.", natura: "funziona", dominio: "graph", estado: "draft",
    tag: ["grafo", "catena", "dati"], props: {}, esempio: LIVE_EX("chain_link.text"),
}), (api) => {
    const c = ch.chainOf(api.node), k = ch.downstream(api.node);
    const label = "Chain", more = "downstream";
    return { ids: c, down: k.length, up: c.length > 1, has: c.length > 1 || k.length > 0, text: `${label}: ${c.map((i) => "#" + i).join(" › ")}${k.length ? `  (+${k.length} ${more})` : ""}` };
});

piece(C("source_link", {
    scopo: "Nodo sorgente dello stile nella catena ({node,id,locked,lockText,goLabel}).", natura: "funziona", dominio: "graph", estado: "draft",
    tag: ["grafo", "catena", "dati"], uses: ["chain_link"], props: {}, esempio: LIVE_EX("source_link.lockText"),
}), (api) => {
    const { src, locked } = ch.sourceOf(api.node);
    if (ch.isRR(api.node)) return { node: src, id: src.id, locked, goLabel: `Go to #${src.id}`, lockText: `This reroute shows the effect of #${src.id}. Switch to Own to give it its own effect. The wire stays connected either way.` };
    return { node: src, id: src.id, locked, goLabel: `Go to #${src.id}`, lockText: `Style inherited from reroute #${src.id}. Edit it there, or turn off "Children inherit" on that reroute to make this one independent.` };
});

piece(C("type_link", {
    scopo: "Tipo di dato risolto lungo la catena e relativo colore del filo ({type,color}).", natura: "funziona", dominio: "graph", estado: "draft",
    tag: ["grafo", "tipo", "dati"], props: {}, esempio: LIVE_EX("type_link.type"),
}), (api) => { const type = ch.resolveType(api.node); return { type, color: ch.typeColor(type) }; });

// config bind_input.input: index OR input name (D-67: with Vue Nodes every widget has its own socket and the indexes
// move around; the name doesn't). Name -> index from Survival (inputLink.slotIndex).
const inIdx = (api) => {
    const i = api.cfg("bind_input").input ?? 0;
    if (typeof i !== "string") return i;
    const il = globalThis.SurvivalKit?.inputLink;
    const k = il?.slotIndex ? il.slotIndex(api.node, i) : (api.node.inputs || []).findIndex((x) => x?.name === i);
    return k < 0 ? -1 : k;
};
piece(C("sig_input", {
    scopo: "Firma del filo in un ingresso (config bind_input.input): null scollegato, undefined non risolto, 'origine:slot'.", natura: "funziona", dominio: "graph", estado: "draft",
    tag: ["input", "filo", "dati"], props: {}, esempio: LIVE_EX("sig_input"),
}), (api) => ch.wireSig(api.node, inIdx(api)));

piece(C("type_input", {
    scopo: "Tipo del dato che arriva sul filo di un ingresso (config bind_input.input), null se scollegato o '*'.", natura: "funziona", dominio: "graph", estado: "draft",
    tag: ["input", "tipo", "dati"], props: {}, esempio: LIVE_EX("type_input"),
}), (api) => ch.wireType(api.node, inIdx(api)));

// ---------- renderer ----------
piece(C("dot_element", {
    scopo: "Pallino del nodo: disegna la skin dell'effetto scelto con il colore del tipo del filo.", natura: "estetica", dominio: "graph", estado: "draft",
    tag: ["canvas", "effetti", "pallino"], uses: ["type_link", "effects_system"], props: { scale: N("raggio relativo al lato minore", 0.36) },
    esempio: ex({ t: "canvas_element", renderer: "dot_element", fps: 10 }, FXEX()),
}), (api, dt, g, w, h, item, args = {}) => {
    const st = ch.styleOf(api.node), auto = ch.typeColor(ch.resolveType(api.node));
    g.clearRect(0, 0, w, h);
    g.save(); g.translate(w / 2, h / 2);
    const skin = (st.cfg.skin !== false && Array.isArray(st.effect.skin)) ? st.effect.skin : FALLBACK.skin;
    drawSkin(g, skin, ch.ctxOf(st.effect, st.saved, auto, performance.now() / 1000), Math.min(w, h) * (args.scale ?? 0.36), 1, false);
    g.restore();
});

piece(C("preview_link", {
    scopo: "Anteprima di un effetto (item {id}) come filo tra due punti, con il motore dei fili.", natura: "estetica", dominio: "graph", estado: "draft",
    tag: ["canvas", "effetti", "anteprima"], uses: ["type_link"], props: {},
    esempio: ex({ t: "canvas_element", renderer: "preview_link", fps: 10 }, FXEX()),
}), (api, dt, g, w, h, item) => {
    const st = ch.styleOf(api.node);
    const eff = st.store.byId.get(item?.id) || (item?.id === FALLBACK.id ? FALLBACK : null);
    g.clearRect(0, 0, w, h);
    if (!eff) return;
    const auto = ch.typeColor(ch.resolveType(api.node));
    const saved = ch.cfgOf(st.src).params[eff.id];
    g.lineCap = "round"; g.lineJoin = "round";
    drawLinkLayers(g, eff, ch.ctxOf(eff, saved, auto, performance.now() / 1000), [10, h * 0.74], [w - 10, h * 0.26], false, 1, false);
    g.fillStyle = auto;
    for (const [x, y] of [[10, h * 0.74], [w - 10, h * 0.26]]) { g.beginPath(); g.arc(x, y, 2.2, 0, TAU); g.fill(); }
});

piece(C("particles_element", {
    scopo: "Particelle che rimbalzano (prova del canvas del kit).", natura: "estetica", dominio: "ui", estado: "draft",
    tag: ["canvas", "particelle"], props: { count: N("numero di particelle", 15), color: S("colore", "rgba(124,188,255,0.7)") },
    esempio: ex({ t: "canvas_element", renderer: "particles_element", args: { count: 5 }, fps: 10 }),
}), (api, dt, g, w, h, item, a = {}) => {
    const n = a.count ?? 15;
    let ps = api.cache.get("particles", null);
    if (!Array.isArray(ps) || ps.length !== n) {
        ps = Array.from({ length: n }, () => ({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 1.2, vy: (Math.random() - 0.5) * 1.2, r: 1 + Math.random() * 2 }));
        api.cache.set("particles", ps);
    }
    g.clearRect(0, 0, w, h);
    g.fillStyle = a.color || "rgba(124,188,255,0.7)";
    for (const p of ps) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < 0 || p.x > 1) p.vx *= -1;
        if (p.y < 0 || p.y > 1) p.vy *= -1;
        g.beginPath(); g.arc(p.x * w, p.y * h, p.r, 0, Math.PI * 2); g.fill();
    }
});

// ---------- behavior ----------
piece(C("feed_system", {
    scopo: "All'avvio carica una sorgente dati del kit (ensure) e ridisegna il nodo quando arriva.", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["comportamento", "dati"], props: { name: { ...PC("io", "pezzo io con ensure()"), required: true } },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "feed_system", name: "effects_system" }], FXEX()),
}), (rt, p) => { impl(p.name, "io")?.ensure?.(rt.api); });

piece(C("sync_output", {
    scopo: "Allinea il tipo dell'uscita 0 al tipo risolto lungo la catena (setup, restore, connessioni, a valle, ogni ~200ms mentre si disegna).", natura: "funziona", dominio: "graph", estado: "draft",
    tag: ["comportamento", "uscita", "tipo"], uses: ["type_link"], props: {},
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "sync_output" }]),
}), (rt) => {
    const one = (n) => { try { ch.syncTypes(n); } catch (_) {} };
    const all = () => { one(rt.node); };
    all();
    rt.onRestore.add(all);
    rt.onConnect.add(() => { all(); for (const d of ch.downstream(rt.node)) one(d); });
    let last = 0;
    rt.onDraw.add(() => { const t = performance.now(); if (t - last > 200) { last = t; all(); } });
});

piece(C("paint_link", {
    scopo: "Disegna l'effetto dell'istanza sui fili che escono/entrano nel nodo (aggancia il disegno dei fili del canvas, rilasciato con l'ultimo nodo).", natura: "estetica", dominio: "graph", estado: "draft",
    tag: ["comportamento", "fili", "effetti"], uses: ["type_link", "effects_system"], props: { fps: N("ridisegni al secondo del canvas finche' il nodo esiste", 30) },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "paint_link" }], FXEX()),
}), (rt, p) => { attachWires(rt, p.fps ?? 30); });

piece(C("paint_link_native", {
    scopo: "Effetto sui reroute NATIVI di ComfyUI: fili che li attraversano (segmenti reali del canvas) e skin sopra il pallino.", natura: "estetica", dominio: "graph", estado: "draft",
    tag: ["comportamento", "fili", "effetti", "reroute", "estensione"], uses: ["effects_system"],
    props: {
        fps: N("ridisegni al secondo mentre l'effetto e' animato e ci sono reroute", 30),
        effect: S("id dell'effetto iniziale ('' = il primo dello store; in console: nativeReroutes.use(id))", ""),
        wires: B("disegna l'effetto sui fili che passano per i reroute", true),
        dot: B("disegna la skin dell'effetto sopra il pallino nativo", true),
        floating: B("anche fili/reroute flottanti (attenuati come fa ComfyUI)", true),
        ns: S("contenitore dei dati per-reroute nel SurvivalKit (graph.extra.succy.<ns>)", "reroutes"),
    },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "paint_link_native", fps: 10 }], FXEX()),
}), (rt, p) => {
    attachNative(rt, p.fps ?? 30, { route: ch.cfgFor(rt).route, ns: p.ns, effect: p.effect, wires: p.wires, dot: p.dot, floating: p.floating });
});

piece(C("snap_link_native", {
    scopo: "Fili da un reroute nativo che agganciano davvero: partenza larga, slot che brilla, rilascio generoso.", natura: "funziona", dominio: "graph", estado: "draft",
    tag: ["comportamento", "fili", "reroute", "estensione"],
    props: {
        startPx: N("px dal pallino del reroute entro cui il trascinamento lancia un filo (sotto coreRadius resta del core: sposta il reroute)", 26),
        coreRadius: N("px dal centro del pallino in cui il click resta del core", 8),
        snapPx: N("px dal mouse entro cui uno slot compatibile e' candidato all'aggancio", 30),
        glow: S("colore dell'alone dello slot agganciato", "#7fd4ff"),
    },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "snap_link_native" }]),
}), (rt, p) => {
    if (!rt.ext) return;                                 // extensions only (a node is not a reroute)
    const kit = globalThis.SurvivalKit;
    if (!kit?.rerouteSnap) return;
    rt.bag.add(kit.rerouteSnap.install({ startPx: p.startPx, coreRadius: p.coreRadius, snapPx: p.snapPx, glow: p.glow }));
});

piece(C("open_float_native", {
    scopo: "Menu dell'estensione su un reroute nativo: passando sul pallino appare una rotella, cliccandola si apre (o hover con attesa).", natura: "funziona", dominio: "graph", estado: "draft",
    tag: ["comportamento", "menu", "reroute", "estensione"],
    props: {
        menu: { ...S("menu dell'estensione da aprire"), required: true },
        on: E(["gear", "hover"], "gear = rotella da cliccare accanto al pallino; hover = si apre dopo una sosta", "gear"),
        dwell: N("hover: ms di sosta sul pallino prima di aprire", 450),
        keep: N("gear: ms in cui la rotella resta visibile dopo aver lasciato il pallino", 900),
    },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "open_float_native", menu: "m" }]),
}), (rt, p) => {
    const ext = rt.ext;
    if (!ext) return;                                    // extensions only (a node has no reroute under the pointer)
    const mode = p.on === "hover" ? "hover" : "gear";
    const dwell = Math.max(0, p.dwell ?? 450), keep = Math.max(0, p.keep ?? 900);
    let tries = 0, hoverR = null, tid = 0, last = { x: 0, y: 0 }, gearR = null, gearUntil = 0, gearHot = false, lastG = null;
    const clear = () => { if (tid) { clearTimeout(tid); tid = 0; } };
    rt.bag.add(clear);
    // gear: in graph coordinates, constant size on screen
    const gearAt = (cv, r) => { const s = cv.ds?.scale || 1, R = Number(r.constructor?.radius) || 10; return { x: r.pos[0] + R + 9 / s, y: r.pos[1] - R - 9 / s, rad: 8 / s }; };
    const onGear = (cv, pos) => { if (!gearR || !pos) return false; const g = gearAt(cv, gearR); return Math.hypot(pos[0] - g.x, pos[1] - g.y) <= g.rad * 1.3; };
    if (mode === "gear") {
        const draw = (ctx, cv) => {
            if (!gearR || cv.graph !== gearR.__g) return;
            const over = lastG && Math.hypot(lastG[0] - gearR.pos[0], lastG[1] - gearR.pos[1]) <= (Number(gearR.constructor?.radius) || 10) * 1.2;
            if (over) gearUntil = performance.now() + keep;           // pointer resting on the dot: the gear stays
            if (performance.now() > gearUntil && !gearHot) { gearR = null; return; }
            const g = gearAt(cv, gearR), s = cv.ds?.scale || 1;
            ctx.save();
            try {
                ctx.globalAlpha = 1;
                ctx.fillStyle = gearHot ? "rgba(74,158,255,.95)" : "rgba(20,22,28,.92)";
                ctx.strokeStyle = gearHot ? "#fff" : "rgba(255,255,255,.55)"; ctx.lineWidth = 1.2 / s;
                ctx.beginPath(); ctx.arc(g.x, g.y, g.rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                ctx.fillStyle = "#fff"; ctx.font = `${11 / s}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText("⚙", g.x, g.y + 0.5 / s);
            } finally { ctx.restore(); }
        };
        DECOR.add(draw);
        rt.bag.add(() => DECOR.delete(draw));
    }
    const go = () => {
        if (rt.bag.closed) return;
        const cv = globalThis.app?.canvas, el = cv?.canvas;
        if (!el) { if (++tries < 240) rt.bag.timeout(go, 250); return; }
        const graphPos = (e) => { try { return typeof cv.convertEventToCanvasOffset === "function" ? cv.convertEventToCanvasOffset(e) : cv.graph_mouse; } catch (_) { return cv.graph_mouse; } };
        const onMove = (e) => {
            last = { x: e.clientX, y: e.clientY };
            const g = cv.graph;
            if (typeof g?.getRerouteOnPos !== "function") return;
            const pos = graphPos(e);
            lastG = pos ? [pos[0], pos[1]] : null;
            if (mode === "gear") {
                const hot = onGear(cv, pos);
                const r = !e.buttons && pos ? g.getRerouteOnPos(pos[0], pos[1]) : null;
                let dirty = hot !== gearHot;
                gearHot = hot;
                if (r) { if (gearR !== r) dirty = true; gearR = r; r.__g = g; gearUntil = performance.now() + keep; rt.bag.timeout(() => { try { cv.setDirty?.(true, true); } catch (_) {} }, keep + 60); }
                else if (gearR && !hot && performance.now() > gearUntil) { gearR = null; dirty = true; }
                if (dirty || gearR) { try { cv.setDirty?.(true, true); } catch (_) {} }
                if (hot) { try { el.style.cursor = "pointer"; } catch (_) {} }
                return;
            }
            if (e.buttons || cv.dragging_canvas) { hoverR = null; clear(); return; }
            const r = pos ? g.getRerouteOnPos(pos[0], pos[1]) : null;
            if (r === hoverR) return;
            hoverR = r; clear();
            if (!r) return;
            if (ext.current()?.node?.reroute === r) return;      // already open on this one
            tid = setTimeout(() => { tid = 0; if (hoverR === r && !rt.bag.closed) ext.openFor(r, p.menu, { point: { x: last.x + 14, y: last.y + 10 } }); }, dwell);
        };
        const onDown = (e) => {
            if (mode === "gear") {
                if (e.button !== 0 || !gearR) return;
                if (!onGear(cv, graphPos(e))) return;
                e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
                const r = gearR;
                ext.openFor(r, p.menu, { point: { x: e.clientX + 12, y: e.clientY + 8 } });
                return;
            }
            hoverR = null; clear();
        };
        rt.bag.listen(el, "pointermove", onMove, { passive: true });
        rt.bag.listen(el, "pointerleave", () => { hoverR = null; lastG = null; clear(); if (gearHot) { gearHot = false; try { cv.setDirty?.(true, true); } catch (_) {} } });
        rt.bag.listen(el, "pointerdown", onDown, { capture: true });
    };
    go();
});

piece(C("gate_link", {
    scopo: "Regolatore degli effetti sul canvas: soglie di costo (ms per frame) e calo automatico mentre il canvas si muove.", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["comportamento", "fili", "effetti", "prestazioni", "estensione"],
    props: {
        lite: N("ms del nostro disegno per frame oltre cui si passa a 'leggero' (niente blur/glow)", 6),
        still: N("ms oltre cui si passa a 'fermo' (niente animazione)", 12),
        frames: N("frame di fila sopra soglia prima di scendere", 8),
        move: B("durante pan/zoom/drag almeno 'leggero'", true),
        upMs: N("ms di calma prima di risalire di un livello", 2000),
    },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "gate_link", lite: 6 }]),
}), (rt, p) => {
    const before = Governor.configure({});
    Governor.configure(p);
    rt.bag.add(() => Governor.configure(before));
});

piece(C("bind_input", {
    scopo: "Il contenuto salvato (JSON con campo sig) vale solo finche' il filo in ingresso e' lo stesso; altrimenti si svuota.", natura: "funziona", dominio: "graph", estado: "draft",
    tag: ["comportamento", "input", "persistenza"], uses: ["sig_input"],
    props: { state: { ...K("chiave di stato con il JSON {sig,...}"), required: true }, input: N("indice dell'ingresso", 0), resetCache: J("chiavi cache da azzerare quando il contenuto cade") },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "bind_input", state: "content" }], { state: { content: { policy: "on-execute" } } }),
}), (rt, p) => {
    const input = p.input ?? rt.api.cfg("bind_input").input ?? 0;
    const validate = () => {
        const raw = rt.ctx.state.get(p.state);
        if (typeof raw !== "string" || !raw) return;
        let c = null; try { c = JSON.parse(raw); } catch (_) { return; }
        const cur = ch.wireSig(rt.node, input);
        if (cur === undefined) return;
        if (cur === null || (c?.sig && c.sig !== cur)) { rt.api.state.set(p.state, ""); for (const k of p.resetCache || []) rt.ctx.cache.set(k, false); }
    };
    validate();
    rt.onRestore.add(validate);
    rt.onConnect.add(validate);
});
void B; void E;
