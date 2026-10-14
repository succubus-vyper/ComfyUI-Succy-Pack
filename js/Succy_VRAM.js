// ============================================================
// Succy_VRAM.js — Succy Clean VRAM as GLUE, NodeStructure v0.3 (D-82)
// Passes anything through while it empties your VRAM: soft (cache), hard (unload every model), nuke (and then some).
// This file contains ONLY: spec (catalog pieces), config, state schema and the hooks. Zero DOM, zero CSS, zero timers.
//   mode / threshold ............ `segmented_element` (per-option tone: soft blue, hard amber, nuke red) + `stepper_element`
//   live reading + bar .......... `status_element` fed by `vram_system` (ONE shared poller for every VRAM node, D-82)
//   output type follows input ... `sync_output`
// Backend: Succy_Utils/Succy_VRAM.py (also serves /succy/vram/stats). Natives stay real widgets (Python validates the combo).
// ============================================================
import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
import { NodeStructure } from "./NodeStructure/index.js";

const TYPE = "Succy_CleanVram";
const NATIVES = ["min_free_vram_gb", "clean_mode"];

/* ---------- spec ---------- */
export const SPEC = {
    v: 1,
    layout: { heightMode: "derived" },
    regions: [{
        id: "main", height: { auto: true, min: 60 },
        tree: { t: "group_box", id: "box", gap: 8, children: [
            { t: "segmented_element", id: "modeSeg", bind: "$native.clean_mode", options: [
                { value: "soft", label: "Soft", tone: "info" },
                { value: "hard", label: "Hard", tone: "warn" },
                { value: "nuke", label: "NUKE", tone: "danger", fx: true },
            ] },
            { t: "row_box", gap: 6, children: [
                { t: "label_element", text: "Min Free (GB)" },
                { t: "stepper_element", id: "minStep", bind: "$native.min_free_vram_gb", min: 0, max: 128, step: 0.1, int: false },
            ] },
            { t: "status_element", id: "meter", size: "m", label: "$live.vram_system.label", value: "$live.vram_system.value",
                bar: "$live.vram_system.bar", tone: "$live.vram_system.tone", labelTone: "$live.vram_system.labelTone" },
            { t: "label_element", variant: "hint", text: "{{$state.last}}", visible: "$state.last" },
        ] },
    }],
    behaviors: [
        { type: "feed_system", name: "vram_system" },
        { type: "sync_output" },
        { type: "chip_input", input: "any_input" },
        { type: "chip_output", output: "any_output" },
        { type: "chip_output", output: "status_report" },
        { type: "gate_mask", region: "main" },
    ],
};

NodeStructure.define(TYPE, {
    minWidth: 280,
    defaultSize: [300, 230],
    natives: NATIVES,
    channels: ["heal", "undo", "redo"],
    order: ["ns_main"],
    state: {
        last: { policy: "on-execute" },          // one-line verdict of the last clean, from the Python
    },
    spec: SPEC,
    hooks: {
        onSetup(api) { api.native.hide(NATIVES); },
        refreshFromNative(api) { api.native.hide(NATIVES); },
        onRestore(api) { api.native.hide(NATIVES); },
        onExecute(api, message) {
            const t = message?.vram_report;
            if (Array.isArray(t) && t.length) api.state.set("last", String(t[0] ?? "").slice(0, 200));
        },
    },
});

void SurvivalKit;
