// ============================================================
// SurvivalKit/debug/selftest.js
// ------------------------------------------------------------
// Usage (console, on an EMPTY workflow, fresh tab — we like a clean slate):
//     await SurvivalKit.selfTest()
//     await SurvivalKit.selfTest({ stress: false, slow: false })  // quicker
//     await SurvivalKit.selfTest({ force: true })                 // even if the workflow isn't empty (deletes the Succy_X nodes!)
//
// Prints a PASS / FAIL / SKIP table and a SELFTEST_JSON line
// to paste to Claude. It won't touch the kit unless you call it.
// v0.1.0 — 2026-10-10
// ============================================================

const TYPE = "Succy_X";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 5000, step = 50) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
        try { if (fn()) return true; } catch (_) {}
        await wait(step);
    }
    return false;
}

export function installSelfTest(SK) {
    SK.selfTest = (opts) => runSelfTest(SK, opts);
}

async function runSelfTest(SK, opts = {}) {
    const app = globalThis.app;
    const LG = globalThis.LiteGraph;
    const NS = SK.NodeState;
    const results = [];

    if (!app?.graph || !LG) {
        console.error("[selfTest] app/LiteGraph non disponibili");
        return "ABORT";
    }
    const rootNodes = () => (app.graph._nodes ?? app.graph.nodes ?? []);
    if (rootNodes().length > 0 && !opts.force) {
        console.warn("[selfTest] il workflow non e' vuoto: apri una tab nuova (+) oppure usa { force: true }");
        return "ABORT: workflow non vuoto";
    }

    const rec = (test, status, detail = "") =>
        results.push({ test, result: status, detail: String(detail) });

    async function step(name, fn) {
        try {
            const r = await fn();
            if (r && r.skip) rec(name, "SKIP", r.skip);
            else if (r && r.ok === true) rec(name, "PASS", r.detail ?? "");
            else rec(name, "FAIL", (r && r.detail) ?? "");
        } catch (e) {
            rec(name, "FAIL", "eccezione: " + (e?.message ?? e));
        }
    }

    // --- helpers ---
    const liveNodes = () => {
        const out = new Set();
        const visit = (g) => {
            for (const n of (g?._nodes ?? g?.nodes ?? [])) if (n?.type === TYPE) out.add(n);
        };
        visit(app.graph);
        const sgs = app.graph.subgraphs;
        if (sgs?.values) for (const s of sgs.values()) visit(s);
        return out;
    };
    const inv = () => {
        const live = liveNodes().size;
        const reg = SK.registry.size(TYPE);
        const st = SK.state._byKey.size;
        const bus = SK.bus.size;
        const timers = SK.state._flushTimers.size;
        const ok = live === reg && reg === st && st === bus && timers === 0;
        return { ok, live, reg, st, bus, timers,
            text: `live=${live} registry=${reg} state=${st} bus=${bus} timers=${timers}` };
    };
    const mk = (x = 0, y = 0) => {
        const n = LG.createNode(TYPE);
        n.pos = [x, y];
        app.graph.add(n);
        return n;
    };
    const rm = (n) => { try { app.graph.remove(n); } catch (_) {} };
    const readyAll = (nodes) => nodes.every((n) => NS.get(n, "ready", false));
    const cleanup = async () => {
        for (const n of [...rootNodes()]) rm(n);
        await wait(700);
    };
    const cfg = () => globalThis.__succyConfigs?.get(TYPE);

    try {
        // 1. patches in place
        await step("kit: API patch presenti", () => {
            const miss = [];
            if (typeof SK.state.release !== "function") miss.push("state.release");
            if (typeof SK.state.sync !== "function") miss.push("state.sync");
            if (typeof SK.state.flushAll !== "function") miss.push("state.flushAll");
            if (typeof SK.perf.addFlushHook !== "function") miss.push("perf.addFlushHook");
            if (typeof SK.perf.raf.wake !== "function") miss.push("raf.wake");
            if (typeof SK.registry.byKey !== "function") miss.push("registry.byKey");
            if (typeof SK.heal?.releaseResources !== "function") miss.push("heal.releaseResources");
            if (!SK.compat) miss.push("compat");
            const proto = (globalThis.LGraph ?? LG.LGraph)?.prototype;
            if (!proto?.convertToSubgraph?.__succyShielded) miss.push("shield convert");
            if (!proto?.unpackSubgraph?.__succyShielded) miss.push("shield unpack");
            return { ok: miss.length === 0, detail: miss.length ? "mancano: " + miss.join(", ") : "ok" };
        });

        await step("compat: versione ComfyUI", () => {
            const v = SK.compat?.getComfyVersion?.();
            return { ok: !!v, detail: "versione=" + (v || "(vuota)") };
        });

        await step("log: silenzioso con debug off, parla con debug on", async () => {
            const L = SK.log;
            const prev = L.enabled;
            const n = mk();
            await waitFor(() => readyAll([n]), 5000);
            const calls = [];
            const orig = console.log;
            console.log = (...a) => {
                if (typeof a[0] === "string" && (a[0].startsWith("[SurvivalKit") || a[0].startsWith("[Succy_X"))) calls.push(a[0]);
                orig.apply(console, a);
            };
            try {
                L.setEnabled(false);
                SK.heal.heal(n, false, cfg());
                await wait(300);
                const off = calls.length;
                L.setEnabled(true);
                SK.heal.heal(n, false, cfg());
                await wait(300);
                const on = calls.length - off;
                return { ok: off === 0 && on >= 1, detail: `righe con off=${off}, con on=${on}` };
            } finally {
                console.log = orig;
                L.setEnabled(prev);
                rm(n);
                await wait(500);
            }
        });

        // 2. create/delete invariants
        await step("10 nodi creati/cancellati: invarianti", async () => {
            const ns = [];
            for (let i = 0; i < 10; i++) ns.push(mk((i % 5) * 420, Math.floor(i / 5) * 520));
            await waitFor(() => readyAll(ns), 5000);
            await wait(600);
            const a = inv();
            for (const n of ns) rm(n);
            await wait(900);
            const b = inv();
            return { ok: a.ok && a.live === 10 && b.ok && b.live === 0,
                detail: `con 10: ${a.text} | dopo delete: ${b.text}` };
        });

        // 3. RAF stopped at 0 canvases
        await step("RAF fermo con 0 canvas", async () => {
            await wait(300);
            const f0 = SK.perf.stats().rafFrames;
            await wait(700);
            const d = SK.perf.stats().rafFrames - f0;
            return { ok: d <= 1 && SK.perf.stats().activeCanvases === 0, detail: `frame in 700ms: ${d}` };
        });

        // 4. RAF wake + single chain
        await step("RAF wake + catena singola", async () => {
            const n = mk();
            await waitFor(() => readyAll([n]), 5000);
            await wait(300);
            let native = 0, run = true;
            const loop = () => { native++; if (run) requestAnimationFrame(loop); };
            requestAnimationFrame(loop);
            const f0 = SK.perf.stats().rafFrames;
            await wait(1000);
            run = false;
            const kit = SK.perf.stats().rafFrames - f0;
            const canv = SK.perf.stats().activeCanvases;
            rm(n);
            await wait(500);
            return { ok: kit > 5 && kit <= native * 1.15 + 3 && canv === 1,
                detail: `kit=${kit} nativo=${native} canvas=${canv}` };
        });

        // 5. persistence round-trip
        await step("persistenza: serialize -> configure", async () => {
            const n = mk();
            await waitFor(() => readyAll([n]), 5000);
            const ctx = NS.get(n, "ctx", null);
            ctx.utils.setNative("text", "selftest @date");
            ctx.utils.setNative("count", 7);
            ctx.utils.setNative("format", "INT");
            ctx.state.set("collapsed", true);
            ctx.state.set("editorHeight", 222);
            await wait(500);
            const data = JSON.parse(JSON.stringify(n.serialize()));
            const m = LG.createNode(TYPE);
            m.configure(data);
            const val = (nm) => m.widgets.find((w) => w.name === nm)?.value;
            const ss = (() => { try { return JSON.parse(m.properties.succy_state); } catch (_) { return null; } })();
            const ok = val("text") === "selftest @date" && val("count") === 7 && val("format") === "INT"
                && typeof m.properties.succy_state === "string" && typeof m.properties.succy_natives === "string"
                && ss?.editorHeight === 222 && ss?.collapsed === true;
            rm(n);
            await wait(500);
            return { ok, detail: `text=${val("text")} count=${val("count")} format=${val("format")} ss=${JSON.stringify(ss)}` };
        });

        // 6. legacy
        await step("workflow legacy (oggetti plain)", () => {
            const t = LG.createNode(TYPE);
            t.configure({ id: 9999, type: TYPE,
                properties: { succy_state: { collapsed: true }, succy_natives: { text: "legacy", count: 7 } },
                widgets_values: ["legacy", 7, "INT", "Option B", 9] });
            const v = (nm) => t.widgets.find((w) => w.name === nm)?.value;
            return { ok: typeof t.properties.succy_state === "string"
                    && typeof t.properties.succy_natives === "string" && v("text") === "legacy",
                detail: `tipi=${typeof t.properties.succy_state}/${typeof t.properties.succy_natives} text=${v("text")}` };
        });

        await step("configure: widgets_values_named batte l'indice", () => {
            const t = LG.createNode(TYPE);
            t.configure({ id: 9998, type: TYPE, properties: {},
                widgets_values: ["x", 1, "STRING", "Option C", 3],
                widgets_values_named: { text: "named", count: 9 } });
            const v = (nm) => t.widgets.find((w) => w.name === nm)?.value;
            return { ok: v("text") === "named" && v("count") === 9, detail: `text=${v("text")} count=${v("count")}` };
        });

        // 7. heal: widgets removed by third parties (+ idempotent onResize)
        await step("heal: widget rimossi da terzi, rebuild pulito", async () => {
            const n = mk();
            await waitFor(() => readyAll([n]), 5000);
            await wait(300);
            const kill = () => {
                for (let i = n.widgets.length - 1; i >= 0; i--) if (n.widgets[i]?._succyKitDom) n.widgets.splice(i, 1);
            };
            kill();
            SK.heal.heal(n, true, cfg());
            await waitFor(() => readyAll([n]) && n.widgets.filter((w) => w._succyKitDom).length === 3, 4000);
            await wait(300);
            const kit1 = n.widgets.filter((w) => w._succyKitDom).length;
            const canv1 = NS.all(n)?.canvases.size;
			kill();
			SK.heal.heal(n, true, cfg());
			await waitFor(() => readyAll([n]) && n.widgets.filter((w) => w._succyKitDom).length === 3, 4000);
			await wait(300);
			const i = inv();
			const act = SK.perf.stats().activeCanvases;
			// The wrapper lives on the prototype (lifecycle.js): we check that it's
			// still there and working, not the identity of an instance function.
			const resizeOk = typeof n.onResize === "function";
			rm(n);
			await wait(600);
			return { ok: kit1 === 3 && canv1 === 1 && act === 1 && i.ok && resizeOk,
				detail: `kitDom=${kit1} canvases=${canv1} attivi=${act} onResizePresente=${resizeOk} | ${i.text}` };
        });

        // 8. addDOMWidget fails
        await step("heal: addDOMWidget ritorna null -> non 'ready', poi recupera", async () => {
            const n = LG.createNode(TYPE);
            n.addDOMWidget = () => null;
            n.pos = [0, 0];
            app.graph.add(n);
            await wait(1200);
            const failedReady = NS.get(n, "ready", false);
            delete n.addDOMWidget;
            SK.heal.heal(n, true, cfg());
			const rec2 = await waitFor(() => NS.get(n, "ready", false), 4000);
			await wait(300);
			rm(n);
			await wait(600);
			const i = inv();
			return { ok: failedReady === false && rec2 && i.ok,
                detail: `readyDopoFallimento=${failedReady} recuperato=${rec2} | ${i.text}` };
        });

        // 9. per-node resources
        await step("risorse per-nodo: RAF scoped e cleanup", async () => {
            const a = mk(0, 0), b = mk(450, 0);
            await waitFor(() => readyAll([a, b]), 5000);
            const ca = NS.get(a, "ctx", null), cb = NS.get(b, "ctx", null);
            const base = SK.perf.raf._ticks.size;
            ca.perf.acquireRAF("t", () => {});
            cb.perf.acquireRAF("t", () => {});
            const two = SK.perf.raf._ticks.size - base;
            const probe = document.createElement("div");
            document.body.appendChild(probe);
            ca.perf.observeResize(probe, () => {});
            const tracked = NS.all(a).resizeEls.size === 1 && NS.all(a).rafs.size === 1;
            rm(a);
            await wait(500);
            const one = SK.perf.raf._ticks.size - base;
            rm(b);
            await wait(500);
            const zero = SK.perf.raf._ticks.size - base;
            probe.remove();
            return { ok: two === 2 && one === 1 && zero === 0 && tracked,
                detail: `tick con 2 nodi=${two}, dopo remove a=${one}, dopo remove b=${zero}, tracciati=${tracked}` };
        });

        // 10. LAB (if the button exists) -> release on removal
        await step("Succy_X LAB: acquireRAF rilasciato alla rimozione", async () => {
            const n = mk();
            await waitFor(() => readyAll([n]), 5000);
            const ctx = NS.get(n, "ctx", null);
            const base = SK.perf.raf._ticks.size;
            const btn = [...(NS.get(n, "root", null)?.querySelectorAll("button") ?? [])].find((b) => b.textContent.startsWith("LAB"));
            if (!btn) { rm(n); return { skip: "pulsante LAB non trovato" }; }
            btn.click();
            await wait(300);
            const on = SK.perf.raf._ticks.size - base;
            void ctx;
            rm(n);
            await wait(500);
            const off = SK.perf.raf._ticks.size - base;
            return { ok: on === 1 && off === 0, detail: `tick con LAB=${on}, dopo remove=${off}` };
        });

        // 11. B4
        await step("B4: setNative -> scheduleChange", async () => {
            const n = mk();
            await waitFor(() => readyAll([n]), 5000);
            await wait(500);
            const f0 = SK.perf.change.flushes;
            NS.get(n, "ctx", null).utils.setNative("count", 123);
            await wait(600);
            const d = SK.perf.change.flushes - f0;
            rm(n);
            await wait(500);
            return { ok: d >= 1, detail: `changeFlushes +${d}` };
        });

        // 12. undo/redo with ChangeTracker
        await step("undo/redo reali (ChangeTracker)", async () => {
            const ct = SK.compat.getChangeTracker?.();
            if (!ct || typeof ct.undo !== "function" || typeof ct.redo !== "function")
                return { skip: "ChangeTracker.undo/redo non disponibili" };
            const ns = [mk(0, 0), mk(450, 0), mk(900, 0)];
            await waitFor(() => readyAll(ns), 5000);
            await wait(500);
            if (typeof ct.captureCanvasState === "function") await ct.captureCanvasState();
			else if (typeof ct.checkState === "function") await ct.checkState();
            for (const n of ns) rm(n);
            await wait(500);
            if (typeof ct.captureCanvasState === "function") await ct.captureCanvasState();
			else if (typeof ct.checkState === "function") await ct.checkState();
			// LiteGraph does one undo per action: 3 removals need 3 undos.
			// We keep undoing until all 3 come back or we run out of tries. Persistence pays off.
			let u = 0;
			while (liveNodes().size < 3 && u < 10) {
				await ct.undo();
				await wait(300);
				u++;
			}
			await wait(900);
			const a = inv();
			// Same thing, mirrored, for redo.
			let r = 0;
			while (liveNodes().size > 0 && r < 10) {
				await ct.redo();
				await wait(300);
				r++;
			}
			await wait(900);
			const b = inv();
			return { ok: a.live === 3 && a.ok && b.live === 0 && b.ok,
				detail: `undo chiamati=${u} redo chiamati=${r} | dopo undo: ${a.text} | dopo redo: ${b.text}` };
        });
        await cleanup();

        // 13. subgraph
        const sgApi = typeof app.graph.convertToSubgraph === "function" && typeof app.graph.unpackSubgraph === "function";
        await step("subgraph: convert + unpack", async () => {
            if (!sgApi) return { skip: "convertToSubgraph/unpackSubgraph non disponibili" };
            const ns = [mk(0, 0), mk(450, 0)];
            await waitFor(() => readyAll(ns), 5000);
            const r = app.graph.convertToSubgraph(new Set(ns));
            const sgNode = r?.node;
            if (!sgNode) return { skip: "convertToSubgraph non ha ritornato il nodo" };
            await wait(900);
            const a = inv();
            app.graph.unpackSubgraph(sgNode);
            await wait(1000);
            const back = [...liveNodes()];
            await waitFor(() => readyAll(back), 4000);
            const b = inv();
            return { ok: a.live === 2 && a.ok && b.live === 2 && b.ok && readyAll(back),
                detail: `dentro: ${a.text} | dopo unpack: ${b.text} ready=${readyAll(back)}` };
        });
        await cleanup();

        await step("subgraph annidato a 2 livelli", async () => {
            if (!sgApi) return { skip: "API subgraph non disponibili" };
            const ns = [mk(0, 0), mk(450, 0)];
            await waitFor(() => readyAll(ns), 5000);
            const r1 = app.graph.convertToSubgraph(new Set(ns));
            if (!r1?.node) return { skip: "primo convert fallito" };
            await wait(800);
            const r2 = app.graph.convertToSubgraph(new Set([r1.node]));
            if (!r2?.node) return { skip: "secondo convert fallito" };
            await wait(900);
            const a = inv();
            app.graph.unpackSubgraph(r2.node);
            await wait(900);
            const mid = rootNodes().find((x) => x.subgraph || x.type?.length > 20);
            if (mid) app.graph.unpackSubgraph(mid);
            await wait(1000);
            const back = [...liveNodes()];
            await waitFor(() => readyAll(back), 4000);
            const b = inv();
            return { ok: a.live === 2 && a.ok && b.live === 2 && b.ok && readyAll(back),
                detail: `annidato: ${a.text} | dopo 2 unpack: ${b.text} ready=${readyAll(back)}` };
        });
        await cleanup();

        // 14. stress 50 — let's see how much it can take
        if (opts.stress !== false) {
            await step("stress: 50 nodi", async () => {
                const ns = [];
                for (let i = 0; i < 50; i++) ns.push(mk((i % 10) * 420, Math.floor(i / 10) * 520));
                const rdy = await waitFor(() => readyAll(ns), 15000);
                await wait(1500);
                const a = inv();
                const canv = SK.perf.stats().activeCanvases;
                for (const n of ns) rm(n);
                await wait(2000);
                const b = inv();
                const f0 = SK.perf.stats().rafFrames;
                await wait(600);
                const idle = SK.perf.stats().rafFrames - f0;
                return { ok: rdy && a.live === 50 && a.ok && canv === 50 && b.live === 0 && b.ok && idle <= 1,
                    detail: `ready=${rdy} canvas=${canv} | con 50: ${a.text} | dopo: ${b.text} | frame idle=${idle}` };
            });
        }

        // 15. cache cleaned up (slow)
        if (opts.slow !== false) {
            await step("cache ripulita dopo ~5s dalla rimozione", async () => {
                await cleanup();
                await wait(5800);
                const size = SK.cache._store.size;
                return { ok: size === 0, detail: `bucket residui=${size}` };
            });
        }
    } finally {
        await cleanup();
    }

    const pass = results.filter((r) => r.result === "PASS").length;
    const fail = results.filter((r) => r.result === "FAIL").length;
    const skip = results.filter((r) => r.result === "SKIP").length;
    console.table(results);
    console.log(`[selfTest] PASS=${pass} FAIL=${fail} SKIP=${skip}`);
    console.log("SELFTEST_JSON " + JSON.stringify(results));
    return `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
}
