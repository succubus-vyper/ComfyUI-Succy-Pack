// ============================================================
// Succy_Stitch.js — Succy Stitch as GLUE, NodeStructure v0.3 (Crop & Stitch phase 4, D-123/D-124/D-125)
// ONE panel (D-125): the Crop's picture with the worked crop already slipped back in, LIVE — and you retouch the seam right on it.
// No Queue needed when the worked picture is dropped / pasted / loaded: ⧉ / ⬇ ask the Python for the full-resolution result.
// This file contains ONLY: spec (catalog pieces), config and the natives it hides. Zero DOM, zero CSS, zero timers.
//   the Crop on the stitch wire, as it is now (R2) ............................... `$live.peek_system` (SurvivalKit nodePorts.inputNode / snapshot)
//   the Crop's picture + the stitched region on top ............................... `view_box` + `stitch_element` (util/blend-math.js = the Python's formulas)
//   the worked picture (wire after a Run, or dropped / pasted on the view) ....... `$live.shot_system` + `load_mask` (reads the PNG's tEXt into `place`)
//   retouch brush ON the result: LEFT = worked wins, RIGHT = original stays ...... `brush_element` (PNG in the `brush` native, whole picture)
//   right click (brush off) / Alt + right click / ⚙: ONE panel, 3 tabs ........... `open_float` + menu v2 `tools`: Brush · Seam · Match (D-130)
//   the panel reopens on the last tab you used ..................................... `$state.tab` (immediate) + `$live.tabBrush/tabSeam/tabMatch`
//   ⧉ / ⬇ on the view: the result at full resolution .............................. `copy_system` / `download_system` + route /succy/stitch/render
//   Stop every run / Reuse · ▶ continue · ■ stop ................................... SurvivalKit.hold via `hold_node` (same shield as Crop / Pause)
//   seam: feather, mode, curve · colour / sharpness / grain match · opacity · aspect  natives, driven by the sliders in the ⚙ panel (D-129/D-130)
//   A|B compare before | after (drag the line) · ✥ move / scale the replacement ... `stitch_element` compare / move (natives offset_x, offset_y, scale)
//   nothing to stitch into yet: the three load boxes fill the black area ........... `drop_element` x3 in `starter` (D-129)
//   inputs stitch · base_image · mask · replacement, output composite ........... `chip_input` / `chip_output`
// Backend: Succy_Crop_Stitch/Succy_Crop_Stitch.py. Natives stay REAL (Python validates them) — only hidden; the controls below drive them.
// ============================================================
import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
import { NodeStructure } from "./NodeStructure/index.js";

const TYPE = "Succy_Stitch";
const NATIVES = ["feather", "feather_mode", "feather_curve", "color_match", "opacity", "aspect_mismatch", "sharpness_match", "grain_match", "offset_x", "offset_y", "scale", "source", "base_file", "mask_file", "brush", "place", "hold", "hold_timeout", "run_id"];
const RENDER = "/succy/stitch/render?node_id={id}";
const CROP = { crop: "$live.peek_system.post" };          // the Crop on the wire rides along with every Copy / Download

const sec = (text) => ({ t: "label_element", variant: "section", text });
const slide = (label, bind, min, max, step = 1, title) => ({ t: "field_element", kind: "range", label, bind, min, max, step, ...(title ? { title } : {}) });     // menus only
const seg = (id, bind, options, title) => ({ t: "segmented_element", id, bind, style: { flex: "1 1 auto" }, options, ...(title ? { title } : {}) });
const full = (label, child) => ({ t: "stack_box", gap: 2, children: [{ t: "label_element", variant: "caption", text: label }, child] });
// numbers as sliders with the value inside, like Crop (D-129): drag, click to type; `soft` = where the bar ends, typing goes up to max
const slider = (id, label, bind, min, max, step = 1, title, more = {}) => ({
    t: "stack_box", id: id + "Box", gap: 2, style: { flex: "1 1 0", minWidth: "0" }, ...(title ? { title } : {}), children: [
        { t: "label_element", variant: "caption", text: label },
        { t: "slider_element", id, bind, min, max, step, ...more, style: { flex: "none" } },
    ],
});
// the view's tools are one at a time (D-129): ✎ retouch · A|B compare · ✥ move
const tool = (text, key, title) => ({ text, title, active: "$state." + key, on: { click: { do: "$actions.pickTool", args: { key } } } });
// one load box per picture input (D-128): a wire on that input wins at Run, the box says so
const drop = (native, label, tone, wired, more = {}) => ({ t: "drop_element", native, label, tone, wired, ...more });

const TIPS = [
    { value: "round", label: "Round · soft edge", bg: "radial-gradient(circle, #fff 34%, rgba(255,255,255,0) 74%)", radius: "50%" },
    { value: "round_hard", label: "Round · solid", bg: "#fff", radius: "50%" },
    { value: "square", label: "Square · soft sides", bg: "#fff", shadow: "0 0 5px 1px rgba(255,255,255,.9)" },
    { value: "square_hard", label: "Square · solid", bg: "#fff" },
];

// the ⚙ panel (right click with the brush off · Alt + right click · ⚙), ONE panel with 3 tabs (D-130): it reopens on the last tab used.
// Brush = Crop's Free hand word for word (D-114/D-120) · Seam = how the edge fades · Match = colour / detail / grain + where it sits.
const BRUSH_TAB = { t: "stack_box", gap: 8, visible: "$live.tabBrush", children: [
    { t: "toggle_element", id: "swapTglM", label: "⇄ Swap buttons", bind: "$state.brushSwap", title: "On: LEFT button erases, RIGHT button paints (the other way round)" },
    { t: "row_box", class: "ns-slim", gap: 6, children: [
        { t: "toggle_element", id: "paintTgl", label: "Retouch", bind: "$state.paint", style: { flex: "1 1 auto" } },
        { t: "toggle_element", id: "strokeTgl", label: "Hide strokes", bind: "$state.clean", style: { flex: "1 1 auto" } },
    ] },
    sec("Retouch brush"),
    { t: "label_element", variant: "hint", text: "Left button: the worked picture wins · right button: the original stays (⇄ swaps them) · Alt + drag: size ↔ hardness · Alt + wheel: size" },
    slide("Size ( [ ] )", "$state.brushSize", 1, 1024),
    slide("Hardness %", "$state.brushHard", 0, 100),
    slide("Opacity %", "$state.brushOp", 1, 100),
    { t: "button_element", id: "clrBrushM", class: "ns-btn", text: "Clear retouch", on: { click: { do: "$actions.set_node", args: { native: "brush", value: "" } } } },
    sec("Brush tip"),
    { t: "swatch_element", bind: "$state.brushShape", rows: 3, options: TIPS },
] };
const SEAM_TAB = { t: "stack_box", gap: 8, visible: "$live.tabSeam", children: [
    { t: "label_element", variant: "hint", text: "Inside fades within the selection, Outside into what lies around it, Centre half and half. ◐ on the picture shows the seam itself." },
    { t: "row_box", gap: 6, children: [
        slider("featherStep", "Feather (px)", "$native.feather", 0, 2048, 1, "Seam softness in region pixels (0 = hard edge) · the bar goes to 256, click to type more", { soft: 256 }),
        slider("opStep", "Opacity", "$native.opacity", 0, 1, 0.01),
    ] },
    // one per line: three choices side by side get cut short in a 340 px panel
    full("Mode", seg("modeSeg", "$native.feather_mode", [{ value: "inside", label: "Inside", tone: "info" }, { value: "centered", label: "Centre", tone: "ok" }, { value: "outside", label: "Outside", tone: "warn" }])),
    full("Curve", seg("curveSeg", "$native.feather_curve", [{ value: "smooth", label: "Smooth", tone: "ok" }, { value: "linear", label: "Linear", tone: "orange" }])),
    sec("Proportions"),
    { t: "label_element", variant: "hint", text: "When the replacement's proportions differ from the cut. Auto = Crop centre under 2%, otherwise Stretch with a warning." },
    seg("aspSeg", "$native.aspect_mismatch", [{ value: "auto", label: "Auto", tone: "ok" }, { value: "stretch", label: "Stretch", tone: "warn" }, { value: "crop_center", label: "Crop centre", tone: "info" }, { value: "fit", label: "Fit", tone: "orange" }]),
] };
const MATCH_TAB = { t: "stack_box", gap: 8, visible: "$live.tabMatch", children: [
    { t: "label_element", variant: "hint", text: "Colour is measured around the cut, detail and grain inside it: the worked crop takes the original's colour, sharpness and grain. A|B on the picture to compare." },
    { t: "row_box", gap: 6, children: [
        slider("cmStep", "Colour %", "$native.color_match", 0, 100, 1, "Pull the worked colours toward the original"),
        slider("shStep", "Sharpness %", "$native.sharpness_match", 0, 100, 1, "100 = the original's fine detail: a soft upscale gets sharper, an over-crisp one calmer"),
        slider("grStep", "Grain %", "$native.grain_match", 0, 100, 1, "Add back the grain the worked crop lacks (monochrome noise) · 100 = the original's grain"),
    ] },
    sec("Position"),
    { t: "label_element", variant: "hint", text: "Nudge the replacement inside the cut when it came back shifted. ✥ on the picture: drag = move, Alt + drag / Alt + wheel = scale." },
    { t: "row_box", gap: 6, children: [
        slider("oxStep", "Offset X (px)", "$native.offset_x", -16384, 16384, 1, "Move right (+) / left (−) · click to type", { softMin: -256, soft: 256 }),
        slider("oyStep", "Offset Y (px)", "$native.offset_y", -16384, 16384, 1, "Move down (+) / up (−) · click to type", { softMin: -256, soft: 256 }),
        slider("scStep", "Scale %", "$native.scale", 10, 400, 0.1, "Scale around the cut's centre · the bar goes 50..200, click to type 10..400", { softMin: 50, soft: 200 }),
    ] },
    { t: "button_element", id: "posReset", class: "ns-btn", text: "Reset position", on: { click: { do: "$actions.resetPlace" } } },
] };
const MENU_TREE = { t: "stack_box", gap: 8, style: { padding: "10px 12px 12px" }, children: [
    { t: "segmented_element", id: "tabSeg", bind: "$state.tab", options: [
        { value: "brush", label: "Brush", tone: "warn" },
        { value: "seam", label: "Seam", tone: "info" },
        { value: "match", label: "Match", tone: "ok" },
    ] },
    BRUSH_TAB, SEAM_TAB, MATCH_TAB,
] };

const wiredIn = (api, name) => { const n = api.liveNode?.() || api.node; return n?.inputs?.find?.((i) => i.name === name)?.link != null; };

/* ---------- spec ---------- */
export const SPEC = {
    v: 1,
    // ONE region, free height (same reason as Crop, D-106): the panels take whatever room the node has
    layout: { heightMode: "free" },
    regions: [
        {
            id: "main", height: { value: 520, min: 420, flex: true },
            tree: { t: "stack_box", id: "page", gap: 6, style: { height: "100%" }, children: [
                // top bar, compact, like Crop: Stop every run / Reuse · ▶ continue · ■ stop; the timer only while waiting; one status line
                { t: "stack_box", gap: 4, style: { flex: "none" }, children: [
                    { t: "row_box", class: "ns-slim", gap: 6, children: [
                        { t: "segmented_element", id: "holdSeg", bind: "$native.hold", style: { flex: "1 1 auto" },
                            title: "Stop = wait on every Run so you can retouch the fresh result · Reuse = run on with the current retouch", options: [
                            { value: true, label: "Stop", tone: "warn" },
                            { value: false, label: "Reuse", tone: "ok" },
                        ] },
                        { t: "button_element", id: "goBtn", class: "ns-btn-act ns-slim ns-tone-ok", style: { flex: "0 0 auto" }, text: "▶", title: "{{$cache.holdLabel}}", disabled: "$cache.holdOff",
                            on: { click: { do: "$actions.release_graph", args: { do: "continue" } } } },
                        { t: "button_element", id: "stopBtn", class: "ns-btn-act ns-slim ns-tone-danger", style: { flex: "0 0 auto" }, text: "■", title: "Stop", disabled: "$cache.holdOff",
                            on: { click: { do: "$actions.release_graph", args: { do: "stop" } } } },
                        // debug mask surface on the same line (D-128): blacks out the original, only the worked part stays lit
                        { t: "row_box", gap: 4, style: { flex: "0 0 auto", alignItems: "center" },
                            title: "Debug mask surface: blacks out the original (0 = off, 100 = solid black) so you can judge the feather even when the worked part looks just like the base", children: [
                            { t: "label_element", variant: "caption", text: "Debug mask" },
                            { t: "slider_element", id: "dimStep", bind: "$state.dim", min: 0, max: 100, step: 5, style: { flex: "none", width: "92px" } },
                        ] },
                    ] },
                    { t: "status_element", id: "status", size: "m", visible: "!$cache.holdOff", label: "$cache.holdText", value: "$cache.holdTimer", tone: "$cache.holdTone", labelTone: "$cache.holdTone" },
                    { t: "label_element", id: "say", variant: "hint", text: "{{$cache.stInfo}}" },
                ] },
                // the view: the result, live, and the brush right on it — ALL the room under the top bar (D-130: no Expand any more, the ⚙ panel holds the settings)
                // nothing to stitch into yet (D-129): the three load boxes take the black area, so it is clear WHAT goes WHERE
                { t: "stack_box", id: "starter", gap: 8, visible: "!$live.ready", style: { flex: "1 1 0", minHeight: "180px", padding: "10px", background: "#0b0b0d", borderRadius: "6px", justifyContent: "center" }, children: [
                    { t: "label_element", variant: "hint", text: "Wire a Succy Crop into stitch (then only the Replacement is needed) — or load the three pictures here. A wire on the same input wins at Run." },
                    { t: "row_box", gap: 6, style: { flexWrap: "wrap", flex: "1 1 auto", alignItems: "stretch" }, children: [
                        drop("base_file", "Base image", "info", "$live.wiredBase", { hint: "The picture to stitch INTO · click · drop · Ctrl+V" }),
                        drop("mask_file", "Mask", "orange", "$live.wiredMask", { hint: "White = replace (whole picture) · click · drop · Ctrl+V" }),
                        drop("source", "Replacement", "ok", "$live.wiredRepl", { hint: "The worked crop, any size · click · drop · Ctrl+V", meta: "place", shot: true }),
                    ] },
                ] },
                { t: "view_box", id: "vp", dblfit: false, visible: "$live.ready", style: { flex: "1 1 0", minHeight: "180px", height: "auto" },
                    src: "$live.peek_system.src", width: "$live.peek_system.width", height: "$live.peek_system.height",
                    empty: "Base image and mask come from a wire: Run once (the live view can't see wires)",
                    buttons: [
                        tool("✎", "paint", "Retouch brush on / off (lit = on)"),
                        tool("A|B", "cmp", "Compare: before | after — drag anywhere on the picture to move the line"),
                        tool("✥", "move", "Move the replacement: drag = move · Alt + drag / Alt + wheel = scale (numbers in ⚙ → Match → Position)"),
                        { text: "◐", title: "Seam view: the seam mask instead of the result (white = worked, black = original) — see what Feather / Mode / Curve do", active: "$state.seam",
                            on: { click: { do: "$actions.flip_node", args: { key: "seam" } } } },
                        { text: "⚙", title: "Brush · Seam · Match (or right click with the brush off · Alt + right click) — reopens on the last tab", on: { click: { do: "$actions.openTools" } } },
                        { text: "⧉", title: "Copy the result at FULL resolution (localhost / https only)",
                            on: { click: { do: "$actions.copy_system", args: { kind: "image", route: RENDER, post: true, body: CROP, flash: "cpFlash" } } } },
                        { text: "⬇", title: "Download the result as a PNG at FULL resolution",
                            on: { click: { do: "$actions.download_system", args: { route: RENDER, post: true, body: CROP, name: "", flash: "dlFlash" } } } },
                    ], children: [
                        { t: "stitch_element", id: "st", crop: "$live.peek_system", work: "$live.shot_system.src",
                            feather: "$native.feather", mode: "$native.feather_mode", curve: "$native.feather_curve", colorMatch: "$native.color_match",
                            opacity: "$native.opacity", aspect: "$native.aspect_mismatch", brush: "$native.brush",
                            sharp: "$native.sharpness_match", grain: "$native.grain_match", offsetX: "$native.offset_x", offsetY: "$native.offset_y", scale: "$native.scale",
                            move: "$state.move", compare: "$state.cmp", split: "$state.split",
                                baseFile: "$native.base_file", maskFile: "$native.mask_file", wired: "$live.wiredBM", place: "$native.place", seam: "$state.seam", dim: "$state.dim", report: "stInfo" },
                        { t: "brush_element", id: "br", data: "$native.brush", active: "$live.paintOn", veil: "$state.clean",
                            size: "$state.brushSize", hardness: "$state.brushHard", opacity: "$state.brushOp", shape: "$state.brushShape", rightErase: true, swap: "$state.brushSwap" },
                    ] },
            ] },
        },
    ],
    menus: {
        // the ⚙ panel, just right of the pointer (menu protocol v2, D-57), draggable. Closes clicking outside; reopens on the last tab (D-130).
        tools: {
            kind: "menu_float_panel", look: "v2", size: "fit", width: 340, dock: "free", dismiss: "outside",
            title: "Stitch #{{$live.self_node.id}}",
            tree: MENU_TREE,
        },
        info: NodeStructure.infoMenu({
            title: "Succy Stitch — put it back, gently",
            about: "I take what Crop cut out — worked, repainted, upscaled, any size — and slip it back where it belongs, seam and all. You see the result live and retouch it right there: your brush has the last word. No Queue needed: drop the worked picture on me and ⧉ copy or ⬇ download the full-resolution result.",
            keys: [
                { keys: "Left drag", does: "Retouch: the worked picture wins where you paint." },
                { keys: "Right drag", does: "Retouch: the original stays where you erase. Shift + click draws a straight line." },
                { keys: "Alt + drag · Alt + wheel", does: "Brush size (sideways) and hardness (up / down) · size." },
                { keys: "[ and ]", does: "Brush smaller / bigger." },
                { keys: "Right click (brush off) · Alt + right click · ⚙", does: "The panel: Brush (size, hardness, tip, clear) · Seam (feather, mode, curve, proportions) · Match (colour, sharpness, grain, position). It reopens on the last tab." },
                { keys: "Wheel", does: "Zoom. Middle drag or Space + drag: pan. ⤢ brings you back." },
                { keys: "Ctrl + V · drop on the picture", does: "Hand me the worked picture (the Replacement), no Run." },
                { keys: "A|B · ✥", does: "Compare before | after (drag the line) · move the replacement (drag; Alt + drag / Alt + wheel = scale)." },
            ],
            notes: [
                "The Crop on the stitch wire tells me where to go, as it is NOW: move its box and I follow. A PNG downloaded from Crop also carries where it was cut — if the Crop moved since, I tell you.",
                "No Crop? Give me a Base image and a Mask (white = replace, whole picture): the cut is the mask's box. A Base image alone replaces the Crop's picture (same size).",
                "Any size, any service: the worked picture is scaled back to the cut by itself. Different proportions: Auto trims the centre under 2%, otherwise it stretches and warns.",
                "⧉ / ⬇ redo everything at full resolution in Python — the same pixels a Queue gives. The live view works smaller to stay quick.",
                "Stop every run: I wait after each Run so you can retouch the fresh result, then ▶ carries on with it.",
            ],
        }),
    },
    behaviors: [
        // the ⚙ panel: right click with the brush off, Alt + right click always (with the brush on the plain right button erases).
        // The event is always ours: never the browser's menu.
        { type: "open_float", menu: "tools", trigger: "vp", on: "contextmenu", when: "!$state.paint", alt: true },
        { type: "feed_system", name: "peek_system" },
        { type: "feed_system", name: "shot_system" },
        // drop / paste on the view (no 📂 there, D-129: the three boxes say what goes where): native upload, file name in `source`, the PNG's tEXt succy_crop in `place`
        { type: "load_mask", view: "vp", native: "source", meta: "place", button: false },
        // the hold shield: same machine as Crop / Pause, same route. `ghost`: the hidden run_id widget leaves a socket behind.
        { type: "hold_node", route: "/succy/crop/action", info: "succy-crop-info", ghost: "run_id",
            names: { pause: "hold", timeout: "hold_timeout", runId: "run_id" } },
        { type: "gate_mask", region: "main" },
        { type: "info_node", menu: "info" },
        { type: "chip_input", input: "stitch", types: ["STITCH"] },
        { type: "chip_input", input: "base_image", types: ["IMAGE"] },
        { type: "chip_input", input: "mask", types: ["MASK"] },
        { type: "chip_input", input: "replacement", types: ["IMAGE"] },
        { type: "chip_output", output: "composite" },
    ],
};

NodeStructure.define(TYPE, {
    minWidth: 340,
    defaultSize: [440, 640],
    natives: NATIVES,
    channels: ["heal", "undo", "redo"],
    order: ["ns_main"],
    config: { peek_system: { input: "stitch", file: "base_file" } },
    live: {
        // which picture inputs have a wire (it wins at Run; the load boxes and the live view say so)
        wiredBase: (api) => wiredIn(api, "base_image"), wiredMask: (api) => wiredIn(api, "mask"), wiredRepl: (api) => wiredIn(api, "replacement"),
        wiredBM: (api) => wiredIn(api, "base_image") || wiredIn(api, "mask"),
        // something to stitch INTO (D-129): a Crop on the wire, or base + mask (loaded or wired). Until then the load boxes show.
        ready: (api) => wiredIn(api, "stitch") || ((!!api.native.get("base_file") || wiredIn(api, "base_image")) && (!!api.native.get("mask_file") || wiredIn(api, "mask"))),
        paintOn: (api) => !!api.state.get("paint") && !api.state.get("cmp") && !api.state.get("move"),
        // the ⚙ panel's tabs (D-130): one shows at a time; an unknown value falls back to Brush
        tabBrush: (api) => !["seam", "match"].includes(api.state.get("tab")),
        tabSeam: (api) => api.state.get("tab") === "seam",
        tabMatch: (api) => api.state.get("tab") === "match",
    },
    state: {
        paint: { policy: "ui", default: true },
        seam: { policy: "ui", default: false },
        dim: { policy: "ui", default: 0 },                       // debug mask surface 0..100 (D-127)
        clean: { policy: "ui", default: true },                  // true = no pink / black tints over the live result (the result shows it)
        brushSize: { policy: "ui", default: 64 }, brushHard: { policy: "ui", default: 50 },
        brushOp: { policy: "ui", default: 100 },
        brushShape: { policy: "ui", default: "round" },
        brushSwap: { policy: "ui", default: false },              // swapped buttons: left erases, right paints (D-126)
        tab: { policy: "immediate", default: "brush" },         // the ⚙ panel's last tab: brush | seam | match (D-130) — she remembers where you left her
        cmp: { policy: "ui", default: false },                   // A|B compare before | after (D-129)
        split: { policy: "ui", default: 0.5 },                   // where the compare line is, 0..1 of the picture width
        move: { policy: "ui", default: false },                  // ✥ move / scale the replacement (D-129)
    },
    actions: {
        // ✎ A|B ✥: one tool at a time; clicking the lit one switches it off
        pickTool(api, ev, el, item, args) {
            const key = args?.key, on = !api.state.get(key);
            for (const k of ["paint", "cmp", "move"]) api.state.set(k, k === key ? on : false);
            api.refresh();
        },
        resetPlace(api) { api.native.set("offset_x", 0); api.native.set("offset_y", 0); api.native.set("scale", 100); api.refresh(); },
        // ⚙ on the view: the brush menu, anchored to the button
        openTools(api, ev, el) { api.openMenu("tools", el ? { anchor: el } : { point: { x: ev?.clientX ?? 200, y: ev?.clientY ?? 200 } }); },
    },
    spec: SPEC,
    hooks: {
        onSetup(api) { api.native.hide(NATIVES); },
        refreshFromNative(api) { api.native.hide(NATIVES); },
        onRestore(api) { api.native.hide(NATIVES); },
    },
});

void SurvivalKit;
