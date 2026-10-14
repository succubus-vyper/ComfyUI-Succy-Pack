// ============================================================
// NodeStructure/selftest.js  —  NodeStructure.selfTest()
// ------------------------------------------------------------
//   await NodeStructure.selfTest()                      // every defined type
//   await NodeStructure.selfTest({ types:["Succy_X"] })
//   opts: { types, app, graph, create(type)->node, wait(ms), cycles, quiet }
//
// Checks (each one yields PASS / FAIL / SKIP + details):
//   T1 create/remove nodes without leaks (instances, Bag, DOM host, anim timers, toasts)
//   T2 spec: validation, JSON round-trip, no non-JSON values
//   T3 persistence: overrides + state -> serialize -> configure on a new node
//   T4 float menu: open/close N times, no leftover listeners on document/window
//   T5 subgraph: convert / unpack (SKIP if the frontend API isn't there)
//   T6 negatives: broken specs get REJECTED (parser). Not everyone gets in.
// Output: table + last line   NS_SELFTEST_JSON {...}
//
// A SKIP is not a PASS: it means "not verified here". Don't fake it.
// ============================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- listener count on document/window/body/documentElement (Proxy, restored) ----
function trackListeners() {
    const EP = EventTarget.prototype;
    const origAdd = EP.addEventListener, origRem = EP.removeEventListener;
    const watched = (t) => t === document || t === window || t === document.body || t === document.documentElement;
    const ids = new WeakMap(); let seq = 0;
    const idOf = (o) => { if (o == null) return "0"; if (typeof o !== "object" && typeof o !== "function") return String(o); let i = ids.get(o); if (!i) { i = ++seq; ids.set(o, i); } return String(i); };
    const net = new Map();
    const cap = (o) => (typeof o === "boolean" ? o : !!(o && o.capture));
    const key = (t, type, fn, o) => `${t === window ? "win" : t === document ? "doc" : "el"}|${type}|${idOf(fn)}|${cap(o)}`;
    EP.addEventListener = new Proxy(origAdd, {
        apply(target, self, args) {
            if (watched(self) && args[1]) { const k = key(self, args[0], args[1], args[2]); if (!net.has(k)) net.set(k, args[0]); }
            return Reflect.apply(target, self, args);
        },
    });
    EP.removeEventListener = new Proxy(origRem, {
        apply(target, self, args) {
            if (watched(self) && args[1]) net.delete(key(self, args[0], args[1], args[2]));
            return Reflect.apply(target, self, args);
        },
    });
    return {
        snapshot: () => new Map(net),
        stop() { EP.addEventListener = origAdd; EP.removeEventListener = origRem; },
    };
}
const diffKeys = (a, b) => [...b.keys()].filter((k) => !a.has(k));

// ---- find elements by id (per spec: first id) ----
function firstId(spec) {
    let found = null;
    const walk = (n) => { if (found || !n || typeof n !== "object") return; if (n.id && n.t === "label") { found = n.id; return; } (n.children || []).forEach(walk); };
    for (const r of spec.regions) walk(r.tree);
    if (!found) { const walk2 = (n) => { if (found || !n || typeof n !== "object") return; if (n.id) { found = n.id; return; } (n.children || []).forEach(walk2); }; for (const r of spec.regions) walk2(r.tree); }
    return found;
}

export async function runSelfTest(NS, opts = {}) {
    const t0 = performance.now();
    const results = [];
    const log = (...a) => { if (!opts.quiet) console.log(...a); };
    const wait = opts.wait || sleep;
    const rec = (id, name, status, detail = "") => { results.push({ id, name, status, detail: String(detail) }); };

    await catalogTests(NS, rec);

    // --- environment ---
    let app = opts.app || globalThis.app || null;
    if (!app) { try { app = (await import("../../../scripts/app.js")).app; } catch (_) {} }
    const graph = opts.graph || app?.graph || null;
    const LG = globalThis.LiteGraph;
    const create = opts.create || (LG?.createNode ? (t) => LG.createNode(t) : null);
    const defs = NS.defs;
    const types = (opts.types || [...defs.keys()]).filter((t) => defs.has(t));
    const cycles = opts.cycles || 3;

    if (!graph || !create) {
        rec("ENV", "ambiente (app.graph + createNode)", "FAIL", "manca app.graph o LiteGraph.createNode: passa opts.{graph,create}");
        return finish();
    }
    if (!types.length) { rec("ENV", "tipi definiti", "FAIL", "nessun tipo NodeStructure.define'd"); return finish(); }

    const makeNode = async (type) => {
        const n = create(type);
        if (!n) throw new Error(`createNode('${type}') ha restituito null (tipo non registrato nel frontend?)`);
        graph.add(n);
        return n;
    };
    const settle = () => wait(750);
    const dropAll = async (nodes) => { for (const n of nodes) { try { graph.remove(n); } catch (_) {} } await wait(450); };
    const base = () => { const i = NS.inspect(); return { instances: i.instances, bags: i.bags.liveBags, items: i.bags.liveItems, hosts: document.querySelectorAll(".ns-host").length, toast: !!document.getElementById("succy-ns-toast-host"), menus: document.querySelectorAll('[id^="succy-ns-menu"]').length }; };

    // =========================================================
    // T1  create / remove without leaks
    // =========================================================
    for (const type of types) {
        const id = `T1:${type}`;
        try {
            const b0 = base();
            const growth = [];
            let regionsOk = true, heightsOk = true, detailExtra = "";
            for (let c = 0; c < cycles; c++) {
                const nodes = [];
                for (let k = 0; k < 3; k++) nodes.push(await makeNode(type));
                await settle();
                const mid = base();
                if (mid.instances !== b0.instances + 3) throw new Error(`ciclo ${c}: istanze ${mid.instances}, attese ${b0.instances + 3}`);
                for (const n of nodes) {
                    const rt = NS.instanceOf(n);
                    if (!rt) { regionsOk = false; continue; }
                    const want = defs.get(type).template.regions.map((r) => r.id).sort().join(",");
                    if ([...rt.regions.keys()].sort().join(",") !== want) regionsOk = false;
                    for (const w of n.widgets || []) {
                        if (!w.name?.startsWith("ns_")) continue;
                        const h = w.computeSize?.(300)?.[1];
                        if (!Number.isFinite(h)) heightsOk = false;
                    }
                }
                await dropAll(nodes);
                const end = base();
                growth.push([end.instances - b0.instances, end.bags - b0.bags, end.items - b0.items, end.hosts - b0.hosts]);
            }
            const last = base();
            const anim = NS.anim.stats();
            const leak = last.instances !== b0.instances || last.bags !== b0.bags || last.items !== b0.items || last.hosts !== b0.hosts || last.toast || last.menus !== b0.menus;
            if (last.instances === b0.instances && anim.entries === 0 && anim.timer) detailExtra = " [timer anim ancora acceso con 0 entry]";
            if (leak) rec(id, `crea/rimuovi x${cycles}x3 senza leak (${type})`, "FAIL", `delta[inst,bags,items,hosts]=${JSON.stringify(growth)} toast=${last.toast} menus=${last.menus}`);
            else if (!regionsOk) rec(id, `crea/rimuovi (${type})`, "FAIL", "regioni montate diverse da quelle della spec");
            else if (!heightsOk) rec(id, `crea/rimuovi (${type})`, "FAIL", "altezza dichiarata non finita");
            else if (detailExtra) rec(id, `crea/rimuovi (${type})`, "FAIL", detailExtra);
            else rec(id, `crea/rimuovi x${cycles}x3 senza leak (${type})`, "PASS", `istanze/Bag/host/menu a baseline; delta=${JSON.stringify(growth.at(-1))}`);
        } catch (e) { rec(id, `crea/rimuovi (${type})`, "FAIL", e.message || e); }
    }

    // =========================================================
    // T2  spec: validation + JSON round-trip
    // =========================================================
    for (const type of types) {
        const id = `T2:${type}`;
        try {
            const d = defs.get(type);
            const v = NS.validateSpec(d.def.spec, d.def);
            if (!v.ok) { rec(id, `spec valida (${type})`, "FAIL", v.errors.slice(0, 3).join(" | ")); continue; }
            const { deepEqual, findNonJson } = NS._internal;
            const bad = findNonJson(v.spec);
            if (bad.length) { rec(id, `spec solo JSON (${type})`, "FAIL", JSON.stringify(bad.slice(0, 3))); continue; }
            const rt = JSON.parse(JSON.stringify(v.spec));
            if (!deepEqual(rt, v.spec)) { rec(id, `round-trip spec (${type})`, "FAIL", "spec != JSON.parse(JSON.stringify(spec))"); continue; }
            const again = NS.validateSpec(rt, d.def);
            if (!again.ok || !deepEqual(again.spec, v.spec)) { rec(id, `normalizzazione idempotente (${type})`, "FAIL", "validate(parse(stringify(spec))) != spec"); continue; }
            rec(id, `spec valida + round-trip JSON + idempotente (${type})`, "PASS", `warnings=${v.warnings.length}`);
        } catch (e) { rec(id, `spec (${type})`, "FAIL", e.message || e); }
    }

    // =========================================================
    // T3  persistence: overrides + state -> serialize -> new node
    // =========================================================
    for (const type of types) {
        const id = `T3:${type}`;
        let n1 = null, n2 = null;
        try {
            const d = defs.get(type);
            const elId = firstId(d.template);
            n1 = await makeNode(type); await settle();
            const rt1 = NS.instanceOf(n1);
            if (!rt1) throw new Error("nessuna istanza dopo il mount");
            if (typeof n1.serialize !== "function" || typeof n1.configure !== "function") { rec(id, `persistenza (${type})`, "SKIP", "node.serialize/configure non disponibili"); await dropAll([n1]); continue; }
            const probe = "ns-selftest-" + Math.random().toString(36).slice(2, 7);
            let overrideId = null;
            if (elId) { rt1.api.patch(elId, { title: probe }); overrideId = elId; }
            // an immediate numeric/boolean state value declared by the type (if any)
            let stKey = null, stVal;
            for (const [k, c] of Object.entries(d.def.state || {})) {
                if (k.startsWith("__ns_")) continue;
                if (c.policy === "immediate" && typeof c.default === "boolean") { stKey = k; stVal = !c.default; break; }
            }
            if (stKey) rt1.api.state.set(stKey, stVal);
            rt1.api.state.flush();
            await wait(400);
            const info = JSON.parse(JSON.stringify(n1.serialize()));
            const viol = NS._internal.propertyViolations(info.properties || {});
            if (viol.length) throw new Error("node.properties con valori non primitivi/JSON-string: " + JSON.stringify(viol.slice(0, 3)));
            await dropAll([n1]); n1 = null;

            n2 = create(type);
            if (!n2) throw new Error("createNode fallito per il nodo di ripristino");
            n2.id = info.id; n2.configure(info); graph.add(n2); await settle();
            const rt2 = NS.instanceOf(n2);
            if (!rt2) throw new Error("nessuna istanza sul nodo ripristinato");
            const probs = [];
            if (overrideId && rt2.overrides?.[overrideId]?.title !== probe) probs.push(`override '${overrideId}' perso`);
            if (stKey && rt2.api.state.get(stKey) !== stVal) probs.push(`stato '${stKey}' = ${rt2.api.state.get(stKey)} (atteso ${stVal})`);
            if (probs.length) rec(id, `round-trip persistenza (${type})`, "FAIL", probs.join("; "));
            else rec(id, `round-trip persistenza (${type})`, "PASS", `override=${overrideId || "-"} stato=${stKey || "-"} properties pulite`);
            await dropAll([n2]); n2 = null;
        } catch (e) {
            rec(id, `persistenza (${type})`, "FAIL", e.message || e);
            await dropAll([n1, n2].filter(Boolean));
        }
    }

    // =========================================================
    // T4  float menu: open/close without leftover listeners
    // =========================================================
    for (const type of types) {
        const id = `T4:${type}`;
        const menus = Object.keys(defs.get(type).template.menus || {});
        if (!menus.length) { rec(id, `float menu (${type})`, "SKIP", "il tipo non dichiara menu"); continue; }
        const tr = trackListeners();
        let n = null;
        try {
            const s0 = tr.snapshot();
            n = await makeNode(type); await settle();
            const rt = NS.instanceOf(n);
            const sMounted = tr.snapshot();
            for (const m of menus) {
                for (let c = 0; c < cycles; c++) {
                    rt.api.openMenu(m, { point: { x: 220, y: 160 } }); await wait(150);
                    if (!rt.api.isMenuOpen(m)) throw new Error(`menu '${m}' non risulta aperto`);
                    if (!document.querySelector('[id^="succy-ns-menu"]')) throw new Error(`menu '${m}': nessun host nel DOM`);
                    // closing by clicking outside (same path as the user)
                    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
                    await wait(120);
                    if (rt.api.isMenuOpen(m)) rt.api.closeMenu(m);
                    await wait(60);
                }
                // Esc
                rt.api.openMenu(m, { point: { x: 220, y: 160 } }); await wait(120);
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
                await wait(120);
                if (rt.api.isMenuOpen(m)) rt.api.closeMenu(m);
            }
            const st = NS.FloatMenu.stats();
            const domLeft = document.querySelectorAll('[id^="succy-ns-menu"]').length;
            const sClosed = tr.snapshot();
            const residualAfterClose = diffKeys(sMounted, sClosed);       // per-node "lazy" guards allowed (1 set), they don't grow with the number of cycles
            await dropAll([n]); n = null;
            const sEnd = tr.snapshot();
            const residualAfterRemove = diffKeys(s0, sEnd);
            if (st.open !== 0 || domLeft) rec(id, `float menu (${type})`, "FAIL", `menu aperti=${st.open}, host nel DOM=${domLeft}`);
            else if (residualAfterRemove.length) rec(id, `float menu (${type})`, "FAIL", `listener residui dopo la rimozione del nodo: ${residualAfterRemove.slice(0, 4).join(" ; ")}`);
            else rec(id, `float menu aperto/chiuso x${cycles} (click-fuori, Esc), 0 residui (${type})`, "PASS", `menu=${menus.join(",")} guard per-nodo=${residualAfterClose.length} (rilasciati alla rimozione)`);
        } catch (e) {
            rec(id, `float menu (${type})`, "FAIL", e.message || e);
            try { NS.FloatMenu.closeEverything?.(); } catch (_) {}
            if (n) await dropAll([n]);
        } finally { tr.stop(); }
    }

    // =========================================================
    // T5  subgraph: convert / unpack (needs the real frontend)
    // =========================================================
    {
        const id = "T5";
        const type = types[0];
        const canConvert = typeof graph.convertToSubgraph === "function";
        const canUnpack = typeof graph.unpackSubgraph === "function";
        if (!canConvert || !canUnpack) {
            rec(id, "subgraph convert/unpack", "SKIP", `API del frontend assenti (convertToSubgraph=${canConvert}, unpackSubgraph=${canUnpack}): NON verificato`);
        } else {
            let n = null;
            try {
                const b0 = base();
                // nodes of the same type ALREADY in the user's workflow: T5 must not find or delete them. Hands off her stuff.
                const pre = new Set((graph._nodes || graph.nodes || []).filter((x) => x.type === type));
                n = await makeNode(type); await settle();
                const rt0 = NS.instanceOf(n);
                const elId = firstId(defs.get(type).template);
                const probe = "sg-" + Math.random().toString(36).slice(2, 6);
                if (elId) rt0.api.patch(elId, { title: probe });
                rt0.api.state.flush(); await wait(300);
                const res = graph.convertToSubgraph(new Set([n]));
                const sgNode = res?.node || res;
                const sub = res?.subgraph || sgNode?.subgraph;
                if (!sub) throw new Error("convertToSubgraph non ha restituito il subgraph");
                await wait(900);
                const inner = (sub._nodes || sub.nodes || []).find((x) => x.type === type);
                if (!inner) throw new Error("nodo non trovato dentro il subgraph");
                const rtIn = NS.instanceOf(inner);
                if (!rtIn) throw new Error("nessuna istanza NodeStructure dopo la conversione (heal non ha ricostruito)");
                if (elId && rtIn.overrides?.[elId]?.title !== probe) throw new Error("override perso dopo la conversione");
                graph.unpackSubgraph(sgNode); await wait(900);
                const back = (graph._nodes || graph.nodes || []).find((x) => x.type === type && !pre.has(x));
                if (!back) throw new Error("nodo non trovato dopo unpack");
                const rtBack = NS.instanceOf(back);
                if (!rtBack) throw new Error("nessuna istanza dopo unpack");
                if (elId && rtBack.overrides?.[elId]?.title !== probe) throw new Error("override perso dopo unpack");
                await dropAll([...(graph._nodes || graph.nodes || [])].filter((x) => x.type === type && !pre.has(x)));
                n = null;
                const e1 = base();
                if (e1.instances !== b0.instances || e1.bags !== b0.bags) throw new Error(`leak dopo subgraph: istanze ${e1.instances - b0.instances}, bag ${e1.bags - b0.bags}`);
                rec(id, "subgraph convert + unpack (istanza ricostruita, override intatti, 0 leak)", "PASS", `tipo=${type}`);
            } catch (e) { rec(id, "subgraph convert/unpack", "FAIL", e.message || e); if (n) await dropAll([n]); }
        }
    }

    // =========================================================
    // T6  broken specs: they must be rejected
    // =========================================================
    {
        const id = "T6";
        const R = (regions) => ({ v: 1, regions });
        const cases = [
            ["componente sconosciuto", R([{ id: "a", tree: { t: "nope" } }])],
            ["ref invalido", R([{ id: "a", tree: { t: "label_element", text: "$bogus.x" } }])],
            ["funzione dentro la spec", R([{ id: "a", tree: { t: "label", text: "x", on: { click: () => 1 } } }])],
            ["id duplicato", R([{ id: "a", tree: { t: "stack", children: [{ t: "label", id: "d" }, { t: "label", id: "d" }] } }])],
            ["javascript: nei valori", R([{ id: "a", tree: { t: "image", src: "javascript:alert(1)" } }])],
            ["nessuna regione", { v: 1, regions: [] }],
            ["classe non del kit", R([{ id: "a", tree: { t: "label_element", class: "mia-classe", text: "x" } }])],
            ["proprieta' fuori scheda", R([{ id: "a", tree: { t: "label_element", text: "x", colore: "rosso" } }])],
            ["enum non ammesso", R([{ id: "a", tree: { t: "label_element", variant: "fluo", text: "x" } }])],
            ["nome fuori grammatica", R([{ id: "a", tree: { t: "Label-Element", text: "x" } }])],
            ["behavior fuori catalogo", { v: 1, regions: [{ id: "a", tree: { t: "label_element", text: "x" } }], behaviors: [{ type: "fai_magia" }] }],
            ["args non in scheda", R([{ id: "a", tree: { t: "button_element", text: "x", on: { click: { do: "$actions.copy_system", args: { sbagliato: 1 } } } } }])],
        ];
        const accepted = [];
        for (const [name, spec] of cases) { let ok; try { ok = NS.validateSpec(spec).ok; } catch (_) { ok = false; } if (ok) accepted.push(name); }
        const dummy = { actions: {}, live: {}, state: {}, natives: [] };
        const refMiss = NS.validateSpec(R([{ id: "a", tree: { t: "button", text: "x", on: { click: "$actions.manca" } } }]), dummy);
        if (refMiss.ok) accepted.push("azione non definita");
        const coll = NS.validateSpec(R([{ id: "a", tree: { t: "button_element", text: "x", on: { click: "$actions.copy_system" } } }]), { actions: { copy_system() {} }, live: {}, state: {}, natives: [] });
        if (coll.ok) accepted.push("azione locale con nome del kit");
        if (accepted.length) rec(id, "spec rotte rifiutate", "FAIL", "accettate per errore: " + accepted.join(", "));
        else rec(id, `spec rotte rifiutate (${cases.length + 2} casi)`, "PASS", "");
    }

    // =========================================================
    // T7  chip input selector (D-61): sources, real wire, reroutes, cycles, chip drawn, dropdown
    //     Only nodes created here (moved into view), removed at the end.
    // =========================================================
    await (async () => {
        const id = "T7";
        const IL = globalThis.SurvivalKit?.inputLink, CH = NS.chips;
        const has = (t) => !!LG?.registered_node_types?.[t];
        const srcType = ["PrimitiveStringMultiline", "PrimitiveString"].find(has);
        if (!IL || !CH) return rec(id, "selettore a chip", "FAIL", "manca SurvivalKit.inputLink o NodeStructure.chips");
        if (!defs.has("Succy_Label") || !srcType) return rec(id, "selettore a chip", "SKIP", "servono Succy_Label e un nodo Primitive String");
        const pr = IL.probe();
        if (!pr.ok) return rec(id, "selettore a chip", "FAIL", "input-link.js: manca " + pr.missing.join(", "));
        const made = [], bad = [];
        const T = (cond, what) => { if (!cond) bad.push(what); };
        const at = (n, dx, dy) => { const cv = app?.canvas, ds = cv?.ds; let x = 0, y = 0; if (ds && cv.canvas) { x = cv.canvas.clientWidth / 2 / ds.scale - ds.offset[0]; y = cv.canvas.clientHeight / 2 / ds.scale - ds.offset[1]; } n.pos = [x + dx, y + dy]; };
        const rrMade = [];
        try {
            const lab = await makeNode("Succy_Label"); made.push(lab); at(lab, 40, 0);
            const p1 = await makeNode(srcType); made.push(p1); at(p1, -340, -60);
            const p2 = await makeNode(srcType); made.push(p2); at(p2, -340, 140);
            await settle();
            const key = (n) => `${n.id}:0`;
            let s = IL.sources(lab, "text");
            T(s.some((x) => x.key === key(p1)) && s.some((x) => x.key === key(p2)), "sorgenti: mancano i Primitive");
            T(!s.some((x) => x.nodeId === lab.id), "sorgenti: il nodo stesso e' in lista");
            let r = IL.connect(lab, "text", { nodeId: p1.id, out: 0 });
            T(r.ok && IL.current(lab, "text")?.nodeId === p1.id, "connect diretto: " + (r.why || "filo assente"));
            // native reroute on the wire: shows up as ↳ and the wire can go through it
            const link = graph.links.get(lab.inputs[0].link);
            const rr = typeof graph.createReroute === "function" ? graph.createReroute([lab.pos[0] - 120, lab.pos[1] + 30], link) : null;
            if (rr) {
                rrMade.push(rr.id);
                r = IL.connect(lab, "text", { nodeId: p1.id, out: 0 });            // direct: the reroute stays (floating)
                s = IL.sources(lab, "text");
                const viaR = s.find((x) => x.rerouteId === rr.id);
                T(viaR && viaR.count === 1 && viaR.nodeId === p1.id, "reroute: non elencato sotto la sua sorgente");
                r = IL.connect(lab, "text", { nodeId: p1.id, out: 0, rerouteId: rr.id });
                T(r.ok && graph.links.get(lab.inputs[0].link)?.parentId === rr.id, "connect via reroute: " + (r.why || "parentId sbagliato"));
            } else bad.push("graph.createReroute mancante (test reroute saltato)");
            // cycles: downstream node excluded and refused
            if (has("StringConcatenate")) {
                const a = await makeNode("StringConcatenate"); made.push(a); at(a, -340, 340);
                const b = await makeNode("StringConcatenate"); made.push(b); at(b, -40, 340);
                a.connect(0, b, 0);
                T(!IL.sources(a, 0).some((x) => x.nodeId === b.id), "cicli: nodo a valle in lista");
                T(!IL.connect(a, 0, { nodeId: b.id, out: 0 }).ok, "cicli: connect a valle accettato");
            }
            await settle();
            // chip drawn (Vue Nodes only) + dropdown: Esc closes without changing anything, filter + Enter connects
            const c = CH.of(lab, "text");
            if (!IL.vueNodesOn()) bad.push("Vue Nodes OFF: chip non verificato");
            else {
                T(c?.drawn && !!document.querySelector(`[data-node-id="${lab.id}"] .ns-chip`), "chip non disegnato: " + (c?.why || "?"));
                const opened = () => NS.FloatMenu.stats().ids.some((x) => x.includes(`${lab.id}-chip:text`));
                const key2 = (k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
                CH.open(lab, "text"); await wait(120);
                T(opened(), "tendina non aperta");
                key2("Escape"); await wait(80);
                T(!opened() && IL.current(lab, "text")?.nodeId === p1.id, "Esc: non chiude o ha cambiato il filo");
                CH.open(lab, "text"); await wait(120);
                const host = [...document.querySelectorAll('[id^="succy-ns-menu"]')].find((h) => h.id.includes(`${lab.id}-chip:text`));
                const q = host?.shadowRoot?.querySelector(".ns-pick-q");
                if (q) { q.value = "#" + p2.id; q.dispatchEvent(new Event("input")); }
                const rows = host?.shadowRoot?.querySelectorAll(".ns-pick-row").length ?? 0;
                T(rows === 1, `filtro '#${p2.id}': ${rows} righe (attesa 1)`);
                key2("Enter"); await wait(120);
                T(!opened() && IL.current(lab, "text")?.nodeId === p2.id, "Invio: filo non creato verso la riga scelta");
            }
            // outputs (chip_output, D-64): taken input = ⚠, connectOut replaces, outLinks/disconnect
            const ti = lab.inputs.findIndex((x) => x.name === "text");
            const occ = IL.targets(p1, 0).find((x) => x.nodeId === lab.id && x.inp === ti);
            T(occ && occ.occupied && occ.occupied.nodeId === p2.id, "uscite: ingresso occupato non segnato ⚠");
            r = IL.connectOut(p1, 0, { nodeId: lab.id, inp: ti });
            T(r.ok && IL.current(lab, "text")?.nodeId === p1.id, "connectOut: " + (r.why || "filo assente"));
            T(IL.outLinks(p1, 0).some((x) => x.nodeId === lab.id), "outLinks: filo non elencato");
            T(IL.targets(p1, 0).find((x) => x.nodeId === lab.id && x.inp === ti)?.current, "uscite: filo di oggi non 'current'");
            r = IL.disconnect(lab, "text");
            T(r.ok && IL.current(lab, "text") == null, "disconnect: " + (r.why || "filo ancora presente"));
        } catch (e) { bad.push("eccezione: " + (e?.message || e)); }
        for (const rid of rrMade) { try { if (graph.reroutes?.has(rid)) graph.removeReroute(rid); } catch (_) {} }
        try { NS.FloatMenu.closeEverything(); } catch (_) {}
        await dropAll(made);
        T(!made.some((n) => CH.of(n)), "chip non rilasciati dopo la rimozione dei nodi");
        const hard = bad.filter((b) => !/test reroute saltato|chip non verificato/.test(b));
        if (hard.length) rec(id, "selettore a chip", "FAIL", hard.join(" || "));
        else rec(id, "selettore a chip: sorgenti, filo vero, reroute, cicli, chip, tendina, uscite", bad.length ? "SKIP" : "PASS", bad.join(" · "));
    })();

    // =========================================================
    // T8  shape-shifting outputs (shape_output, D-66) on Preview: text = 1 output, image = 4, back = 1 and wires unplugged
    // =========================================================
    await (async () => {
        const id = "T8", PT = "Succy_Preview_Anything_&_Convert";
        const has = (t) => !!LG?.registered_node_types?.[t];
        const img = ["EmptyImage"].find(has), txt = ["PrimitiveStringMultiline", "PrimitiveString"].find(has);
        if (!defs.has(PT) || !img || !txt) return rec(id, "uscite che cambiano forma", "SKIP", "servono Preview, EmptyImage e un Primitive String");
        const made = [], bad = [];
        try {
            const P = await makeNode(PT), I = await makeNode(img), S = await makeNode(txt), L = await makeNode("Succy_Label");
            made.push(P, I, S, L);
            await settle();
            const sh = () => P.outputs.map((o) => `${o.name}:${o.type}`).join(",");
            if (P.outputs.length !== 1) bad.push("nuovo: " + sh());
            S.connect(0, P, 0); await wait(80);
            if (sh() !== "output:STRING") bad.push("testo: " + sh());
            I.connect(0, P, 0); await wait(80);
            if (sh() !== "output:IMAGE,width:INT,height:INT,megapixels:FLOAT") bad.push("immagine: " + sh());
            S.connect(0, P, 0); await wait(80);
            if (sh() !== "output:STRING") bad.push("ritorno testo: " + sh());
            P.disconnectInput(0); await wait(80);
            if (sh() !== "output:STRING") bad.push("scollegato: " + sh());
        } catch (e) { bad.push("eccezione: " + (e?.message || e)); }
        await dropAll(made);
        bad.length ? rec(id, "uscite che cambiano forma", "FAIL", bad.join(" || ")) : rec(id, "uscite che cambiano forma (Preview: testo 1, immagine 4, ritorno 1)", "PASS", "");
    })();

    // =========================================================
    // T9  multi-column Pick Combo (D-67): count-based outputs with wires following the name, table (paste), width
    // =========================================================
    await (async () => {
        const id = "T9", PT = "Succy_Pick_Combo";
        if (!defs.has(PT)) return rec(id, "Pick Combo multi colonna", "SKIP", "nodo Succy_Pick_Combo non definito");
        const made = [], bad = [];
        try {
            // the wire under test goes from P.index into a Preview (select_index_in is gone, D-69)
            const P = await makeNode(PT), Q = await makeNode("Succy_Preview_Anything_&_Convert");
            made.push(P, Q);
            await settle();
            const rp = () => NS.instanceOf(P)?.api;           // always the CURRENT runtime: a late setup can replace the first one
            const sh = () => P.outputs.map((o) => o.name).join(",");
            if (sh() !== "cmb1,index,label,all") bad.push("nuovo: " + sh());
            const qi = 0;
            P.connect(P.outputs.findIndex((o) => o.name === "index"), Q, qi); await wait(80);
            const src = () => { const l = P.graph.links.get?.(Q.inputs[qi].link) ?? P.graph.links[Q.inputs[qi].link]; return l ? P.outputs[l.origin_slot]?.name : "none"; };
            const w0 = P.size[0];
            const setOk = rp().native.set("num_values", 3); await wait(150);
            const why3 = () => `[set=${setOk} native=${rp()?.native.get("num_values")} widget=${P.widgets?.find((w) => w.name === "num_values")?.value} rt=${!!NS.instanceOf(P)} destroyed=${NS.instanceOf(P)?.destroyed} portErr=${JSON.stringify(NS.ports.stats().errors)}]`;
            if (sh() !== "cmb1,cmb2,cmb3,index,label,all") bad.push("3 colonne: " + sh() + " " + why3());
            if (src() !== "index") bad.push("3 colonne: il filo di index ora parte da " + src());
            if (!(P.size[0] > w0 + 100)) bad.push(`larghezza non cresciuta (${Math.round(w0)} -> ${Math.round(P.size[0])})`);
            rp().native.set("num_values", 1); await wait(150);
            if (sh() !== "cmb1,index,label,all" || src() !== "index") bad.push("ritorno 1 colonna: " + sh() + " filo da " + src());
            if (Math.abs(P.size[0] - w0) > 2) bad.push(`larghezza non tornata (${Math.round(w0)} -> ${Math.round(P.size[0])})`);
            // paste 3 lines into the first label: rows 2 -> 3, labels a b c, choice dropdown = labels
            const cell = rp().el("grid")?.querySelector?.(".ns-table-cell") || null;
            if (!cell) bad.push("cella della tabella non trovata");
            else {
                const dt = new DataTransfer(); dt.setData("text/plain", "a\nb\nc\n");
                cell.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); await wait(150);
                let tb = null; try { tb = JSON.parse(rp().native.get("table")); } catch (_) {}
                const lb = (tb?.rows || []).slice(0, 3).map((r) => r[0]).join(",");
                if (rp().native.get("num_options") !== 3 || lb !== "a,b,c") bad.push(`incolla: righe ${rp().native.get("num_options")} etichette ${lb}`);
                const cv = (rp().native.widget("choice")?.options?.values || []).join(",");
                if (cv !== "a,b,c") bad.push("choice: " + cv);
            }
        } catch (e) { bad.push("eccezione: " + (e?.message || e)); }
        await dropAll(made);
        bad.length ? rec(id, "Pick Combo multi colonna", "FAIL", bad.join(" || ")) : rec(id, "Pick Combo: uscite a conteggio (fili seguono il nome), larghezza, incolla", "PASS", "");
    })();

    // =========================================================
    // T10  widget with a reroute hung on it (D-69): it joins the chip lists, the wire goes in through the reroute
    // =========================================================
    await (async () => {
        const id = "T10", PT = "Succy_Pick_Combo";
        const il = globalThis.SurvivalKit?.inputLink, g0 = graph;
        if (!defs.has(PT) || !il?.widgetReroute || !LG?.registered_node_types?.EmptyLatentImage || typeof g0?.createReroute !== "function")
            return rec(id, "widget + reroute nelle liste chip", "SKIP", "servono Pick Combo, EmptyLatentImage, inputLink.widgetReroute e graph.createReroute");
        const made = [], bad = [];
        let rid = null;
        try {
            const P = await makeNode(PT), E = await makeNode("EmptyLatentImage");
            made.push(P, E);
            await settle();
            const g = P.graph, io = P.outputs.findIndex((o) => o.name === "index");
            const wi = E.inputs.findIndex((i) => i.name === "width"), hi = E.inputs.findIndex((i) => i.name === "height");
            const listed = (k) => il.targets(P, io).some((d) => String(d.nodeId) === String(E.id) && d.inp === k);
            if (listed(wi) || listed(hi)) bad.push("widget elencato senza reroute");
            // hang a reroute on width: wire it, put a reroute on the link, then unplug the source (floating reroute stays)
            const l0 = P.connect(io, E, wi);
            rid = g.createReroute([E.pos[0] - 80, E.pos[1]], l0)?.id ?? null;
            P.disconnectOutput(io); await wait(60);
            if (il.widgetReroute(E, wi) !== rid) bad.push(`reroute non trovato sul widget (${il.widgetReroute(E, wi)} vs ${rid})`);
            if (!listed(wi)) bad.push("widget con reroute NON elencato");
            if (listed(hi)) bad.push("height elencato (non ha reroute)");
            const r = il.connectOut(P, io, { nodeId: E.id, inp: wi });
            const L = r.ok ? (g.links.get?.(E.inputs[wi].link) ?? g.links[E.inputs[wi].link]) : null;
            if (!r.ok) bad.push("connectOut: " + r.why);
            else if (L?.parentId !== rid) bad.push(`il filo non passa dal reroute (parent ${L?.parentId})`);
            const r2 = il.connectOut(P, io, { nodeId: E.id, inp: hi });
            if (r2.ok) bad.push("connectOut su widget senza reroute accettato");
        } catch (e) { bad.push("eccezione: " + (e?.message || e)); }
        await dropAll(made);
        try { if (rid != null && g0.reroutes?.has?.(rid)) g0.removeReroute(rid); } catch (_) {}
        bad.length ? rec(id, "widget + reroute nelle liste chip", "FAIL", bad.join(" || ")) : rec(id, "widget + reroute: elencato, filo dentro dal reroute, senza reroute escluso", "PASS", "");
    })();

    return finish();

    function finish() {
        const pass = results.filter((r) => r.status === "PASS").length;
        const fail = results.filter((r) => r.status === "FAIL").length;
        const skip = results.filter((r) => r.status === "SKIP").length;
        const ms = Math.round(performance.now() - t0);
        const w = Math.min(70, Math.max(...results.map((r) => r.name.length), 10));
        log(`\n=== NodeStructure ${NS.version} selfTest ===`);
        for (const r of results) log(`${r.status.padEnd(5)} ${r.id.padEnd(16)} ${r.name.slice(0, w).padEnd(w)}  ${r.detail}`);
        log(`--- PASS ${pass}  FAIL ${fail}  SKIP ${skip}  (${ms} ms) ---`);
        const summary = { version: NS.version, pass, fail, skip, ms, ok: fail === 0, results: results.map((r) => ({ id: r.id, status: r.status, detail: r.detail.slice(0, 200) })) };
        log("NS_SELFTEST_JSON " + JSON.stringify(summary));
        return summary;
    }
}


// =============================================================
// CATALOG: drift guardian (NAMING.md sec. 7)
// =============================================================
async function catalogTests(NS, rec) {
    const cat = NS.catalog, R = cat.registry, G = cat.grammar;
    const pass = (id, name, d = "") => rec(id, name, "PASS", d);
    const fail = (id, name, d) => rec(id, name, "FAIL", d);

    // C1 registration
    const pr = R.PROBLEMS;
    pr.length ? fail("C1", "schede valide", pr.map((p) => `${p.nome}: ${p.errors.join("; ")}`).join(" || ")) : pass("C1", `tutti i pezzi hanno scheda valida (${R.REG.size})`);

    // C2 grammar / dictionary / composition
    {
        const bad = [];
        for (const [n, r] of R.REG) {
            const pn = G.parseName(n);
            if (!pn.ok) bad.push(`${n}: ${pn.error}`);
            for (const u of r.card.uses || []) if (!R.REG.has(u)) bad.push(`${n}: uses '${u}' non esiste`);
            for (const a of r.card.alias || []) if (R.REG.has(a)) bad.push(`${n}: alias '${a}' e' anche un pezzo`);
        }
        const cyc = [];
        for (const [n] of R.REG) { const seen = new Set(), st = [n]; while (st.length) { const x = st.pop(); for (const u of R.REG.get(x)?.card.uses || []) { if (u === n) cyc.push(n); if (!seen.has(u)) { seen.add(u); st.push(u); } } } }
        if (cyc.length) bad.push("uses circolare: " + [...new Set(cyc)].join(","));
        bad.length ? fail("C2", "grammatica nomi / alias / uses", bad.join(" || ")) : pass("C2", "nomi nella grammatica, alias senza collisioni, uses validi e senza cicli");
    }

    // C3 examples: every piece mounts its own example
    {
        const { mountExample } = await import("./catalog/example.js");
        const bad = [];
        for (const [n, r] of R.REG) { let m; try { m = mountExample(r.card); } catch (e) { m = { ok: false, errors: [String(e.message || e)] }; } if (!m.ok) bad.push(`${n}: ${m.errors.join(" ; ")}`); }
        bad.length ? fail("C3", `esempi montati (${R.REG.size - bad.length}/${R.REG.size})`, bad.join(" || ")) : pass("C3", `tutti gli esempi validano e montano senza leak (${R.REG.size})`);
    }

    // C4 late pieces/CSS (written outside the kit)
    {
        const late = cat.late();
        late.pieces.length || late.css.length ? fail("C4", "niente pezzi/CSS fuori dal kit", `pezzi: ${late.pieces.join(",")} css: ${late.css.join(",")}`) : pass("C4", "nessun pezzo o CSS registrato fuori dal kit");
    }

    // C5 lock of the stable pieces
    try {
        const url = new URL("./catalog/catalog.lock.json", import.meta.url);
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) rec("C5", "catalog.lock.json", "SKIP", "HTTP " + r.status);
        else { const errs = R.checkLock(await r.json()); errs.length ? fail("C5", "hash dei pezzi stable = lock", errs.join(" || ")) : pass("C5", "hash dei pezzi stable uguali al lock"); }
    } catch (e) { rec("C5", "catalog.lock.json", "SKIP", String(e.message || e)); }

    // C6 nodes: valid spec, old names, file hygiene
    for (const [type, info] of R.NODES) {
        const d = NS.defs.get(type) || NS.extensions?.get(type);
        if (d && d.errors.length) fail("C6:" + type, `nodo '${type}' usa solo pezzi del catalogo`, d.errors.slice(0, 4).join(" || "));
        else pass("C6:" + type, `nodo '${type}' usa solo pezzi del catalogo`, `${info.pieces.size} pezzi${info.aliasUsed.length ? "; NOMI VECCHI: " + info.aliasUsed.join(", ") : ""}`);
        if (!info.src) { rec("C7:" + type, `igiene file '${type}'`, "SKIP", "sorgente non identificabile"); continue; }
        try {
            const txt = await (await fetch(info.src, { cache: "no-store" })).text();
            const code = txt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
            const rules = [[/\bdocument\./, "document.*"], [/createElement/, "createElement"], [/\binnerHTML\b/, "innerHTML"], [/registerCss/, "registerCss"], [/\.style\.|cssText/, "stile a mano"], [/\bnew Function\b|\beval\(/, "eval"], [/addEventListener/, "addEventListener (usa il kit)"], [/requestAnimationFrame|setInterval|setTimeout/, "timer diretti (usa api.after/raf)"], [/getComputedStyle|getSelection|navigator\.clipboard|createObjectURL/, "API browser"]];
            const hits = rules.filter(([re]) => re.test(code)).map(([, n]) => n);
            hits.length ? fail("C7:" + type, `igiene file '${type}'`, "nel file del nodo: " + hits.join(", ")) : pass("C7:" + type, `igiene file '${type}': nessun CSS/DOM/timer a mano`);
        } catch (e) { rec("C7:" + type, `igiene file '${type}'`, "SKIP", String(e.message || e)); }
        if (info.debt.length) rec("C8:" + type, `debito '${type}'`, "PASS", info.debt.join("; "));
    }
}
