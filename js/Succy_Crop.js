// ============================================================
// Succy_Crop.js — Succy Crop as GLUE, NodeStructure v0.3 (Crop & Stitch phase 2 D-105, phase 3 D-106)
// Shows the real image, lets you DRAW the selection on it (rectangle and/or free hand) and (optionally) stops every Run so you can
// do it on the fresh picture. The picture can also come WITHOUT a Queue: drop it, paste it or load it on the viewport.
// This file contains ONLY: spec (catalog pieces), config and the natives it hides. Zero DOM, zero CSS, zero timers.
//   zoom / pan stage ............................................................. `view_box`
//   the rectangle you draw, move, resize ......................................... `marquee_element` (writes x, y, w, h, box)
//   the free hand mask (paint / erase, [ ] size) ................................. `brush_element` (PNG in the `brush` native)
//   drop / paste (Ctrl+V) / 📂 a picture, no Queue ............................... `load_mask` (native upload, name in `source`)
//   the picture the node is looking at ........................................... `$live.shot_system` (Python preview or the loaded file)
//   Clear box / Clear brush ...................................................... `set_node` on the natives
//   Stop every run / Reuse ....................................................... SurvivalKit.hold via `hold_node` (same shield as Pause)
//   ▶ Continue / ■ Stop ........................................................... `release_graph`
//   Alpha / Solid (one button) + colour: the `cutout` output (mask applied) ...... `$native.alpha`, `$native.solid_color` (D-111/D-113)
//   Mask view on/off (button) · tools under the picture fold (start folded) ...... `flip_node` on `$state.maskView` / `$state.tools`
//   Free hand: LEFT button paints, RIGHT button erases ............................ `brush_element` rightErase
//   live veil over what the final mask leaves out (box feather, grow, feather...) . `veil_element` (Python's recipe, D-107)
//   right click in Rectangle / Alt + right click / ⚙: the tools menu ............. `open_float` (contextmenu, alt) + menu v2 `tools`
//   Alt + drag / Alt + wheel (D-120) .............................................. rectangle: resize from the centre · brush: size + hardness
//   freeze the rectangle's width / height (sides turn red) + its Multiple ......... `boxlock_element` (menu) -> `$state.lockW/lockH`, `$native.box_snap`
//   brush tip (round / solid / square / solid square) ............................. `swatch_element` (menu) -> `$state.brushShape`
//   WORKSPACE (whole picture, megapixels) · Cropped area (context, output size) ... natives `workspace_mp`, `context`, `out_mp`, `multiple`
//   ⬇ on the picture: download any output, no Queue needed ....................... menu `downloads` + Python route /succy/crop/download
//   every input and output ....................................................... `chip_input` / `chip_output`
// Backend: Succy_Crop_Stitch/Succy_Crop_Stitch.py. Natives stay REAL (Python validates them) — only hidden; the controls below drive them.
// ============================================================
import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
import { NodeStructure } from "./NodeStructure/index.js";

const TYPE = "Succy_Crop";
const NATIVES = ["x", "y", "w", "h", "context", "workspace_mp", "out_mp", "multiple", "box_snap", "alpha", "solid_color", "box", "box_feather", "mask_grow", "mask_feather",
    "hold", "hold_timeout", "run_id", "source", "brush"];

const stepper = (id, label, bind, min, max, step = 1) => ({
    t: "stack_box", id: id + "Box", gap: 2, style: { flex: "1 1 0", minWidth: "0" }, children: [
        { t: "label_element", variant: "caption", text: label },
        { t: "stepper_element", id, bind, min, max, step, style: { flex: "none" } },
    ],
});
const nat = (id, label, native, min, max, step) => stepper(id, label, "$native." + native, min, max, step);
const clear = (id, text, native, value) => ({ t: "button_element", id, class: "ns-btn", text, style: { flex: "1 1 0" },
    on: { click: { do: "$actions.set_node", args: { native, value } } } });

// the pieces the node body and the tools menu share (ids get a suffix: one tree each)
// cutout output: ONE button that flips Alpha <-> Solid (D-113), the colour swatch shows only in Solid (D-111)
const alphaBtn = (id) => ({ t: "button_element", id, class: "ns-btn-act ns-slim", style: { flex: "0 0 auto" }, state: "$native.alpha", labels: ["Alpha", "Solid"],
    title: "cutout output: Alpha = transparent outside the mask, Solid = the chosen colour outside the mask (click to switch)",
    on: { click: { do: "$actions.flip_node", args: { native: "alpha" } } } });
// Mask view: an on/off button (lit when on)
const maskBtn = (id) => ({ t: "button_element", id, class: "ns-btn-act ns-slim", style: { flex: "0 0 auto" }, text: "Mask view", classIf: { "ns-on": "$state.maskView" },
    title: "Show the final mask on the picture, the outside as the cutout will have it",
    on: { click: { do: "$actions.flip_node", args: { key: "maskView", default: true } } } });
const colorPick = (label) => ({ t: "field_element", kind: "color", label, bind: "$native.solid_color", visible: "!$native.alpha" });
const modeSeg = (id) => ({ t: "segmented_element", id, bind: "$state.paint", style: { flex: "1 1 auto" }, options: [
    { value: false, label: "Rectangle", tone: "info" },
    { value: true, label: "Free hand", tone: "warn" },
] });
const maskTgl = (id) => ({ t: "toggle_element", id, label: "Mask view", bind: "$state.maskView", style: { flex: "none" } });
// fold the settings under the picture (D-113): folded = one big Expand row, the picture gets the room. Start open (D-115).
const foldBtn = (id, text, style) => ({ t: "button_element", id, class: "ns-btn", text, style, on: { click: { do: "$actions.flip_node", args: { key: "tools" } } } });
// Hardness = the stroke's own feather (100 = hard edge, 0 = all soft): Photoshop's name, kept on purpose (D-107).
// Box feather = the RECTANGLE's own soft edge. Mask feather = the soft edge of the FINAL mask (box + strokes, minus eraser).

// brush tips for the menu list (D-120): the little picture is CSS, the real tip is drawn by brush_element
const TIPS = [
    { value: "round", label: "Round · soft edge", bg: "radial-gradient(circle, #fff 34%, rgba(255,255,255,0) 74%)", radius: "50%" },
    { value: "round_hard", label: "Round · solid", bg: "#fff", radius: "50%" },
    { value: "square", label: "Square · soft sides", bg: "#fff", shadow: "0 0 5px 1px rgba(255,255,255,.9)" },
    { value: "square_hard", label: "Square · solid", bg: "#fff" },
];

// tools menu (D-108): one option per line, slider + value you can click and type (field_element range), only the active method
const slide = (label, bind, min, max, title) => ({ t: "field_element", kind: "range", label, bind, min, max, step: 1, ...(title ? { title } : {}) });
const sec = (text) => ({ t: "label_element", variant: "section", text });
// the tools menu (right click in Rectangle / Alt + right click / ⚙ on the picture): the method and ITS options only (D-114)
const MENU_TREE = { t: "stack_box", gap: 8, style: { padding: "10px 12px 12px" }, children: [
    { t: "row_box", class: "ns-slim", gap: 6, children: [modeSeg("modeSegM"), maskTgl("maskTglM")] },
    { t: "stack_box", gap: 8, visible: "!$state.paint", children: [
        sec("Rectangle"),
        { t: "label_element", variant: "hint", text: "Drag on the picture. Alt + drag or Alt + wheel resize it from the centre." },
        { t: "row_box", gap: 6, children: [nat("xStepM", "X", "x", 0, 16384), nat("yStepM", "Y", "y", 0, 16384)] },
        { t: "row_box", gap: 6, children: [nat("wStepM", "W (0 = edge)", "w", 0, 16384), nat("hStepM", "H (0 = edge)", "h", 0, 16384)] },
        slide("Box feather", "$native.box_feather", 0, 256),
        clear("clrBoxM", "Clear box", "box", false),
    ] },
    { t: "stack_box", gap: 8, visible: "$state.paint", children: [
        sec("Free hand"),
        { t: "label_element", variant: "hint", text: "Left button paints · right button erases · Alt + drag: size ↔ hardness · Alt + wheel: size" },
        slide("Size ( [ ] )", "$state.brushSize", 1, 1024),
        slide("Hardness %", "$state.brushHard", 0, 100),
        slide("Opacity %", "$state.brushOp", 1, 100),
        clear("clrBrushM", "Clear brush", "brush", ""),
    ] },
    // the final mask (rectangle + brush): same in both methods
    sec("Final mask"),
    slide("Grow / shrink", "$native.mask_grow", -1024, 1024),
    slide("Mask feather", "$native.mask_feather", 0, 1024),
    // the interactive part of the method
    { t: "stack_box", gap: 8, visible: "!$state.paint", children: [
        sec("Box lock"),
        { t: "boxlock_element", w: "$native.w", h: "$native.h", imgW: "$live.shot_system.width", imgH: "$live.shot_system.height",
            lockW: "$state.lockW", lockH: "$state.lockH", snap: "$native.box_snap" },
    ] },
    { t: "stack_box", gap: 8, visible: "$state.paint", children: [
        sec("Brush tip"),
        { t: "swatch_element", bind: "$state.brushShape", rows: 3, options: TIPS },
    ] },
] };

/* ---------- spec ---------- */
export const SPEC = {
    v: 1,
    // ONE region and a free node height (D-106): the node is resized by hand only, the picture takes whatever room is left
    // (Vue Nodes shares spare room between regions and never lets a node shrink below its content: one region = no fight).
    layout: { heightMode: "free" },
    regions: [
        {
            id: "main", height: { value: 470, min: 470, flex: true },
            tree: { t: "stack_box", id: "page", gap: 6, style: { height: "100%" }, children: [
              // top bar, compact, ABOVE the picture: Mask view · Alpha/Solid (cutout output) · colour · Stop every run / Reuse · ▶ continue · ■ stop.
              // The timer shows only while waiting.
              { t: "stack_box", gap: 4, style: { flex: "none" }, children: [
                { t: "row_box", class: "ns-slim", gap: 6, children: [
                    maskBtn("maskBtn"),
                    alphaBtn("alphaBtn"),
                    { ...colorPick(""), class: "ns-field-bare", title: "Solid colour of the cutout output" },
                    { t: "segmented_element", id: "holdSeg", bind: "$native.hold", style: { flex: "1 1 auto" },
                        title: "Stop = wait on every Run so you can draw on the fresh picture · Reuse = run on with the current selection", options: [
                        { value: true, label: "Stop", tone: "warn" },
                        { value: false, label: "Reuse", tone: "ok" },
                    ] },
                    { t: "button_element", id: "goBtn", class: "ns-btn-act ns-slim ns-tone-ok", style: { flex: "0 0 auto" }, text: "▶", title: "{{$cache.holdLabel}}", disabled: "$cache.holdOff",
                        on: { click: { do: "$actions.release_graph", args: { do: "continue" } } } },
                    { t: "button_element", id: "stopBtn", class: "ns-btn-act ns-slim ns-tone-danger", style: { flex: "0 0 auto" }, text: "■", title: "Stop", disabled: "$cache.holdOff",
                        on: { click: { do: "$actions.release_graph", args: { do: "stop" } } } },
                ] },
                { t: "status_element", id: "status", size: "m", visible: "!$cache.holdOff", label: "$cache.holdText", value: "$cache.holdTimer", tone: "$cache.holdTone", labelTone: "$cache.holdTone" },
              ] },
              // the viewport: all the room the node has left (min 180 px)
              { t: "view_box", id: "vp", dblfit: false, buttons: [
                    { text: "⇄", title: "Swap tool: Rectangle ⇄ Free hand (lit = Free hand)", active: "$state.paint", on: { click: { do: "$actions.flip_node", args: { key: "paint" } } } },
                    { text: "⚙", title: "Options of the current tool (or right click · Alt + right click in Free hand)", on: { click: { do: "$actions.openTools" } } },
                    { text: "⬇", title: "Download an output as PNG (no Run needed with a picture loaded on the node)", on: { click: { do: "$actions.openDownloads" } } },
                ], style: { flex: "1 1 0", minHeight: "180px", height: "auto" }, src: "$live.shot_system.src", width: "$live.shot_system.width", height: "$live.shot_system.height",
                empty: "Drop, paste (Ctrl+V) or 📂 load a picture — or Run once", children: [
                    // the final mask, live: covers what the Run leaves out with what the cutout will have there (Solid colour / Alpha checkerboard) (not with a wired mask: that one is only known at Run)
                    { t: "veil_element", id: "mv", show: "$state.maskView", off: "$live.maskWired",
                        x: "$native.x", y: "$native.y", w: "$native.w", h: "$native.h", box: "$native.box", boxFeather: "$native.box_feather",
                        brush: "$native.brush", grow: "$native.mask_grow", feather: "$native.mask_feather",
                        fill: "$native.solid_color", alpha: "$native.alpha" },
                    { t: "brush_element", id: "br", data: "$native.brush", active: "$state.paint",
                        size: "$state.brushSize", hardness: "$state.brushHard", opacity: "$state.brushOp", shape: "$state.brushShape", rightErase: true, veil: "$state.maskView" },
                    { t: "marquee_element", id: "mq", x: "$native.x", y: "$native.y", w: "$native.w", h: "$native.h", context: "$native.context",
                        enabled: "$native.box", locked: "$state.paint", snap: "$native.box_snap", lockX: "$state.lockW", lockY: "$state.lockH" },
                ] },
              // under the picture, foldable (starts folded): GLOBAL settings only — the method's options live in the tools menu (D-114)
              { t: "group_box", id: "box", gap: 6, style: { flex: "none" }, children: [
                { ...foldBtn("expandBtn", "Expand ▾", { width: "100%" }), visible: "!$state.tools" },
                { t: "stack_box", gap: 6, visible: "$state.tools", children: [
                  foldBtn("foldBtn", "Collapse ▴", { width: "100%" }),
                  // WORKSPACE: the whole picture is resized FIRST, the canvas and every output live at that size (D-120)
                  sec("WORKSPACE"),
                  { t: "label_element", variant: "hint", text: "Resizes the whole picture before cropping: canvas, mask and outputs all use this size." },
                  { t: "row_box", gap: 6, children: [nat("wsStep", "Resize (megapixels, 0 = real)", "workspace_mp", 0, 400, 0.1)] },
                  sec("Cropped area"),
                  { t: "row_box", gap: 6, children: [nat("ctxStep", "Increase area by (px)", "context", 0, 16384), nat("mulStep", "MULTIPLE by", "multiple", 1, 256)] },
                  { t: "row_box", gap: 6, children: [nat("outStep", "Resize output (megapixels, 0 = real)", "out_mp", 0, 400, 0.1)] },
                ] },
              ] },
            ] },
        },
    ],
    menus: {
        // ⬇ on the picture: which output to save as a PNG. No Queue needed (D-117): the Python runs the same crop on the node's
        // current widgets (picture loaded on the node, or the one the last Run got through a wire). Route /succy/crop/download.
        downloads: {
            kind: "menu_float_list",
            items: [
                { header: true, label: "Download as PNG (the node as it is now)" },
                ...[["Full image", "full_img"], ["Cutout", "cutout"], ["Mask (whole picture)", "mask"], ["Crop image", "crop_img"], ["Crop mask", "crop_mask"]]
                    .map(([label, which]) => ({ label, action: "$actions.download_system", route: `/succy/crop/download?node_id={id}&which=${which}`, post: true, name: "" })),
            ],
        },
        // right click on the picture (menu protocol v2, D-57): the active method and its options, compact. Closes clicking outside.
        tools: {
            kind: "menu_float_panel", look: "v2", size: "fit", width: 300, dock: "free", dismiss: "outside",
            title: "Crop #{{$live.self_node.id}}",
            tree: MENU_TREE,
        },
        // the (i) in the title bar (D-121): what this node does + every key combo. Plain text, wraps by itself.
        info: NodeStructure.infoMenu({
            title: "Succy Crop — cut me out, gently",
            about: "Show me what you want to keep — a box, a brush, or both — and I'll hand you the cut, the leftovers and the way back in. No Queue needed to play: drop a picture on me, paste it, or 📂 slide it in.",
            keys: [
                { keys: "Drag", does: "On empty canvas: draw a box. Inside it: move it. On an edge or corner: stretch it." },
                { keys: "Shift + drag", does: "Draw a perfect square. Some things are better when they're even." },
                { keys: "Alt + drag ↔", does: "Box: widen or narrow it from the centre. Brush: bigger or smaller tip." },
                { keys: "Alt + drag ↕", does: "Box: taller or shorter from the centre. Brush: harder (up) or softer (down)." },
                { keys: "Alt + wheel", does: "Box: both axes at once, same proportions. Brush: tip size. Never moves the centre, never leaves the picture." },
                { keys: "Left / right (brush)", does: "Left paints, right erases. Shift + click draws a straight line from where you last stopped." },
                { keys: "[ and ]", does: "Brush smaller / bigger, one gentle notch at a time." },
                { keys: "Right click", does: "Box mode: open the tools menu. Alt + right click (or ⚙): the same, in any mode." },
                { keys: "Wheel", does: "Zoom. Middle drag or Space + drag: pan. ⤢ brings you back." },
                { keys: "Ctrl + V · drop · 📂", does: "Hand me a picture without a Run." },
            ],
            notes: [
                "Red box edges = locked. Freeze the width or the height in ⚙ → Box lock; moving stays free, only stretching is refused.",
                "WORKSPACE resizes the whole picture first (in megapixels, 0 = untouched): the canvas, the mask and every output then play at that size. Cropped area shapes only the cut that leaves me.",
                "Outputs: stitch · full_img · cutout · mask · crop_img · crop_mask. ⬇ downloads any of them, no Queue needed.",
            ],
        }),
    },
    behaviors: [
        // the tools menu, just right of the pointer: right click in Rectangle, Alt + right click anywhere (in Free hand the plain
        // right button erases). No double click any more (D-115: it painted two dots and opened in the corner).
        { type: "open_float", menu: "tools", trigger: "vp", on: "contextmenu", when: "!$state.paint", alt: true },
        // wakes the picture feed up (subscribes this node to the previews the Python sends)
        { type: "feed_system", name: "shot_system" },
        // drop / paste / 📂 on the viewport: native upload to the input folder, file name in the `source` native
        { type: "load_mask", view: "vp", native: "source" },
        // the hold shield: same machine as Pause, own route/class. `ghost`: the hidden run_id widget leaves a socket behind.
        { type: "hold_node", route: "/succy/crop/action", info: "succy-crop-info", ghost: "run_id",
            names: { pause: "hold", timeout: "hold_timeout", runId: "run_id" } },
        { type: "gate_mask", region: "main" },
        { type: "info_node", menu: "info" },
        // chips on every socket: pick a source / see the destinations without dragging wires across the graph
        { type: "chip_input", input: "image", types: ["IMAGE"] },
        { type: "chip_input", input: "mask", types: ["MASK"] },
        { type: "chip_output", output: "stitch" },
        { type: "chip_output", output: "full_img" },
        { type: "chip_output", output: "cutout" },
        { type: "chip_output", output: "mask" },
        { type: "chip_output", output: "crop_img" },
        { type: "chip_output", output: "crop_mask" },
    ],
};

NodeStructure.define(TYPE, {
    minWidth: 340,
    defaultSize: [400, 720],
    natives: NATIVES,
    channels: ["heal", "undo", "redo"],
    order: ["ns_main"],
    state: {
        paint: { policy: "ui", default: false },
        brushSize: { policy: "ui", default: 64 }, brushHard: { policy: "ui", default: 50 },
        brushOp: { policy: "ui", default: 100 },
        maskView: { policy: "ui", default: true },
        lockW: { policy: "ui", default: false }, lockH: { policy: "ui", default: false },      // rectangle width / height frozen (D-120)
        brushShape: { policy: "ui", default: "round" },
        tools: { policy: "ui", default: false },                 // global settings under the picture: start FOLDED (D-121)
    },
    live: {
        // a wired mask replaces the box at Run time: the browser cannot know its shape, so the veil steps aside
        maskWired: (api) => { const n = api.liveNode?.() || api.node; return n?.inputs?.find?.((i) => i.name === "mask")?.link != null; },
    },
    actions: {
        // ⚙ on the picture: the tools menu, anchored to the button
        openTools(api, ev, el) { api.openMenu("tools", el ? { anchor: el } : { point: { x: ev?.clientX ?? 200, y: ev?.clientY ?? 200 } }); },
        openDownloads(api, ev, el) { api.openMenu("downloads", el ? { anchor: el } : { point: { x: ev?.clientX ?? 200, y: ev?.clientY ?? 200 } }); },
    },
    spec: SPEC,
    hooks: {
        onSetup(api) { api.native.hide(NATIVES); },
        refreshFromNative(api) { api.native.hide(NATIVES); },
        onRestore(api) { api.native.hide(NATIVES); },
    },
});

void SurvivalKit;
