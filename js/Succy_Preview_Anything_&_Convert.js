// ============================================================
// Succy_Preview_Anything_&_Convert.js — NodeStructure v0.2 (kit-first)
// This file contains ONLY: spec (catalog pieces), the pieces' JSON config,
// state schema and "when". No CSS, DOM, canvas, graph logic: it all lives in the kit (see CATALOG.md).
// Shape-shifting outputs (text = 1 output, image = 4): `shape_output` behavior (D-66), only the JSON here.
// ============================================================
import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
import { NodeStructure } from "./NodeStructure/index.js";

const TYPE = "Succy_Preview_Anything_&_Convert";
const IMAGE_TYPES = ["IMAGE", "MASK"];
const TEXT_TYPES = ["STRING", "INT", "FLOAT", "BOOLEAN", "LIST", "DICT", "ARRAY", "JSON", "COMBO"];
const OUT_SOCKET_TYPE = { IMAGE: "IMAGE", MASK: "MASK", STRING: "STRING", INT: "INT", FLOAT: "FLOAT", BOOLEAN: "BOOLEAN" };   // others -> "*"
const MAX_TEXT = 200000;
const DEFAULT_W = 280;

/* ---------- glue: state <-> values ---------- */
let _pc = { raw: null, val: null };
function content(api) {
    const raw = api.state.get("content");
    if (typeof raw !== "string" || !raw) return null;
    if (_pc.raw === raw) return _pc.val;
    let v = null; try { v = JSON.parse(raw); } catch (_) {}
    _pc = { raw, val: v };
    return v;
}
const setContent = (api, c) => api.state.set("content", c ? JSON.stringify(c) : "");
const imageUrl = (c) => SurvivalKit.compat.viewUrl(c?.images?.[0]);       // /view URL: Survival compat

/* ---------- spec ---------- */
// ONE single region: [92px command box] [8px FIXED separator] [pane]. Region height = plus(100) + bodyHeight;
// no space between widgets => no stretchy grey. With Preview Off only the fixed part remains.
const UI_H = 92, SEP_H = 8;
export const SPEC = {
    v: 1,
    layout: { heightMode: "derived" },
    regions: [
        {
            id: "main",
            height: { bind: "$state.bodyHeight", default: 120, min: 62, max: 640, triple: true, flex: true, plus: UI_H + SEP_H, active: "$native.preview" },
            tree: { t: "stack_box", id: "root", gap: 0, style: { height: "100%" }, children: [
                { t: "group_box", id: "uiBox", style: { flex: "0 0 " + UI_H + "px" }, children: [
                    { t: "row_box", children: [
                        { t: "label_element", text: "Preview" },
                        { t: "segmented_element", id: "pvSeg", bind: "$native.preview", options: [{ value: false, label: "Off", tone: "danger" }, { value: true, label: "On", tone: "info" }] },
                    ] },
                    { t: "row_box", children: [
                        { t: "label_element", text: "Convert To" },
                        { t: "select_element", id: "typeSel", class: "ns-sel-out", bind: "$native.output_type", options: "$live.typeOptions" },
                        // MASK out only: converts to a mask AND flips it (white <-> black). Blue = on, grey = off.
                        { t: "button_element", id: "invBtn", text: "INVERT", title: "Invert the mask", visible: "$live.maskOut", classIf: { "ns-on-info": "$native.invert_mask" },
                            on: { click: { do: "$actions.flip_node", args: { native: "invert_mask" } } } },
                    ] },
                ] },
                { t: "separator_element", id: "sep", size: SEP_H, visible: "$native.preview" },
                { t: "pane_box", id: "pane", visible: "$native.preview", classIf: { "ns-nogrip": "$live.free" }, style: { flex: "1 1 0", minHeight: 0 },
                    mode: "$live.view.mode", text: "$live.view.text", src: "$live.view.src", info: "$live.view.info",
                    on: { "ns-load": { do: "$actions.fit_mask", args: { state: "bodyHeight", min: 160, max: 640, pad: 40, when: "$native.preview" } } },
                    children: [
                        { t: "button_element", id: "copyBtn", text: "{{$cache.copyFlash}}", glyph: "⧉", title: "Copy to clipboard", attrs: { "data-ns-for": "text image" },
                            on: { click: { do: "$actions.copy_system", args: { kind: "$live.view.mode", text: "$live.view.text", url: "$live.view.src", flash: "copyFlash" } } } },
                        { t: "button_element", id: "dlBtn", text: "{{$cache.dlFlash}}", glyph: "⬇", title: "Download image", attrs: { "data-ns-for": "image" },
                            on: { click: { do: "$actions.download_system", args: { url: "$live.view.src", name: "$live.view.filename", flash: "dlFlash" } } } },
                    ] },
            ] },
        },
    ],
    menus: {
        info: NodeStructure.infoMenu({
            title: "Succy Preview — look at anything, change its type",
            about: "Plug anything in: you see it in the box, and you get it back converted to the type you choose. It works as a viewer, as a converter, or both.",
            keys: [
                { keys: "Preview On / Off", does: "Off hides the box and the node shrinks. The conversion still works." },
                { keys: "Convert To", does: "The type of the output: STRING, INT, FLOAT, BOOLEAN, LIST, DICT, ARRAY, JSON, COMBO, and IMAGE ↔ MASK for pictures." },
                { keys: "INVERT", does: "Appears when Convert To is MASK. Blue = on: the mask comes out flipped (white ↔ black), preview included. Grey = off." },
        { keys: "⧉ Copy", does: "Copies the text or the picture to the clipboard." },
                { keys: "⬇ Download", does: "Saves the picture (image mode)." },
            ],
            notes: [
                "Plug an IMAGE and the node grows three more outputs: width, height and megapixels (besides the picture).",
                "Anything else gives just the one output. If the text can't become the type you asked for, you get a neutral value (0, empty…).",
                "With a picture the box follows the node; with text, stretch it from the corner handle.",
            ],
        }),
    },
    behaviors: [
        { type: "info_node", menu: "info" },
        // image: the node is free and the box follows; text/empty: node height LOCKED, resizes only from the handle
        { type: "follow_mask", region: "main", state: "bodyHeight", min: 62, max: 640, persist: "triple", when: "$live.free" },
        { type: "resize_mask", container: "pane", region: "main", state: "bodyHeight", min: 62, max: 640 },
        { type: "gate_mask", region: "main" },
        { type: "bind_input", state: "content", resetCache: ["fitDone"] },
        // chip selectors (D-64): the input lists only readable/printable outputs, the output the compatible inputs
        { type: "chip_input", input: "source", types: ["STRING", "INT", "FLOAT", "BOOLEAN", "IMAGE", "MASK", "LIST", "DICT", "ARRAY", "JSON", "COMBO", "*"] },
        { type: "chip_output", output: "output" },
        { type: "chip_output", output: "width" },          // these 3 exist only in image mode (shape_output):
        { type: "chip_output", output: "height" },         // when they're missing the chip is "absent", not an error
        { type: "chip_output", output: "megapixels" },
        // output shape from the incoming type (D-66): image = output+width+height+megapixels, anything else = output only
        { type: "shape_output", input: 0, combo: "output_type", cacheKey: "mode", resetOnUnplug: true, types: OUT_SOCKET_TYPE, modes: [
            { name: "IMAGE", when: IMAGE_TYPES, combo: IMAGE_TYPES, outputs: [["output", "@combo"], ["width", "INT"], ["height", "INT"], ["megapixels", "FLOAT"]] },
            { name: "TEXT", default: true, combo: TEXT_TYPES, outputs: [["output", "@combo"]] },
        ] },
    ],
};

const live = {
    // image mode (IMAGE/MASK input connected, even before the first run): free node, no handle
    maskOut: (api) => api.native.get("output_type") === "MASK",
    free: (api) => api.cache.get("mode") === "IMAGE" || content(api)?.kind === "image",
    typeOptions: (api) => { const v = api.native.widget("output_type")?.options?.values; return Array.isArray(v) && v.length ? v : TEXT_TYPES; },
    view(api) {
        const c = content(api);
        return { mode: !c ? "empty" : c.kind === "image" ? "image" : "text", text: c?.text ?? "", src: c?.kind === "image" ? imageUrl(c) : "", info: c?.info || "", filename: c?.images?.[0]?.filename || "image.png" };
    },
};

NodeStructure.define(TYPE, {
    minWidth: 240,
    defaultSize: [DEFAULT_W, 260],
    natives: ["preview", "output_type", "invert_mask"],
    channels: ["heal", "undo", "redo"],
    order: ["ns_main"],
    state: {
        content:    { policy: "on-execute" },        // JSON string { sig, kind, text|images, info }
        bodyHeight: { policy: "ui" },                // preview box height (the variable part only)
    },
    config: { bind_input: { input: 0 } },
    spec: SPEC, live,
    hooks: {
        onSetup(api) { api.native.hide(["preview", "output_type", "invert_mask"]); },
        refreshFromNative(api) { api.native.hide(["preview", "output_type", "invert_mask"]); },
        onRestore(api) { api.native.hide(["preview", "output_type", "invert_mask"]); },
        onConnect(api, t, index) {
            // "when": image input unplugged -> HEIGHT goes back to default (width stays).
            // Deferred: a cable swap (unplug+plug) must not reset anything. Quick changes of partner are allowed. The output shape is shape_output's job.
            if (t !== 1 || index !== 0 || api.node.inputs?.[0]?.link != null) return;
            if (api.cache.get("mode") === "IMAGE")   /* the glue runs before shape_output: here "mode" is still the previous one */ api.after(() => { if (api.node.inputs?.[0]?.link == null) api.act.reset_node({ key: "bodyHeight", value: 120 }); }, 40);
        },
        onExecute(api, message) {
            const imgs = message?.succy_images, txt = message?.succy_text, info = message?.succy_info;
            let c;
            if (Array.isArray(imgs) && imgs.length) c = { kind: "image", images: imgs, info: Array.isArray(info) ? String(info[0] ?? "") : "" };
            else if (Array.isArray(txt) && txt.length) c = { kind: "text", text: String(txt[0] ?? "").slice(0, MAX_TEXT), info: "" };
            else return;
            c.sig = api.io.sig_input() ?? null;
            const prev = content(api)?.kind;
            if (c.kind === "image" && prev !== "image") api.cache.set("fitDone", false);
            // image -> text: height and width go back to default (text -> image: width unchanged)
            if (c.kind === "text" && prev === "image") api.act.reset_node({ key: "bodyHeight", value: 120, width: DEFAULT_W });
            setContent(api, c);
        },
    },
});

