// ============================================================
// pieces/note.js — "note/label with effects" domain (formerly Succy_Label.js v5, taken apart)
//   component: note_box      box with text, background (color/gradient/animated on canvas),
//                            pattern overlay, border and text style from JSON effects
//   io:        style_system  style menu fields (per section) read from the same JSONs
// The JSONs live in the NODE's folder (the glue says where: config.note_box). The canvas
// engine is fx/note-engine.js, the data fx/note-store.js. The menu is a normal v2 menu (D-57)
// with form_box: no handmade editor.
// Contract with the effect JSONs (unchanged since Label v5): classes .succy-label-display,
// .succy-label-text, .succy-label-pattern-inner and attributes data-text-style / data-border-style /
// data-pattern-anim; variables --sl-*.
// ============================================================
import { piece } from "../catalog/registry.js";
import { C, ex, exb, S, R, K, N } from "../catalog/kit.js";
import { mkEl } from "../components/index.js";
import { INSTANCES } from "../core/runtime.js";
import { GOV } from "../../Governor/governor.js";
import { NoteFx } from "../fx/note-engine.js";
import {
    noteStore, loadNote, entry, defaultId, defaultOf, uiOptions, optionsOf, valuesOf, normColor, hexRgb, hexAlpha, hexRgba,
    patternDuration, bgPalette, KEYMAP,
} from "../fx/note-store.js";

const FX = new NoteFx();
// Ctrl+Z / tab switch: ComfyUI reloads the graph and the box is reborn. To keep the background from "flashing":
// the canvas's last frame and the animation state wait here a few seconds for the same key. No flashing in public.
const KEEP = new Map();          // scope -> { snap, timer }
const KEEP_MS = 4000;
const storeOf = (rt) => noteStore(rt.api.cfg("note_box"));

// ---------------- piece CSS (box infrastructure, formerly Label's "BASE CSS") ----------------
// The .succy-label-* element selectors have the SAME specificity as Label v5: the JSON effects (loaded later)
// must be able to override them (e.g. the borders' ::after, the glitch's animation-delay). Don't add prefixes.
const NOTE_CSS = `
.ns-note{position:relative;width:100%;height:100%;display:flex;flex-direction:column;box-sizing:border-box;overflow:visible}
.ns-note-ctl{position:absolute;top:-15px;right:-15px;z-index:20;display:flex;gap:4px;opacity:0;pointer-events:none;transition:opacity .15s}
.ns-note:hover .ns-note-ctl,.lg-node:hover .ns-note-ctl,.ns-note-ctl:focus-within{opacity:1;pointer-events:auto}
.ns-note-ctl .ns-btn{width:28px;height:28px;min-width:0;padding:0;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font:16px system-ui;background:var(--ns-c-menu-bg, rgba(20,22,28,.92));color:var(--ns-c-text, #e0e0e0);border:1px solid var(--ns-border-hi, rgba(255,255,255,.35));box-shadow:0 2px 8px var(--ns-c-shadow, rgba(0,0,0,.5));cursor:pointer}
.ns-note-ctl .ns-btn:hover{background:var(--ns-c-accent-tint, rgba(74,158,255,.35));color:var(--ns-c-text-strong, #fff)}
.succy-label-display{flex:1;display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch;position:relative;box-sizing:border-box;line-height:1.3;width:100%;height:100%;overflow:hidden;cursor:default;isolation:isolate}
.succy-label-bg-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:0}
.succy-label-pattern{position:absolute;inset:0;pointer-events:none;z-index:3}
.succy-label-pattern-inner{position:absolute;top:-100px;left:-100px;right:-100px;bottom:-100px;will-change:transform,opacity}
.succy-label-pattern-inner::after{content:"";position:absolute;inset:0;pointer-events:none;background-image:var(--sl-pat-bg,none);background-size:var(--sl-pat-size,auto);background-position:var(--sl-pat-pos,0 0);background-repeat:repeat;opacity:0;will-change:transform,clip-path,opacity,filter}
.succy-label-text{position:relative;z-index:2;width:100%;white-space:pre-wrap;word-wrap:break-word;box-sizing:border-box;transition:background .2s,box-shadow .2s,border-radius .2s}
.succy-label-placeholder{opacity:.4;font-style:italic;user-select:none;pointer-events:none}
.sl-border-pseudo{position:relative}
.sl-border-pseudo::after{content:"";position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:5;border-radius:inherit}
.succy-label-display .succy-label-text::before,.succy-label-display .succy-label-text::after{animation-delay:var(--sl-delay-text,0s)}
.succy-label-display.sl-border-pseudo::after{animation-delay:var(--sl-delay-border,0s)}
.ns-root[data-ns-anim="off"] .ns-note *,.ns-root[data-ns-anim="off"] .ns-note *::before,.ns-root[data-ns-anim="off"] .ns-note *::after{animation-play-state:paused!important}
`;

// ---------------- note_box ----------------
piece(C("note_box", {
    scopo: "Riquadro-nota: testo stilizzato, sfondo (colore/gradiente/canvas animato), overlay e bordo da JSON effetti (config.note_box).",
    natura: "estetica", dominio: "ui", estado: "draft", archetipo: "container",
    tag: ["nota", "effetti", "testo", "canvas"], css: NOTE_CSS,
    props: {
        state: { ...K("chiave di stato con il JSON dello stile {sezione:{chiave:valore}} (scritto dal form_box del menu)"), required: true },
        empty: R("testo mostrato (attenuato) quando il testo e' vuoto (letterale o $ref; \"\" = niente). Default: \"Double-click to edit\""),
        dim: R("se vero il testo e' mostrato attenuato (es. 'in attesa')"),
        fps: N("fotogrammi al secondo dello sfondo animato", 30),
    },
    esempio: ex({ t: "note_box", text: "ciao", state: "st" }, { config: { note_box: { route: "/__none__/" } }, state: { st: { policy: "ui", default: "" } } }),
}), (node, h) => {
    const { rt } = h;
    const st = storeOf(rt);
    const el = mkEl("div", "ns-note");
    const display = mkEl("div", "succy-label-display sl-border-pseudo");
    const cv = mkEl("canvas", "succy-label-bg-canvas");
    const pat = mkEl("div", "succy-label-pattern");
    const patIn = mkEl("div", "succy-label-pattern-inner");
    const txt = mkEl("div", "succy-label-text");
    const ctl = mkEl("div", "ns-note-ctl");
    pat.appendChild(patIn);
    display.append(cv, pat, txt);
    el.append(display, ctl);

    const scope = rt.ctx.key;
    const bg = { style: null, palette: ["#000000", "#888888", "#ffffff"], speed: 5 };
    let time = Number(rt.ctx.cache.get("__note_t")) || 0;
    let canvasOn = false, lastSig = "", lastPat = "", patDur = 1;

    const render = (dt, g, w, hh) => {
        if (GOV.level >= 2) return;                       // throttle: stopped/off -> the last frame stays
        const eff = entry(st, "background", bg.style);
        if (!eff) { g.clearRect(0, 0, w, hh); return; }
        const ds = dt * bg.speed * 0.2;
        time += ds;
        rt.ctx.cache.set("__note_t", time);
        try { FX.run(eff, g, { w, h: hh, t: time, dt: ds, colors: bg.palette, speed: bg.speed || 5, scopeKey: scope }); }
        catch (e) { rt.warnOnce("note-bg", e); }
    };
    const setCanvas = (on) => {
        if (on === canvasOn) return;
        canvasOn = on;
        if (on) rt.ctx.perf.acquireCanvas(cv, { fps: Number(h.val(node.fps)) || 30, render });
        else { try { rt.ctx.perf.releaseCanvas(cv); } catch (_) {} try { cv.getContext("2d")?.clearRect(0, 0, cv.width, cv.height); } catch (_) {} }
    };
    // rebirth: pick up the last frame (no flash) and cancel forgetting the animation state
    const kept = KEEP.get(scope);
    if (kept) { clearTimeout(kept.timer); KEEP.delete(scope); }
    if (kept?.snap) rt.api.whenConnected(cv, () => {
        try {
            const r = cv.getBoundingClientRect(), dpr = globalThis.devicePixelRatio || 1;
            const w = Math.floor(r.width * dpr), hh = Math.floor(r.height * dpr);
            if (w > 0 && hh > 0) { cv.width = w; cv.height = hh; cv.getContext("2d").drawImage(kept.snap, 0, 0, w, hh); }
        } catch (_) {}
    });
    h.bag.add(() => {
        let snap = null;
        if (canvasOn && cv.width > 0 && cv.height > 0) { try { snap = document.createElement("canvas"); snap.width = cv.width; snap.height = cv.height; snap.getContext("2d").drawImage(cv, 0, 0); } catch (_) { snap = null; } }
        setCanvas(false);
        const timer = setTimeout(() => { KEEP.delete(scope); FX.forget(scope); }, KEEP_MS);
        KEEP.set(scope, { snap, timer });
    });

    const applyPattern = (v) => {
        const key = [v.pattern, v.pattern_color, v.pattern_color_b, v.pattern_blend, v.pattern_animation, v.pattern_speed, st.gen].join("|");
        if (key === lastPat) return;
        lastPat = key;
        const s = patIn.style;
        s.animation = ""; s.animationDelay = ""; s.backgroundImage = "none"; s.backgroundSize = ""; s.backgroundPosition = ""; s.filter = "";
        pat.style.mixBlendMode = "normal";
        for (const [k, x] of [["--sl-pat-tx", "0px"], ["--sl-pat-ty", "0px"], ["--sl-pat-bg", "none"], ["--sl-pat-size", "auto"], ["--sl-pat-pos", "0 0"], ["--sl-pat-dur", "1s"]]) s.setProperty(k, x);
        delete patIn.dataset.patternAnim;
        patDur = 1;
        const e = v.pattern && v.pattern !== defaultId(st, "pattern") ? entry(st, "pattern", v.pattern) : null;
        if (!e || !e.css) { s.top = s.left = s.right = s.bottom = "0"; return; }
        const c = hexRgba(normColor(v.pattern_color, "#2dd4bf26")), cb = hexRgba(normColor(v.pattern_color_b, "#ff2bd626"));
        const img = String(e.css).replaceAll("{{color}}", c).replaceAll("{{color_b}}", cb);
        s.backgroundImage = img;
        if (e.size) s.backgroundSize = e.size;
        if (e.position) s.backgroundPosition = e.position;
        pat.style.mixBlendMode = v.pattern_blend && v.pattern_blend !== "default" ? v.pattern_blend : (e.blendMode || "normal");
        s.setProperty("--sl-pat-bg", img); s.setProperty("--sl-pat-size", e.size || "auto"); s.setProperty("--sl-pat-pos", e.position || "0 0");
        const tile = Number(e.tile) || 20;
        s.setProperty("--sl-pat-tx", `-${tile}px`); s.setProperty("--sl-pat-ty", `-${tile}px`);
        s.top = s.left = s.right = s.bottom = `-${tile + 4}px`;
        patDur = patternDuration(st, tile, v.pattern_speed);
        s.setProperty("--sl-pat-dur", patDur + "s");
        const anim = v.pattern_animation && v.pattern_animation !== defaultId(st, "overlayStyle") ? entry(st, "overlayStyle", v.pattern_animation) : null;
        if (anim?.keyframe) { s.animation = `${anim.keyframe} ${patDur}s linear infinite`; patIn.dataset.patternAnim = v.pattern_animation; }
    };

    const apply = () => {
        const text = h.val(node.text), dim = !!h.val(node.dim);
        const raw = rt.ctx.state.get(node.state);
        const empty = h.val(node.empty) ?? "Double-click to edit";
        const sig = `${st.gen}\x1f${text}\x1f${dim}\x1f${raw}\x1f${empty}`;
        if (sig === lastSig) return;
        lastSig = sig;
        const v = valuesOf(st, raw);
        const ds = display.style;

        const t = text == null ? "" : String(text);
        txt.textContent = t || String(empty);
        txt.dataset.text = t;
        txt.classList.toggle("succy-label-placeholder", !t || dim);

        const fCol = normColor(v.font_color, "#ffffffff"), bCol = normColor(v.bg_color, "#00000080");
        const bdCol = normColor(v.border_color, "#00ffffff"), bdColB = normColor(v.border_color_b, "#ff0000ff");
        const bW = parseInt(v.border_width) || 0, rad = parseInt(v.border_radius) || 0;
        const tsCol = normColor(v.text_style_color, "#ff0000ff"), tsColB = normColor(v.text_style_color_b, "#00ffffff");
        const tsInt = parseInt(v.text_style_intensity), tsSpd = parseInt(v.text_style_speed);
        const tsSt = v.text_style || defaultId(st, "text"), bSt = v.border_style || defaultId(st, "border");
        const bGl = parseInt(v.border_glow) || 0;

        ds.textAlign = v.align || "left";
        ds.flexDirection = "column"; ds.alignItems = "stretch";
        ds.justifyContent = v.align_vertical === "center" ? "center" : v.align_vertical === "bottom" ? "flex-end" : "flex-start";
        ds.fontSize = (Number(v.font_size) || 24) + "px";
        ds.padding = (Number(v.padding) || 0) + "px";
        ds.lineHeight = String(parseFloat(v.line_height) || 1.3);
        let fn = String(v.font_family || "system-ui");
        if (fn.includes(" ")) fn = "'" + fn + "'";
        ds.fontFamily = txt.style.fontFamily = fn + ", sans-serif";

        const intVal = ((Number.isFinite(tsInt) ? tsInt : 50) / 50).toFixed(2);
        const durVal = (10 / ((Number.isFinite(tsSpd) ? tsSpd : 50) * 0.1 + 0.5)).toFixed(2) + "s";
        for (const [k, x] of [["--sl-font-col", fCol], ["--sl-bg-col", bCol], ["--sl-border-col", bdCol], ["--sl-border-col-b", bdColB], ["--sl-border-w", bW + "px"], ["--sl-rad", rad + "px"],
            ["--sl-ts-col", tsCol], ["--sl-ts-col-b", tsColB], ["--sl-ts-int", intVal], ["--sl-ts-dur", durVal]]) ds.setProperty(k, x);

        // animation continuity (undo, tab switch, reload): phase taken from the node's "born"
        const born = Number(rt.ctx.state.get("__ns_born")) || Date.now();
        const el0 = (Date.now() - born) / 1000;
        const phase = (d) => (d > 0 ? -(el0 % d) : 0).toFixed(3) + "s";
        if (display.dataset.textStyle !== tsSt) display.dataset.textStyle = tsSt;
        if (display.dataset.borderStyle !== bSt) display.dataset.borderStyle = bSt;
        const tsE = entry(st, "text", tsSt) || {}, bE = entry(st, "border", bSt) || {};
        const durSec = parseFloat(durVal) || 1;
        txt.style.animationDelay = phase(durSec * (Number(tsE.textMult) || 1));
        ds.setProperty("--sl-delay-text", phase(durSec * (Number(tsE.pseudoMult) || 0)));
        const bDur = Number(bE.borderDur) || 0;
        ds.animationDelay = phase(bDur);
        ds.setProperty("--sl-delay-border", phase(bDur));
        ds.setProperty("--sl-border-dur", (bDur || 1) + "s");

        ds.color = "var(--sl-font-col)";
        ds.backgroundColor = "var(--sl-bg-col)";
        ds.borderRadius = bE.ignoreRadius ? "0" : "var(--sl-rad)";

        const animated = !!v.bg_style && v.bg_style !== defaultId(st, "background");
        let grad = "none";
        if (!animated) {
            const g = uiOptions(st, "gradient").find((o) => o.id === v.bg_grad_style);
            if (g && g.type !== "none") {
                const bal = Number(v.bg_grad_balance), soft = Number(v.bg_grad_softness);
                const cA = hexRgba(bCol), cB = hexRgba(normColor(v.bg_grad_color, "#00808080"));
                const half = Math.max(0, Math.min(50, soft / 2)), s1 = Math.max(0, bal - half), s2 = Math.min(100, bal + half);
                grad = g.type === "radial"
                    ? `radial-gradient(circle at center, ${cA} 0%, ${cA} ${s1}%, ${cB} ${s2}%, ${cB} 100%)`
                    : `linear-gradient(${g.angle || 90}deg, ${cA} 0%, ${cA} ${s1}%, ${cB} ${s2}%, ${cB} 100%)`;
            }
        }
        ds.backgroundImage = grad;

        if (bE.noBorder) ds.border = "none";
        else if (bE.solidBorder) ds.border = `${bW}px solid var(--sl-border-col)`;
        else ds.border = `${bW}px ${bSt} var(--sl-border-col)`;

        const sh = [];
        if (bGl > 0 && bW > 0 && !bE.glowIgnored) {
            const c = hexRgb(bdCol), L = (x) => Math.round(x + (255 - x) * 0.45);
            sh.push(`0 0 ${(bGl / 100) * 45}px ${(bGl / 100) * 8}px rgba(${L(c.r)},${L(c.g)},${L(c.b)},0.85)`);
        }
        const shadowInt = parseInt(v.box_shadow) || 0;
        if (shadowInt > 0) {
            const sc = normColor(v.box_shadow_color, "#00000080"), c = hexRgb(sc);
            sh.push(`0 ${(shadowInt / 100) * 6}px ${(shadowInt / 100) * 30}px rgba(${c.r},${c.g},${c.b},${hexAlpha(sc)})`);
        }
        ds.boxShadow = sh.join(", ");

        applyPattern(v);
        patIn.style.animationDelay = `-${(el0 % (patDur || 1)).toFixed(3)}s`;

        bg.style = animated ? v.bg_style : null;
        bg.palette = bgPalette(st, v);
        bg.speed = Number(v.bg_speed) || 5;
        setCanvas(animated);
    };

    // data: loaded once for every note_box with the same config; on reload it redraws
    const onData = () => { lastSig = ""; lastPat = ""; if (!rt.destroyed) rt.update(); };
    st.listeners.add(onData);
    h.bag.add(() => st.listeners.delete(onData));
    loadNote(st);
    apply();
    return { el, container: ctl, update: apply, handlesText: true };
});

// ---------------- style_system: style menu fields ----------------
// Default schema (keys = the note_box contract). The glue can replace it with config.style_system.{tabs,fields}.
// Every field sits in a SECTION (sec) and in a SLOT: the slot is a fixed spot in the 2-column grid.
// Several fields can share a slot (the first one whose conditions are true shows); if none applies the slot
// stays EMPTY but keeps its place: the section doesn't change height and the one below doesn't move up (no dancing).
// if: [{key, is|not|min|has, meta?, dflt?}] -> all true. "@default" = default id of the family/option.
//   meta: field of the effect chosen for `key` (family) or of the chosen option (ui). has: the string is contained.
const NOT_DEF = (key) => ({ key, not: "@default" });
const IS_DEF = (key) => ({ key, is: "@default" });
const ANIM = NOT_DEF("bg_style"), BASIC = IS_DEF("bg_style"), GRAD = { key: "bg_grad_style", meta: "type", not: "none" };
const DEF_FIELDS = [
    // TEXT
    { sec: "text", slot: 1, key: "font_family", label: "Font", type: "select" },
    { sec: "text", slot: 2, key: "font_size", label: "Size", type: "range", min: 8, max: 200, step: 1 },
    { sec: "text", slot: 3, key: "font_color", label: "Color", type: "rgba" },
    { sec: "text", slot: 4, key: "line_height", label: "Line height", type: "range", min: 0.8, max: 2, step: 0.05 },
    { sec: "text", slot: 5, key: "align", label: "Align", type: "select" },
    { sec: "text", slot: 6, key: "align_vertical", label: "Vertical", type: "select" },
    // EFFECT (animated text style)
    { sec: "effect", slot: 1, key: "text_style", label: "Effect", type: "select" },
    { sec: "effect", slot: 2, key: "text_style_intensity", label: "Intensity", labelMeta: { key: "text_style", meta: "tsLabels.intensity" }, type: "range", min: 0, max: 100, step: 1, if: [{ key: "text_style", meta: "tsLabels.intensityOff", not: true }] },
    { sec: "effect", slot: 3, key: "text_style_color", label: "Effect color", type: "rgba", if: [{ key: "text_style", meta: "tsColors", min: 1, dflt: 1 }] },
    { sec: "effect", slot: 4, key: "text_style_speed", label: "Speed", labelMeta: { key: "text_style", meta: "tsLabels.speed" }, type: "range", min: 1, max: 100, step: 1, if: [{ key: "text_style", meta: "tsLabels.speedOff", not: true }] },
    { sec: "effect", slot: 5, key: "text_style_color_b", label: "Effect color 2", type: "rgba", if: [{ key: "text_style", meta: "tsColors", min: 2, dflt: 1 }] },
    { sec: "effect", slot: 6, key: "__blank" },
    // BACKGROUND (None = color/gradient; otherwise canvas animation). Animated and base share the slots.
    { sec: "back", slot: 1, key: "bg_style", label: "Animation", type: "select" },
    { sec: "back", slot: 2, key: "bg_speed", label: "Speed", type: "range", min: 0.1, max: 10, step: 0.1, if: [ANIM] },
    { sec: "back", slot: 2, key: "bg_grad_style", label: "Gradient", type: "select", if: [BASIC] },
    { sec: "back", slot: 3, key: "bg_palette", label: "Palette", type: "select", if: [ANIM] },
    { sec: "back", slot: 3, key: "bg_color", label: "Color", type: "rgba", if: [BASIC] },
    { sec: "back", slot: 4, key: "bg_color_a", label: "Color A · base", type: "rgba", if: [ANIM, IS_DEF("bg_palette")] },
    { sec: "back", slot: 4, key: "bg_grad_color", label: "Second color", type: "rgba", if: [BASIC, GRAD] },
    { sec: "back", slot: 5, key: "bg_color_b", label: "Color B · accent", type: "rgba", if: [ANIM, IS_DEF("bg_palette"), { key: "bg_style", meta: "colors", min: 2, dflt: 3 }] },
    { sec: "back", slot: 5, key: "bg_grad_balance", label: "Balance", type: "range", min: 0, max: 100, step: 1, if: [BASIC, GRAD] },
    { sec: "back", slot: 6, key: "bg_color_c", label: "Color C · highlight", type: "rgba", if: [ANIM, IS_DEF("bg_palette"), { key: "bg_style", meta: "colors", min: 3, dflt: 3 }] },
    { sec: "back", slot: 6, key: "bg_grad_softness", label: "Softness", type: "range", min: 0, max: 100, step: 1, if: [BASIC, GRAD] },
    // BOX (border, padding, shadow)
    { sec: "box", slot: 1, key: "border_style", label: "Border", type: "select" },
    { sec: "box", slot: 2, key: "border_width", label: "Width", type: "range", min: 0, max: 50, step: 1 },
    { sec: "box", slot: 3, key: "border_color", label: "Border color", type: "rgba" },
    { sec: "box", slot: 4, key: "border_color_b", label: "Border color 2", type: "rgba", if: [{ key: "border_style", meta: "borderColors", min: 2, dflt: 1 }] },
    { sec: "box", slot: 5, key: "border_radius", label: "Radius", type: "range", min: 0, max: 100, step: 1 },
    { sec: "box", slot: 6, key: "border_glow", label: "Glow", type: "range", min: 0, max: 100, step: 1 },
    { sec: "box", slot: 7, key: "padding", label: "Padding", type: "range", min: 0, max: 100, step: 1 },
    { sec: "box", slot: 8, key: "box_shadow", label: "Shadow", type: "range", min: 0, max: 100, step: 1 },
    { sec: "box", slot: 9, key: "box_shadow_color", label: "Shadow color", type: "rgba" },
    { sec: "box", slot: 10, key: "__blank" },
    // OVERLAY (pattern over the text) — a little lingerie for your words
    { sec: "over", slot: 1, key: "pattern", label: "Pattern", type: "select" },
    { sec: "over", slot: 2, key: "pattern_animation", label: "Animation", type: "select", if: [NOT_DEF("pattern")] },
    { sec: "over", slot: 3, key: "pattern_color", label: "Color", type: "rgba", if: [NOT_DEF("pattern")] },
    { sec: "over", slot: 4, key: "pattern_speed", label: "Speed", type: "range", min: 0.1, max: 10, step: 0.1, if: [NOT_DEF("pattern"), NOT_DEF("pattern_animation")] },
    { sec: "over", slot: 5, key: "pattern_color_b", label: "Color 2", type: "rgba", if: [NOT_DEF("pattern"), { key: "pattern", meta: "css", has: "{{color_b}}" }] },
    { sec: "over", slot: 6, key: "pattern_blend", label: "Blend", type: "select", if: [NOT_DEF("pattern")] },
];
// menu tabs: one section on top, another (optional) below
const DEF_TABS = [
    { value: "text", label: "Text", top: "text", bottom: "effect" },
    { value: "box", label: "Box", top: "back", bottom: "box" },
    { value: "over", label: "Overlay", top: "over" },
];
const DEF_TITLES = { text: "Text", effect: "Effect", back: "Background", box: "Border & box", over: "Overlay" };
const DEF_HINTS = { over: "The overlay is drawn on top of the text: keep the color alpha low." };

const dig = (o, path) => String(path).split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
// "chosen" object for a key: effect of the family or ui option
function chosen(s, key, val) {
    const m = KEYMAP[key];
    if (m?.[0] === "fam") return entry(s, m[1], val);
    if (m?.[0] === "ui") return uiOptions(s, m[1]).find((o) => o.id === val) || null;
    return null;
}
function defaultFor(s, key) {
    const m = KEYMAP[key];
    if (m?.[0] === "fam") return defaultId(s, m[1]);
    if (m?.[0] === "ui") return s.ui.get(m[1])?.default ?? "";
    return undefined;
}
function holds(s, v, c) {
    let x = v[c.key];
    if (c.meta) { x = dig(chosen(s, c.key, x), c.meta); if (x === undefined && c.dflt !== undefined) x = c.dflt; }
    const cmp = (y) => (y === "@default" ? defaultFor(s, c.key) : y);
    if ("is" in c) return x === cmp(c.is);
    if ("not" in c) return x !== cmp(c.not);
    if ("min" in c) return (typeof x === "number" ? x : Number(x)) >= c.min;
    if ("has" in c) return typeof x === "string" && x.includes(c.has);
    return true;
}

export const styleCfg = (rt) => rt.api.cfg("style_system");
// fields of a section, one per slot (empty slot = invisible row holding the spot)
function sectionRows(s, v, all, sec) {
    if (!sec) return [];
    const slots = new Map();
    let auto = 1000;
    for (const f of all) if (f.sec === sec) { const k = f.slot ?? auto++; if (!slots.has(k)) slots.set(k, []); slots.get(k).push(f); }
    const out = [];
    for (const [k, list] of [...slots.entries()].sort((a, b) => a[0] - b[0])) {
        const f = list.find((x) => x.key !== "__blank" && (x.if || []).every((c) => holds(s, v, c)));
        if (!f) { out.push({ key: `__slot_${sec}_${k}`, label: "", type: "text", hidden: true }); continue; }
        const lm = f.labelMeta ? dig(chosen(s, f.labelMeta.key, v[f.labelMeta.key]), f.labelMeta.meta) : undefined;
        // default = the JSON one (FIXED): the form_box reads the current value from state. If the default changed
        // on every edit, the grid would rebuild and sliders/color pickers would lose their drag.
        out.push({ key: f.key, label: typeof lm === "string" && lm ? lm : f.label, type: f.type, min: f.min, max: f.max, step: f.step,
            options: f.type === "select" ? optionsOf(s, f.key) : undefined, default: defaultOf(s, f.key) });
    }
    return out;
}
const styleSystem = (api) => {
    const rt = INSTANCES.get(api.node);
    const s = storeOf(rt), c = styleCfg(rt);
    const tabs = Array.isArray(c.tabs) ? c.tabs : DEF_TABS;
    const want = api.state.get(c.tabKey || "tab");
    const t = tabs.find((x) => x.value === want) || tabs[0] || {};
    const v = valuesOf(s, api.state.get(c.styleKey || "style"));
    const all = Array.isArray(c.fields) ? c.fields : DEF_FIELDS;
    const titles = c.titles || DEF_TITLES, hints = c.hints || DEF_HINTS;
    return {
        tabs: tabs.map((x) => ({ value: x.value, label: x.label })), tab: t.value,
        top: sectionRows(s, v, all, t.top), bottom: sectionRows(s, v, all, t.bottom),
        topScope: t.top || "", bottomScope: t.bottom || "_none", hasBottom: !!t.bottom,
        topTitle: titles[t.top] || "", bottomTitle: titles[t.bottom] || "",
        isText: t.value === (c.textTab || "text"), hint: hints[t.value] || "",
        loading: !s.loaded, hasErrors: s.errors.length > 0, errorsText: s.errors.length ? "effects: " + s.errors.join(" | ") : "",
        count: Object.values(s.fam).reduce((n, m) => n + m.size, 0),
    };
};
styleSystem.ensure = (api) => {
    const s = storeOf(INSTANCES.get(api.node));
    const refresh = () => api.refresh();
    s.listeners.add(refresh); api.onDispose(() => s.listeners.delete(refresh));
    loadNote(s);
};
styleSystem.reload = (api) => loadNote(storeOf(INSTANCES.get(api.node)), true);
piece(C("style_system", {
    scopo: "Menu di stile del note_box: schede, sezioni sopra/sotto a slot fissi (condizioni e scelte dai JSON degli effetti); reload/ensure.",
    natura: "funziona", dominio: "runtime", estado: "draft", tag: ["nota", "effetti", "form", "dati"], uses: ["note_box"], props: {},
    esempio: exb({ t: "form_box", fields: "$live.style_system.top", state: "st", scope: "$live.style_system.topScope" }, [{ type: "feed_system", name: "style_system" }],
        { config: { note_box: { route: "/__none__/" }, style_system: { styleKey: "st", tabKey: "tab" } }, state: { st: { policy: "ui", default: "" }, tab: { policy: "ui", default: "text" } } }),
}), styleSystem);
