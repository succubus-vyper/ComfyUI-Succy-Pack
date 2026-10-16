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
    menus: {
        info: NodeStructure.infoMenu({
            title: "Succy Clean VRAM — make some room",
            about: "Drop it in the middle of a chain: your data passes through untouched, while I strip your GPU memory bare so the next heavy node has room to move. It runs on every Queue, never skipped by the cache: I never say no.",
            keys: [
                { keys: "Soft", does: "Light touch: runs garbage collection and empties the CUDA cache. Models stay loaded, so nothing needs reloading afterwards." },
                { keys: "Hard", does: "Soft, plus it unloads ALL models from VRAM. The next node that needs a model loads it again (slower, but VRAM really is free)." },
                { keys: "NUKE", does: "Hard, plus a deep cleanup of whatever the models left behind. For stubborn leftovers from huge transformer models." },
                { keys: "Min Free (GB)", does: "Cleans only if free VRAM is BELOW this number. Enough room already = skipped, models stay put. 0 = clean every single time." },
                { keys: "Meter", does: "Live free / used / total VRAM of your GPU." },
            ],
            notes: [
                "Outputs: any_output = whatever you plugged in, unchanged; status_report = a text of what was done and how many GB it freed (or why it was skipped).",
                "Tip: put it right after a heavy step (a big sampler, a VAE decode) and before the next one.",
            ],
        }),
    },
    behaviors: [
        { type: "info_node", menu: "info" },
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
