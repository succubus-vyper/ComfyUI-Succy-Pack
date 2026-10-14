// ============================================================
// pieces/ports.js — outputs that change shape (D-66)
//   behavior: shape_output   picks the node's "mode" from the type coming into an input and shapes
//                           outputs + native dropdown entries to match. The node only declares JSON:
//   { type: "shape_output", input: 0, combo: "output_type", cacheKey: "mode", resetOnUnplug: true,
//     types: { IMAGE: "IMAGE", STRING: "STRING", ... },            // dropdown value -> socket type
//     modes: [
//       { name: "IMAGE", when: ["IMAGE", "MASK"], combo: ["IMAGE", "MASK"],
//         outputs: [["output", "@combo"], ["width", "INT"], ["height", "INT"], ["megapixels", "FLOAT"]] },
//       { name: "TEXT", default: true, combo: ["STRING", "INT", ...], outputs: [["output", "@combo"]] } ] }
// Rules: input unplugged -> `default` mode (and, with resetOnUnplug, dropdown back to its first entry);
// unknown type ("*", untyped reroute) -> keeps the previous mode; dropdown value outside the list ->
// first entry of the mode. "@combo" = socket type taken from `types[dropdown value]` (otherwise "*").
// Removed outputs = unplugged wires (agreed with the user). The LiteGraph APIs are in Survival: shields/node-ports.js.
// COUNT variant (D-67, Pick Combo): `outputs: "$live.x"` = list [[name, type], ...] computed by the glue
// (e.g. from the number of columns); no `modes`. With `byName` (default with `outputs`) an output that changes place
// takes its wires along (Survival setOutputs byName).
// COUNT variant outputs may be [name, type, label]: the wire keeps `name`, the socket SHOWS `label` (Multi Math: r1 shows "Total").
// behavior: grow_input (D-70)  multi-input sockets that open the next one when the last is plugged. See syncGrow below.
// ============================================================
import { piece } from "../catalog/registry.js";
import { C, exb, N, S, B, J, R } from "../catalog/kit.js";
import { evalValue } from "../core/binding.js";

const NP = () => globalThis.SurvivalKit?.nodePorts || null;
const USERS = new Set();       // runtimes using shape_output (Governor light)

function syncOutput(rt, p) {
    const node = rt.node;
    const modes = Array.isArray(p.modes) ? p.modes : [];
    if (!node) return;
    if (p.outputs !== undefined) return syncCount(rt, p);
    if (!modes.length) return;
    const st = { rt, mode: null, err: "" };
    USERS.add(st);
    rt.bag.add(() => USERS.delete(st));
    const idx = Number(p.input) || 0;
    const key = p.cacheKey || "mode";
    const def = modes.find((m) => m.default) || modes[modes.length - 1];
    let busy = false, lastSig = "", wasConnected = null;

    const pick = (np) => {
        const connected = node.inputs?.[idx]?.link != null;
        const t = connected ? np.inputType(node, idx) : null;
        let mode;
        if (!connected) mode = def;
        else if (t == null) mode = modes.find((m) => m.name === (st.mode ?? rt.ctx.cache.get(key))) || modes.find((m) => (m.outputs?.length || 0) === (node.outputs?.length || 0)) || def;
        else mode = modes.find((m) => Array.isArray(m.when) && m.when.includes(t)) || def;
        return { mode, connected, t };
    };

    const apply = (force = false) => {
        if (busy || rt.destroyed) return;
        const np = NP();
        if (!np) { st.err = "SurvivalKit.nodePorts missing"; return; }
        const { mode, connected, t } = pick(np);
        const w = p.combo ? rt.ctx.utils.getNative?.(p.combo) : null;
        const sig = `${connected}|${t}|${mode.name}|${w?.value}|${node.outputs?.length}`;
        if (!force && sig === lastSig) return;
        busy = true;
        try {
            rt.ctx.utils.withInternalResize(() => {
                if (w && Array.isArray(mode.combo)) {
                    np.setComboValues(w, mode.combo);
                    const unplugged = wasConnected === true && !connected;
                    if (unplugged && p.resetOnUnplug && mode.combo.length) rt.api.native.set(p.combo, mode.combo[0]);
                    else if (!mode.combo.includes(w.value) && mode.combo.length) rt.api.native.set(p.combo, mode.combo[0]);
                }
                const cv = w?.value;
                const outs = (mode.outputs || []).map(([n, ty]) => [n, ty === "@combo" ? (p.types?.[cv] || "*") : ty]);
                np.setOutputs(node, outs, `${node.type} #${node.id}`);
            });
            st.mode = mode.name; st.err = "";
            rt.ctx.cache.set(key, mode.name);
            wasConnected = connected;
            lastSig = `${connected}|${t}|${mode.name}|${w?.value}|${node.outputs?.length}`;
        } catch (e) { st.err = String(e?.message || e); console.warn("[NodeStructure] shape_output:", e); }
        finally { busy = false; }
    };
    apply(true);
    rt.onRestore.add(() => apply(true));
    rt.onConnect.add(() => apply());
    rt.onUpdate.add(() => apply());           // dropdown changed from the node's menu (native.set -> update): cheap comparison
}

// count variant: the glue decides the shape ($live), the kit applies it (by name)
function syncCount(rt, p) {
    const node = rt.node;
    const st = { rt, mode: "count", err: "" };
    USERS.add(st);
    rt.bag.add(() => USERS.delete(st));
    let busy = false, lastSig = "", loaded = true;
    // `loaded` = the FIRST shape after a birth/load (open workflow, Ctrl+Z, paste): the node still has the sockets
    // from the Python (RETURN_NAMES) but the saved wires point at the POSITIONS of the saved shape, which is exactly `outs`
    // (computed from the already restored widgets). So it aligns BY POSITION first; afterwards by name (tested live, D-67).
    const apply = (force = false) => {
        if (busy || rt.destroyed) return;
        const np = NP();
        if (!np) { st.err = "SurvivalKit.nodePorts missing"; return; }
        let outs;
        try { outs = evalValue(rt, p.outputs); } catch (e) { st.err = "outputs: " + (e?.message || e); return; }
        if (!Array.isArray(outs) || !outs.every((o) => Array.isArray(o) && typeof o[0] === "string")) { st.err = "outputs is not [[name, type], ...]"; return; }
        let vals = null;
        if (p.combo && p.comboValues !== undefined) { try { vals = evalValue(rt, p.comboValues); } catch (_) { vals = null; } if (!Array.isArray(vals)) vals = null; }
        const sig = JSON.stringify(outs) + "|" + (node.outputs || []).map((o) => o.name + ":" + o.type).join(",") + "|" + JSON.stringify(vals);
        if (!force && sig === lastSig) return;
        busy = true;
        try {
            if (vals) { const w = rt.ctx.utils.getNative?.(p.combo); if (w) np.setComboValues(w, vals.map(String)); }
            const byName = p.byName !== false && !loaded;
            rt.ctx.utils.withInternalResize(() => np.setOutputs(node, outs, `${node.type} #${node.id}`, { byName }));
            loaded = false;
            st.err = "";
            lastSig = JSON.stringify(outs) + "|" + (node.outputs || []).map((o) => o.name + ":" + o.type).join(",") + "|" + JSON.stringify(vals);
        } catch (e) { st.err = String(e?.message || e); console.warn("[NodeStructure] shape_output (count):", e); }
        finally { busy = false; }
    };
    apply(true);
    rt.onRestore.add(() => { loaded = true; apply(true); });
    rt.onConnect.add(() => apply());
    rt.onUpdate.add(() => apply());
}

piece(C("shape_output", {
    scopo: "Uscite che cambiano forma: dal tipo che entra sceglie la modalita' e porta uscite e tendina a quella forma.",
    natura: "funziona", dominio: "graph", estado: "draft", tag: ["comportamento", "output", "dinamico", "tipi"],
    props: {
        modes: J("[{name, when?:[tipi], default?, combo?:[voci], outputs:[[nome, tipo|\"@combo\"]]}] (variante per tipo)"),
        outputs: R("variante a conteggio: ref (es. $live.outs) a [[nome, tipo], ...] calcolata dalla colla; esclude modes"),
        comboValues: R("con outputs: ref alla lista delle voci della tendina nativa `combo` (es. le etichette)"),
        byName: B("con outputs: le uscite si riconoscono dal nome e i fili seguono la presa che cambia posto", true),
        input: N("indice dell'ingresso che decide la modalita'", 0),
        combo: S("nome della tendina nativa: per tipo = sceglie il tipo dell'uscita principale; a conteggio = riceve comboValues"),
        types: J("{valore della tendina: tipo della presa} per \"@combo\" (mancante = \"*\")"),
        cacheKey: S("chiave di cache dove scrivere la modalita' (la legge la colla, es. $live)", "mode"),
        resetOnUnplug: B("staccando l'ingresso la tendina torna alla prima voce della modalita' di default", false),
    },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "shape_output", modes: [{ name: "A", default: true, outputs: [["o", "*"]] }] }]),
}), syncOutput);

// ---------------- grow_input (D-70) ----------------
// Multi-input sockets: plug the last visible one and the next one opens. NOTHING ever shifts upwards when you unplug
// (A and B gone, C still plugged => A, B (empty), C and D stay). The rule lives in Survival (node-ports.growInputs).
// Also publishes WHO feeds each socket into the cache (`cacheKey`, default "inNames": { a: "seed", b: "KSampler" }) so
// the glue / editor tokens can show the source's name instead of "a". Names refresh on every (un)plug; a source
// renamed later while still wired shows up within a second (cheap signature check, no redraw unless it changed).
function syncGrow(rt, p) {
    const node = rt.node;
    const names = Array.isArray(p.names) ? p.names.map(String) : [];
    if (!node || !names.length) return;
    const st = { rt, mode: "grow", err: "" };
    USERS.add(st);
    rt.bag.add(() => USERS.delete(st));
    const key = p.cacheKey || "inNames";
    let busy = false, lastNames = "";
    const apply = () => {
        if (busy || rt.destroyed) return;
        const np = NP();
        if (!np?.growInputs) { st.err = "SurvivalKit.nodePorts.growInputs missing"; return; }
        busy = true;
        try {
            rt.ctx.utils.withInternalResize(() => np.growInputs(node, names, { min: Number(p.min) || 2, type: p.slotType || "*" }));
            const map = {};
            names.forEach((n) => {
                const i = (node.inputs || []).findIndex((x) => x.name === n);
                const s = i >= 0 ? np.inputSource(node, i) : null;
                if (s) map[n] = { name: s.name, from: s.output ? `${s.node} · ${s.output}` : s.node };
            });
            const sig = JSON.stringify(map) + "|" + (node.inputs || []).map((x) => x.name).join(",");
            if (sig !== lastNames) { lastNames = sig; rt.ctx.cache.set(key, map); rt.update(); }     // tokens / glue read it
            st.err = "";
        } catch (e) { st.err = String(e?.message || e); console.warn("[NodeStructure] grow_input:", e); }
        finally { busy = false; }
    };
    apply();
    rt.onRestore.add(() => apply());
    rt.onConnect.add(() => apply());
    rt.api.every(() => { if (node.graph) apply(); }, 1000);          // a node that already left the graph has nothing to grow (and no addInput worth calling)
}

piece(C("grow_input", {
    scopo: "Ingressi multipli che crescono: collegato l'ultimo se ne apre un altro; scollegando nulla si sposta. Pubblica il nome delle sorgenti.",
    natura: "funziona", dominio: "graph", estado: "draft", tag: ["comportamento", "input", "dinamico", "multi-ingresso"],
    props: {
        names: { ...J("[nomi delle prese in ordine, es. a..j]"), required: true },
        min: N("prese sempre visibili (almeno)", 2),
        slotType: S("tipo delle prese aggiunte", "*"),
        cacheKey: S("chiave di cache con { presa: { name, from } } per le prese collegate", "inNames"),
    },
    esempio: exb({ t: "label_element", text: "x" }, [{ type: "grow_input", names: ["a", "b", "c"] }]),
}), syncGrow);

export const Ports = {
    stats() {
        const all = [...USERS].filter((u) => !u.rt.destroyed);
        return { users: all.length, errors: all.filter((u) => u.err).map((u) => `${u.rt.node?.type} #${u.rt.node?.id}: ${u.err}`), kit: NP()?.stats() || null };
    },
};
