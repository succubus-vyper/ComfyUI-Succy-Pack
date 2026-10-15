// ============================================================
// Succy_Label.js — NodeStructure v0.3 (glue)
// Note/label with effects. This file contains ONLY: spec (catalog pieces), JSON config,
// state schema and the "when" (text from the input during a Queue).
// Drawing (note_box), animated background engine, style menu (menu v2 + form_box), effects
// loading: all in the builder (pieces/note.js, fx/note-*.js). The effects are JSONs in the
// node's folder (Succy_Label/effects/), served by the node's backend. See DECISIONS D-59.
// ============================================================
import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
import { NodeStructure } from "./NodeStructure/index.js";

const TYPE = "Succy_Label";
const AWAIT = "Awaiting node communication…";

/* ---------- glue: which text to show ---------- */
const wired = (api) => api.io.sig_input() != null;                 // `text` input connected
function received(api) {
    const raw = api.state.get("content");
    if (typeof raw !== "string" || !raw) return null;
    try { const c = JSON.parse(raw); return typeof c?.text === "string" ? c.text : null; } catch (_) { return null; }
}
const live = {
    shown: (api) => (wired(api) ? (received(api) ?? AWAIT) : (api.state.get("text") ?? "")),
    waiting: (api) => wired(api) && received(api) === null,
    // placeholder: "Double-click to edit" only makes sense by hand; with the input connected the text gets overwritten -> empty = empty box
    placeholder: (api) => (wired(api) ? "" : "Double-click to edit"),
    hint: (api) => (wired(api) && api.io.style_system()?.isText ? "Text input connected: the incoming text replaces this one on every run." : api.io.style_system()?.hint ?? ""),
};

/* ---------- spec ---------- */
const SEC = (where) => ({ t: "stack_box", class: "ns-m-sec", visible: where === "bottom" ? "$live.style_system.hasBottom" : true, children: [
    { t: "label_element", variant: "section", text: `{{$live.style_system.${where}Title}}` },
    { t: "form_box", fields: `$live.style_system.${where}`, state: "style", scope: `$live.style_system.${where}Scope`, cols: 2, rows: 6, colsSmall: 2, foot: false },
] });
export const SPEC = {
    v: 1,
    regions: [{
        // the box height follows the node (follow_mask): the node resizes freely in width and height — stretch it however you like
        id: "main", height: { bind: "$state.boxH", default: 80, min: 30, max: 4000 },
        tree: { t: "note_box", id: "note", text: "$live.shown", dim: "$live.waiting", state: "style", empty: "$live.placeholder", children: [
            { t: "button_element", id: "gear", text: "⚙", title: "Edit label", variant: "icon" },
        ] },
    }],
    menus: {
        info: NodeStructure.infoMenu({
            title: "Succy Label — a note with attitude",
            about: "A note that lives on the canvas, with backgrounds, borders, text styles and animated effects. Type the text by hand, or plug a STRING and the note shows it on every run.",
            keys: [
                { keys: "Double click", does: "Edit the note and open the style menu." },
                { keys: "⚙", does: "The same style menu, from the gear." },
                { keys: "↻ (in the menu)", does: "Reloads the effect files from disk after you edit them." },
                { keys: "Stretch the node", does: "The note follows the node size, any width and height." },
            ],
            notes: [
                "Style menu: text, background animation and palette, border, overlay pattern, font. The tabs at the top switch between them.",
                "With the text input plugged, the incoming text replaces your own on every Queue (until the first run it says 'Awaiting node communication…').",
                "Effects are plain JSON files in Succy_Label/effects: the 0----HowTo.txt there explains how to make your own.",
            ],
        }),
        // dedicated menu protocol v2 (D-57): fixed size L/M/S, anchored to the node, closes with ✕/Esc
        style: {
            kind: "menu_float_panel", look: "v2", size: "auto", dock: "subject", dismiss: "explicit",
            title: "Label #{{$live.self_node.id}}",
            head: { t: "row_box", gap: 2, children: [
                { t: "button_element", text: "↻", variant: "icon", title: "Reload effects", on: { click: { do: "$actions.reload_system", args: { name: "style_system" } } } },
            ] },
            tree: { t: "stack_box", gap: 0, children: [
                { t: "row_box", class: "ns-m-bar", children: [
                    { t: "segmented_element", options: "$live.style_system.tabs", bind: "$state.tab" },
                ] },
                { t: "stack_box", class: "ns-m-main", children: [
                    { t: "stack_box", class: "ns-m-params", children: [
                        { t: "label_element", variant: "hint", text: "{{$live.hint}}", visible: "$live.hint" },
                        { t: "textarea_element", bind: "$state.text", placeholder: "Type your note here…", stopKeys: true, visible: "$live.style_system.isText" },
                        SEC("top"),
                        SEC("bottom"),
                        { t: "label_element", variant: "error", text: "{{$live.style_system.errorsText}}", visible: "$live.style_system.hasErrors" },
                    ] },
                ] },
            ] },
        },
    },
    behaviors: [
        { type: "info_node", menu: "info", hover: true },   // the heart only shows while the pointer is over the node
        { type: "open_float", menu: "style", trigger: "gear", on: "click" },
        { type: "open_float", menu: "style", trigger: "note", on: "dblclick" },
        { type: "follow_mask", region: "main", state: "boxH", min: 30, max: 4000 },
        { type: "feed_system", name: "style_system" },
        { type: "bind_input", state: "content" },
        { type: "chip_input", input: "text" },                       // chip selector on the input (D-61)
        { type: "gate_mask", region: "main" },
    ],
};

NodeStructure.define(TYPE, {
    minWidth: 150,
    defaultSize: [300, 100],
    natives: [],
    channels: ["heal", "undo", "redo"],
    node: { noTitle: true, bare: true },                                        // only the note shows (transparent frame/title) — nothing on but the words
    state: {
        text:    { policy: "debounced", ms: 250, default: "" },   // handwritten text
        style:   { policy: "debounced", ms: 250, default: "" },   // JSON {section:{key:value}} (the menu's form_box)
        content: { policy: "on-execute" },                         // JSON {sig, text}: text that came in from the input
        tab:     { policy: "ui", default: "text" },                // tab open in the menu
        boxH:    { policy: "debounced", ms: 300 },                 // box height (follows the node's resizing)
    },
    config: {
        // where the effects live: the Succy_Label/effects/ folder served by the node's backend
        note_box: {
            route: "/succy/effects/", ui: "/succy/uiconfig", fonts: "/succy/css_proxy",
            families: { background: "BG_Animations", text: "Text_Styles", border: "Borders_Styles", pattern: "Overlay_Patterns", palette: "Bg_Anim_Palettes", fonts: "Fonts", overlayStyle: "Overlay_Style" },
        },
        style_system: { styleKey: "style", tabKey: "tab" },
        bind_input: { input: 0 },
    },
    spec: SPEC, live,
    hooks: {
        // "when": at the end of the run the input's text becomes the shown text (valid as long as the wire stays the same)
        onExecute(api, message) {
            const t = message?.succy_text;
            if (!Array.isArray(t)) return;
            api.state.set("content", JSON.stringify({ sig: api.io.sig_input() ?? null, text: String(t[0] ?? "") }));
        },
    },
});

void SurvivalKit;
