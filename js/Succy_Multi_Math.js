// ============================================================
// Succy_Multi_Math.js — Multi Math as GLUE, NodeStructure v0.3 (D-70..72)
// Up to 15 chained equations over inputs a..j. This file contains ONLY: spec (catalog pieces), config, state schema
// and the little `live` recipes that feed them. Zero DOM, zero CSS, zero timers: she's got the kit for that.
//   inputs that open one after the other ........ `grow_input` (D-70, never shifts when you unplug)
//   @tokens in the formulas ...................... `editor_element`, names live: equation labels / source names (D-71)
//   outputs r1..rN (count follows the stepper) .. `shape_output` count variant, wire = rN, shown name = the label
//   debug pane + copy ............................ `pane_box` + `copy_system`, same toys as Preview
//   the maths .................................... Succy_Multi_Math/Succy_Multi_Math.py (AST evaluator, no eval: D-72)
// Natives: num_equations + `ops` are real hidden widgets; label_i / equation_i / format_ri are packed into `ops` (JSON): the Python reads that.
// ============================================================
import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
import { NodeStructure } from "./NodeStructure/index.js";

const TYPE = "Succy_Multi_Math";
const MAX_EQ = 15;
const INPUTS = "abcdefghij".split("");
const FORMATS = ["FLOAT", "INT", "STRING", "BOOL"];
const SOCKET = { FLOAT: "FLOAT", INT: "INT", STRING: "STRING", BOOL: "BOOLEAN" };      // BOOL travels as BOOLEAN
const EQS = Array.from({ length: MAX_EQ }, (_, k) => k + 1);
// Real hidden widgets: two. Labels, equations and formats are virtual natives packed as JSON into `ops` by the builder
// (`packed`, NodeStructure/core/packed.js, D-79): fewer widgets = no create / clone / load lag. Less is more, sweetheart.
const PACK = "ops";
const NATIVES = ["num_equations", PACK];
const VDEF = Object.fromEntries(EQS.flatMap((i) => [[`label_${i}`, `Equation ${i}`], [`equation_${i}`, ""], [`format_r${i}`, "INT"]]));

/* ---------- glue: read the hidden widgets ---------- */
const count = (api) => Math.max(1, Math.min(MAX_EQ, Math.floor(Number(api.native.get("num_equations")) || 1)));
const fmtOf = (api, i) => String(api.native.get(`format_r${i}`) || "INT").toUpperCase();
const eqLabel = (api, i) => String(api.native.get(`label_${i}`) ?? "").trim() || `Equation ${i}`;
const sockLabel = (api, i) => String(api.native.get(`label_${i}`) ?? "").replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 18) || `r${i}`;

// Tokens offered after "@" in equation i: the inputs that exist (named after whoever feeds them) + the equations ABOVE it.
// Two sources with the same name get their letter appended, so "seed (a)" and "seed (b)" stay tellable apart.
function tokens(api, i) {
    const who = api.cache.get("inNames") || {};
    const present = new Set((api.node.inputs || []).map((x) => x.name));
    const out = INPUTS.filter((n) => present.has(n)).map((n) => ({
        key: n, label: who[n]?.name || `Input ${n.toUpperCase()}`,
        hint: who[n]?.from ? `${n.toUpperCase()} ← ${who[n].from}` : `Input ${n.toUpperCase()} (nobody plugged in yet)`,
    }));
    for (let k = 1; k < i; k++) out.push({ key: `r${k}`, label: eqLabel(api, k), hint: `r${k} · ${fmtOf(api, k)}` });
    const seen = {};
    out.forEach((t) => { seen[t.label] = (seen[t.label] || 0) + 1; });
    out.forEach((t) => { if (seen[t.label] > 1) t.label = `${t.label} (${t.key})`; });
    return out;
}

const live = {
    // outputs: wire name rN (stable, so renaming a label never unplugs anything), shown name = the label
    outs: (api) => EQS.slice(0, count(api)).map((i) => [`r${i}`, SOCKET[fmtOf(api, i)] || "*", sockLabel(api, i)]),
    view: (api) => { const t = api.state.get("last"); return { mode: t ? "text" : "empty", text: t || "", src: "", info: "" }; },
    ...Object.fromEntries(EQS.flatMap((i) => [
        [`eqOn${i}`, (api) => i <= count(api)],
        [`tok${i}`, (api) => tokens(api, i)],
    ])),
};

/* ---------- spec ---------- */
// ONE region, everything inside separated by FIXED separators (no spacing between widgets that can stretch, Preview-style):
// the region is measured from its content, so the node hugs it exactly: debug off / collapsed = the node shrinks to fit.
// The debug pane is an element INSIDE the region and `resize_element` stretches only itself: the grey gaps stay put.
const SEP = 6;
const eqBlock = (i) => ({
    t: "stack_box", id: `eqw${i}`, gap: 0, visible: `$live.eqOn${i}`, children: [
        { t: "separator_element", size: SEP },
        { t: "group_box", id: `eq${i}`, variant: "inset", children: [
            { t: "row_box", children: [
                { t: "badge_element", text: `r${i}`, tone: "accent" },
                { t: "input_element", id: `lbl${i}`, bind: `$native.label_${i}`, placeholder: `Equation ${i}` },
                { t: "select_element", id: `fmt${i}`, class: "ns-sel-out", bind: `$native.format_r${i}`, options: FORMATS.map((v) => ({ value: v, label: v })) },
            ] },
            { t: "editor_element", id: `ed${i}`, bind: `$native.equation_${i}`, tokens: `$live.tok${i}`, placeholder: "Type @ to insert a variable...", modalTitle: `Equation ${i}` },
        ] },
    ],
});

export const SPEC = {
    v: 1,
    layout: { heightMode: "derived" },
    regions: [
        {
            id: "main", height: { auto: true, min: 40 },
            tree: { t: "stack_box", id: "root", gap: 0, children: [
                { t: "group_box", id: "headBox", children: [
                    { t: "row_box", class: "ns-wrap", children: [
                        { t: "label_element", text: "Equations" },
                        { t: "stepper_element", id: "numStep", bind: "$native.num_equations", min: 1, max: MAX_EQ },
                        { t: "spacer_element" },
                        // Debug stays awake while folded (D-96): fold the work, keep the peephole — the pane still opens below
                        { t: "label_element", text: "Debug" },
                        { t: "segmented_element", id: "dbgSeg", bind: "$state.debug", options: [{ value: false, label: "Off", tone: "danger" }, { value: true, label: "On", tone: "ok" }] },
                        // yellow "Collapse" while open, blue "Expand" while folded (collapse_box writes text and class)
                        { t: "button_element", id: "colBtn", text: "▾ Collapse", class: "ns-on" },
                    ] },
                ] },
                { t: "stack_box", id: "eqRoot", gap: 0, children: EQS.map(eqBlock) },
                { t: "stack_box", id: "dbgWrap", gap: 0, class: "ns-relative", visible: "$state.debug", children: [
                    { t: "separator_element", size: SEP },
                    { t: "pane_box", id: "pane", style: { height: "110px" },
                        mode: "$live.view.mode", text: "$live.view.text", src: "$live.view.src", info: "$live.view.info",
                        children: [
                            { t: "button_element", id: "copyBtn", text: "{{$cache.copyFlash}}", glyph: "⧉", title: "Copy to clipboard", attrs: { "data-ns-for": "text" },
                                on: { click: { do: "$actions.copy_system", args: { kind: "$live.view.mode", text: "$live.view.text", flash: "copyFlash" } } } },
                        ] },
                ] },
            ] },
        },
    ],
    menus: {
        info: NodeStructure.infoMenu({
            title: "Succy Multi Math — a pocket calculator, chained",
            about: "Up to 15 equations over the inputs a..j (the next input appears when you plug the previous one). Each equation is its own output (r1, r2…), and each can use the ones above it: results build on each other, one climax after another. A broken formula gives 0 and a red line in Debug: it never kills the Queue, it just sulks.",
            keys: [
                { keys: "@", does: "Type @ in a formula to insert an input or an earlier result by name." },
                { keys: "+ − * / // % ^", does: "Add, subtract, multiply, divide, whole-number divide, remainder, power." },
                { keys: "< <= > >= == != and or not", does: "Comparisons and logic give 1 (true) or 0 (false)." },
                { keys: "a if c else b  ·  ifelse(c,a,b)", does: "Choose between two values." },
                { keys: "min max abs round clamp lerp avg sign factorial", does: "Handy helpers. round() goes half UP: 2.5 → 3." },
                { keys: "sqrt sin cos tan log exp floor ceil …", does: "Everything from Python's math module, plus pi, e, tau." },
                { keys: "FLOAT · INT · STRING · BOOL", does: "The format of each output. INT rounds half up; BOOL is false only for 0." },
            ],
            notes: [
                "The name you type in the small box becomes the output's name, but the wire stays r1..rN: renaming never unplugs anything.",
                "Equations: the stepper sets how many; the outputs follow.",
                "Debug On shows every formula with its values filled in and the result. Collapse folds the equations away.",
                "No eval: formulas are parsed by a tiny safe interpreter, so sharing a workflow is safe.",
            ],
        }),
    },
    behaviors: [
        { type: "info_node", menu: "info" },
        // sockets: a..j open one by one, nothing shifts when you unplug (D-70). Must run BEFORE the chips look for their sockets.
        { type: "grow_input", names: INPUTS, min: 2, slotType: "*", cacheKey: "inNames" },
        ...INPUTS.map((n) => ({ type: "chip_input", input: n, types: ["INT", "FLOAT", "BOOLEAN", "*"] })),
        // outputs = number of equations; wire r1..rN stays put, the shown name follows the label (live)
        { type: "shape_output", outputs: "$live.outs" },
        ...EQS.map((i) => ({ type: "chip_output", output: `r${i}` })),
        { type: "collapse_box", state: "collapsed", trigger: "colBtn", hide: ["eqRoot"], glyphs: ["▾ Collapse", "▸ Expand"], target: "colBtn", rootClass: "ns-cool" },
        // the debug pane stretches ITSELF (its own height in state), never the gaps around it
        { type: "resize_element", container: "dbgWrap", target: "pane", mode: "element", state: "dbgHeight", min: 60, max: 600 },
        { type: "gate_mask", region: "main" },
    ],
};

NodeStructure.define(TYPE, {
    minWidth: 380,                    // D-92: measured live — the header row (Equations/Debug/Collapse) wraps below 372, +8 px of margin for other fonts
    defaultSize: [390, 240],
    natives: NATIVES,
    packed: { widget: PACK, defaults: VDEF },
    channels: ["heal", "undo", "redo"],
    order: ["ns_main"],
    state: {
        collapsed: { policy: "immediate", default: false },
        debug:     { policy: "immediate", default: false },
        last:      { policy: "on-execute" },            // last debug text from the Python
        dbgHeight: { policy: "ui" },
    },
    spec: SPEC, live,
    hooks: {
        onSetup(api) { api.native.hide(NATIVES); },
        refreshFromNative(api) { api.native.hide(NATIVES); },
        onRestore(api) { api.native.hide(NATIVES); },
        onExecute(api, message) {
            const t = message?.text;
            if (Array.isArray(t) && t.length) api.state.set("last", String(t[0] ?? "").slice(0, 20000));
        },
    },
});

void SurvivalKit;
