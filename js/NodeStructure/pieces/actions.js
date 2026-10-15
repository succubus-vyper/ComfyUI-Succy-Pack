// ============================================================
// pieces/actions.js — the kit's GENERIC actions ($actions.<name>, with `args`)
//   copy_system  download_system  flip_node  set_node  focus_graph
//   reload_system  fit_mask  reset_node  toast_system  kill_node
// Signature: (api, ev, el, item, args). The args arrive already resolved ($ref/template evaluated).
// ============================================================
import { piece } from "../catalog/registry.js";
import { C, ex, E, S, N, B, R, K, J } from "../catalog/kit.js";
import { INSTANCES } from "../core/runtime.js";
import { writePersisted } from "../core/heights.js";
import { impl } from "../catalog/registry.js";

const BTN = (id, text, on) => ({ t: "button_element", id, text, on });
const actEx = (name, args, more = {}) => ex(BTN("b", "go", { click: { do: "$actions." + name, args } }), more);

const flash = (api, key, ok) => {
    api.cache.set(key, ok ? "✓" : "✗"); api.refresh();
    api.after(() => { api.cache.set(key, ""); api.refresh(); }, 1500);
};

piece(C("copy_system", {
    scopo: "Copia negli appunti un testo oppure un'immagine (da URL) e mostra un flash ✓/✗ nella cache.", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["azione", "appunti"],
    props: { kind: E(["text", "image"], "cosa copiare", "text"), text: R("testo da copiare"), url: R("URL dell'immagine (kind image)"), flash: S("chiave cache per il flash ✓/✗", "copyFlash") },
    esempio: actEx("copy_system", { kind: "text", text: "x", flash: "cf" }),
}), async (api, ev, el, item, a = {}) => {
    ev?.stopPropagation?.();
    const key = a.flash || "copyFlash";
    try {
        if (a.kind === "image" && a.url) {
            const blob = await (await fetch(a.url)).blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
        } else await navigator.clipboard.writeText(String(a.text ?? ""));
        flash(api, key, true);
    } catch (e) { api.log?.("copy failed", e); flash(api, key, false); }
});

piece(C("download_system", {
    scopo: "Scarica un file da un URL (fetch + blob) con il nome indicato e mostra un flash ✓/✗.", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["azione", "file"],
    props: { url: { ...R("URL da scaricare"), required: true }, name: S("nome del file", "download"), flash: S("chiave cache per il flash", "dlFlash") },
    esempio: actEx("download_system", { url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", name: "x.gif" }),
}), async (api, ev, el, item, a = {}) => {
    ev?.stopPropagation?.();
    if (!a.url) return;
    const key = a.flash || "dlFlash";
    try {
        const blob = await (await fetch(a.url)).blob();
        const bu = URL.createObjectURL(blob);
        const link = document.createElement("a"); link.href = bu; link.download = a.name || "download";
        document.body.appendChild(link); link.click(); link.remove();
        api.after(() => URL.revokeObjectURL(bu), 1000);
        flash(api, key, true);
    } catch (e) { api.log?.("download failed", e); flash(api, key, false); }
});

piece(C("flip_node", {
    scopo: "Inverte una chiave di stato booleana del nodo (con default quando non e' ancora impostata) oppure un widget nativo booleano (`native`).", natura: "funziona", estado: "draft",
    tag: ["azione", "stato"],
    props: { key: K("chiave di stato bool"), native: S("in alternativa a key: nome di un widget nativo bool (es. use_choice)"), default: B("valore assunto se la chiave e' vuota", false) },
    esempio: actEx("flip_node", { key: "f" }, { state: { f: { policy: "ui", default: false } } }),
}), (api, ev, el, item, a = {}) => {
    // a native widget gets flipped in place (the Python reads it); otherwise the kit state key — one flick and she switches sides
    if (a.native) { const v = api.native.get(a.native); api.native.set(a.native, !(v === true || v === "true")); return; }
    if (!a.key) return;
    const cur = api.state.get(a.key);
    const eff = cur === undefined || cur === null ? !!a.default : !!cur;
    api.state.set(a.key, !eff);
});

piece(C("set_node", {
    scopo: "Scrive un valore in una chiave di stato del nodo o in un widget nativo (salvo `unless`) e, se richiesto, segna il grafo come modificato.", natura: "funziona", estado: "draft",
    tag: ["azione", "stato"],
    props: { key: K("chiave di stato"), native: S("in alternativa a key: nome di un widget nativo (es. box)"), value: { ...R("valore da scrivere"), required: true }, unless: R("se vero non fa nulla"), change: B("chiama graph.change()", false) },
    esempio: actEx("set_node", { key: "v", value: "uno", change: true }, { state: { v: { policy: "ui" } } }),
}), (api, ev, el, item, a = {}) => {
    if (a.unless) return;
    // a native widget gets the value in place (the Python reads it) — same door as flip_node
    if (a.native) { if (api.native.get(a.native) !== a.value) api.native.set(a.native, a.value); return; }
    if (!a.key) return;
    if (api.state.get(a.key) === a.value) return;
    api.state.set(a.key, a.value);
    if (a.change) { try { api.node.graph?.change?.(); } catch (_) {} }
});

piece(C("focus_graph", {
    scopo: "Centra un altro nodo (o reroute nativo) del grafo e, se indicato, apre li' un menu (chiudendo il corrente).", natura: "funziona", dominio: "graph", estado: "draft",
    tag: ["azione", "grafo", "navigazione"],
    props: { node: { ...R("nodo di destinazione (da un $live del kit)"), required: true }, menu: S("menu da aprire sul nodo di destinazione"), close: S("menu da chiudere su questo nodo") },
    esempio: actEx("focus_graph", { node: "$live.self_node.node", close: "m" }),
}), (api, ev, el, item, a = {}) => {
    const target = a.node;
    if (a.close) api.closeMenu(a.close);
    if (!target) return;
    if (target.reroute) {                                 // native reroute subject: centers the canvas on the dot — all eyes on her
        const cv = globalThis.app?.canvas, r = target.reroute;
        try {
            const dpr = globalThis.devicePixelRatio || 1, sc = cv.ds.scale || 1;
            cv.ds.offset[0] = -r.pos[0] + (cv.canvas.width * 0.5) / (sc * dpr);
            cv.ds.offset[1] = -r.pos[1] + (cv.canvas.height * 0.5) / (sc * dpr);
            cv.setDirty?.(true, true);
        } catch (_) {}
        if (a.menu && typeof target.open === "function") {
            let pt;
            try { const b = cv.canvas.getBoundingClientRect(); pt = { x: b.left + b.width / 2 + 18, y: b.top + b.height / 2 + 12 }; } catch (_) {}
            setTimeout(() => target.open(a.menu, pt ? { point: pt } : {}), 0);     // not api.after: the current menu (and its runtime) closes now
        }
        return;
    }
    try { globalThis.app?.canvas?.selectNode?.(target); globalThis.app?.canvas?.centerOnNode?.(target); } catch (_) {}
    if (a.menu) INSTANCES.get(target)?.api.openMenu(a.menu, { reopen: true });
});

piece(C("reload_system", {
    scopo: "Ricarica una sorgente dati del kit (es. effects_system) chiamando il suo reload().", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["azione", "dati"], props: { name: { ...S("nome del pezzo io da ricaricare"), required: true } },
    esempio: actEx("reload_system", { name: "effects_system" }),
}), (api, ev, el, item, a = {}) => { const f = impl(a.name, "io"); f?.reload?.(api); });

piece(C("fit_mask", {
    scopo: "Alla prima immagine caricata adatta l'altezza di una maschera al rapporto d'aspetto (persistita).", natura: "funziona", estado: "draft",
    tag: ["azione", "layout", "immagine"],
    props: {
        state: { ...K("chiave di stato numerica dell'altezza"), required: true }, min: N("altezza minima dell'adattamento", 160), max: N("altezza massima", 640),
        pad: N("spazio aggiunto (px)", 40), done: S("chiave cache 'gia' adattato'", "fitDone"), when: R("se definito e falso non fa nulla"),
    },
    esempio: actEx("fit_mask", { state: "ah", min: 100, max: 300 }, { state: { ah: { policy: "ui" } } }),
}), (api, ev, el, item, a = {}) => {
    const img = ev?.detail?.img || el?.querySelector?.("img");
    if (!img?.naturalWidth) return;
    const done = a.done || "fitDone";
    if (api.cache.get(done) || (a.when !== undefined && !a.when)) return;
    const innerW = Math.max(120, (api.node.size?.[0] || 240) - 40);
    const area = Math.round(Math.min(a.max ?? 640, Math.max(a.min ?? 160, innerW * img.naturalHeight / img.naturalWidth + (a.pad ?? 40))));
    api.cache.set(done, true);
    const rt = INSTANCES.get(api.node);
    if (rt) writePersisted(rt, { kind: "state", key: a.state, raw: "$state." + a.state }, area, true);
    api.relayout();
});

piece(C("reset_node", {
    scopo: "Riporta a un valore una chiave di stato numerica (cache+local+state) e, se indicato, la larghezza del nodo.", natura: "funziona", estado: "draft",
    tag: ["azione", "layout", "stato"],
    props: { key: { ...K("chiave di stato numerica da riportare"), required: true }, value: { ...N("valore"), required: true }, width: N("larghezza del nodo (px); assente = invariata") },
    esempio: actEx("reset_node", { key: "h", value: 100 }, { state: { h: { policy: "ui" } } }),
}), (api, ev, el, item, a = {}) => {
    const rt = INSTANCES.get(api.node);
    if (rt && typeof a.value === "number") writePersisted(rt, { kind: "state", key: a.key, raw: "$state." + a.key }, a.value, true);
    if (typeof a.width === "number") {
        try { api.utils.withInternalResize(() => api.node.setSize?.([a.width, api.node.size?.[1] ?? 0])); } catch (_) {}
    }
    api.relayout();
});

piece(C("toast_system", {
    scopo: "Mostra un avviso temporaneo in alto a destra.", natura: "funziona", dominio: "ui", estado: "draft",
    tag: ["azione", "avviso"], props: { text: { ...R("testo (accetta template {{$state.x}})"), required: true }, ms: N("durata (ms)", 2000) },
    esempio: actEx("toast_system", { text: "ciao" }),
}), (api, ev, el, item, a = {}) => api.toast(a.text ?? "", a.ms));

piece(C("kill_node", {
    scopo: "TEST: rimuove i widget DOM del kit dal nodo e forza heal (prova di auto-riparazione).", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["azione", "test", "heal"], props: {},
    esempio: actEx("kill_node", {}),
}), (api) => {
    const n = api.node;
    for (let i = n.widgets.length - 1; i >= 0; i--) if (n.widgets[i]?._succyKitDom) n.widgets.splice(i, 1);
    api.after(() => {
        const cfg = globalThis.__succyConfigs?.get(api.type);
        try { globalThis.SurvivalKit.heal.heal(n, true, cfg); } catch (err) { console.warn("[kill_node] heal error:", err); }
    }, 50);
});
void J;
