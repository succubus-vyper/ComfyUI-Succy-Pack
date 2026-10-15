// ============================================================
// Succy_Multi_Parse.js — Multi Parse as GLUE, NodeStructure v0.3 (D-78)
// Up to 15 chained text operations over inputs a..j. This file contains ONLY: spec (catalog pieces), config, state schema
// and the little `live` recipes that feed them. Zero DOM, zero CSS, zero timers: she's got the kit for that.
//   inputs that open one after the other ........ `grow_input` (never shifts when you unplug)
//   @tokens in the fields ........................ `editor_element`, names live: operation labels / source names
//   field names + visibility ..................... `live` recipes: they change with the mode (Source / Find / Replace with ...)
//   outputs r1..rN (count follows the stepper) .. `shape_output` count variant, wire = rN, shown name = the label,
//                                                 socket type = the output format you picked
//   debug pane + copy ............................ `pane_box` + `copy_system`, same toys as Multi Math
//   the string-fiddling .......................... Succy_Multi_Parse/Succy_Multi_Parse.py
// Natives (label_i / mode_i / rx cs se tr / f1_i f2_i f3_i / n e o / format_ri / num_operations) stay as hidden widgets: the Python reads them.
// ============================================================
import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
import { NodeStructure } from "./NodeStructure/index.js";

const TYPE = "Succy_Multi_Parse";
const MAX_OPS = 15;
const INPUTS = "abcdefghij".split("");
const OPS = Array.from({ length: MAX_OPS }, (_, k) => k + 1);
const FIELDS = [1, 2, 3];

// mode -> [value, short label]. The fields each mode shows depend on the mode AND on its little toggle (shape() below).
const MODES = [
    ["CONCATENATE", "Concat"], ["REPLACE", "Replace"], ["REGEX", "Regex"], ["SPLIT", "Split"],
    ["JOIN", "Join"], ["CONTAINS", "Contains"], ["COMPARE", "Compare"], ["STARTS_ENDS", "Starts / Ends with"],
    ["TRIM", "Trim"], ["CASE", "Case"], ["SUBSTRING", "Substring"], ["LENGTH", "Length"],
];
// the flavour of a mode: native key, options (first = default)
const KINDS = {
    REGEX:       { key: "rx", options: [["EXTRACT", "Extract"], ["REPLACE", "Replace"]], toggle: true },
    STARTS_ENDS: { key: "se", options: [["STARTS", "Starts with"], ["ENDS", "Ends with"]], toggle: true },
    CASE:        { key: "cs", options: [["UPPER", "UPPER"], ["LOWER", "lower"], ["TITLE", "Title Case"], ["SENTENCE", "Sentence case"],
                                        ["SWAP", "sWAP"], ["SNAKE", "snake_case"], ["KEBAB", "kebab-case"], ["CAMEL", "camelCase"]] },
    TRIM:        { key: "tr", options: [["ENDS", "Edges only"], ["COLLAPSE", "Squash double spaces"], ["NO_SPACES", "Remove ALL spaces"], ["NO_BLANK_LINES", "Remove blank lines"]] },
};
// text fields and numeric slots per mode: { t: [names], n: [names] }; numeric slots have a switch (off = the "off" behaviour)
function shapeOf(mode, kind) {
    switch (mode) {
        case "CONCATENATE": return { t: ["Template"], n: [] };
        case "REPLACE":     return { t: ["Source", "Find", "Replace with"], n: [] };
        case "REGEX":       return kind === "REPLACE" ? { t: ["Source", "Pattern", "Replacement"], n: [] }
                                                      : { t: ["Source", "Pattern"], n: ["Group (off = 1)"] };
        case "SPLIT":       return { t: ["Source", "Delimiter (\\n \\t ok)"], n: ["Index (off = whole list)"] };
        case "JOIN":        return { t: ["Source (list)", "Separator (\\n \\t ok)"], n: [] };
        case "CONTAINS":    return { t: ["Source (text or list)", "Look for"], n: [] };
        case "COMPARE":     return { t: ["Value A", "Value B"], n: [] };
        case "STARTS_ENDS": return { t: ["Source", kind === "ENDS" ? "Suffix" : "Prefix"], n: [] };
        case "SUBSTRING":   return { t: ["Source"], n: ["Start (off = 0)", "End (off = end)"] };
        case "LENGTH":      return { t: ["Source (text or list)"], n: [] };
        default:            return { t: ["Source"], n: [] };         // TRIM, CASE
    }
}
const FORMATS = ["STRING", "INT", "FLOAT", "BOOLEAN", "LIST", "DICT", "ARRAY", "JSON", "COMBO"];
const NUMS = [1, 2];
// Real hidden widgets: just two. Every per-block setting (label, mode, fields, switches...) is a "virtual native" packed as JSON
// into the `ops` widget by the builder (`packed`, NodeStructure/core/packed.js): 241 real widgets made create / clone / load crawl. D-79
const PACK = "ops";
const NATIVES = ["num_operations", PACK];
const VDEF = new Map();                                            // virtual native -> default (only non-defaults are stored)
OPS.forEach((i) => {
    VDEF.set(`label_${i}`, `Parse ${i}`); VDEF.set(`mode_${i}`, "CONCATENATE"); VDEF.set(`format_r${i}`, "STRING");
    Object.values(KINDS).forEach((kd) => VDEF.set(`${kd.key}_${i}`, kd.options[0][0]));
    FIELDS.forEach((k) => VDEF.set(`f${k}_${i}`, ""));
    NUMS.forEach((k) => { VDEF.set(`n${k}_${i}`, 0); VDEF.set(`e${k}_${i}`, false); VDEF.set(`o${k}_${i}`, "-"); });
});

/* ---------- glue: read the hidden widgets ---------- */
const count = (api) => Math.max(1, Math.min(MAX_OPS, Math.floor(Number(api.native.get("num_operations")) || 1)));
const modeOf = (api, i) => { const m = String(api.native.get(`mode_${i}`) || "CONCATENATE"); return MODES.some(([v]) => v === m) ? m : "CONCATENATE"; };
const kindOf = (api, i) => {                                   // the mode's flavour, falling back to the default
    const k = KINDS[modeOf(api, i)]; if (!k) return "";
    const v = String(api.native.get(`${k.key}_${i}`) || "").toUpperCase();
    return k.options.some(([o]) => o === v) ? v : k.options[0][0];
};
const shape = (api, i) => shapeOf(modeOf(api, i), kindOf(api, i));
const fmtOf = (api, i) => String(api.native.get(`format_r${i}`) || "STRING").toUpperCase();
const opLabel = (api, i) => String(api.native.get(`label_${i}`) ?? "").trim() || `Parse ${i}`;
const sockLabel = (api, i) => String(api.native.get(`label_${i}`) ?? "").replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 18) || `r${i}`;

// Tokens offered after "@" in operation i: the inputs that exist (named after whoever feeds them) + the operations ABOVE it.
// Two sources with the same name get their letter appended, so "seed (a)" and "seed (b)" stay tellable apart.
function tokens(api, i) {
    const who = api.cache.get("inNames") || {};
    const present = new Set((api.node.inputs || []).map((x) => x.name));
    const out = INPUTS.filter((n) => present.has(n)).map((n) => ({
        key: n, label: who[n]?.name || `Input ${n.toUpperCase()}`,
        hint: who[n]?.from ? `${n.toUpperCase()} ← ${who[n].from}` : `Input ${n.toUpperCase()} (nobody plugged in yet)`,
    }));
    for (let k = 1; k < i; k++) out.push({ key: `r${k}`, label: opLabel(api, k), hint: `r${k} · ${modeOf(api, k)} · ${fmtOf(api, k)}` });
    const seen = {};
    out.forEach((t) => { seen[t.label] = (seen[t.label] || 0) + 1; });
    out.forEach((t) => { if (seen[t.label] > 1) t.label = `${t.label} (${t.key})`; });
    return out;
}

// Sources that really ARRIVE as INT: plugged inputs whose wire is INT + earlier blocks whose format is INT. Nothing else gets in.
function intSources(api, i) {
    const who = api.cache.get("inNames") || {};                  // reading it keeps the list in step with plugging / unplugging
    const g = api.node.graph;
    const out = [{ value: "-", label: "— none —" }];
    for (const inp of api.node.inputs || []) {
        if (!INPUTS.includes(inp.name) || inp.link == null) continue;
        const link = g?.getLink?.(inp.link) ?? g?.links?.[inp.link];
        if (link?.type === "INT") out.push({ value: inp.name, label: `${inp.name.toUpperCase()} ← ${who[inp.name]?.name || "INT"}` });
    }
    for (let k = 1; k < i; k++) if (fmtOf(api, k) === "INT") out.push({ value: `r${k}`, label: `r${k} · ${opLabel(api, k)}` });
    return out;
}

const live = {
    // outputs: wire name rN (stable, so renaming a label never unplugs anything), shown name = the label, type = the format
    outs: (api) => OPS.slice(0, count(api)).map((i) => [`r${i}`, fmtOf(api, i) || "*", sockLabel(api, i)]),
    view: (api) => { const t = api.state.get("last"); return { mode: t ? "text" : "empty", text: t || "", src: "", info: "" }; },
    ...Object.fromEntries(OPS.flatMap((i) => [
        [`opOn${i}`, (api) => i <= count(api)],
        [`tok${i}`, (api) => tokens(api, i)],
        ...FIELDS.map((k) => [`fn${i}_${k}`, (api) => shape(api, i).t[k - 1] || ""]),
        ...FIELDS.map((k) => [`fv${i}_${k}`, (api) => k <= shape(api, i).t.length]),
        ...NUMS.map((k) => [`nn${i}_${k}`, (api) => shape(api, i).n[k - 1] || ""]),
        ...NUMS.map((k) => [`nv${i}_${k}`, (api) => k <= shape(api, i).n.length]),
        [`iopt${i}`, (api) => intSources(api, i)],
        // which flavour control is on show (toggle for 2 options, dropdown for more)
        ...Object.entries(KINDS).map(([m, kd]) => [`kv${i}_${kd.key}`, (api) => modeOf(api, i) === m]),
    ])),
};

/* ---------- spec ---------- */
// ONE region, everything inside separated by FIXED separators (Multi Math layout, D-76): the node hugs its content.
const SEP = 6;
const fieldBlock = (i, k) => ({
    t: "stack_box", id: `fw${i}_${k}`, gap: 0, visible: `$live.fv${i}_${k}`, children: [
        { t: "label_element", variant: "hint", text: `{{$live.fn${i}_${k}}}` },
        { t: "editor_element", id: `ed${i}_${k}`, bind: `$native.f${k}_${i}`, tokens: `$live.tok${i}`, placeholder: "Type @ to insert a variable...", modalTitle: `Operation ${i}` },
    ],
});
// numeric slot: [switch] [stepper] [override: only INTs that arrive plugged]. Override wins over the stepper.
const numBlock = (i, k) => ({
    t: "stack_box", id: `nw${i}_${k}`, gap: 0, visible: `$live.nv${i}_${k}`, children: [
        { t: "label_element", variant: "hint", text: `{{$live.nn${i}_${k}}}` },
        { t: "row_box", children: [
            { t: "segmented_element", id: `ne${i}_${k}`, bind: `$native.e${k}_${i}`, options: [{ value: false, label: "Off" }, { value: true, label: "On", tone: "info" }] },
            { t: "stepper_element", id: `nn${i}_${k}`, bind: `$native.n${k}_${i}`, min: -9999, max: 9999 },
            { t: "select_element", id: `no${i}_${k}`, bind: `$native.o${k}_${i}`, options: `$live.iopt${i}` },
        ] },
    ],
});
const kindBlock = (i, [mode, kd]) => ({
    t: "stack_box", id: `kw${i}_${kd.key}`, gap: 0, visible: `$live.kv${i}_${kd.key}`, children: [
        kd.toggle
            ? { t: "segmented_element", id: `k${i}_${kd.key}`, bind: `$native.${kd.key}_${i}`, options: kd.options.map(([value, label]) => ({ value, label, tone: "info" })) }
            : { t: "select_element", id: `k${i}_${kd.key}`, bind: `$native.${kd.key}_${i}`, options: kd.options.map(([value, label]) => ({ value, label, tone: "info" })) },
    ],
});
const opBlock = (i) => ({
    t: "stack_box", id: `opw${i}`, gap: 0, visible: `$live.opOn${i}`, children: [
        { t: "separator_element", size: SEP },
        { t: "group_box", id: `op${i}`, variant: "inset", children: [
            { t: "row_box", children: [
                { t: "badge_element", text: `r${i}`, tone: "accent" },
                { t: "input_element", id: `lbl${i}`, bind: `$native.label_${i}`, placeholder: `Parse ${i}` },
            ] },
            { t: "row_box", children: [
                { t: "select_element", id: `mode${i}`, bind: `$native.mode_${i}`, options: MODES.map(([v, l]) => ({ value: v, label: l })) },
                { t: "label_element", text: "→" },
                { t: "select_element", id: `fmt${i}`, class: "ns-sel-out", bind: `$native.format_r${i}`, options: FORMATS.map((v) => ({ value: v, label: v })) },
            ] },
            ...Object.entries(KINDS).map((e) => kindBlock(i, e)),
            ...FIELDS.map((k) => fieldBlock(i, k)),
            ...NUMS.map((k) => numBlock(i, k)),
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
                        { t: "label_element", text: "Operations" },
                        { t: "stepper_element", id: "numStep", bind: "$native.num_operations", min: 1, max: MAX_OPS },
                        { t: "spacer_element" },
                        // Debug stays awake while folded (D-96): fold the work, keep the peephole — the pane still opens below
                        { t: "label_element", text: "Debug" },
                        { t: "segmented_element", id: "dbgSeg", bind: "$state.debug", options: [{ value: false, label: "Off", tone: "danger" }, { value: true, label: "On", tone: "ok" }] },
                        // yellow "Collapse" while open, blue "Expand" while folded (collapse_box writes text and class)
                        { t: "button_element", id: "colBtn", text: "▾ Collapse", class: "ns-on" },
                    ] },
                ] },
                { t: "stack_box", id: "opRoot", gap: 0, children: OPS.map(opBlock) },
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
            title: "Succy Multi Parse — text, taken apart",
            about: "Up to 15 text operations over the inputs a..j (the next input appears when you plug the previous one). Each operation has a Mode, a few fields and an output format, and comes out as its own output (r1, r2…). Later operations can use earlier results. A broken one gives a neutral value and a red line in Debug.",
            keys: [
                { keys: "Concat", does: "Builds text from a template: Hello @a, you are @b." },
                { keys: "Replace", does: "Source, text to find, text to put instead." },
                { keys: "Regex", does: "Extract: the first match (Group picks which bracket, default 1). Replace: swaps every match." },
                { keys: "Split", does: "Cuts text at a delimiter into a list. Index picks one piece; off = the whole list. \\n and \\t work." },
                { keys: "Join", does: "Glues a list into one text with a separator." },
                { keys: "Contains", does: "True if the text holds the string, or the list holds that item." },
                { keys: "Compare", does: "True if A and B are equal." },
                { keys: "Starts / Ends with", does: "True if the text starts or ends with what you give." },
                { keys: "Trim", does: "Edges only · squash double spaces · remove ALL spaces · remove blank lines." },
                { keys: "Case", does: "UPPER · lower · Title · Sentence · sWAP · snake_case · kebab-case · camelCase." },
                { keys: "Substring", does: "A slice from Start to End (off = beginning / end)." },
                { keys: "Length", does: "How many characters, or how many items in a list." },
                { keys: "→ format", does: "STRING, INT, FLOAT, BOOLEAN, LIST, DICT, ARRAY, JSON, COMBO: the type of that output." },
            ],
            notes: [
                "Type @ in a field to insert an input or an earlier result. A field holding ONLY a token passes the raw value (a list stays a list). @@ writes a literal @.",
                "The name you type becomes the output's name; the wire stays r1..rN.",
                "Regex is protected against patterns that hang the Queue (timeout 2 s with the regex module).",
                "Debug On shows each operation with the values filled in. Collapse folds the operations away.",
            ],
        }),
    },
    behaviors: [
        { type: "info_node", menu: "info" },
        // sockets: a..j open one by one, nothing shifts when you unplug. Must run BEFORE the chips look for their sockets.
        { type: "grow_input", names: INPUTS, min: 2, slotType: "*", cacheKey: "inNames" },
        ...INPUTS.map((n) => ({ type: "chip_input", input: n })),
        // outputs = number of operations; wire r1..rN stays put, shown name follows the label, type follows the format (live)
        { type: "shape_output", outputs: "$live.outs" },
        ...OPS.map((i) => ({ type: "chip_output", output: `r${i}` })),
        { type: "collapse_box", state: "collapsed", trigger: "colBtn", hide: ["opRoot"], glyphs: ["▾ Collapse", "▸ Expand"], target: "colBtn", rootClass: "ns-cool" },
        // the debug pane stretches ITSELF (its own height in state), never the gaps around it
        { type: "resize_element", container: "dbgWrap", target: "pane", mode: "element", state: "dbgHeight", min: 60, max: 600 },
        { type: "gate_mask", region: "main" },
    ],
};

NodeStructure.define(TYPE, {
    minWidth: 384,                    // D-92: measured live — the header row (Operations/Debug/Collapse) wraps below 376, +8 px of margin for other fonts
    defaultSize: [390, 260],
    natives: NATIVES,
    packed: { widget: PACK, defaults: Object.fromEntries(VDEF) },
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
