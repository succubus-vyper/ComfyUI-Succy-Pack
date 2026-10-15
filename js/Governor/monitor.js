// ============================================================
// Governor/monitor.js — CONTROL department: Succy Monitor, monitoring and commands over SurvivalKit + NodeStructure + throttle
// ------------------------------------------------------------
// Outside kit and builder: imports only the throttle (same department), reads globalThis.SurvivalKit / globalThis.NodeStructure
// when the panel is open (load order doesn't matter). Replaces the kit's old panel
// (SurvivalKit/debug/panel.js): same stats and same commands, plus builder, effects and
// health checks on the assumptions made about the ComfyUI frontend (they tell you what
// broke after an update). Ctrl+Shift+D opens/closes. Loops run ONLY while the panel is open — she watches only when invited.
// See DECISIONS D-50.
// ============================================================

import { Governor } from "./governor.js";
import { Errors } from "./errors.js";

const VERSION = "1.6.0";
const TESTED_FE = "1.55.17";             // frontend on which the assumptions were verified
const LS_OPEN = "succy:monitor-open";

if (!globalThis.__succyMonitorInstalled) {
    globalThis.__succyMonitorInstalled = true;
    install();
}

function install() {
    const SK = () => globalThis.SurvivalKit || null;
    const NS = () => globalThis.NodeStructure || null;
    const app = () => globalThis.app || null;

    // ---------- DOM (once only, in a shadow root: isolated style) ----------
    const host = document.createElement("div");
    host.id = "succy-monitor";
    host.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:999999;display:none;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
        :host { all: initial; }
        .p { width: 312px; max-height: 82vh; overflow: auto; padding: 10px 12px; box-sizing: border-box;
             background: rgba(10,10,15,.94); color: #b9d6ff; font: 10px/1.6 ui-monospace, "SF Mono", Menlo, monospace;
             border: 1px solid rgba(74,158,255,.4); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.6); user-select: none; }
        .h { color: #fff; font-weight: 700; font-size: 11px; } .h .dim { display: block; font-weight: 400; font-size: 9px; }
        .sec { margin-top: 7px; border-top: 1px solid rgba(255,255,255,.07); padding-top: 6px; }
        .t { color: #8aa; font-weight: 700; letter-spacing: .04em; margin-bottom: 2px; }
        .row { display: flex; justify-content: space-between; gap: 8px; }
        .dim { color: #667; } .ok { color: #7cff7c; } .warn { color: #ffb84d; } .err { color: #ff6b6b; }
        b { color: #fff; font-weight: 700; }
        button { padding: 2px 7px; margin: 2px 4px 2px 0; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.15);
                 border-radius: 4px; color: #ccc; font: bold 10px ui-monospace, monospace; cursor: pointer; }
        button:hover { background: rgba(255,255,255,.12); } button.on { border-color: #4a9eff; color: #fff; background: rgba(74,158,255,.25); }
        button:disabled { opacity: .5; cursor: default; }
        canvas { display: block; width: 288px; height: 42px; margin: 3px 0; background: rgba(255,255,255,.03); border-radius: 3px; }
        .hc { display: grid; grid-template-columns: 12px 1fr; gap: 0 4px; }
        .out { color: #aaa; white-space: pre-wrap; }
    </style><div class="p"></div>`;
    const P = root.querySelector(".p");
    const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const section = (title) => { const s = el("div", "sec"); s.append(el("div", "t", title)); P.append(s); return s; };
    const line = (parent, label) => { const r = el("div", "row"); const v = el("span"); r.append(el("span", null, label), v); parent.append(r); return v; };
    const btn = (parent, label, fn) => {
        const b = el("button", null, label);
        b.addEventListener("click", (e) => { e.stopPropagation(); try { fn(b); } catch (err) { console.warn("[Succy Monitor]", err); } refresh(); });
        parent.append(b); return b;
    };
    const setv = (node, text, cls) => { node.textContent = text; node.className = cls || ""; };

    // header
    const head = el("div", "h"); const title = el("span", null, "Succy Monitor"); const vers = el("span", "dim");
    head.append(title, vers); P.append(head);

    // frame
    const sFrame = section("FRAME");
    const vFps = line(sFrame, "FPS"), vDrop = line(sFrame, "Frame drop (>33 ms)"), vLong = line(sFrame, "Long tasks");

    // effects
    const sFx = section("EFFECTS (wires / dots / animations)");
    const vLevel = line(sFx, "Level"), vWhy = line(sFx, "Reason"), vCost = line(sFx, "Our cost / native wires"), vNat = line(sFx, "Native"), vHold = line(sFx, "Holds");
    const spark = el("canvas"); spark.width = 576; spark.height = 84; sFx.append(spark);
    const modeRow = el("div"); sFx.append(modeRow);
    const modeBtns = ["auto", 0, 1, 2, 3].map((m) => btn(modeRow, m === "auto" ? "auto" : String(m), () => Governor.setMode(m)));
    const fxRow = el("div"); sFx.append(fxRow);
    const bNat = btn(fxRow, "native", () => { const nr = NS()?.nativeReroutes; if (!nr) return; nr.isOn() ? nr.disable() : nr.enable(); });
    const bHold = btn(fxRow, "test hold", () => { (Governor.stats().holds.monitor ? Governor.release("monitor") : Governor.hold("monitor")); });
    btn(fxRow, "release all", () => Governor.releaseAll());

    // builder
    const sNs = section("NODESTRUCTURE (builder)");
    const vNsTypes = line(sNs, "Types / extensions"), vNsInst = line(sNs, "Instances / menus"), vNsBag = line(sNs, "Live bags / items"), vNsCat = line(sNs, "Pieces / problems"), vNsAnim = line(sNs, "CSS animations");

    // survival kit
    const sSk = section("SURVIVALKIT");
    const vSkFlush = line(sSk, "Resize / change flush"), vSkCk = line(sSk, "Checkpoint / pending"), vSkRaf = line(sSk, "RAF frames (active)"), vSkCv = line(sSk, "Canvases (scale)");
    const vSkNodes = el("div", "dim"); sSk.append(vSkNodes);

    // health
    const sHealth = section("HEALTH (frontend assumptions)");
    const hc = el("div", "hc"); sHealth.append(hc);

    // pack errors: department + file:line (Governor/errors.js)
    const sErr = section("ERRORS (department · file:line)");
    const vErrSum = el("div"); sErr.append(vErrSum);
    const vErrList = el("div", "out"); sErr.append(vErrList);
    const errRow = el("div"); sErr.append(errRow);
    btn(errRow, "clear errors", () => Errors.clear());
    btn(errRow, "errors → console", () => { console.log("SUCCY_ERRORS " + JSON.stringify({ summary: Errors.summary(), list: Errors.list() })); });
    function refreshErrors() {
        const sum = Errors.summary(), list = Errors.list();
        vErrSum.textContent = "";
        if (!sum.length) { vErrSum.append(el("span", "ok", "no errors from the pack")); vErrList.textContent = ""; return; }
        for (const x of sum.slice(0, 5)) { const r = el("div", "row"); r.append(el("span", "err", x.where), el("span", null, "×" + x.count)); vErrSum.append(r); }
        vErrList.textContent = list.slice(-4).reverse().map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.level} [${e.dept}] ${e.where}${e.fn ? " (" + e.fn + ")" : ""}${e.n > 1 ? " ×" + e.n : ""}\n  ${e.msg.slice(0, 140)}`).join("\n");
    }

    // kit commands (carried over 1:1 from the old panel)
    const sCmd = section("COMMANDS");
    const logToggle = btn(sCmd, "", () => { const L = SK()?.log; if (L) L.setEnabled(!L.enabled); });
    const nsRow = el("div"); sCmd.append(nsRow);
    const actRow = el("div"); sCmd.append(actRow);
    btn(actRow, "Dump log", () => SK()?.log?.dump(100));
    btn(actRow, "Clear buf", () => SK()?.log?.clear());
    btn(actRow, "Heal all", () => { const k = SK(); if (!k) return; for (const t of Object.keys(k.inspect().active)) k.heal.healAll(t, true); });
    btn(actRow, "Flush all", () => SK()?.flushAll());
    const testRow = el("div"); sCmd.append(testRow);
    const out = el("div", "out"); sCmd.append(out);
    const runTest = async (b, label, fn) => {
        b.disabled = true; out.textContent = label + " running...";
        try { const r = await fn(); out.textContent = label + ": " + (typeof r === "object" ? JSON.stringify(r).slice(0, 160) : r) + " (details in console)"; }
        catch (e) { out.textContent = label + ": error " + (e?.message || e); }
        finally { b.disabled = false; }
    };
    btn(testRow, "selfTest kit", (b) => runTest(b, "selfTest kit", () => SK()?.selfTest?.({ stress: true, slow: true })));
    btn(testRow, "kit rapido", (b) => runTest(b, "selfTest kit rapido", () => SK()?.selfTest?.({ stress: false, slow: false })));
    btn(testRow, "selfTest builder", (b) => runTest(b, "selfTest builder", async () => { const r = await NS()?.selfTest?.(); return r ? { pass: r.pass, fail: r.fail, skip: r.skip } : "NodeStructure missing"; }));
    btn(testRow, "report", () => { const r = report(); console.log("SUCCY_MONITOR " + JSON.stringify(r)); out.textContent = "report in console (SUCCY_MONITOR line)"; });
    P.append(el("div", "dim", "Ctrl+Shift+D toggles"));

    // ---------- log commands: rebuilt only when the log changes ----------
    let unsubLog = null;
    function refreshLog() {
        const L = SK()?.log;
        if (!L) { logToggle.textContent = "Log kit: n/a"; nsRow.textContent = ""; return; }
        logToggle.textContent = "Log kit: " + (L.enabled ? "ON" : "OFF");
        logToggle.style.color = L.enabled ? "#7cff7c" : "#ff9a9a";
        nsRow.textContent = "";
        for (const ns of L.namespaces()) {
            const m = L.isMuted(ns);
            const b = btn(nsRow, (m ? "✕ " : "✓ ") + ns, () => L.setMuted(ns, !L.isMuted(ns)));
            b.style.opacity = m ? "0.5" : "1";
        }
    }

    // ---------- frame (panel open only) ----------
    let visible = false, rafId = null, intervalId = null, perfObs = null;
    let lastFrame = 0, fpsAcc = 0, fpsCount = 0, drops = 0, worst = 0, longTasks = 0, worstTask = 0, lastReset = 0;
    function frameTick() {
        const now = performance.now(), dt = now - lastFrame; lastFrame = now;
        fpsAcc += 1000 / dt; fpsCount++;
        if (dt > 33) drops++;
        if (dt > worst) worst = dt;
        rafId = requestAnimationFrame(frameTick);
    }

    // ---------- health ----------
    const CHECKS = [
        ["SurvivalKit loaded", () => SK() ? ["ok", "v" + SK().version] : ["err", "globalThis.SurvivalKit missing"]],
        ["NodeStructure loaded", () => NS() ? ["ok", "v" + NS().version] : ["err", "globalThis.NodeStructure missing"]],
        ["Tested frontend", () => { const v = globalThis.__COMFYUI_FRONTEND_VERSION__; return !v ? ["warn", "unknown version"] : v === TESTED_FE ? ["ok", v] : ["warn", `${v} (tested: ${TESTED_FE}) — check the rows below`]; }],
        ["Canvas + drawConnections", () => { const c = app()?.canvas; return c && typeof c.drawConnections === "function" ? ["ok", "Vue Nodes " + (globalThis.LiteGraph?.vueNodesMode ? "ON" : "OFF")] : ["err", "app.canvas.drawConnections missing: no wire effects"]; }],
        ["renderLink (segments)", () => typeof app()?.canvas?.renderLink === "function" ? ["ok", ""] : ["err", "canvas.renderLink missing: reroute wires cannot be recorded"]],
        ["graph.links readable", () => { const L = app()?.canvas?.graph?.links; return typeof L?.values === "function" ? ["ok", (L.constructor?.name || "?") + " · " + L.size] : ["err", "links without values()"]; }],
        ["graph.reroutes = Map", () => { const r = app()?.canvas?.graph?.reroutes; return r instanceof Map ? ["ok", String(r.size)] : ["err", "reroutes is not a Map"]; }],
        ["Wire wrapper installed", () => { const n = NS(); if (!n) return ["n/a", ""]; const s = n.nativeReroutes.stats(); const i = n.nativeReroutes.info(); if (!s.native && !s.nodes) return ["n/a", "no users"]; return s.installed ? ["ok", `native ${s.native} · nodes ${s.nodes}`] : ["err", "wrapper NOT installed"]; }],
        ["Reroute wires recorded", () => {
            const n = NS(); if (!n) return ["n/a", ""];
            const i = n.nativeReroutes.info(), lv = Governor.stats().level;
            if (!i.active || lv >= 3) return ["n/a", i.active ? "effects off" : "native reroutes off"];
            if (!i.throughReroutes) return ["n/a", "no wire goes through a reroute"];
            if (!i.last.recorder) return ["err", "recorder not hooked (renderLink changed?)"];
            return i.last.segments > 0 ? ["ok", `${i.last.segments} segments · ${i.last.dots} dots`] : ["warn", "0 segments: off screen, or the frontend no longer goes through renderLink"];
        }],
        ["Reroute data (Survival)", () => { const gs = SK()?.graphStore; if (!gs) return ["err", "SurvivalKit without graphStore (old version?)"]; const i = gs.info(); const n = Object.keys(i.namespaces).length; if (!n) return ["n/a", "no namespace registered"]; return i.clipboard ? ["ok", `copy/paste hooked · saved ${i.sets} · pasted ${i.pasted} · subgraph moves ${i.moved || 0}`] : ["warn", "copy/paste NOT hooked: reroute data will not follow copy/paste"]; }],
        ["Input link (Survival)", () => { const il = SK()?.inputLink; if (!il) return ["err", "SurvivalKit without inputLink (old version?)"]; const p = il.probe(); return p.ok ? ["ok", `v${il.version} · Vue ${p.vue ? "ON" : "OFF"}${p.wireless ? " · wireless ON" : ""}`] : ["err", "missing: " + p.missing.join(", ")]; }],
        ["Chips (in/out)", () => { const c = NS()?.chips; if (!c) return ["n/a", ""]; const s = c.stats(); if (!s.users) return ["n/a", "no chips"]; if (s.broken.length) return ["err", "source gone: " + s.broken.slice(0, 3).join(" · ")]; if (s.notDrawable.length) return ["warn", s.notDrawable.slice(0, 3).join(" · ")]; return ["ok", `${s.drawn} drawn · ${s.hidden} off screen`]; }],
        ["Dynamic outputs", () => { const np = SK()?.nodePorts, ps = NS()?.ports; if (!np || !ps) return ["err", "SurvivalKit.nodePorts / NodeStructure.ports missing"]; const pr = np.probe(); if (!pr.ok) return ["err", "missing: " + pr.missing.join(", ")]; const s = ps.stats(); if (!s.users) return ["n/a", "no users"]; if (s.errors.length) return ["err", s.errors.slice(0, 2).join(" · ")]; const l = s.kit?.last; return ["ok", `${s.users} nodes · changes ${s.kit?.changes ?? 0}` + (l?.detached?.length ? ` · last: ${l.who} detached ${l.detached.join(",")}` : "")]; }],
        // --- D-86: lights for the departments that were running without a chaperone ---
        ["EXT door (Builder)", () => { const np = SK()?.nodePorts, e = NS()?.ext; if (!np || !e) return ["err", "SurvivalKit.nodePorts / NodeStructure.ext missing"]; const pr = np.probe(); if (!pr.ok) return ["err", "missing: " + pr.missing.join(", ")]; if (typeof np.showInputs !== "function") return ["err", "nodePorts.showInputs missing"]; const s = e.stats(); if (!s.users) return ["n/a", "no users"]; if (s.errors.length) return ["err", s.errors.slice(0, 2).join(" · ")]; return ["ok", `${s.users} nodes · widget ${s.widget} · chip ${s.chip}`]; }],
        ["Reroute panel (Builder)", () => { const il = SK()?.inputLink; if (!il) return ["err", "SurvivalKit.inputLink missing"]; const miss = ["rerouteWires", "rerouteDropSource", "rerouteSetSource", "rerouteDropDest"].filter((k) => typeof il[k] !== "function"); if (miss.length) return ["err", "inputLink missing: " + miss.join(", ")]; const ex = NS()?.extensions?.get?.("Succy.NativeReroutes"), cur = ex?.current?.(), g = app()?.canvas?.graph, rid = cur?.node?.reroute?.id; if (cur && g && !g.reroutes?.has?.(rid)) return ["err", `orphan panel: reroute #${rid} is gone but its menu is still open`]; const n = g?.reroutes instanceof Map ? g.reroutes.size : 0; return ["ok", n ? `${n} reroutes · ${cur ? "panel open on #" + rid : "no panel open"}` : "no reroutes"]; }],
        ["Pause hold (Survival)", () => { const h = SK()?.hold; if (!h) return ["err", "SurvivalKit.hold missing"]; const s = h.stats(); if (!s.classes?.length) return ["n/a", "no Pause nodes"]; return ["ok", `${s.classes.length} class(es) · ${s.waiting} waiting · ${s.runs} runs`]; }],
        // --- D-105 (Crop phase 2): the viewport and the picture feed ---
        ["Crop viewport (Builder)", () => { const v = NS()?.view; if (!v) return ["err", "NodeStructure.view missing"]; const s = v.stats(), f = v.shots(); if (!s.views && !f.nodes) return ["n/a", "no Crop viewport open"]; if (f.nodes && !f.wired) return ["warn", "pictures arrived but the feed is not wired"]; return ["ok", `${s.views} viewport(s) (${s.zoomed} zoomed) · ${f.nodes} picture(s)`]; }],
        // --- D-106 (Crop phase 3): free hand mask and pictures loaded without a Queue ---
        ["Crop brush (Builder)", () => { const b = NS()?.view?.brush; if (!b) return ["err", "NodeStructure.view.brush missing"]; const s = b(); if (!s.brushes) return ["n/a", "no brush open"]; return ["ok", `${s.brushes} brush(es) · ${s.active} in free hand · ${s.painting} painting`]; }],
        ["Crop mask view (Builder)", () => { const m = NS()?.view?.mask; if (!m) return ["err", "NodeStructure.view.mask missing"]; const s = m(); if (!s.previews) return ["n/a", "no mask preview open"]; if (s.lastMs > 250) return ["warn", `slow preview: ${s.lastMs} ms per render (lower res)`]; return ["ok", `${s.previews} preview(s) · ${s.shown} shown · ${s.renders} render(s) · last ${s.lastMs} ms`]; }],
        ["Image load (Survival)", () => { const c = SK()?.compat; if (!c?.uploadStats) return ["err", "SurvivalKit.compat.uploadImage missing"]; const u = c.uploadStats(), b = NS()?.view?.brush?.() || {}; if (!u.ok && !u.failed && !u.pending) return ["n/a", "nothing uploaded yet"]; if (u.failed) return ["warn", `${u.failed} failed upload(s): ${u.last || b.last || "?"}`]; return ["ok", `${u.ok} upload(s) · ${b.drops || 0} drop · ${b.pastes || 0} paste · ${b.picks || 0} pick${u.pending ? ` · ${u.pending} in flight` : ""}`]; }],
        ["Reroute snap (Survival)", () => { const r = SK()?.rerouteSnap; if (!r) return ["err", "SurvivalKit.rerouteSnap missing"]; return r.active() ? ["ok", `${r.active()} user(s)`] : ["n/a", "no users"]; }],
        ["Subgraph shield (Survival)", () => { const sh = SK()?.subgraphShield, P = globalThis.LiteGraph?.LGraph?.prototype; if (!sh) return ["err", "SurvivalKit.subgraphShield missing"]; const miss = ["convertToSubgraph", "unpackSubgraph"].filter((k) => typeof P?.[k] !== "function"); if (miss.length) return ["err", "frontend lost: " + miss.join(", ")]; return sh._installed ? ["ok", "installed"] : ["warn", "not installed"]; }],
        // --- B4 (14/10): the last Survival departments without a chaperone get one too. Nobody sleeps unwatched, darling ---
        ["Lifecycle + heal (Survival)", () => { const sk = SK(), C = globalThis.__succyConfigs; if (!sk?.heal || !(C instanceof Map)) return ["err", "SurvivalKit.heal / __succyConfigs missing"]; const T = globalThis.LiteGraph?.registered_node_types || {}; const bare = [...C.keys()].filter((t) => T[t] && !T[t].prototype.__succyLifecycleInstalled); if (bare.length) return ["err", "hooks not wrapped: " + bare.slice(0, 3).join(", ")]; const live = (app()?.canvas?.graph?._nodes || []).filter((n) => C.has(n.type)); if (!live.length) return ["n/a", `no kit nodes here · ${C.size} types wrapped`]; const sick = live.filter((n) => { try { return !sk.heal._uiHealthy(n); } catch (_) { return true; } }); return sick.length ? ["warn", `${sick.length}/${live.length} not healthy (heal pending?): ` + sick.slice(0, 3).map((n) => `${n.type} #${n.id}`).join(" · ")] : ["ok", `${live.length} nodes healthy · ${C.size} types wrapped`]; }],
        ["State store (Survival)", () => { const st = SK()?.state, C = globalThis.__succyConfigs; if (!st || !(st._byKey instanceof Map) || !(C instanceof Map)) return ["err", "SurvivalKit.state missing"]; const keyOf = (n) => Object.entries(C.get(n.type)?.state || {}).find(([, v]) => v?.default !== undefined)?.[0]; const live = (app()?.canvas?.graph?._nodes || []).filter((n) => C.has(n.type) && keyOf(n)); if (!live.length) return ["n/a", "no nodes with declared state"]; const lost = live.filter((n) => st.get(n, keyOf(n)) === undefined); return lost.length ? ["err", "no state entry: " + lost.slice(0, 3).map((n) => `${n.type} #${n.id}`).join(" · ")] : ["ok", `${live.length} nodes · ${st._byKey.size} entries`]; }],
        ["Compat adapters (Survival)", () => { const c = SK()?.compat; if (!c) return ["err", "SurvivalKit.compat missing"]; const i = c.inspect(), blind = []; if (!i.hasChangeTracker) blind.push("changeTracker (undo/redo checkpoints)"); if (typeof globalThis.LiteGraph?.LGraphNode?.prototype?.addDOMWidget !== "function") blind.push("addDOMWidget"); if (!i.version) blind.push("ComfyUI version"); return blind.length ? ["warn", "adapter blind: " + blind.join(", ")] : ["ok", "frontend " + i.version]; }],
        ["Tables", () => { const t = NS()?.tables; if (!t) return ["err", "NodeStructure.tables missing"]; const s = t.stats(); if (!s.users) return ["n/a", "no users"]; if (s.errors.length) return ["err", s.errors.slice(0, 2).join(" · ")]; const mv = SK()?.nodePorts?.stats()?.moved || 0; return ["ok", `${s.users} tables (${s.shapes.slice(0, 3).join(", ")}) · pastes ${s.pastes} · edits ${s.edits} · wires moved ${mv}`]; }],
        ["Kit hover (Tip)", () => { const n = NS(); if (!n) return ["n/a", ""]; if (!n.tip) return ["err", "NodeStructure.tip missing"]; if (!n.chips?.stats().users) return ["n/a", "no users"]; return document.getElementById("succy-ns-css-ns-tip") ? ["ok", "1 hover · native muted on hover"] : ["warn", "tip CSS not registered (no hover drawn yet)"]; }],
        ["Catalog", () => { const n = NS(); if (!n) return ["n/a", ""]; const p = n.catalog.problems().length, l = n.catalog.late(); const late = l.pieces.length + l.css.length; return p || late ? ["err", `problems ${p} · late ${late}`] : ["ok", n.inspect().pieces + " pieces"]; }],
    ];
    // WHERE to look when a check isn't green (the responsible pack file)
    const WHERE = {
        "SurvivalKit loaded": "SurvivalKit/survival-kit.js",
        "NodeStructure loaded": "NodeStructure/index.js",
        "Tested frontend": "Governor/monitor.js (TESTED_FE) + NodeStructure/fx/native.js",
        "Canvas + drawConnections": "NodeStructure/fx/overlay.js (install)",
        "renderLink (segments)": "NodeStructure/fx/native.js (beginFrame/record)",
        "graph.links readable": "NodeStructure/fx/chain.js (allLinks) · fx/native.js",
        "graph.reroutes = Map": "NodeStructure/fx/chain.js (rr*) · fx/native.js",
        "Wire wrapper installed": "NodeStructure/fx/overlay.js (install/attachNative)",
        "Reroute wires recorded": "NodeStructure/fx/native.js (beginFrame/record/paintNative)",
        "Reroute data (Survival)": "SurvivalKit/persistence/graph-store.js",
        "Input link (Survival)": "SurvivalKit/shields/input-link.js (probe)",
        "Chips (in/out)": "NodeStructure/pieces/chip.js (sync) + SurvivalKit/shields/input-link.js (VUE / slotDom)",
        "Dynamic outputs": "NodeStructure/pieces/ports.js (shape_output) + SurvivalKit/shields/node-ports.js (setOutputs)",
        "EXT door (Builder)": "NodeStructure/pieces/node.js (ext_node) + SurvivalKit/shields/node-ports.js (showInputs)",
        "Reroute panel (Builder)": "SurvivalKit/shields/input-link.js (reroute*) + NodeStructure/pieces/wire.js + NodeStructure/core/extend.js (the menu closes when its reroute dies)",
        "Pause hold (Survival)": "SurvivalKit/shields/hold.js",
        "Crop viewport (Builder)": "NodeStructure/components/view.js (view_box, marquee_element) + NodeStructure/runtime/shot-feed.js",
        "Crop brush (Builder)": "NodeStructure/components/brush.js (brush_element)",
        "Crop mask view (Builder)": "NodeStructure/components/veil.js (veil_element) + NodeStructure/util/mask-math.js",
        "Image load (Survival)": "SurvivalKit/compat/adapters.js (uploadImage) + NodeStructure/components/brush.js (load_mask)",
        "Reroute snap (Survival)": "SurvivalKit/shields/reroute-snap.js",
        "Subgraph shield (Survival)": "SurvivalKit/shields/subgraph.js",
        "Lifecycle + heal (Survival)": "SurvivalKit/core/lifecycle.js (_wrapHooks) + SurvivalKit/core/heal.js (_uiHealthy / heal)",
        "State store (Survival)": "SurvivalKit/persistence/state.js (init / get)",
        "Compat adapters (Survival)": "SurvivalKit/compat/adapters.js + SurvivalKit/compat/version.js",
        "Tables": "NodeStructure/pieces/table.js (table_box) + core/runtime.js (wantWidth) · moved wires: SurvivalKit/shields/node-ports.js (byName)",
        "Kit hover (Tip)": "NodeStructure/menu/tip.js + SurvivalKit/shields/input-link.js (VUE.nativeTip)",
        "Catalog": "NodeStructure/catalog/registry.js + the piece named by the selfTest",
    };
    const hcRows = CHECKS.map(([label]) => { const d = el("span"); const t = el("span"); const lab = el("span", null, label + " "); lab.append(t); hc.append(d, lab); return { d, t }; });
    const health = () => CHECKS.map(([label, fn]) => { let r; try { r = fn(); } catch (e) { r = ["err", String(e?.message || e)]; } return { label, status: r[0], detail: r[1], where: WHERE[label] || "?" }; });

    // ---------- effects cost sparkline ----------
    function drawSpark(hist, cfg) {
        const g = spark.getContext("2d"), W = spark.width, H = spark.height;
        g.clearRect(0, 0, W, H);
        if (!hist.length) return;
        const max = Math.max(cfg.still * 1.5, ...hist.map((h) => Math.max(h.cost, h.draw)));
        const y = (v) => H - 2 - (v / max) * (H - 6);
        for (const [v, c] of [[cfg.lite, "rgba(255,184,77,.5)"], [cfg.still, "rgba(255,107,107,.5)"]]) { g.strokeStyle = c; g.setLineDash([6, 6]); g.beginPath(); g.moveTo(0, y(v)); g.lineTo(W, y(v)); g.stroke(); }
        g.setLineDash([]);
        const step = W / 119;
        for (const [key, c] of [["draw", "rgba(140,140,160,.8)"], ["cost", "#4a9eff"]]) {
            g.strokeStyle = c; g.lineWidth = 2; g.beginPath();
            hist.forEach((h, i) => { const X = i * step, Y = y(h[key]); i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
            g.stroke();
        }
        const LC = ["#7cff7c", "#ffb84d", "#ff9a4d", "#ff6b6b"];
        hist.forEach((h, i) => { g.fillStyle = LC[h.level] || "#888"; g.fillRect(i * step, H - 3, step + 1, 3); });
    }

    // ---------- refresh (every 500 ms while the panel is open) ----------
    function refresh() {
        if (!visible) return;
        const k = SK(), n = NS();
        vers.textContent = `kit ${k?.version ?? "—"} · ns ${n?.version ?? "—"} · fe ${globalThis.__COMFYUI_FRONTEND_VERSION__ ?? "?"}`;
        const fps = fpsCount ? fpsAcc / fpsCount : 0;
        setv(vFps, fpsCount ? fps.toFixed(1) : "—", fps >= 55 ? "ok" : fps >= 30 ? "warn" : "err");
        setv(vDrop, `${drops} (worst ${worst.toFixed(0)} ms)`, drops === 0 ? "ok" : drops < 5 ? "warn" : "err");
        setv(vLong, `${longTasks} (worst ${worstTask.toFixed(0)} ms)`, longTasks === 0 ? "ok" : longTasks < 3 ? "warn" : "err");
        if (performance.now() - lastReset > 1000) { fpsAcc = fpsCount = drops = worst = longTasks = worstTask = 0; lastReset = performance.now(); }

        if (n?.nativeReroutes) {
            const s = Governor.stats(), i = n.nativeReroutes.info();
            setv(vLevel, `${s.level} ${s.levelName}${s.mode === "auto" ? " (auto)" : " (manual)"}`, ["ok", "warn", "warn", "err"][s.level]);
            setv(vWhy, s.reason || "—", "dim");
            setv(vCost, `${s.costMs} / ${s.drawMs} ms`, s.costMs > s.cfg.still ? "err" : s.costMs > s.cfg.lite ? "warn" : "ok");
            setv(vNat, `${i.active ? "ON" : "OFF"} · ${i.effect} · ${i.last.segments} seg · ${i.last.dots} dots`, i.active ? "" : "dim");
            const holds = Object.entries(s.holds);
            setv(vHold, holds.length ? holds.map(([w, c]) => `${w}×${c}`).join(", ") : "—", holds.length ? "warn" : "dim");
            modeBtns.forEach((b, j) => b.classList.toggle("on", ["auto", 0, 1, 2, 3][j] === s.mode));
            bNat.textContent = "native " + (i.off ? "OFF" : "ON"); bNat.classList.toggle("on", !i.off);
            bHold.classList.toggle("on", !!s.holds.monitor);
            drawSpark(Governor.history(), s.cfg);
        } else { setv(vLevel, "NodeStructure missing", "dim"); }

        if (n) {
            const ins = n.inspect(), bag = n._internal?.Bag?.stats?.(), an = n.anim?.stats?.();
            setv(vNsTypes, `${ins.types.length} / ${n.extensions?.size ?? 0}`);
            setv(vNsInst, `${ins.instances} / ${ins.openMenus}`);
            setv(vNsBag, bag ? `${bag.liveBags} / ${bag.liveItems}` : "—");
            setv(vNsCat, `${ins.pieces} / ${ins.problems}`, ins.problems ? "err" : "");
            setv(vNsAnim, an ? `${an.mode}${an.forced ? " → forced " + an.forced : ""} · ${an.entries} nodes` : "—", an?.forced ? "warn" : "");
        }

        if (k) {
            const s = k.perf.stats(), nodes = k.inspect();
            setv(vSkFlush, `${s.resizeFlushes} / ${s.changeFlushes}`);
            setv(vSkCk, `${s.checkpointFlushes} / ${s.pendingChanges}`);
            setv(vSkRaf, `${s.rafFrames} (${s.activeRafs})`);
            setv(vSkCv, `${s.activeCanvases || 0} (${(s.canvasScale || 1).toFixed(2)}${s.underBudget ? " · free" : " · throttled"})`, s.underBudget ? "" : "warn");
            vSkNodes.textContent = Object.entries(nodes.active).filter(([, c]) => c > 0).map(([t, c]) => `${t}:${c}`).join("  ");
        }

        health().forEach((h, j) => { const r = hcRows[j]; r.d.textContent = { ok: "●", warn: "●", err: "●", "n/a": "○" }[h.status]; r.d.className = h.status === "n/a" ? "dim" : h.status; r.t.textContent = (h.detail ? "— " + h.detail : "") + (h.status === "err" || h.status === "warn" ? "  → " + h.where : ""); r.t.className = h.status === "err" ? "err" : "dim"; });
        refreshErrors();
    }

    function report() {
        const n = NS(), k = SK();
        return {
            monitor: VERSION, t: new Date().toISOString(), fe: globalThis.__COMFYUI_FRONTEND_VERSION__ ?? null, vueNodes: !!globalThis.LiteGraph?.vueNodesMode,
            governor: Governor.stats(),
            kit: k ? { version: k.version, perf: k.perf.stats(), nodes: k.inspect().active, graphStore: k.graphStore?.info?.() } : null,
            ns: n ? { version: n.version, inspect: n.inspect(), bags: n._internal?.Bag?.stats?.(), anim: n.anim?.stats?.(), native: n.nativeReroutes?.info?.(), wires: n.nativeReroutes?.stats?.() } : null,
            health: health(),
            errors: { summary: Errors.summary(), last: Errors.list().slice(-20) },
        };
    }

    function open(v) {
        visible = v;
        host.style.display = v ? "block" : "none";
        try { localStorage.setItem(LS_OPEN, v ? "1" : "0"); } catch (_) {}
        if (v) {
            lastFrame = lastReset = performance.now();
            if (rafId === null) rafId = requestAnimationFrame(frameTick);
            if (intervalId === null) intervalId = setInterval(refresh, 500);
            if (!perfObs && window.PerformanceObserver) {
                try { perfObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) { longTasks++; if (e.duration > worstTask) worstTask = e.duration; } }); perfObs.observe({ type: "longtask", buffered: false }); } catch (_) { perfObs = null; }
            }
            if (!unsubLog && SK()?.log) unsubLog = SK().log.subscribe(refreshLog);
            refreshLog(); refresh();
        } else {
            if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
            if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
            if (perfObs) { try { perfObs.disconnect(); } catch (_) {} perfObs = null; }
            if (unsubLog) { try { unsubLog(); } catch (_) {} unsubLog = null; }
        }
    }

    const mount = () => { if (!host.isConnected) document.body.appendChild(host); };
    if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount, { once: true });

    document.addEventListener("keydown", (e) => {
        // e.code: independent of layout and Caps Lock
        if (e.ctrlKey && e.shiftKey && e.code === "KeyD") { e.preventDefault(); e.stopPropagation(); open(!visible); }
    }, true);

    globalThis.SuccyMonitor = { version: VERSION, open: () => open(true), close: () => open(false), toggle: () => open(!visible), report, health };
    try { if (localStorage.getItem(LS_OPEN) === "1") setTimeout(() => open(true), 1500); } catch (_) {}
}
