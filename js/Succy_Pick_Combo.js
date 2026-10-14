// ============================================================
// Succy_Pick_Combo.js — multi-column "Pick Combo", NodeStructure v0.3 (glue, D-67)
// Rows x columns table: you pick ONE row, each column comes out of its own socket (cmb1..cmbN) in its own format,
// plus index / label / all. This file contains ONLY: spec (catalog pieces), config, state schema and the
// outputs JSON. Table (typing, pasting, column editor, widening to the right): `table_box`.
// Outputs that change in number with the columns: `shape_output` count variant (wires follow the name).
// The table data lives in the hidden `table` widget (JSON), so the Python can read it.
// ============================================================
import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
import { NodeStructure } from "./NodeStructure/index.js";

const TYPE = "Succy_Pick_Combo";
const MAX_ROWS = 20, MAX_COLS = 8;
const FORMATS = ["STRING", "INT", "FLOAT", "BOOLEAN", "LIST", "DICT", "ARRAY", "JSON", "COMBO"];
const SOCKET = { STRING: "STRING", INT: "INT", FLOAT: "FLOAT", BOOLEAN: "BOOLEAN" };      // other formats -> "*"
const NATIVES = ["num_options", "num_values", "selected_index", "use_choice", "choice", "table"];

/* ---------- glue: table data (read-only) ---------- */
let _tc = { raw: null, val: null };
function table(api) {
    const raw = api.native.get("table");
    if (raw === _tc.raw) return _tc.val;
    let v = null; try { v = raw ? JSON.parse(raw) : null; } catch (_) { v = null; }
    _tc = { raw, val: v };
    return v;
}
const count = (api, name, max) => Math.max(1, Math.min(max, Math.floor(Number(api.native.get(name)) || 1)));
const labels = (api) => Array.from({ length: count(api, "num_options", MAX_ROWS) }, (_, i) => { const r = table(api)?.rows?.[i]; return Array.isArray(r) ? String(r[0] ?? "") : `Option ${i + 1}`; });

const live = {
    rowOptions: (api) => labels(api).map((l, i) => ({ value: i, label: `${i} · ${l || "(empty)"}` })),
    labelList: (api) => labels(api),
    // outputs: cmb1..cmbN (type from the column format, SHOWN name = the column label, D-90; the wire keeps cmbN) + index / label / all
    outs: (api) => [
        ...Array.from({ length: count(api, "num_values", MAX_COLS) }, (_, i) => [`cmb${i + 1}`, SOCKET[String(table(api)?.fmt?.[i] ?? "STRING").toUpperCase()] || "*", String(table(api)?.names?.[i] || "").trim() || `cmb${i + 1}`]),
        ["index", "INT"], ["label", "STRING"], ["all", "STRING"],
    ],
};

/* ---------- spec ---------- */
export const SPEC = {
    v: 1,
    layout: { heightMode: "derived" },
    regions: [
        {
            id: "head", height: { auto: true, min: 60 },
            tree: { t: "group_box", id: "headBox", children: [
                // ns-wrap: on a narrow node the Minimize button slides onto its own line instead of spilling out
                { t: "row_box", class: "ns-wrap", children: [
                    { t: "label_element", text: "Rows" },
                    { t: "stepper_element", id: "rowsStep", bind: "$native.num_options", min: 1, max: MAX_ROWS },
                    { t: "label_element", text: "Columns" },
                    { t: "stepper_element", id: "colsStep", bind: "$native.num_values", min: 1, max: MAX_COLS },
                    { t: "spacer_element" },
                    // collapse trigger: yellow "Minimize" while open, blue "Expand" while folded (collapse_box writes the text and the class)
                    { t: "button_element", id: "colBtn", text: "▾ Minimize", class: "ns-on" },
                ] },
                { t: "row_box", children: [
                    { t: "label_element", text: "Use" },
                    { t: "select_element", id: "pick", bind: "$native.selected_index", options: "$live.rowOptions", disabled: "$native.use_choice" },
                    // EXT lights up yellow when on, Succy_X style: one click and she takes orders from outside
                    { t: "button_element", id: "extBtn", text: "EXT", classIf: { "ns-on": "$native.use_choice" }, on: { click: { do: "$actions.flip_node", args: { native: "use_choice" } } } },
                ] },
                // EXT door (D-86): Widget = the native "choice" dropdown below, Chip = a real socket with a chip. Selected = blue, the other waits its turn.
                // ns-op = operative, not essential: folded (Minimize) hides it, Expand brings it back (D-89)
                { t: "segmented_element", id: "extMode", class: "ns-op", bind: "$state.extMode", visible: "$native.use_choice",
                    options: [{ value: "widget", label: "Widget", tone: "info" }, { value: "chip", label: "Chip", tone: "info" }] },
                { t: "label_element", variant: "hint", class: "ns-op", text: "EXT: the row is chosen by name. Widget = the “choice” dropdown below (hang a reroute on it to wire it). Chip = a real input: pick the source from the chip.", visible: "$native.use_choice" },
            ] },
        },
        {
            id: "table", height: { auto: true, min: 40 },
            tree: { t: "group_box", id: "tableBox", variant: "inset", children: [
                { t: "table_box", id: "grid", data: "$native.table", rows: "$native.num_options", cols: "$native.num_values", selected: "$native.selected_index",
                    maxRows: MAX_ROWS, maxCols: MAX_COLS, formats: FORMATS, colName: "cmb", labelName: "Label" },
            ] },
        },
    ],
    behaviors: [
        { type: "collapse_box", state: "collapsed", trigger: "colBtn", hide: ["region:table"], glyphs: ["▾ Minimize", "▸ Expand"], target: "colBtn", rootClass: "ns-cool" },
        // EXT (D-86): flag on -> Widget door shows "choice", Chip door shows the real socket "choice_in" (dressed by the chip below)
        { type: "ext_node", when: "$native.use_choice", mode: "$state.extMode", natives: ["choice"], sockets: [{ name: "choice_in", type: "STRING" }] },
        { type: "chip_input", input: "choice_in", label: "choice" },
        // outputs = number of columns (D-67): the index/label/all wires follow their socket when it changes place
        { type: "shape_output", outputs: "$live.outs", combo: "choice", comboValues: "$live.labelList" },
        // chip selectors (D-62/64): one line per socket
        ...Array.from({ length: MAX_COLS }, (_, i) => ({ type: "chip_output", output: `cmb${i + 1}` })),
        { type: "chip_output", output: "index" },
        { type: "chip_output", output: "label" },
        { type: "chip_output", output: "all" },
    ],
};

NodeStructure.define(TYPE, {
    minWidth: 392,                    // D-92: measured live — the Rows/Columns/Minimize row wraps below 383 (same with EXT + Widget/Chip switch), +9 px of margin
    defaultSize: [400, 200],
    natives: NATIVES,
    channels: ["heal", "undo", "redo"],
    order: ["ns_head", "choice", "ns_table"],
    state: {
        collapsed: { policy: "immediate", default: false },
        extMode: { policy: "immediate", default: "chip" },        // D-91: the chip door is the pack's flagship, so she opens it first
    },
    spec: SPEC, live,
    hooks: {
        onSetup(api) { api.native.hide(NATIVES.filter((n) => n !== "choice")); },
        refreshFromNative(api) { api.native.hide(NATIVES.filter((n) => n !== "choice")); },
        onRestore(api) { api.native.hide(NATIVES.filter((n) => n !== "choice")); },
    },
});

void SurvivalKit;
