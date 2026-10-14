// ============================================================
// pieces/node.js — behaviors on the node: ext_node (was reveal_node), lab_node, persist_node
// ============================================================
import { piece } from "../catalog/registry.js";
import { C, exb, E, K, ID, J, R } from "../catalog/kit.js";
import { evalValue } from "../core/binding.js";

// ext_node (D-86) — the EXT button, but with a lover's choice: when the flag is on, the outside world gets in through ONE of
// two doors. mode "widget" = the native widgets show up (the classic: type it, or hang a reroute on it). mode "chip" = the
// widgets stay hidden and real sockets appear instead, ready to wear a chip (chip_input) and take a REAL wire from anywhere.
// Flag off = both doors shut, the node keeps its legs together. Succubus approves: a node should always know who it's letting in.
const EXT_USERS = new Set();                   // { rt, on, mode, err } — for the Governor light (NodeStructure.ext.stats())

piece(C("ext_node", {
    scopo: "EXT: col flag acceso mostra i widget nativi (modo widget) o prese vere pronte per un chip (modo chip); spento nasconde tutto.",
    natura: "funziona", estado: "draft",
    tag: ["comportamento", "nativi", "ext", "chip"],
    props: {
        when: { ...R("flag EXT: ref letto a ogni update (es. $native.use_choice o $state.extOpen)"), required: true },
        mode: R("ref con il modo scelto: \"widget\" (default) o \"chip\" (es. $state.extMode)"),
        natives: { ...J("nomi dei widget nativi che il modo widget mostra"), required: true },
        sockets: J("prese vere [{name, type}] che il modo chip mostra (dichiarate opzionali nel Python)"),
        quiet: R("ref opzionale (es. $state.collapsed): se vero i widget nativi restano nascosti; le prese vere NON spariscono mai (portano fili)"),
    },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "ext_node", when: "$state.ext", mode: "$state.mode", natives: ["a"], sockets: [{ name: "a_in", type: "STRING" }] }],
        { state: { ext: { policy: "ui", default: false }, mode: { policy: "ui", default: "widget" } }, natives: ["a"] }),
}), (rt, p) => {
    const u = { rt, on: false, mode: "widget", err: "" };
    EXT_USERS.add(u); rt.bag.add(() => EXT_USERS.delete(u));
    let last = "";
    const apply = (force) => {
        try {
            const on = !!evalValue(rt, p.when);
            const m = p.mode !== undefined && evalValue(rt, p.mode) === "chip" ? "chip" : "widget";
            // D-89: a folded node keeps its natives hidden (operative, not essential). Sockets stay: they carry wires, never hide those.
            const quiet = p.quiet !== undefined && !!evalValue(rt, p.quiet);
            u.on = on; u.mode = m;
            const key = on + ":" + m + ":" + quiet;
            if (!force && key === last) return;
            last = key;
            if (on && m === "widget" && !quiet) rt.api.native.show(p.natives); else rt.api.native.hide(p.natives);
            if (Array.isArray(p.sockets) && p.sockets.length) globalThis.SurvivalKit?.nodePorts?.showInputs(rt.node, p.sockets, on && m === "chip");
            u.err = "";
        } catch (e) { u.err = String(e?.message || e); console.warn("[NodeStructure] ext_node:", e); }
    };
    apply(true);
    rt.onUpdate.add(() => apply(false));
    rt.onRestore.add(() => apply(true));
});

export const Ext = {
    stats() {
        const all = [...EXT_USERS].filter((x) => !x.rt.destroyed);
        return { users: all.length, chip: all.filter((x) => x.on && x.mode === "chip").length, widget: all.filter((x) => x.on && x.mode === "widget").length,
            errors: all.filter((x) => x.err).map((x) => `${x.rt.node?.type} #${x.rt.node?.id}: ${x.err}`) };
    },
};

piece(C("lab_node", {
    scopo: "TEST: con lo stato attivo esercita acquireRAF e observeResize del kit su un elemento.", natura: "funziona", dominio: "runtime", estado: "draft",
    tag: ["comportamento", "test", "kit"], props: { state: { ...K("chiave di stato bool"), required: true }, target: ID("elemento osservato") },
    esempio: exb({ t: "stack_box", id: "w", children: [] }, [{ type: "lab_node", state: "lab", target: "w" }], { state: { lab: { policy: "ui", default: false } } }),
}), (rt, p) => {
    let last;
    const wrap = () => rt.el(p.target);
    const apply = (force) => {
        const on = rt.ctx.state.get(p.state) === true;
        if (!force && on === last) return;
        last = on;
        const w = wrap();
        if (on) {
            let frames = 0;
            rt.ctx.perf.acquireRAF("lab", () => { frames++; if (frames % 60 === 0 && w) w.title = "lab frames: " + frames; });
            if (w) rt.ctx.perf.observeResize(w, () => { w.dataset.labH = String(w.offsetHeight); });
        } else {
            rt.ctx.perf.releaseRAF("lab");
            if (w) rt.ctx.perf.unobserveResize(w);
        }
    };
    apply(true);
    rt.onUpdate.add(() => apply(false));
    rt.onRestore.add(() => apply(true));
    rt.bag.add(() => { try { rt.ctx.perf.releaseRAF("lab"); } catch (_) {} });
});

piece(C("persist_node", {
    scopo: "Salva in una chiave di stato la larghezza scelta dall'utente quando ridimensiona il nodo.", natura: "funziona", estado: "draft",
    tag: ["comportamento", "resize", "persistenza"], props: { state: { ...K("chiave di stato numerica"), required: true }, what: E(["width"], "cosa salvare", "width") },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "persist_node", state: "uw" }], { state: { uw: { policy: "debounced", ms: 300 } } }),
}), (rt, p) => {
    rt.onNodeResize.add((size) => { if (size && size[0]) rt.api.state.set(p.state, size[0]); });
});
