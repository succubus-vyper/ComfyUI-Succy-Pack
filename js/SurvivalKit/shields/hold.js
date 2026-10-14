// ============================================================
// SurvivalKit/shields/hold.js
// ------------------------------------------------------------
// The HOLD shield (D-82): a node that stops the graph in place and waits for a human (Succy Pause today, the LLM
// node and Loop tomorrow). Everything that keeps a hold from breaking lives HERE, not in the node:
//   - the run-state machine: one "run" per (node, run_id), alive across Ctrl+Z / rebuilt nodes / subgraph entry
//   - Run pressed while a hold is waiting ........ the old waits are released (Python side too) and run_ids renewed
//   - Stop / Interrupt / error / success ......... every waiting hold is closed with the right status
//   - Continue ................................... "requeue": new run_id `<ts>_continue`, re-queue, THEN stop the old wait
//                                                  (so you can edit upstream while it waits); inside a loop: resume in place
//   - undo brings back an older run_id while Python still waits .... the live state wins, the widget follows it
// This is a straight port of the engineering that lived in Succy_Pause.js v1.4.2 (months of "stop, stop the workflow,
// play while the timer ticks" debugging): same order of operations, same guards. Only the DOM went away (the node's
// spec draws it) and the node-property flags became module state.
// Nodes inside SUBGRAPHS are first-class: the key of a node is its EXECUTION id (`5:3` = node 3 inside subgraph node 5),
// the same id the backend and the `executing` event use.
//   install(cfg)  attach(node)  view(node)  subscribe(node, fn)  act(node, "continue"|"stop")  on(event, fn)  stats()
//   cfg = { classType, route, infoEvent, names:{pause,timeout,onTimeout,sound,runId} }   (first config per class wins)
// Succubus was here — and when she says wait, you wait. Nobody leaves before the safeword.
// v1.0.0 — 2026-10-13
// ============================================================

import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";

const VERSION = "1.0.0";
const DEFAULTS = {
    route: "/succy/pause/action",
    infoEvent: "succy-pause-info",
    names: { pause: "pause_flow", timeout: "timeout_seconds", onTimeout: "on_timeout", sound: "emit_sound", runId: "run_id" },
};

// ---- module state (nothing lives on the nodes) ----
const CONFIGS = new Map();          // classType -> cfg
const RUNS = new Map();             // "<nodeId>::<runId>" -> run state
const VIEWS = new Map();            // nodeId -> last shown view (survives rebuilt instances)
const LOOP = new Map();             // nodeId -> true when Python said the node sits inside a Succy loop
const SUBS = new Map();             // nodeId -> Set(fn): who wants to redraw
const LISTENERS = { start: new Set() };
const HAD_RUN = new WeakSet();      // node instances that already showed a run state this session
const REMOVED = new WeakSet();      // node instances that were removed from the graph (undo brings NEW instances)
let pendingAuto = false;            // set right before OUR OWN re-queue so the queuePrompt wrapper doesn't treat it as a manual Run

const IDLE = Object.freeze({ text: "READY TO USE", timer: "", tone: "mute", canAct: false });

// ---- tiny helpers ----
const warn = (what, e) => console.warn(`[Survival] hold: ${what}`, e ?? "");
const classOf = (node) => node?.comfyClass || node?.type;
const cfgOf = (node) => CONFIGS.get(classOf(node)) || null;
export const isHold = (node) => !!node && CONFIGS.has(classOf(node));
const widget = (node, name) => node?.widgets?.find((w) => w.name === name);
const nameOf = (node, k) => cfgOf(node)?.names?.[k] ?? DEFAULTS.names[k];
const runIdOf = (node) => String(widget(node, nameOf(node, "runId"))?.value ?? "");
const runKey = (nodeId, runId) => String(nodeId) + "::" + String(runId ?? "");
const safeNumber = (v, def = 60) => { const n = Number(v); return Number.isFinite(n) ? Math.max(1, Math.min(3600, Math.floor(n))) : def; };
const sameGraph = (a, b) => a === b || (a?.id != null && b?.id != null && String(a.id) === String(b.id));
const dirty = (node) => { try { (node?.graph?.list_of_graphs?.[0] || node?.graph || app.graph)?.setDirtyCanvas?.(true, true); } catch (_) {} };

function notify(nodeId) {
    const set = SUBS.get(String(nodeId));
    if (!set) return;
    for (const fn of [...set]) { try { fn(); } catch (e) { warn("subscriber", e); } }
}
function setView(nodeId, text, tone, timer = "") {
    VIEWS.set(String(nodeId), { text, timer, tone, canAct: false });
    notify(nodeId);
}

// ---- execution ids: `5:3` = node 3 inside subgraph node 5 (what the backend and `executing` speak) ----
const rootOf = () => app.graph?.rootGraph || app.graph;
const graphNodes = (g) => g?._nodes || g?.nodes || [];
const byId = (g, id) => { try { return g?.getNodeById?.(id) ?? g?.getNodeById?.(Number(id)) ?? graphNodes(g).find((n) => String(n.id) === String(id)) ?? null; } catch (_) { return null; } };
function subgraphNodeOf(sub, g = rootOf(), depth = 0) {
    if (!g || depth > 8) return null;
    for (const n of graphNodes(g)) {
        if (n.subgraph === sub) return n;
        if (n.subgraph) { const f = subgraphNodeOf(sub, n.subgraph, depth + 1); if (f) return f; }
    }
    return null;
}
function idOf(node, depth = 0) {
    if (!node) return "";
    const g = node.graph, root = rootOf();
    if (!g || g === root || depth > 8) return String(node.id);
    const holder = subgraphNodeOf(g);
    return holder ? `${idOf(holder, depth + 1)}:${node.id}` : String(node.id);
}
function nodeByExecId(execId, root = rootOf()) {
    const segs = String(execId ?? "").split(":");
    let g = root, n = null;
    for (let i = 0; i < segs.length; i++) {
        n = byId(g, segs[i]);
        if (!n) return null;
        if (i < segs.length - 1) g = n.subgraph;
    }
    return n;
}
function eachHold(cb, g = rootOf(), depth = 0) {
    if (!g || depth > 8) return;
    for (const n of graphNodes(g)) {
        if (isHold(n)) cb(n);
        if (n.subgraph) eachHold(cb, n.subgraph, depth + 1);
    }
}

// ---- finding things (the node instance can be replaced by undo / paste / subgraph moves at any time) ----
function stateForNode(node) {
    if (!node || node.id == null) return null;
    const nid = idOf(node);
    const exact = RUNS.get(runKey(nid, runIdOf(node)));
    if (exact) return exact;
    // Ctrl+Z can bring back the workflow's older hidden run_id while the Python node is still waiting. Old flames die hard.
    const graph = node.graph?.rootGraph || node.graph;
    const matches = [...RUNS.values()].filter((s) => s.nodeId === nid && (!s.ownerGraph || !graph || sameGraph(s.ownerGraph, graph)));
    return matches.length === 1 ? matches[0] : null;
}
function liveNodeOf(state) {
    const graphs = [state?.ownerGraph, app.graph, app.graph?.rootGraph];
    const seen = new Set();
    for (const graph of graphs) {
        if (!graph || seen.has(graph)) continue;
        seen.add(graph);
        try {
            const node = nodeByExecId(state.nodeId, graph);
            const graphMatches = !state.ownerGraph || sameGraph(state.ownerGraph, graph) || sameGraph(state.ownerGraph, node?.graph?.rootGraph || node?.graph);
            if (node && graphMatches && !REMOVED.has(node) && isHold(node)) return node;
        } catch (_) {}
    }
    return null;
}

// ---- run-state machine ----
function stopClock(state) {
    if (state?.timer) clearInterval(state.timer);
    if (state) state.timer = null;
}
function touch(node, state) {
    if (!node) return;
    if (state) HAD_RUN.add(node);
    notify(idOf(node));
    dirty(node);
}
function finishRun(state, text, tone, remove = true) {
    if (!state) return;
    stopClock(state);
    state.status = "finished";
    state.statusText = text;
    state.tone = tone;
    VIEWS.set(state.nodeId, { text, timer: "", tone, canAct: false });      // the verdict stays on screen after the run is forgotten
    touch(liveNodeOf(state), state);
    notify(state.nodeId);
    if (remove) RUNS.delete(state.key);
}
function clearRunsForNode(node, text, tone) {
    if (!node) return;
    const id = idOf(node);
    for (const state of [...RUNS.values()]) if (state.nodeId === id) finishRun(state, text, tone, true);
}
function resetWaitingNodes(text, tone) {
    for (const state of [...RUNS.values()]) finishRun(state, text, tone, true);
    try { eachHold((node) => { if (!HAD_RUN.has(node)) setView(idOf(node), text, tone); }); }
    catch (e) { warn("resetWaitingNodes", e); }
}
function startRun(node, timeoutSeconds, timeoutAction) {
    const runId = runIdOf(node);
    const nid = idOf(node);
    const key = runKey(nid, runId);
    stopClock(RUNS.get(key));
    const state = {
        key, nodeId: nid, runId, classType: classOf(node),
        ownerGraph: node.graph?.rootGraph || node.graph || null,
        deadline: Date.now() + timeoutSeconds * 1000,
        timeoutAction, status: "waiting", statusText: "", tone: "warn", timer: null,
    };
    RUNS.set(key, state);
    const tick = () => {
        if (state.status !== "waiting") return;
        if (Date.now() >= state.deadline) {
            state.status = "finished";
            state.statusText = timeoutAction === "continue" ? "CONTINUING" : "EXPIRED";
            state.tone = timeoutAction === "continue" ? "ok" : "danger";
            VIEWS.set(state.nodeId, { text: state.statusText, timer: "", tone: state.tone, canAct: false });
            stopClock(state);
        }
        touch(liveNodeOf(state), state);
        notify(state.nodeId);
    };
    state.timer = setInterval(tick, 1000);
    touch(node, state);
    return state;
}
// a (re)built node picks its run back up: run_id follows the LIVE state, the view follows the state
function attachRun(node) {
    const state = stateForNode(node);
    if (!state) return false;
    state.ownerGraph = node.graph?.rootGraph || node.graph || state.ownerGraph;
    const w = widget(node, nameOf(node, "runId"));
    if (w && w.value !== state.runId) w.value = state.runId;
    touch(node, state);
    return true;
}

// ---- what the node draws ----
function view(node) {
    const state = node ? stateForNode(node) : null;
    const inLoop = !!(node && LOOP.get(idOf(node)));
    const base = { label: inLoop ? "Resume loop" : "Continue", inLoop, runId: node ? runIdOf(node) : "" };
    if (state) {
        if (state.status === "waiting") {
            const remaining = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
            return { ...base, text: "WAITING FOR CHANGES", timer: `${remaining}s`, tone: "warn", canAct: true };
        }
        return { ...base, text: state.statusText || IDLE.text, timer: "", tone: state.tone || "mute", canAct: false };
    }
    return { ...base, ...(node && VIEWS.get(idOf(node)) || IDLE) };
}

// ---- backend ----
const post = (cfg, nodeId, action) => api.fetchApi(cfg.route, { method: "POST", body: JSON.stringify({ node_id: String(nodeId), action }) });

// ---- user actions (Continue / Stop) ----
async function act(node, action) {
    const cfg = cfgOf(node);
    if (!cfg) return false;
    if (!view(node).canAct) return false;                                   // buttons are dead unless a run is waiting
    let kind = action === "continue" ? "requeue" : "stop";
    // Inside a loop a requeue would restart the cycle from scratch: here we pick up right where we left off.
    if (kind === "requeue" && LOOP.get(idOf(node))) kind = "resume";
    try {
        const active = stateForNode(node);
        const actionNodeId = String(active?.nodeId ?? idOf(node));
        const doneText = kind === "requeue" ? "SAVING & RESTARTING" : kind === "resume" ? "RESUMING LOOP" : "STOPPING";
        const doneTone = kind === "stop" ? "danger" : "ok";
        if (active) { stopClock(active); active.status = "finished"; active.statusText = doneText; active.tone = doneTone; RUNS.delete(active.key); }
        setView(idOf(node), doneText, doneTone);

        if (kind === "requeue") {
            pendingAuto = true;                                              // the very next queuePrompt is OURS
            const w = widget(node, nameOf(node, "runId"));
            if (w) w.value = Date.now().toString() + "_continue";
            await app.queuePrompt();
            await post(cfg, actionNodeId, "stop");
        } else if (kind === "resume") {
            await post(cfg, actionNodeId, "continue");
        } else {
            await post(cfg, actionNodeId, "stop");
            setView(idOf(node), "STOPPED", "danger");
        }
        return true;
    } catch (e) {
        pendingAuto = false;
        warn("action failed", e);
        return false;
    }
}

// ---- global wiring (once) ----
function installGlobals() {
    if (app.__succyHoldV1) return;
    app.__succyHoldV1 = true;

    // Run pressed by a human: every old wait is over. Our own re-queue (Continue) passes through untouched.
    if (typeof app.queuePrompt === "function") {
        const orig = app.queuePrompt;
        const wrapped = async function () {
            const auto = pendingAuto;
            pendingAuto = false;
            if (!auto) {
                const nodes = []; eachHold((n) => nodes.push(n));
                const newRunId = Date.now().toString() + "_manual";
                const releases = [];
                const released = new Set();
                const release = (nodeId, cfg) => {
                    if (released.has(String(nodeId))) return;
                    released.add(String(nodeId));
                    releases.push(post(cfg, nodeId, "stop").catch((err) => warn("release failed", err)));
                };
                for (const state of [...RUNS.values()]) {
                    finishRun(state, "READY TO USE", "mute", true);
                    release(state.nodeId, CONFIGS.get(state.classType) || DEFAULTS);
                }
                for (const node of nodes) {
                    const w = widget(node, nameOf(node, "runId"));
                    if (w) w.value = newRunId;
                    setView(idOf(node), IDLE.text, IDLE.tone);
                    clearRunsForNode(node, "READY TO USE", "mute");
                    release(idOf(node), cfgOf(node));
                }
                if (releases.length) await Promise.allSettled(releases);
            }
            return orig.apply(this, arguments);
        };
        wrapped.__succyHoldV1 = true;
        app.queuePrompt = wrapped;
    }

    // executing: a hold node starts (or just transits)
    api.addEventListener("executing", (event) => {
        const nodeId = event.detail;
        if (!nodeId) { resetWaitingNodes("INTERRUPTED", "orange"); return; }
        const node = nodeByExecId(nodeId);
        if (!isHold(node)) return;
        const pauseW = widget(node, nameOf(node, "pause"));
        if ((pauseW && pauseW.value === false) || runIdOf(node).endsWith("_continue")) {
            clearRunsForNode(node, "TRANSIT COMPLETED", "ok");
            setView(idOf(node), "TRANSIT COMPLETED", "ok");
            return;
        }
        const sound = !!widget(node, nameOf(node, "sound"))?.value;
        for (const fn of [...LISTENERS.start]) { try { fn({ node, sound }); } catch (e) { warn("start listener", e); } }
        const timeout = safeNumber(widget(node, nameOf(node, "timeout"))?.value, 60);
        startRun(node, timeout, widget(node, nameOf(node, "onTimeout"))?.value ?? "continue");
    });
    api.addEventListener("execution_success", () => resetWaitingNodes("COMPLETED", "ok"));
    api.addEventListener("execution_error", () => resetWaitingNodes("INTERRUPTED", "orange"));
    for (const name of ["execution_interrupted", "interrupted"]) {
        try { api.addEventListener(name, () => resetWaitingNodes("INTERRUPTED", "orange")); } catch (_) { /* event not registered */ }
    }
}

let infoInstalled = new Set();
function installInfo(cfg) {
    if (infoInstalled.has(cfg.infoEvent)) return;
    infoInstalled.add(cfg.infoEvent);
    // Python tells us whether the node sits inside a loop: Continue becomes "Resume loop"
    api.addEventListener(cfg.infoEvent, (event) => {
        const d = event?.detail;
        if (!d || d.node_id == null) return;
        const node = nodeByExecId(d.node_id);
        if (!isHold(node)) return;
        LOOP.set(idOf(node), !!d.in_loop);
        notify(idOf(node));
    });
}

export const Hold = {
    version: VERSION,
    isHold,
    install(cfg = {}) {
        if (!cfg.classType) return false;
        if (!CONFIGS.has(cfg.classType)) CONFIGS.set(cfg.classType, { ...DEFAULTS, ...cfg, names: { ...DEFAULTS.names, ...(cfg.names || {}) } });
        installGlobals();
        installInfo(CONFIGS.get(cfg.classType));
        return true;
    },
    // a node instance was built / restored: pick up a live run or show "ready"
    attach(node) {
        if (!isHold(node)) return false;
        REMOVED.delete(node);
        if (!attachRun(node)) { VIEWS.set(idOf(node), { ...IDLE }); notify(idOf(node)); }
        return true;
    },
    detach(node) { if (node) REMOVED.add(node); },
    view,
    subscribe(node, fn) {
        const id = idOf(node);
        if (!SUBS.has(id)) SUBS.set(id, new Set());
        SUBS.get(id).add(fn);
        return () => { const s = SUBS.get(id); if (s) { s.delete(fn); if (!s.size) SUBS.delete(id); } };
    },
    act,
    on(event, fn) {
        const set = LISTENERS[event];
        if (!set) return () => {};
        set.add(fn);
        return () => set.delete(fn);
    },
    stats() {
        return { version: VERSION, classes: [...CONFIGS.keys()], runs: RUNS.size, waiting: [...RUNS.values()].filter((s) => s.status === "waiting").length, views: VIEWS.size, subs: SUBS.size, loop: [...LOOP.entries()].filter(([, v]) => v).map(([k]) => k) };
    },
};
