// ============================================================
// NodeStructure/components/media.js
// image_element / canvas_element / slot_element / raw_element
//   canvas_element = canvas managed by the kit (acquireCanvas), draws a catalog
//                    RENDERER (`renderer:"dot_element"`, `args:{...}`);
//   slot_element / raw_element = ESCAPE HATCH (free DOM): they're DEBT and the
//                    catalog lists them per node. Every escape gets written down.
// ============================================================

import { GOV } from "../../Governor/governor.js";
import { mkEl, safeUrl } from "./index.js";
import { piece, impl } from "../catalog/registry.js";
import { C, ex, E, S, N, J, R, PC } from "../catalog/kit.js";
import { parseRef } from "../core/parser.js";
import { actionFn, evalDeep } from "../core/binding.js";

piece(C("image_element", {
    scopo: "Immagine (solo URL sicuri) che riempie il contenitore; eventi load/error via `on`.", natura: "estetica", estado: "stable", archetipo: "leaf",
    tag: ["media"], alias: ["image"], props: { src: R("URL (http, blob, data:image, relativo)"), fit: E(["contain", "cover", "fill", "none"], "adattamento", "contain") },
    esempio: ex({ t: "image_element", src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", fit: "contain" }),
}), (node, h) => {
    const img = mkEl("img", "ns-image");
    img.draggable = false;
    let last = null;
    const apply = () => {
        const fit = String(h.val(node.fit) || "contain").replace(/[^\w-]/g, "");
        img.style.objectFit = fit;
        const src = safeUrl(h.val(node.src));
        if (src === last) return;
        last = src;
        if (src) img.src = src; else img.removeAttribute("src");
    };
    apply();
    return { el: img, update: apply, handlesText: true };
});

piece(C("canvas_element", {
    scopo: "Canvas gestito dal kit (dpr, fps, visibilita') che disegna un renderer del catalogo.", natura: "estetica", dominio: "ui", estado: "stable", archetipo: "renderer-host",
    tag: ["media", "canvas"], alias: ["canvas"],
    props: {
        renderer: PC("renderer", "renderer del catalogo da disegnare"), args: J("argomenti per il renderer (valori letterali o ref)"),
        render: R("DEBITO: $live.nome con una funzione di disegno scritta nel nodo"), fps: N("frame al secondo", 30),
        priority: R("'selected' oppure ref booleano: priorita' di disegno"),
    },
    esempio: ex({ t: "canvas_element", renderer: "particles_element", args: { count: 4 }, fps: 10 }),
}), (node, h) => {
    const cv = mkEl("canvas", "ns-canvas");
    const { rt } = h;
    const rend = typeof node.renderer === "string" ? impl(node.renderer, "renderer") : null;
    const rr = parseRef(node.render);
    const fn = rend || (rr && rt.def[rr.kind]?.[rr.key]);
    if (typeof fn === "function") {
        const prio = parseRef(node.priority);
        const prioFn = node.priority === "selected" ? () => !!rt.node.is_selected : (prio ? () => !!h.val(node.priority) : undefined);
        const fps = Number(h.val(node.fps)) || 30;
        rt.ctx.perf.acquireCanvas(cv, {
            fps, priority: prioFn,
            render: (dt, g, w, hh) => {
                if (GOV.level >= 2) return;                 // throttle: stopped/off -> the last frame stays on screen
                if (rt.onDraw.size) rt.fire("onDraw");
                try { fn(rt.api, dt, g, w, hh, h.item, rend ? evalDeep(rt, node.args || {}, h.item) : undefined); }
                catch (e) { rt.warnOnce("canvas:" + (node.renderer || rr?.raw), e); }
            },
        });
        h.bag.add(() => { try { rt.ctx.perf.releaseCanvas(cv); } catch (_) {} });
    }
    return { el: cv };
});

// slot: mount(el, api) -> { dispose?() } | function | void.  Tracked by the bag.
piece(C("slot_element", {
    scopo: "ESCAPE HATCH: div vuoto in cui il nodo monta il suo DOM (debito: elencato per nodo).", natura: "funziona", estado: "draft", archetipo: "renderer-host",
    tag: ["debito", "escape"], alias: ["slot"], props: { name: S("nome dello slot"), mount: R("$actions.x che monta il DOM") },
    esempio: ex({ t: "slot_element", name: "s", mount: "$actions.mountIt" }, { actions: { mountIt() {} } }),
}), (node, h) => {
    const el = mkEl("div", "ns-slot");
    const { rt } = h;
    if (typeof node.name === "string") el.dataset.slot = node.name;
    const mount = typeof node.mount === "string" ? actionFn(rt, node.mount) : null;
    if (mount) {
        let ret;
        try { ret = mount(rt.api, el, h.item); }
        catch (e) { console.warn(`[NodeStructure] slot '${node.name ?? node.id ?? "?"}' mount failed (${rt.def.type}):`, e); }
        const dispose = typeof ret === "function" ? ret : ret?.dispose;
        if (typeof dispose === "function") h.bag.add(() => { try { dispose.call(ret); } catch (_) {} });
        if (ret && typeof ret === "object" && node.name) rt.slotApis.set(node.name, ret);
        if (node.name) h.bag.add(() => rt.slotApis.delete(node.name));
    }
    return { el, handlesText: true };
});

// raw: create(api, item) -> Element.  The node owns the DOM; the builder positions it.
piece(C("raw_element", {
    scopo: "ESCAPE HATCH: il nodo crea l'elemento DOM, il builder lo posiziona (debito).", natura: "funziona", estado: "draft", archetipo: "renderer-host",
    tag: ["debito", "escape"], alias: ["raw"], props: { create: R("$actions.x che ritorna un Element") },
    esempio: ex({ t: "raw_element", create: "$actions.mk" }, { actions: { mk: () => document.createElement("div") } }),
}), (node, h) => {
    const { rt } = h;
    const create = typeof node.create === "string" ? actionFn(rt, node.create) : null;
    let el = null;
    if (create) {
        try { el = create(rt.api, h.item); } catch (e) { console.warn(`[NodeStructure] raw create failed (${rt.def.type}):`, e); }
    }
    if (!(el instanceof Element)) el = mkEl("div", "ns-raw-missing");
    el.classList.add("ns-raw");
    return { el, handlesText: true };
});
