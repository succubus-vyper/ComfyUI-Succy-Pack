// ============================================================
// NodeStructure/components/view.js — the VIEWPORT and the SELECTION (Crop & Stitch phase 2, D-105)
//   view_box        a stage you zoom (wheel) and pan (middle button / Space+drag); Alt+drag and Alt+wheel belong to the children (D-120); the picture lives in ORIGINAL pixels,
//                   so every child placed on it speaks image coordinates. Double click or the ⤢ button = fit. Wheel and drags never
//                   reach the graph (no accidental canvas zoom, no node dragged while you draw).
//   marquee_element a rectangle you draw (drag on empty stage), move (drag inside) and resize (8 handles) over a view_box. Shift while
//                   drawing = square. The numbers go to the bound natives (x, y, w, h) when you let go; context ring drawn dashed.
//                   Alt gestures (D-120): a child registers `view.alt({ active, start, drag, end, wheel })`; Alt + left drag / Alt + wheel go to the
//                   first ACTIVE one (rectangle: resize from the centre; brush: size and hardness). Pan is middle button / Space only.
//   shot_system     io: the latest picture a node is looking at ({ src, width, height }) from the shared shot-feed.
// The node never touches the DOM: it only names the pieces and the natives. Succubus was here — drag, resize, repeat. Gently.
// ============================================================
import { mkEl } from "./index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, N, S, R, B, J } from "../catalog/kit.js";
import { parseRef } from "../core/parser.js";
import { writeRef, runAction } from "../core/binding.js";
import { ShotFeed } from "../runtime/shot-feed.js";

const VIEWS = new Set();                       // live viewports (Governor counts them)
// zoom/pan survive a REBUILD of the node (ComfyUI's Ctrl+Z reloads the whole graph and recreates every node, D-109):
// remembered per graph uuid + node id + piece id, restored if the picture has the same size. She remembers where you were looking.
const VIEW_MEM = new Map();
const memKey = (rt, id) => { const n = rt?.node; return `${n?.graph?.id ?? n?.graph?.rootGraph?.id ?? "g"}:${n?.id ?? "?"}:${id ?? "view"}`; };
export const viewStats = () => ({ views: VIEWS.size, zoomed: [...VIEWS].filter((v) => !v.auto).length });

const CSS = `
.ns-view{position:relative;width:100%;height:100%;min-height:120px;overflow:hidden;background:#0b0b0d;border-radius:6px;box-shadow:inset 0 0 8px rgba(0,0,0,.6);touch-action:none;user-select:none;-webkit-user-select:none;cursor:crosshair;box-sizing:border-box}
.ns-view.pan{cursor:grab}.ns-view.panning{cursor:grabbing}.ns-view.alting{cursor:ew-resize}
.ns-view-stage{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.ns-view-img{position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none;-webkit-user-drag:none}
.ns-view-empty[hidden]{display:none}
.ns-view-empty{position:absolute;inset:0;display:grid;place-items:center;padding:12px;text-align:center;font-size:11px;letter-spacing:.5px;color:#74747c;pointer-events:none}
.ns-view-hud{position:absolute;right:6px;top:6px;display:flex;gap:6px;align-items:center;font:10px ui-monospace,Consolas,monospace;color:#a4a4ac}
.ns-view-hud button{all:unset;cursor:pointer;padding:2px 7px;border-radius:5px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.12);color:#cfcfd4}
.ns-view-hud button:hover{border-color:#7cbcff;color:#fff}
.ns-view-zoom{padding:2px 6px;border-radius:5px;background:rgba(0,0,0,.45)}
.ns-view-tools{position:absolute;right:6px;top:32px;display:flex;flex-direction:column;align-items:flex-end;gap:6px;font:11px ui-monospace,Consolas,monospace}
.ns-view-tools button{all:unset;cursor:pointer;min-width:16px;text-align:center;padding:3px 7px;border-radius:5px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.12);color:#cfcfd4}
.ns-view-tools button:hover{border-color:#7cbcff;color:#fff}
.ns-view-tools button.on{border-color:#e8a33c;color:#ffcf8a}
.ns-mq{position:absolute;box-sizing:border-box;pointer-events:none;border:calc(2px / var(--ns-vs,1)) solid #7cbcff;background:rgba(124,188,255,.10);box-shadow:0 0 0 calc(1px / var(--ns-vs,1)) rgba(0,0,0,.65)}
.ns-mq[hidden],.ns-mq-ctx[hidden]{display:none}
.ns-mq-ctx{position:absolute;box-sizing:border-box;pointer-events:none;border:calc(1px / var(--ns-vs,1)) dashed rgba(124,188,255,.6)}
.ns-mq.lx{border-left-color:#ff5a5a;border-right-color:#ff5a5a}.ns-mq.ly{border-top-color:#ff5a5a;border-bottom-color:#ff5a5a}
.ns-mq.lx.ly{background:rgba(255,90,90,.12)}
.ns-mq.lx .ns-mq-h[data-h="e"],.ns-mq.lx .ns-mq-h[data-h="w"],.ns-mq.ly .ns-mq-h[data-h="n"],.ns-mq.ly .ns-mq-h[data-h="s"]{opacity:.3;border-color:#ff5a5a;pointer-events:none}
.ns-mq-h{position:absolute;pointer-events:auto;box-sizing:border-box;width:calc(11px / var(--ns-vs,1));height:calc(11px / var(--ns-vs,1));margin:calc(-5.5px / var(--ns-vs,1)) 0 0 calc(-5.5px / var(--ns-vs,1));background:#101012;border:calc(2px / var(--ns-vs,1)) solid #7cbcff;border-radius:2px}
.ns-mq-body{position:absolute;inset:0;pointer-events:auto;cursor:move}
.ns-mq-wrap.locked .ns-mq-body,.ns-mq-wrap.locked .ns-mq-h{pointer-events:none}.ns-mq-wrap.locked .ns-mq-h{opacity:.35}
.ns-mq-tag{position:absolute;left:0;top:calc(-18px / var(--ns-vs,1));font:calc(11px / var(--ns-vs,1)) ui-monospace,Consolas,monospace;color:#7cbcff;white-space:nowrap;pointer-events:none;text-shadow:0 0 3px #000}
`;

// ComfyUI forwards wheel and middle-button events over a node to the graph canvas (zoom/pan the graph) from handlers that run before
// anything inside the node. A capture listener on the WINDOW runs before all of them: if the pointer is over a viewport, the viewport wins.
let wired = false;
function wireGlobal() {
    if (wired) return;
    wired = true;
    const view = (e) => e.target?.closest?.(".ns-view")?.__nsView || null;
    window.addEventListener("wheel", (e) => {
        if (e.ctrlKey || e.metaKey) return;                         // Ctrl + wheel stays the graph's zoom gesture
        const V = view(e); if (!V?.wheel) return;
        e.preventDefault(); e.stopImmediatePropagation(); V.wheel(e);
    }, { capture: true, passive: false });
    for (const ev of ["mousedown", "auxclick"]) {
        window.addEventListener(ev, (e) => { if (e.button === 1 && view(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, { capture: true });
    }
    window.addEventListener("pointerdown", (e) => {
        if (e.button !== 1) return;
        const V = view(e); if (!V?.panStart) return;
        e.stopImmediatePropagation(); V.panStart(e);
    }, { capture: true });
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const stop = (e) => { e.stopPropagation(); };

// ---------- view_box ----------
piece(C("view_box", {
    scopo: "Viewport con zoom (rotella) e pan (tasto centrale, Alt o Spazio): mostra l'immagine in pixel originali, i figli usano quelle coordinate.",
    natura: "funziona", dominio: "ui", estado: "draft", archetipo: "container",
    tag: ["viewport", "zoom", "pan", "immagine", "crop"], css: CSS,
    props: {
        src: R("URL dell'immagine (testo o ref, es. $live.shot_system.src)"),
        width: R("larghezza ORIGINALE in px (numero o ref)"), height: R("altezza ORIGINALE in px (numero o ref)"),
        empty: S("testo mostrato quando non c'e' immagine", "Run once to load the image"),
        dblfit: B("doppio click = fit (falso: il doppio click resta libero, es. per aprire un menu)", true),
        buttons: J("bottoni in colonna sotto ⤢: [{text, title?, active? (ref: acceso), on:{click:{do, args}}}] (D-114)"),
    },
    esempio: ex({ t: "view_box", empty: "no picture yet", children: [] }),
}), (node, h) => {
    wireGlobal();
    const el = mkEl("div", "ns-view");
    el.setAttribute("data-capture-wheel", "true");      // ComfyUI: "this zone eats the wheel itself" (otherwise the wheel zooms the graph)
    el.tabIndex = -1; el.style.outline = "none";         // ComfyUI only honours data-capture-wheel while the zone HAS FOCUS: so it must be focusable
    const stage = mkEl("div", "ns-view-stage");
    const img = mkEl("img", "ns-view-img"); img.draggable = false;
    const empty = mkEl("div", "ns-view-empty");
    const hud = mkEl("div", "ns-view-hud");
    const zoomTxt = mkEl("span", "ns-view-zoom"); const fitBtn = mkEl("button"); fitBtn.type = "button"; fitBtn.textContent = "⤢"; fitBtn.title = "Fit (double click)";
    hud.append(zoomTxt, fitBtn);
    // extra buttons under the HUD (D-114): declared by the node, run its actions — e.g. swap the tool, open the options
    const tools = mkEl("div", "ns-view-tools");
    const extra = (Array.isArray(node.buttons) ? node.buttons : []).map((b) => {
        const btn = mkEl("button"); btn.type = "button";
        btn.addEventListener("pointerdown", (e) => e.stopPropagation());
        btn.addEventListener("dblclick", (e) => e.stopPropagation());
        btn.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });
        btn.addEventListener("click", (e) => { e.stopPropagation(); const a = b.on?.click; if (a) runAction(h.rt, a, e, btn); h.rt.update?.(); });
        tools.appendChild(btn);
        return { b, btn };
    });
    const paintTools = () => { for (const { b, btn } of extra) {
        const t = String(h.val(b.text) ?? ""); if (btn.textContent !== t) btn.textContent = t;
        const ti = String(h.val(b.title) ?? ""); if (btn.title !== ti) btn.title = ti;
        btn.classList.toggle("on", b.active !== undefined && !!h.val(b.active));
    } };
    stage.appendChild(img);
    el.append(stage, empty, hud);
    if (extra.length) el.appendChild(tools);

    const v = { s: 1, tx: 0, ty: 0, cw: 0, ch: 0, W: 0, H: 0, auto: true, space: false, hover: false, subs: new Set(), alts: new Set(), altBusy: false, altAt: -1e9 };
    const mkey = memKey(h.rt, node.id);
    const mem = VIEW_MEM.get(mkey);
    const on = (t, ev, fn, opts) => { t.addEventListener(ev, fn, opts); h.bag.add(() => { try { t.removeEventListener(ev, fn, opts); } catch (_) { /* gone already */ } }); };
    VIEWS.add(v);
    h.bag.add(() => VIEWS.delete(v));

    // screen pixels per CSS pixel of this viewport: the graph canvas scales the node, so clientX/getBoundingClientRect (screen) and tx/ty (CSS) differ
    const k = () => { const r = el.getBoundingClientRect(); return el.offsetWidth ? (r.width / el.offsetWidth) || 1 : 1; };
    const apply = () => {
        if (v.W) VIEW_MEM.set(mkey, { s: v.s, tx: v.tx, ty: v.ty, auto: v.auto, W: v.W, H: v.H });
        stage.style.transform = `translate(${v.tx}px,${v.ty}px) scale(${v.s})`;
        stage.style.setProperty("--ns-vs", String(v.s));
        zoomTxt.textContent = Math.round(v.s * 100) + "%";
        for (const fn of [...v.subs]) { try { fn(); } catch (e) { console.warn("[NodeStructure] view subscriber:", e); } }
    };
    const fit = () => {
        const vw = el.clientWidth, vh = el.clientHeight;
        if (!v.W || !v.H || !vw || !vh) return;
        v.s = Math.min(vw / v.W, vh / v.H) * 0.97;
        v.tx = (vw - v.W * v.s) / 2; v.ty = (vh - v.H * v.s) / 2;
        v.auto = true; v.cw = vw; v.ch = vh; apply();
    };
    const setSize = (w, hh) => {
        if (w === v.W && hh === v.H) return;
        const first = !v.W;
        v.W = w; v.H = hh;
        // a rebuilt node (undo) gets its zoom back, once, if it is still the same picture
        if (first && mem && !mem.auto && mem.W === w && mem.H === hh) { v.s = mem.s; v.tx = mem.tx; v.ty = mem.ty; v.auto = false; }
        stage.style.width = w + "px"; stage.style.height = hh + "px";
        if (v.auto) fit(); else apply();
    };

    // public face, found by children through el.closest(".ns-view").__nsView
    el.__nsView = {
        scale: () => v.s,
        size: () => ({ w: v.W, h: v.H }),
        toImage(cx, cy) { const r = el.getBoundingClientRect(), z = k(); return { x: ((cx - r.left) / z - v.tx) / v.s, y: ((cy - r.top) / z - v.ty) / v.s }; },
        onChange(fn) { v.subs.add(fn); return () => v.subs.delete(fn); },
        fit,
        isBusy: () => v.panning === true || v.altBusy === true,
        alt(g) { v.alts.add(g); return () => v.alts.delete(g); },
    };

    // wheel = zoom around the cursor
    const activeAlt = () => [...v.alts].find((g) => { try { return g.active?.(); } catch (_) { return false; } });
    const wheel = (e) => {
        if (e.altKey) { v.altAt = performance.now(); activeAlt()?.wheel?.(e); return; }           // Alt + wheel: the active tool's own resize, never zoom (D-120)
        if (!v.W) return;
        const r = el.getBoundingClientRect();
        const z = k(), px = (e.clientX - r.left) / z, py = (e.clientY - r.top) / z;
        const ns = clamp(v.s * Math.exp(-e.deltaY * 0.0015), 0.02, 32);
        const ratio = ns / v.s;
        v.tx = px - (px - v.tx) * ratio; v.ty = py - (py - v.ty) * ratio; v.s = ns; v.auto = false;
        apply();
    };
    el.__nsView.wheel = wheel;
    on(el, "wheel", (e) => { e.preventDefault(); e.stopPropagation(); wheel(e); }, { passive: false });

    // pan: middle button or Space+left. Alt+left is for the children (D-120). Everything else is for them too (drawing).
    const panWanted = (e) => e.button === 1 || (e.button === 0 && !e.altKey && v.space);
    const panStart = (e) => {
        e.preventDefault(); e.stopPropagation();
        v.panning = true; el.classList.add("panning");
        const id = e.pointerId, sx = e.clientX, sy = e.clientY, tx0 = v.tx, ty0 = v.ty;
        // window + capture: runs before ComfyUI's own middle-button forwarding, which would pan the graph along with us
        const move = (m) => { if (m.pointerId !== id) return; m.stopImmediatePropagation(); m.preventDefault(); const z = k(); v.tx = tx0 + (m.clientX - sx) / z; v.ty = ty0 + (m.clientY - sy) / z; v.auto = false; apply(); };
        const end = (m) => {
            if (m.pointerId !== id) return;
            m.stopImmediatePropagation();
            v.panning = false; el.classList.remove("panning");
            window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", end, true); window.removeEventListener("pointercancel", end, true);
        };
        window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", end, true); window.addEventListener("pointercancel", end, true);
    };
    el.__nsView.panStart = panStart;
    // Alt + left drag: handed to the active tool as deltas in image px (dx, dy) and screen px (sx, sy) from where it started
    const altStart = (e, g) => {
        const st = g.start?.(e);
        if (st === false) return;
        e.preventDefault(); e.stopPropagation();
        v.altBusy = true; v.altAt = performance.now(); el.classList.add("alting");
        const id = e.pointerId, sx = e.clientX, sy = e.clientY;
        const move = (m) => {
            if (m.pointerId !== id) return;
            m.stopImmediatePropagation(); m.preventDefault();
            const z = k() * v.s, px = m.clientX - sx, py = m.clientY - sy;
            v.altAt = performance.now();
            g.drag?.(st, { sx: px, sy: py, dx: px / z, dy: py / z }, m);
        };
        const end = (m) => {
            if (m.pointerId !== id) return;
            m.stopImmediatePropagation();
            v.altBusy = false; v.altAt = performance.now(); el.classList.remove("alting");
            window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", end, true); window.removeEventListener("pointercancel", end, true);
            g.end?.(st);
        };
        window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", end, true); window.addEventListener("pointercancel", end, true);
    };
    on(el, "pointerdown", (e) => {
        if (panWanted(e)) { panStart(e); return; }
        if (e.button === 0 && e.altKey && !v.space) { const g = activeAlt(); if (g) altStart(e, g); }
    }, true);       // capture phase: NEVER stop others for a plain drag, the children need it
    on(el, "pointerdown", () => { try { el.focus({ preventScroll: true }); } catch (_) { /* not focusable right now */ } });
    on(el, "pointerdown", stop);               // bubble phase: after the children had their say, keep the graph out of it
    on(el, "dblclick", (e) => { if (node.dblfit === false) return; e.stopPropagation(); fit(); });
    on(fitBtn, "click", (e) => { e.stopPropagation(); fit(); });
    on(fitBtn, "pointerdown", stop);
    on(el, "pointerenter", () => {
        v.hover = true;
        const a = document.activeElement;                 // grab focus on hover, but never steal it from a text field
        if (!a || a === document.body || a.tagName === "CANVAS") { try { el.focus({ preventScroll: true }); } catch (_) { /* not focusable right now */ } }
    });
    on(el, "pointerleave", () => { v.hover = false; v.space = false; el.classList.remove("pan"); });
    // Alt is ours while this node is in use (pointer over the NODE, or the node selected): a lone Alt press would otherwise
    // wake the browser's own menu (Alt + right click = the tools menu, Alt + drag = pan) — D-117
    const nodeActive = () => {
        if (v.hover) return true;
        const host = el.closest("[data-node-id]");
        if (host?.matches?.(":hover")) return true;
        const id = h.rt?.node?.id, sel = globalThis.app?.canvas?.selected_nodes;
        return id != null && !!sel && Object.prototype.hasOwnProperty.call(sel, String(id));
    };
    // Windows/Chrome opens its menu bar on a lone Alt key-UP: so keep eating it for a moment after ANY Alt gesture here, wherever the
    // pointer ended up (the drag/wheel can carry it off the node before Alt is released) — D-121
    const altRecently = () => performance.now() - v.altAt < 2500;
    const eatAlt = (e) => { if ((e.key === "Alt" || e.key === "AltGraph") && (nodeActive() || altRecently())) e.preventDefault(); };
    on(window, "keydown", eatAlt, true);
    on(window, "keyup", eatAlt, true);
    on(window, "keydown", (e) => { if (v.hover && e.code === "Space" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) { e.preventDefault(); v.space = true; el.classList.add("pan"); } });
    on(window, "keyup", (e) => { if (e.code === "Space") { v.space = false; el.classList.remove("pan"); } });

    // the box follows the node: refit while the user has not zoomed on purpose
    if (typeof ResizeObserver === "function") {
        const ro = new ResizeObserver(() => {
            if (v.auto) { fit(); return; }
            const nw = el.clientWidth, nh = el.clientHeight;
            if (v.cw && v.ch) { v.tx += (nw - v.cw) / 2; v.ty += (nh - v.ch) / 2; apply(); }      // zoomed on purpose: keep the centre still
            v.cw = nw; v.ch = nh;
        });
        ro.observe(el);
        h.bag.add(() => ro.disconnect());
    }
    on(img, "load", () => { if (!v.W) setSize(img.naturalWidth, img.naturalHeight); });

    let lastSrc = "";
    const update = () => {
        const src = String(h.val(node.src) || "");
        const w = Number(h.val(node.width)) || 0, hh = Number(h.val(node.height)) || 0;
        if (src !== lastSrc) { lastSrc = src; if (src) img.src = src; else img.removeAttribute("src"); }
        if (w > 0 && hh > 0) setSize(w, hh); else if (img.naturalWidth) setSize(img.naturalWidth, img.naturalHeight);
        empty.hidden = !!src;
        empty.textContent = String(h.val(node.empty) ?? "");
        img.style.visibility = src ? "visible" : "hidden";
        paintTools();
    };
    update();
    return { el, container: stage, update, handlesText: true };
});

// ---------- marquee_element ----------
const HANDLES = [["nw", 0, 0, "nwse-resize"], ["n", .5, 0, "ns-resize"], ["ne", 1, 0, "nesw-resize"], ["e", 1, .5, "ew-resize"],
    ["se", 1, 1, "nwse-resize"], ["s", .5, 1, "ns-resize"], ["sw", 0, 1, "nesw-resize"], ["w", 0, .5, "ew-resize"]];

piece(C("marquee_element", {
    scopo: "Rettangolo di selezione su un view_box: si disegna, si sposta, 8 maniglie; scrive x/y/w/h nei nativi al rilascio.",
    natura: "funziona", dominio: "ui", estado: "draft", archetipo: "renderer-host",
    tag: ["selezione", "rettangolo", "crop"], uses: ["view_box"],
    props: {
        x: R("x in px immagine (ref, es. $native.x)"), y: R("y (ref)"), w: R("larghezza, 0 = fino al bordo destro (ref)"), h: R("altezza, 0 = fino al bordo basso (ref)"),
        context: R("margine di contesto in px (ref); disegnato tratteggiato"),
        snap: R("multiplo a cui agganciare x/y/w/h (numero o ref)"),
        minSize: N("lato minimo in px", 8), tag: B("mostra le misure sopra il rettangolo", true),
        enabled: R("falso = nessun rettangolo (nascosto); disegnarne uno nuovo lo scrive vero (ref, es. $native.box)"),
        locked: R("vero = si vede ma non si tocca (es. mentre si dipinge col brush)"),
        lockX: R("vero = la LARGHEZZA non cambia (lati rossi); lo spostamento resta libero (ref, es. $state.lockX)"),
        lockY: R("vero = l'ALTEZZA non cambia (sopra e sotto rossi); lo spostamento resta libero (ref)"),
    },
    esempio: ex({ t: "view_box", children: [{ t: "marquee_element", x: 0, y: 0, w: 64, h: 64 }] }),
}), (node, h) => {
    const { rt } = h;
    const box = mkEl("div", "ns-mq");
    const ctxEl = mkEl("div", "ns-mq-ctx");
    const body = mkEl("div", "ns-mq-body");
    const tag = mkEl("div", "ns-mq-tag");
    box.append(body, tag);
    const hs = HANDLES.map(([id, fx, fy, cur]) => { const d = mkEl("div", "ns-mq-h"); d.dataset.h = id; d.style.cursor = cur; d.style.left = fx * 100 + "%"; d.style.top = fy * 100 + "%"; box.appendChild(d); return d; });
    // two siblings in the stage: the ring first (behind), then the box. The factory returns ONE element: a transparent wrapper.
    const wrap = mkEl("div", "ns-mq-wrap");
    wrap.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none";
    wrap.append(ctxEl, box);

    const refs = { x: parseRef(node.x), y: parseRef(node.y), w: parseRef(node.w), h: parseRef(node.h), on: parseRef(node.enabled) };
    const isOn = () => node.enabled === undefined || !!h.val(node.enabled);
    const isLocked = () => !!h.val(node.locked);
    const lockX = () => !!h.val(node.lockX), lockY = () => !!h.val(node.lockY);      // width / height frozen: the lock beats every gesture (D-120)
    const view = () => wrap.closest(".ns-view")?.__nsView || null;
    const cur = { x: 0, y: 0, w: 0, h: 0, drag: null };     // while dragging, the live rect (not yet written to the natives)

    const read = () => {
        const V = view(); const S = V ? V.size() : { w: 0, h: 0 };
        const x = S.w ? Math.min(Number(h.val(node.x)) || 0, S.w - 1) : Number(h.val(node.x)) || 0;
        const y = S.h ? Math.min(Number(h.val(node.y)) || 0, S.h - 1) : Number(h.val(node.y)) || 0;
        let w = Number(h.val(node.w)) || 0, hh = Number(h.val(node.h)) || 0;
        if (w <= 0 || (S.w && x + w > S.w)) w = Math.max(0, S.w - x);          // 0 = edge, and Python clamps too: draw what it will really cut
        if (hh <= 0 || (S.h && y + hh > S.h)) hh = Math.max(0, S.h - y);
        return { x, y, w, h: hh, W: S.w, H: S.h };
    };
    const place = (r) => {
        const V = view();
        wrap.classList.toggle("locked", isLocked());
        box.classList.toggle("lx", lockX()); box.classList.toggle("ly", lockY());
        box.hidden = !V || !r.W || r.w <= 0 || r.h <= 0 || (!cur.drag && !isOn());
        if (box.hidden) { ctxEl.hidden = true; return; }
        box.style.left = r.x + "px"; box.style.top = r.y + "px"; box.style.width = r.w + "px"; box.style.height = r.h + "px";
        const c = Number(h.val(node.context)) || 0;
        const cx0 = Math.max(0, r.x - c), cy0 = Math.max(0, r.y - c), cx1 = Math.min(r.W, r.x + r.w + c), cy1 = Math.min(r.H, r.y + r.h + c);
        ctxEl.hidden = c <= 0;
        ctxEl.style.left = cx0 + "px"; ctxEl.style.top = cy0 + "px"; ctxEl.style.width = (cx1 - cx0) + "px"; ctxEl.style.height = (cy1 - cy0) + "px";
        tag.hidden = h.val(node.tag) === false;
        tag.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}  @ ${Math.round(r.x)},${Math.round(r.y)}`;
    };
    const update = () => { if (!cur.drag) place(read()); };

    const snapV = () => Math.max(1, Math.round(Number(h.val(node.snap)) || 1));
    const snap = (n) => { const m = snapV(); return m > 1 ? Math.round(n / m) * m : Math.round(n); };
    const commit = (r) => {
        const W = r.W, H = r.H;
        const x = clamp(snap(r.x), 0, Math.max(0, W - 1)), y = clamp(snap(r.y), 0, Math.max(0, H - 1));
        let w = clamp(snap(r.w), 1, W - x), hh = clamp(snap(r.h), 1, H - y);
        // reaching the far edge is stored as an exact size (0 would also mean "to the edge", but explicit numbers are friendlier)
        for (const [k, val] of [["x", x], ["y", y], ["w", w], ["h", hh]]) writeRef(rt, refs[k], val);
        if (refs.on && !isOn()) writeRef(rt, refs.on, true);          // a freshly drawn box switches the box back on
        rt.update?.();
    };

    // drag engine: kind = "new" | "move" | one of the handle ids
    const begin = (e, kind) => {
        const V = view(); if (!V || e.button !== 0 || e.altKey) return;
        if (V.isBusy() || isLocked()) return;
        if (kind !== "new" && !isOn()) return;                            // an invisible box has no body to grab
        e.preventDefault(); e.stopPropagation();
        const r0 = read(); if (!r0.W) return;
        const p0 = V.toImage(e.clientX, e.clientY);
        const min = Math.max(1, Number(node.minSize) || 8);
        const start = { x: r0.x, y: r0.y, w: r0.w, h: r0.h };
        const lx = lockX(), ly = lockY();
        cur.drag = kind;
        const target = e.currentTarget;
        try { target.setPointerCapture(e.pointerId); } catch (_) {}
        const move = (m) => {
            const p = V.toImage(m.clientX, m.clientY);
            const dx = p.x - p0.x, dy = p.y - p0.y;
            let { x, y, w, h: hh } = start;
            if (kind === "new") {
                let x1 = clamp(p.x, 0, r0.W), y1 = clamp(p.y, 0, r0.H);
                const x0 = clamp(p0.x, 0, r0.W), y0 = clamp(p0.y, 0, r0.H);
                let ww = x1 - x0, h2 = y1 - y0;
                if (m.shiftKey && !lx && !ly) { const s = Math.max(Math.abs(ww), Math.abs(h2)); ww = Math.sign(ww || 1) * s; h2 = Math.sign(h2 || 1) * s; }
                x = Math.min(x0, x0 + ww); y = Math.min(y0, y0 + h2); w = Math.abs(ww); hh = Math.abs(h2);
                if (x < 0) { w += x; x = 0; } if (y < 0) { hh += y; y = 0; }
                w = Math.min(w, r0.W - x); hh = Math.min(hh, r0.H - y);
                // a frozen side keeps its size: the click only places the box on that axis
                if (lx) { w = Math.min(start.w, r0.W); x = clamp(x0, 0, r0.W - w); }
                if (ly) { hh = Math.min(start.h, r0.H); y = clamp(y0, 0, r0.H - hh); }
            } else if (kind === "move") {
                x = clamp(start.x + dx, 0, r0.W - start.w); y = clamp(start.y + dy, 0, r0.H - start.h);
            } else {
                let l = start.x, t = start.y, rr = start.x + start.w, b = start.y + start.h;
                if (kind.includes("w") && !lx) l = clamp(start.x + dx, 0, rr - min);
                if (kind.includes("e") && !lx) rr = clamp(start.x + start.w + dx, l + min, r0.W);
                if (kind.includes("n") && !ly) t = clamp(start.y + dy, 0, b - min);
                if (kind.includes("s") && !ly) b = clamp(start.y + start.h + dy, t + min, r0.H);
                x = l; y = t; w = rr - l; hh = b - t;
            }
            cur.x = x; cur.y = y; cur.w = w; cur.h = hh;
            place({ x, y, w, h: hh, W: r0.W, H: r0.H });
        };
        const up = () => {
            target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); target.removeEventListener("pointercancel", up);
            const moved = cur.w >= min && cur.h >= min && cur.drag;
            cur.drag = null;
            if (moved) commit({ x: cur.x, y: cur.y, w: cur.w, h: cur.h, W: r0.W, H: r0.H }); else place(read());
        };
        target.addEventListener("pointermove", move); target.addEventListener("pointerup", up); target.addEventListener("pointercancel", up);
        if (kind === "new") { cur.x = p0.x; cur.y = p0.y; cur.w = 0; cur.h = 0; }
    };
    h.listen(body, "pointerdown", (e) => begin(e, "move"));
    hs.forEach((d) => h.listen(d, "pointerdown", (e) => begin(e, d.dataset.h)));

    // ---- Alt gestures (D-120): resize from the CENTRE, never moving it. Locked side = frozen, image edge = hard stop.
    //      Alt + left drag: sideways = width, up/down = height (the axis is chosen by the first few pixels and kept).
    //      Alt + wheel: both at once, same ratio. Steps follow the Multiple of the rectangle (box_snap); numbers land in the natives on release.
    const MINPX = () => Math.max(1, Number(node.minSize) || 8);
    const floorSnap = (n) => { const m = snapV(); return m > 1 ? Math.floor(n / m) * m : Math.floor(n); };
    // the largest size on an axis that keeps the centre where it is, snapped DOWN so the limit is never overshot
    const limitOf = (c, total) => Math.max(1, floorSnap(2 * Math.min(c, total - c)));
    const setCentered = (r0, w, hh) => {
        const cx = r0.x + r0.w / 2, cy = r0.y + r0.h / 2;
        const x = Math.round(cx - w / 2), y = Math.round(cy - hh / 2);
        cur.x = clamp(x, 0, Math.max(0, r0.W - w)); cur.y = clamp(y, 0, Math.max(0, r0.H - hh)); cur.w = w; cur.h = hh;
        place({ x: cur.x, y: cur.y, w, h: hh, W: r0.W, H: r0.H });
    };
    const writeBox = () => {
        for (const [k2, val] of [["x", cur.x], ["y", cur.y], ["w", cur.w], ["h", cur.h]]) writeRef(rt, refs[k2], Math.round(val));
        rt.update?.();
    };
    let wheelRect = null, wheelTimer = 0;
    h.bag.add(() => clearTimeout(wheelTimer));
    const altGesture = {
        active: () => !isLocked() && isOn() && !!view()?.size().w,
        start: () => { const r0 = read(); if (!r0.W || r0.w <= 0 || r0.h <= 0) return false; cur.drag = "alt"; cur.x = r0.x; cur.y = r0.y; cur.w = r0.w; cur.h = r0.h; return { r0, axis: null }; },
        drag: (st, d) => {
            const { r0 } = st;
            if (!st.axis) { if (Math.hypot(d.sx, d.sy) < 5) return; st.axis = Math.abs(d.sx) >= Math.abs(d.sy) ? "x" : "y"; }
            let w = r0.w, hh = r0.h;
            if (st.axis === "x" && !lockX()) w = clamp(floorSnap(r0.w + 2 * d.dx), Math.min(MINPX(), limitOf(r0.x + r0.w / 2, r0.W)), limitOf(r0.x + r0.w / 2, r0.W));
            if (st.axis === "y" && !lockY()) hh = clamp(floorSnap(r0.h + 2 * d.dy), Math.min(MINPX(), limitOf(r0.y + r0.h / 2, r0.H)), limitOf(r0.y + r0.h / 2, r0.H));
            setCentered(r0, w, hh);
        },
        end: () => { cur.drag = null; if (cur.w > 0) writeBox(); else place(read()); },
        wheel: (e) => {
            if (!isOn() || isLocked()) return;
            if (!wheelRect) { const r0 = read(); if (!r0.W || r0.w <= 0 || r0.h <= 0) return; wheelRect = { r0, w: r0.w, h: r0.h }; cur.drag = "alt"; cur.x = r0.x; cur.y = r0.y; cur.w = r0.w; cur.h = r0.h; }
            const { r0 } = wheelRect, fx = !lockX(), fy = !lockY();
            const maxW = limitOf(r0.x + r0.w / 2, r0.W), maxH = limitOf(r0.y + r0.h / 2, r0.H), min = MINPX();
            let f = Math.exp(-e.deltaY * 0.001);                            // wheel up = bigger
            // the same ratio on both axes: whichever frozen side or image edge is hit first stops the other too
            if (f > 1) { if (fx) f = Math.min(f, maxW / wheelRect.w); if (fy) f = Math.min(f, maxH / wheelRect.h); }
            else { if (fx) f = Math.max(f, Math.min(min, wheelRect.w) / wheelRect.w); if (fy) f = Math.max(f, Math.min(min, wheelRect.h) / wheelRect.h); }
            const grow = (n, lim, lo) => { let q = Math.round(n * f); const m = snapV(); if (m > 1) q = Math.round(q / m) * m; if (q === n && f !== 1) q += Math.sign(f - 1) * m; return clamp(q, Math.min(lo, lim), lim); };
            if (fx) wheelRect.w = grow(wheelRect.w, maxW, min);
            if (fy) wheelRect.h = grow(wheelRect.h, maxH, min);
            setCentered(r0, wheelRect.w, wheelRect.h);
            clearTimeout(wheelTimer);
            wheelTimer = setTimeout(() => { wheelRect = null; cur.drag = null; if (cur.w > 0) writeBox(); else place(read()); }, 180);
        },
    };

    // drawing a NEW rectangle: a drag that starts on the empty stage. We hook the view once it exists.
    let off = null, offView = null;
    const hook = () => {
        const V = view(); const root = wrap.closest(".ns-view");
        if (!V || !root || root === offView) return;
        if (off) off();
        offView = root;
        const down = (e) => {
            if (e.target.closest?.(".ns-mq")) return;                       // box/handles have their own drag
            const fake = { button: e.button, altKey: e.altKey, clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId, currentTarget: root, preventDefault: () => e.preventDefault(), stopPropagation: () => {} };
            if (e.button === 0 && !e.altKey && !root.classList.contains("pan")) begin(fake, "new");
        };
        root.addEventListener("pointerdown", down);
        const unsub = V.onChange(() => update());
        const unAlt = V.alt(altGesture);
        off = () => { root.removeEventListener("pointerdown", down); unsub(); unAlt(); };
    };
    h.bag.add(() => { if (off) off(); });
    const tick = () => { hook(); update(); };
    queueMicrotask(tick); setTimeout(tick, 50); setTimeout(tick, 400);       // the stage is attached after the factory returns

    return { el: wrap, update: tick, handlesText: true };
});

// ---------- shot_system (io) ----------
// A picture loaded on the node (no Run yet) is the file as it is; a node with a `workspace_mp` native (Crop, D-120) resizes the whole
// picture to that many megapixels before cropping, so the canvas must speak THAT size: same formula as the Python (_mp_size).
// Pictures that come from a Run are already at workspace size (the Python says so).
const shotSystem = (api) => {
    const s = ShotFeed.get(api.liveNode?.() || api.node);
    if (!s) return { src: "", width: 0, height: 0 };
    let { width, height } = s;
    const mp = s.raw ? Number(api.native?.get?.("workspace_mp")) || 0 : 0;
    if (mp > 0 && width > 0 && height > 0) {
        const k2 = Math.sqrt((mp * 1e6) / (width * height));
        width = Math.max(1, Math.round(width * k2)); height = Math.max(1, Math.round(height * k2));
    }
    return { src: s.src, width, height };
};
shotSystem.ensure = (api) => { api.onDispose(ShotFeed.subscribe(() => api.refresh())); };
piece(C("shot_system", {
    scopo: "L'ultima immagine che il nodo sta guardando ({src, width, height} in pixel ORIGINALI) da un solo ascoltatore condiviso.",
    natura: "funziona", dominio: "runtime", estado: "draft", tag: ["immagine", "dati", "viewport"], props: {},
    esempio: ex({ t: "view_box", src: "$live.shot_system.src", width: "$live.shot_system.width", height: "$live.shot_system.height", children: [] }),
}), shotSystem);
