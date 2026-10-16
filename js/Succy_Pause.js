// ============================================================
// Succy_Pause.js — Succy Pause as GLUE, NodeStructure v0.3 (D-82)
// Stops the workflow in place until you press Continue or Stop (or the timeout runs out). This file contains ONLY: spec
// (catalog pieces), config and the little hooks that hide the real widgets. Zero DOM, zero CSS, zero timers.
//   the run-state machine (Run while it waits, Stop, interrupt, undo, Continue = requeue / Resume loop) ... SurvivalKit.hold
//   binding the node to it, status in cache ........................................................... `hold_node`
//   Continue / Stop ................................................................................... `release_graph`
//   the display ....................................................................................... `status_element`
//   coloured switches ................................................................................. `segmented_element` + tone
//   the ding .......................................................................................... `hold_node` ding (sound_system)
//   output type follows the input ..................................................................... `sync_output`
// Backend: Succy_Pause/Succy_Pause.py (untouched: months of battle scars live there too).
// Natives: the five real widgets stay real (Python validates them; run_id is the hidden run token) — only hidden.
// ============================================================
import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
import { NodeStructure } from "./NodeStructure/index.js";

const TYPE = "Succy_PauseExecution";
const NATIVES = ["pause_flow", "timeout_seconds", "on_timeout", "emit_sound", "run_id"];

/* ---------- spec ---------- */
export const SPEC = {
    v: 1,
    layout: { heightMode: "derived" },
    regions: [{
        id: "main", height: { auto: true, min: 60 },
        tree: { t: "group_box", id: "box", gap: 8, children: [
            { t: "segmented_element", id: "pauseSeg", bind: "$native.pause_flow", options: [
                { value: true, label: "Pause Workflow", tone: "warn" },
                { value: false, label: "Do Not Pause", tone: "ok" },
            ] },
            { t: "row_box", gap: 10, children: [
                { t: "stack_box", id: "toBox", gap: 3, style: { flex: "1 1 0" }, children: [
                    { t: "label_element", variant: "caption", text: "Timeout" },
                    { t: "stepper_element", id: "timeoutStep", bind: "$native.timeout_seconds", min: 1, max: 3600, step: 1, style: { flex: "none" } },
                ] },
                { t: "stack_box", id: "otBox", gap: 3, children: [
                    { t: "label_element", variant: "caption", text: "On Timeout" },
                    // two little squares: play = carry on, stop = kill the workflow
                    { t: "segmented_element", id: "onTimeout", class: "ns-seg-mini", bind: "$native.on_timeout", options: [
                        { value: "continue", label: "▶", tone: "ok" },
                        { value: "stop workflow", label: "■", tone: "danger" },
                    ] },
                ] },
            ] },
            { t: "segmented_element", id: "soundSeg", bind: "$native.emit_sound", options: [
                { value: true, label: "Sound Warning", tone: "info" },
                { value: false, label: "Mute", tone: "danger" },
            ] },
            { t: "status_element", id: "status", size: "l", label: "$cache.holdText", value: "$cache.holdTimer", tone: "$cache.holdTone", labelTone: "$cache.holdTone" },
            { t: "row_box", gap: 6, children: [
                { t: "button_element", id: "goBtn", class: "ns-btn-act ns-tone-ok", text: "{{$cache.holdLabel}}", disabled: "$cache.holdOff",
                    on: { click: { do: "$actions.release_graph", args: { do: "continue" } } } },
                { t: "button_element", id: "stopBtn", class: "ns-btn-act ns-tone-danger", text: "Stop", disabled: "$cache.holdOff",
                    on: { click: { do: "$actions.release_graph", args: { do: "stop" } } } },
            ] },
        ] },
    }],
    menus: {
        info: NodeStructure.infoMenu({
            title: "Succy Pause — hold that thought",
            about: "Stops the Queue right here and leaves everything after it tied up, waiting, until you press Continue, press Stop, or the timeout runs out. You're in control. What goes in comes out unchanged.",
            keys: [
                { keys: "Pause Workflow / Do Not Pause", does: "Do Not Pause turns the node into a plain wire: handy to keep it in place and switch it off." },
                { keys: "Timeout", does: "Seconds to wait (1–3600). When it runs out, the node decides by itself (see On Timeout)." },
                { keys: "On Timeout  ▶ / ■", does: "▶ = carry on after the timeout. ■ = stop the whole workflow." },
                { keys: "Sound Warning / Mute", does: "A ding when the workflow stops here, so you can go and make tea." },
                { keys: "Continue", does: "Lets the run go on past this node." },
                { keys: "Stop", does: "Ends the run here." },
            ],
            notes: [
                "ComfyUI's own Stop button works too, any time.",
                "Inside a Succy loop, it pauses at every turn and Continue resumes in place.",
                "While it waits the status shows the countdown; the buttons are only active when there is something to act on.",
            ],
        }),
    },
    behaviors: [
        { type: "info_node", menu: "info" },
        { type: "sync_output" },
        { type: "chip_input", input: "input" },
        { type: "chip_output", output: "output" },
        // the hold shield: run state, Run/Stop/Continue safety, ding. `ghost`: the hidden run_id widget leaves a socket behind.
        { type: "hold_node", ding: "/succy/pause/ding.mp3", ghost: "run_id" },
        { type: "gate_mask", region: "main" },
    ],
};

NodeStructure.define(TYPE, {
    minWidth: 280,
    defaultSize: [320, 250],
    natives: NATIVES,
    channels: ["heal", "undo", "redo"],
    order: ["ns_main"],
    state: {},
    spec: SPEC,
    hooks: {
        onSetup(api) { api.native.hide(NATIVES); },
        refreshFromNative(api) { api.native.hide(NATIVES); },
        onRestore(api) { api.native.hide(NATIVES); },
    },
});

void SurvivalKit;
