// ============================================================
// Succy_Loop.js — Succy Loop Start / End + While Start / End as GLUE, NodeStructure v0.3 (D-101, D-102)
// For loops (simple, for, list, ping-pong, grid) and while loops built on the dynamic graph. Round and round she goes.
// This file contains ONLY: spec (catalog pieces), config and the hooks that hide the real widgets. Zero DOM, zero CSS, zero timers.
//   the animated display (ring, cells, slots, condition) ........ `progress_element` (look = fx JSON) fed by `loop_system`
//   mode / iterations / accumulate .............................. `segmented_element` + `stepper_element` on the real widgets
//   iterations from outside ..................................... `ext_node`: Widget = native num_iterations, Chip = iterations_override
//   every input and output ...................................... `chip_input` / `chip_output`
// Backend: Succy_Loop/Succy_Loop.py (untouched: the GraphBuilder expansion and the FLOW_CONTROL state live there).
// Natives: mode, num_iterations, accumulate stay real widgets (Python validates them) — only hidden.
// ============================================================
import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
import { NodeStructure } from "./NodeStructure/index.js";

const L = "$live.loop_system";
const V5 = [0, 1, 2, 3, 4];

const display = (name, icon, accent) => ({ t: "progress_element", id: "display", name, icon, data: `${L}.view`, fx: { accent } });
const chipsIn = (names) => names.map((n) => (typeof n === "string" ? { type: "chip_input", input: n } : { type: "chip_input", ...n }));
const chipsOut = (names) => names.map((n) => ({ type: "chip_output", output: n }));

const spec = (children, behaviors = []) => ({
    v: 1,
    layout: { heightMode: "derived" },
    regions: [{ id: "main", height: { auto: true, min: 60 }, tree: { t: "group_box", id: "box", gap: 8, children } }],
    behaviors: [
        { type: "feed_system", name: "loop_system" },
        { type: "gate_mask", region: "main" },
        ...behaviors,
    ],
});

export const SPECS = {
    Succy_LoopStart: spec([
        display("Loop Start", "↻", "#7cbcff"),
        { t: "label_element", variant: "caption", text: "Mode" },
        { t: "segmented_element", id: "modeSeg", bind: "$native.mode", options: [
            { value: "simple", label: "↻ Simple" },
            { value: "for", label: "➜ For" },
            { value: "list", label: "☰ List" },
            { value: "ping-pong", label: "⇄ Ping" },
            { value: "grid", label: "▦ Grid" },
        ] },
        { t: "row_box", gap: 6, children: [
            { t: "label_element", text: "Iterations" },
            { t: "stepper_element", id: "iterStep", bind: "$native.num_iterations", min: 1, max: 99999, step: 1, disabled: `${L}.lock` },
            { t: "button_element", id: "extBtn", text: "EXT", title: "Iterations from outside", classIf: { "ns-on": "$state.extOpen" },
                on: { click: { do: "$actions.flip_node", args: { key: "extOpen" } } } },
        ] },
        // EXT door (D-86): Widget = the native num_iterations, Chip = the real socket iterations_override with its chip
        { t: "segmented_element", id: "extMode", bind: "$state.extMode", visible: "$state.extOpen",
            options: [{ value: "widget", label: "Widget", tone: "info" }, { value: "chip", label: "Chip", tone: "info" }] },
    ], [
        { type: "ext_node", when: "$state.extOpen", mode: "$state.extMode", natives: ["num_iterations"], sockets: [{ name: "iterations_override", type: "INT" }] },
        ...chipsIn(["state", "initial_iteration_value", { input: "iterations_override", label: "iterations" }]),
        ...chipsOut(["flow", "iteration_index", "is_first", "is_last", "list_item", "current_iteration_value"]),
    ]),
    Succy_LoopEnd: spec([
        display("Loop End", "⟲", "#ffb84d"),
        { t: "label_element", variant: "caption", text: "Accumulate outputs" },
        { t: "segmented_element", id: "accSeg", bind: "$native.accumulate", options: [
            { value: false, label: "OFF · last only", tone: "info" },
            { value: true, label: "ON · batch all", tone: "warn" },
        ] },
    ], [
        ...chipsIn(["flow", "output_value", "next_iteration_value"]),
        ...chipsOut(["outputs"]),
    ]),
    Succy_WhileStart: spec([display("While Start", "⟳", "#b794ff")], [
        ...chipsIn(["state", ...V5.map((i) => `initial_value${i}`)]),
        ...chipsOut(["flow", ...V5.map((i) => `value${i}`)]),
    ]),
    Succy_WhileEnd: spec([display("While End", "⟳", "#ff7ab8")], [
        ...chipsIn(["flow", "condition", ...V5.map((i) => `initial_value${i}`)]),
        ...chipsOut(V5.map((i) => `value${i}`)),
    ]),
};

const DEFS = {
    Succy_LoopStart:  { role: "start",  natives: ["mode", "num_iterations"], size: [340, 330] },
    Succy_LoopEnd:    { role: "end",    natives: ["accumulate"],             size: [340, 260] },
    Succy_WhileStart: { role: "wstart", natives: [],                         size: [340, 250] },
    Succy_WhileEnd:   { role: "wend",   natives: [],                         size: [340, 250] },
};

for (const [type, d] of Object.entries(DEFS)) {
    const start = d.role === "start";
    // Start: EXT decides whether num_iterations shows (ext_node), so the hooks only hide `mode`
    const hidden = start ? ["mode"] : d.natives;
    const hide = (api) => { if (hidden.length) api.native.hide(hidden); };
    NodeStructure.define(type, {
        minWidth: 320,
        defaultSize: d.size,
        natives: d.natives,
        channels: ["heal", "undo", "redo"],
        order: ["ns_main"],
        state: start ? {
            extOpen: { policy: "immediate", default: false },
            extMode: { policy: "immediate", default: "chip" },        // D-91: every EXT node starts in Chip mode
        } : {},
        config: { loop_system: start ? { role: d.role, ext: "extOpen" } : { role: d.role } },
        spec: SPECS[type],
        hooks: { onSetup: hide, refreshFromNative: hide, onRestore: hide },
    });
}

void SurvivalKit;
