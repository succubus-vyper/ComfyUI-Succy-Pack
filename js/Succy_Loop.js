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

const display = (name, icon, accent, reverse = false) => ({ t: "progress_element", id: "display", name, icon, data: `${L}.view`, fx: { accent, reverse } });
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
        ...chipsIn(["state", "initial_iteration_value", { input: "iterations_override", label: "iterations", types: ["INT"] }]),
        ...chipsOut(["flow", "iteration_index", "is_first", "is_last", "list_item", "current_iteration_value"]),
    ]),
    Succy_LoopEnd: spec([
        display("Loop End", "⟲", "#ffb84d", true),
        { t: "label_element", variant: "caption", text: "Accumulate outputs" },
        { t: "segmented_element", id: "accSeg", bind: "$native.accumulate", options: [
            { value: true, label: "ON · batch all", tone: "warn" },
            { value: false, label: "OFF · last only", tone: "info" },
        ] },
    ], [
        { type: "sync_output", input: "output_value", output: "outputs" },       // `outputs` takes the type of whatever feeds output_value (image in, image out; string in, string out; anything in, same out)
        ...chipsIn(["flow", "output_value", "next_iteration_value"]),
        ...chipsOut(["outputs"]),
    ]),
    Succy_WhileStart: spec([display("While Start", "⟳", "#b794ff")], [
        ...chipsIn(["state", ...V5.map((i) => `initial_value${i}`)]),
        ...chipsOut(["flow", ...V5.map((i) => `value${i}`)]),
    ]),
    Succy_WhileEnd: spec([display("While End", "⟲", "#ff7ab8", true)], [
        ...chipsIn(["flow", "condition", ...V5.map((i) => `initial_value${i}`)]),
        ...chipsOut(V5.map((i) => `value${i}`)),
    ]),
};

// the (i) texts (D-121): one per node, the kit does the rest
const INFO = {
    Succy_LoopStart: {
        title: "Succy Loop Start — round and round",
        about: "Opens a loop: everything between Loop Start and Loop End goes again and again, harder every turn, until the last round has had its fill. Wire flow into Loop End.",
        keys: [
            { keys: "Simple", does: "N turns, one after the other. iteration_index counts 0, 1, 2…" },
            { keys: "For", does: "Same count; use iteration_index to drive your own maths." },
            { keys: "List", does: "One turn per item of the list you give in initial_iteration_value. list_item is the current item and the turns follow the list length." },
            { keys: "Ping-pong", does: "Up and back: 0, 1, 2, 1, 0… With N = 4 the loop makes 2N − 2 = 6 turns; list_item is the position." },
            { keys: "Grid", does: "Walks a square-ish grid; list_item is the pair (column, row)." },
            { keys: "Iterations", does: "How many turns (1–99999). In List mode the list decides." },
            { keys: "EXT", does: "Take the iterations from outside. Widget: the box stays, you can wire it. Chip: a real input (iterations_override) that wins over the box." },
        ],
        notes: [
            "Outputs: flow (to Loop End) · iteration_index · is_first · is_last · list_item · current_iteration_value (what the last turn handed on, or initial_iteration_value on the first).",
            "Loop End's next_iteration_value (or its output_value) becomes the next turn's current_iteration_value: that's how a result travels round.",
            "The ring on the node shows where the loop is.",
        ],
    },
    Succy_LoopEnd: {
        title: "Succy Loop End — and back again",
        about: "Closes the loop opened by Loop Start: hand it the result of the turn and it sends you back for more, until the very last turn. Then it delivers. Worth the wait.",
        keys: [
            { keys: "output_value", does: "The result of this turn." },
            { keys: "next_iteration_value", does: "Optional: what the next turn should receive. If empty, output_value is carried on." },
            { keys: "outputs type", does: "Follows whatever you plug into output_value: image in, image out; text in, text out; any custom type in, the same type out. Nothing plugged = any." },
            { keys: "Accumulate ON (default)", does: "At the end you get ALL the results, batched (images and masks become a batch, other types a list)." },
            { keys: "Accumulate OFF", does: "At the end you get only the last turn's result." },
        ],
        notes: ["Wire flow from Loop Start. The outputs socket only delivers once the last turn is done."],
    },
    Succy_WhileStart: {
        title: "Succy While Start — as long as it holds",
        about: "Opens a while loop: it keeps going until the condition at While End says enough. Up to five values get passed around meanwhile. Nobody's counting.",
        keys: [
            { keys: "initial_value0…4", does: "Starting values (plug only the ones you need). On later turns they are replaced by what While End hands back." },
            { keys: "value0…4", does: "The values for THIS turn, to use inside the loop." },
        ],
        notes: ["Wire flow into While End.", "Safety: after 4096 turns the loop stops with an error, so a condition that never ends can't hang your Queue."],
    },
    Succy_WhileEnd: {
        title: "Succy While End — until you say stop",
        about: "Closes the while loop. Condition true: it goes round again, carrying the new values. Condition false: it finishes and delivers them. Know when to stop.",
        keys: [
            { keys: "condition", does: "True = another turn. False = done. It needs a BOOLEAN wired in." },
            { keys: "initial_value0…4", does: "The new values at the end of the turn: they become value0…4 of the next turn, and the final outputs when it stops." },
        ],
        notes: ["Wire flow from While Start.", "Build the condition with Multi Math (a comparison gives true / false) or any BOOLEAN."],
    },
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
        spec: { ...SPECS[type], menus: { info: NodeStructure.infoMenu(INFO[type]) }, behaviors: [...SPECS[type].behaviors, { type: "info_node", menu: "info" }] },
        hooks: { onSetup: hide, refreshFromNative: hide, onRestore: hide },
    });
}

void SurvivalKit;
