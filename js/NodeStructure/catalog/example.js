// ============================================================
// NodeStructure/catalog/example.js — mounts each piece's `esempio` (no kit, no LiteGraph)
// Real runtime + fake ctx: validates the spec, builds the DOM, attaches behaviors, updates, releases.
// selfTest FAILS if an example doesn't validate, doesn't mount, leaves a [missing component] or leaks resources. We kiss and tell.
// ============================================================
import { normalizeSpec, checkRefs } from "../core/parser.js";
import { Runtime, INSTANCES, makeApi } from "../core/runtime.js";
import { createHost } from "../core/host.js";
import { renderTree } from "../core/renderer.js";
import { getBehavior } from "../behaviors/index.js";
import { Bag } from "../util/tracker.js";
import { deepClone } from "../util/json.js";

function fakeCtx(node, def) {
    const store = (init = {}) => { const m = new Map(Object.entries(init)); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => { m.set(k, v); }, delete: (k) => m.delete(k), flush() {} }; };
    const state = store(Object.fromEntries(Object.entries(def.state).filter(([, c]) => c && c.default !== undefined).map(([k, c]) => [k, c.default])));
    const natives = new Map((def.natives || []).map((n) => [n, { name: n, value: "", options: {} }]));
    const docL = [];
    return {
        node, key: "ex-" + def.type, id: node.id, graph: null,
        state, cache: store(), local: store(),
        log() {},
        perf: {
            acquireCanvas() {}, releaseCanvas() {}, acquireRAF() {}, releaseRAF() {}, observeResize() {}, unobserveResize() {},
        },
        utils: {
            scrollable() {}, withInternalResize: (fn) => fn(), getNative: (n) => natives.get(n), setNative: (n, v) => { const w = natives.get(n); if (w) w.value = v; return !!w; },
            showNative() {}, hideNative() {}, liveNode: () => node, orderWidgets() {},
            onDocument: (t, fn, o) => { document.addEventListener(t, fn, o); docL.push([t, fn, o]); },
        },
        _docL: docL,
    };
}

export function mountExample(card) {
    const out = { ok: false, errors: [] };
    let ex = card.esempio;
    if (typeof ex === "function") { try { ex = ex(); } catch (e) { out.errors.push("esempio() ha lanciato: " + (e.message || e)); return out; } }
    if (!ex || !ex.spec) { out.errors.push("esempio senza .spec"); return out; }
    const def = {
        type: "__ex_" + card.nome, actions: ex.actions || {}, live: ex.live || {}, hooks: {}, natives: ex.natives || [], config: ex.config,
        state: { ...(ex.state || {}), __ns_born: { policy: "ui", default: 0 }, __ns_over: { policy: "immediate", default: "" } }, minWidth: 100,
    };
    const res = normalizeSpec(ex.spec, {});
    out.errors.push(...res.errors);
    if (res.spec) out.errors.push(...checkRefs(res.refs, def));
    if (card.tipo !== "action" && card.tipo !== "io" && card.tipo !== "renderer" && res.spec && !res.used.has(card.nome) && !out.errors.length) out.errors.push(`l'esempio non usa il pezzo '${card.nome}'`);
    if (out.errors.length) return out;

    const node = { id: 1, type: def.type, size: [300, 100], inputs: [{ name: "i", type: "*", link: null }], outputs: [{ name: "o", type: "*" }], widgets: [], graph: null, is_selected: false, setSize() {}, computeSize: () => [300, 100] };
    const before = Bag.stats();
    const stage = document.createElement("div");
    stage.style.cssText = "position:fixed;left:-9999px;top:0;width:300px;visibility:hidden";
    document.body.appendChild(stage);
    const ctx = fakeCtx(node, def);
    const rt = new Runtime(ctx, def, deepClone(res.spec));
    INSTANCES.set(node, rt);
    rt.api = makeApi(rt);
    try {
        for (const rs of rt.spec.regions) {
            const { host, root, mode } = createHost(rt, rs, rt.spec);
            const tree = renderTree(rt, rs.tree, "ex:" + rs.id);
            root.appendChild(tree.root);
            stage.appendChild(host);
            rt.regions.set(rs.id, { spec: rs, host, root, tree, widget: null, mode });
        }
        for (const b of rt.spec.behaviors || []) {
            const att = getBehavior(b.type);
            if (!att) throw new Error(`behavior '${b.type}' non registrato`);
            att(rt, b);
        }
        rt.update(true);
        for (const fn of [...rt.onRestore]) fn({});
        for (const fn of [...rt.onUpdate]) fn();
        const miss = stage.querySelector(".ns-missing, .ns-raw-missing");
        if (miss) out.errors.push("DOM con elemento mancante: " + miss.textContent);
        if (!stage.querySelector(".ns-root *")) out.errors.push("DOM vuoto");
    } catch (e) { out.errors.push("montaggio fallito: " + (e.stack || e.message || e).split("\n").slice(0, 3).join(" | ")); }
    try { rt.destroyed || rt.dispose(); } catch (e) { out.errors.push("dispose fallito: " + e.message); }
    for (const [t, fn, o] of ctx._docL) document.removeEventListener(t, fn, o);
    stage.remove();
    INSTANCES.delete(node);
    const after = Bag.stats();
    if (after.liveBags !== before.liveBags || after.liveItems !== before.liveItems) out.errors.push(`risorse non rilasciate (bag ${before.liveBags}->${after.liveBags}, items ${before.liveItems}->${after.liveItems})`);
    out.ok = out.errors.length === 0;
    return out;
}
