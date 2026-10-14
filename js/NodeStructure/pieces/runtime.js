// ============================================================
// pieces/runtime.js — pieces for nodes that WAIT or WATCH the machine (D-82)
//   behavior: hold_node      binds a node to the SurvivalKit hold shield (stop the graph in place, wait for a human)
//   action:   release_graph  Continue / Stop of a waiting hold
//   action:   sound_system   rings a bell (URL) — the ding of Pause, free for any other node
//   io:       vram_system    live VRAM reading for status_element ({label, value, bar, tone}), ONE shared poller
// The machinery itself is NOT here: run states live in SurvivalKit/shields/hold.js, the poller in runtime/vram-feed.js.
// These pieces are the thin sockets the nodes plug into. Succubus was here — she plugs things in, then stays a while.
// ============================================================
import { piece } from "../catalog/registry.js";
import { C, ex, exb, E, S, N, J } from "../catalog/kit.js";
import { Sound } from "../runtime/sound.js";
import { VramFeed } from "../runtime/vram-feed.js";

const BTN = (id, text, on) => ({ t: "button_element", id, text, on });

// ---------- behavior: hold_node ----------
const DINGS = new Set();          // one "start" listener per bell URL

piece(C("hold_node", {
    scopo: "Lega il nodo allo scudo hold del Survival e ne scrive lo stato in cache (holdText, holdTimer, holdTone, holdOff, holdLabel).",
    natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["comportamento", "pausa", "run"], uses: ["sound_system"],
    props: {
        route: S("POST del backend per continue/stop", "/succy/pause/action"),
        info: S("evento del backend che dice se il nodo e' in un loop", "succy-pause-info"),
        ding: S("URL del suono quando il nodo si ferma (se il widget sound e' on); vuoto = niente suono", ""),
        ghost: S("socket di ingresso da togliere (il widget run_id nascosto ne ha uno fantasma)", ""),
        names: J("nomi dei widget nativi {pause,timeout,onTimeout,sound,runId} (default: pause_flow...)"),
    },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "hold_node" }]),
}), (rt, p) => {
    const Hold = globalThis.SurvivalKit?.hold;
    if (!Hold) { rt.warnOnce("hold", "SurvivalKit.hold not available"); return; }
    const cfg = { classType: rt.def.type };
    for (const k of ["route", "info", "names"]) if (p[k] !== undefined) cfg[k === "info" ? "infoEvent" : k] = p[k];
    Hold.install(cfg);
    if (p.ding && !DINGS.has(p.ding)) {
        DINGS.add(p.ding);
        Sound.preload(p.ding);
        Hold.on("start", ({ sound }) => { if (sound) Sound.play(p.ding); });
    }

    const node = () => rt.api.liveNode() || rt.node;
    const cache = rt.ctx.cache;
    const refresh = () => {
        const v = Hold.view(node());
        const next = { holdText: v.text, holdTimer: v.timer, holdTone: v.tone, holdOff: !v.canAct, holdLabel: v.label };
        let changed = false;
        for (const [k, x] of Object.entries(next)) if (cache.get(k) !== x) { cache.set(k, x); changed = true; }
        return changed;
    };
    // the hidden run_id widget leaves a ghost socket on the node: strip it (same as the old Pause did at 0/10/100 ms)
    const strip = () => {
        if (!p.ghost) return;
        try {
            const n = node(); const i = (n.inputs || []).findIndex((x) => x?.name === p.ghost);
            if (i > -1 && typeof n.removeInput === "function") n.removeInput(i);
        } catch (e) { rt.warnOnce("hold.ghost", e); }
    };
    const attach = () => { Hold.attach(node()); strip(); if (refresh()) rt.update(); };
    attach();
    for (const ms of [10, 100]) rt.api.after(strip, ms);
    rt.onRestore.add(attach);
    const off = Hold.subscribe(node(), () => { if (refresh()) rt.update(); });
    rt.bag.add(() => { off(); Hold.detach(rt.node); });
});

// ---------- action: release_graph ----------
piece(C("release_graph", {
    scopo: "Continue o Stop di un hold in attesa (Continue diventa 'Resume loop' da solo se il nodo e' dentro un loop).", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["azione", "pausa", "run"], uses: ["hold_node"],
    props: { do: E(["continue", "stop"], "cosa fare", "continue") },
    esempio: ex(BTN("b", "go", { click: { do: "$actions.release_graph", args: { do: "stop" } } })),
}), (api, ev, el, item, a = {}) => {
    ev?.stopPropagation?.();
    const Hold = globalThis.SurvivalKit?.hold;
    if (!Hold) return;
    Hold.act(api.liveNode() || api.node, a.do === "stop" ? "stop" : "continue");
});

// ---------- action: sound_system ----------
piece(C("sound_system", {
    scopo: "Suona un file audio da un URL (cache + sblocco autoplay del browser).", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["azione", "suono"],
    props: { src: { ...S("URL del suono"), required: true }, volume: N("volume 0..1", 1) },
    esempio: ex(BTN("b", "go", { click: { do: "$actions.sound_system", args: { src: "/__none__.mp3" } } })),
}), (api, ev, el, item, a = {}) => {
    if (a.src) Sound.play(String(a.src), Number.isFinite(Number(a.volume)) ? Number(a.volume) : 1);
});

// ---------- io: vram_system ----------
const toneOf = (pct) => (pct > 90 ? "danger" : pct > 75 ? "warn" : "info");
const vramSystem = () => {
    const s = VramFeed.last();
    if (s.kind === "ok") return { label: `VRAM USED: ${s.pct.toFixed(1)}%`, value: `${s.used} / ${s.total} GB`, bar: s.pct, tone: toneOf(s.pct), labelTone: "mute" };
    if (s.kind === "nocuda") return { label: "NO CUDA DEVICE", value: "N/A", bar: 0, tone: "mute", labelTone: "mute" };
    if (s.kind === "na") return { label: "STATS UNAVAILABLE", value: "N/A", bar: 0, tone: "mute", labelTone: "mute" };
    return { label: "SYSTEM READY", value: "Monitoring…", bar: 0, tone: "info", labelTone: "mute" };
};
vramSystem.ensure = (api) => {
    const off = VramFeed.subscribe(() => api.refresh(), () => !api.node.flags?.collapsed);
    api.onDispose(off);
};
piece(C("vram_system", {
    scopo: "Lettura live della VRAM ({label, value, bar, tone, labelTone}) da un solo poller condiviso; con feed_system parte e si ferma da solo.",
    natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["vram", "dati", "stato"], props: {},
    esempio: ex({ t: "label_element", text: "{{$live.vram_system.label}}" }),
}), vramSystem);
