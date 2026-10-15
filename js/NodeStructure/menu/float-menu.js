// ============================================================
// NodeStructure/menu/float-menu.js
// ------------------------------------------------------------
// The ONLY way to build, position, close and clean up a float
// menu. The node only declares the entries (spec.menus.<name>):
//
//   { kind:"list",  items:[ {label, action, icon?, shortcut?, checked?, disabled?,
//                            keepOpen?, children?:[...]} | {type:"sep"} ] | "$live.fn" }
//   { kind:"panel", title, tree:{...}, modal?, geometry?:{state}, width?, height? }
//   { kind:"picker", title, chip?, placeholder?, empty?, hint?, warn?, groups?:{on:"Connected", "":"..."},
//                    items()->[{key,label,bold?,sym?,sub?,state?:""|"current"|"warn",group?,removable?}],
//                    via?:{options()->[{key,label}], preview(key)}, preview(item)->rect|null,
//                    pick(item, via)->true|"error", unpick(item)->true|"error" }   (kit only: D-61/64, chip_input/chip_output)
//   open(..., { over:true })  a picker opened OVER an open menu: the menu stays (D-85, wire_box)
//
// Build       : host in the body with id  succy-ns-menu-<ctx.key>-<name>
//               (never node.id), its own shadow root -> isolated CSS.
// Position    : anchor (Element) | point {x,y} | center; clamped to the viewport.
// Closing     : click outside, Esc, graph change, node removal/rebuild,
//               opening another menu (only one open at a time — we're exclusive).
// Cleanup     : document listeners ONLY via ctx.utils.onDocument (kit),
//               registered once per node on first open and gated;
//               everything else in the entry's Bag; graph-check RAF
//               via ctx.perf.acquireRAF (kit) only while a menu is open.
// ============================================================

import { evalValue, runAction } from "../core/binding.js";
import { renderTree } from "../core/renderer.js";
import { ensureGlobalTheme, sharedSheet, THEME_CSS, applyTheme, extraCss } from "../theme/theme.js";
import { Bag } from "../util/tracker.js";
import { globalId } from "../util/ids.js";
import { safeParse } from "../util/json.js";
import { piece } from "../catalog/registry.js";
import { C, E, N, S, B, J } from "../catalog/kit.js";

const OPEN = new Map(); // id -> entry (global: one menu open at a time)

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

export function graphStillActive(rt) {
    try {
        const cur = globalThis.app?.canvas?.graph;
        const g = rt.node?.graph;
        if (!g) return false;
        if (rt.node?.reroute && !g.reroutes?.has?.(rt.node.reroute.id)) return false;     // reroute subject deleted
        if (!cur) return true;
        return cur === g;
    } catch (_) { return true; }
}

function ensureGuards(rt) {
    if (rt.menuGuards) return;
    rt.menuGuards = true;
    const mine = () => [...OPEN.values()].filter((e) => e.rt === rt);
    const inside = (e, entry) => {
        const path = typeof e.composedPath === "function" ? e.composedPath() : [];
        return path.includes(entry.host);
    };
    const keepOpen = (entry) => entry.spec?.look === "v2" && entry.spec?.dismiss === "explicit";
    const onDown = (e) => {
        for (const entry of mine()) if (!inside(e, entry) && !keepOpen(entry)) close(rt, entry.name);
    };
    const onKey = (e) => {
        const list = mine();
        if (!list.length) return;
        const top = list[list.length - 1];
        if (e.key === "Escape") {
            // a dropdown open inside the menu (field_element select) closes on its own: the menu stays open
            const path = typeof e.composedPath === "function" ? e.composedPath() : [];
            if (path.some((n) => n?.classList?.contains?.("ns-combo-pop"))) return;
            e.preventDefault(); e.stopPropagation(); close(rt, top.name); return;
        }
        if (top.nav) top.nav(e);
    };
    const onWheel = (e) => {      // v2: canvas zoom does NOT close the menu (it follows along, if anchored)
        for (const entry of mine()) if (!inside(e, entry) && entry.spec?.look !== "v2") close(rt, entry.name);
    };
    // via kit: tracked and removed by releaseResources
    rt.ctx.utils.onDocument("pointerdown", onDown, true);
    rt.ctx.utils.onDocument("contextmenu", onDown, true);
    rt.ctx.utils.onDocument("keydown", onKey, true);
    rt.ctx.utils.onDocument("wheel", onWheel, { capture: true, passive: true });
}

function buildHost(rt, id, spec) {
    const host = el("div", "ns-menu-host");
    host.id = id;
    host.dataset.succyNodeKey = rt.ctx.key;
    host.style.cssText = "position:fixed;inset:0;z-index:999990;pointer-events:none;";
    const root = el("div", "ns-root ns-menu-layer");
    root.style.cssText += "height:100%;";
    let mode = "light";
    try {
        const sr = host.attachShadow({ mode: "open" });
        const sheet = sharedSheet();
        const extras = extraCss();     // CSS of the kit pieces (cards_box, notice_box, ...)
        if (sheet && "adoptedStyleSheets" in sr && extras.every((x) => x.sheet)) sr.adoptedStyleSheets = [sheet, ...extras.map((x) => x.sheet)];
        else { const st = el("style"); st.textContent = THEME_CSS + extras.map((x) => x.css).join("\n"); sr.appendChild(st); }
        sr.appendChild(root);
        mode = "shadow";
    } catch (_) {
        ensureGlobalTheme();
        host.appendChild(root);
    }
    applyTheme(root, { theme: rt.spec.theme || "dark", tokens: rt.spec.tokens });
    host.dataset.nsMode = mode;
    document.body.appendChild(host);
    return { host, root };
}

// ---------- menu v2 (D-57): fixed sizes, font, anchoring to the subject ----------
const SIZES = { L: [404, 612], M: [360, 520], S: [320, 440] };
function pickSize(spec) {
    if (spec.size === "fit") return "fit";
    if (SIZES[spec.size]) return spec.size;
    const vw = innerWidth, vh = innerHeight;
    if (vh >= 700 && vw >= 520) return "L";
    if (vh >= 580 && vw >= 440) return "M";
    return "S";
}
function applySize(menu, spec) {
    const z = pickSize(spec);
    menu.dataset.nsSize = z;
    // fit (D-108): fixed width, height = the content (a short tool menu, no empty floor); scrolls only past the screen
    if (z === "fit") { menu.style.width = (Number(spec.width) || 300) + "px"; menu.style.height = "auto"; menu.style.maxHeight = Math.max(200, innerHeight - 24) + "px"; return z; }
    const [w, h] = SIZES[z];
    menu.style.width = w + "px"; menu.style.height = h + "px";
    return z;
}
let _fontAsked = false;
function ensureMenuFont() {            // IBM Plex for menu v2; if offline the system fonts stay (token --nsm-font)
    if (_fontAsked) return;
    _fontAsked = true;
    try {
        if (document.getElementById("succy-ns-font-menu-v2")) return;
        const l = document.createElement("link");
        l.id = "succy-ns-font-menu-v2"; l.rel = "stylesheet";
        l.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap";
        document.head.appendChild(l);
    } catch (_) {}
}
// on-screen rectangle of the runtime's subject (node or native reroute), or null
export function subjectRect(rt) {
    try {
        const cv = globalThis.app?.canvas, n = rt.node;
        if (!cv?.ds || !cv.canvas || !n) return null;
        const b = cv.canvas.getBoundingClientRect();
        const toScr = (x, y) => { const p = cv.ds.convertOffsetToCanvas([x, y]); return [b.left + p[0], b.top + p[1]]; };
        let x0, y0, x1, y1;
        if (n.reroute) { const r = n.reroute, R = (Number(r.constructor?.radius) || 10) + 6; [x0, y0] = toScr(r.pos[0] - R, r.pos[1] - R); [x1, y1] = toScr(r.pos[0] + R, r.pos[1] + R); }
        else if (n.pos && n.size) { const th = globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30; [x0, y0] = toScr(n.pos[0], n.pos[1] - th); [x1, y1] = toScr(n.pos[0] + n.size[0], n.pos[1] + n.size[1]); }
        else return null;
        return { left: x0, top: y0, right: x1, bottom: y1, width: x1 - x0, height: y1 - y0 };
    } catch (_) { return null; }
}
// the side with the most room (right, left, below, above); if there's no room anywhere: centered
function dockPlace(menu, rect, margin = 12) {
    const w = menu.offsetWidth, h = menu.offsetHeight, vw = innerWidth, vh = innerHeight;
    const cand = [
        { side: "right", space: vw - rect.right - margin, fits: vw - rect.right - margin >= w },
        { side: "left", space: rect.left - margin, fits: rect.left - margin >= w },
        { side: "bottom", space: vh - rect.bottom - margin, fits: vh - rect.bottom - margin >= h },
        { side: "top", space: rect.top - margin, fits: rect.top - margin >= h },
    ];
    const c = cand.find((x) => x.fits);
    let x, y;
    if (!c) { x = (vw - w) / 2; y = (vh - h) / 2; }
    else if (c.side === "right") { x = rect.right + margin; y = rect.top + rect.height / 2 - h / 2; }
    else if (c.side === "left") { x = rect.left - w - margin; y = rect.top + rect.height / 2 - h / 2; }
    else if (c.side === "bottom") { x = rect.left + rect.width / 2 - w / 2; y = rect.bottom + margin; }
    else { x = rect.left + rect.width / 2 - w / 2; y = rect.top - h - margin; }
    x = clamp(x, 8, Math.max(8, vw - w - 8)); y = clamp(y, 8, Math.max(8, vh - h - 8));
    const L = Math.round(x) + "px", T = Math.round(y) + "px";
    if (menu.style.left !== L) menu.style.left = L;
    if (menu.style.top !== T) menu.style.top = T;
}

function place(menuEl, { anchor, point }) {
    const r = menuEl.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    let x, y;
    if (anchor && anchor.getBoundingClientRect) {
        const a = anchor.getBoundingClientRect();
        x = a.left; y = a.bottom + 4;
        if (y + r.height > vh - 8) y = Math.max(8, a.top - r.height - 4); // flip above
    } else if (point) { x = point.x; y = point.y; }
    else { x = (vw - r.width) / 2; y = (vh - r.height) / 3; }
    menuEl.style.left = clamp(x, 8, Math.max(8, vw - r.width - 8)) + "px";
    menuEl.style.top = clamp(y, 8, Math.max(8, vh - r.height - 8)) + "px";
}

function renderItems(rt, entry, items, parent, depth = 0) {
    const btns = [];
    for (const it of items) {
        if (!it || typeof it !== "object") continue;
        if (it.type === "sep" || it.sep === true) { parent.appendChild(el("div", "ns-menu-sep")); continue; }
        if (it.header) { const hd = el("div", "ns-label"); hd.style.padding = "4px 10px"; hd.textContent = String(it.label ?? ""); parent.appendChild(hd); continue; }
        const disabled = typeof it.disabled === "string" ? !!evalValue(rt, it.disabled) : !!it.disabled;
        const checked = typeof it.checked === "string" ? !!evalValue(rt, it.checked) : !!it.checked;
        const wrap = it.children ? el("div", "ns-menu-sub") : null;
        const b = el("button", "ns-menu-item");
        b.type = "button";
        b.disabled = disabled;
        const ck = el("span", "ns-menu-check"); ck.textContent = checked ? "✓" : (it.icon ? String(it.icon) : "");
        const lb = el("span"); lb.textContent = String(it.label ?? "");
        b.append(ck, lb);
        if (it.shortcut) { const k = el("span", "ns-menu-key"); k.textContent = String(it.shortcut); b.appendChild(k); }
        if (it.children) {
            const arrow = el("span", "ns-menu-key"); arrow.textContent = "▸"; b.appendChild(arrow);
            const sub = el("div", "ns-menu ns-menu-children");
            sub.style.position = "absolute";
            renderItems(rt, entry, it.children, sub, depth + 1);
            entry.bag.listen(b, "click", () => wrap.classList.toggle("ns-open"));
            wrap.append(b, sub);
            parent.appendChild(wrap);
        } else {
            entry.bag.listen(b, "click", (e) => {
                e.stopPropagation();
                if (it.action) runAction(rt, it.action, e, b, it);
                if (!it.keepOpen) close(rt, entry.name);
                rt.update();
            });
            parent.appendChild(b);
        }
        if (depth === 0) btns.push(b);
    }
    return btns;
}

function openList(rt, entry, spec, layer) {
    const menu = el("div", "ns-menu");
    menu.tabIndex = -1;
    menu.setAttribute("role", "menu");
    layer.appendChild(menu);
    let items = typeof spec.items === "string" ? evalValue(rt, spec.items) : spec.items;
    if (!Array.isArray(items)) items = [];
    const btns = renderItems(rt, entry, items, menu);
    let idx = -1;
    const focusAt = (i) => {
        const en = btns.filter((b) => !b.disabled);
        if (!en.length) return;
        idx = (i + en.length) % en.length;
        en.forEach((b, k) => b.classList.toggle("ns-focus", k === idx));
        en[idx].scrollIntoView?.({ block: "nearest" });
    };
    entry.nav = (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); focusAt(idx + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(idx < 0 ? -1 : idx - 1); }
        else if (e.key === "Enter") {
            const en = btns.filter((b) => !b.disabled);
            if (idx >= 0 && en[idx]) { e.preventDefault(); en[idx].click(); }
        }
    };
    entry.menuEl = menu;
    return menu;
}

function openPanel(rt, entry, spec, layer, opts) {
    if (spec.modal) {
        const bd = el("div", "ns-menu-backdrop");
        layer.appendChild(bd);
        entry.bag.listen(bd, "pointerdown", (e) => { e.preventDefault(); close(rt, entry.name); });
    }
    const menu = el("div", "ns-menu ns-panel");
    menu.tabIndex = -1;
    const v2 = spec.look === "v2";
    if (v2) { menu.classList.add("ns-pv2"); ensureMenuFont(); applySize(menu, spec); }
    else {
        menu.style.width = (Number(spec.width) || 380) + "px";
        if (spec.height) menu.style.height = Number(spec.height) + "px";
    }
    const head = el("div", "ns-panel-head");
    const title = el("span", "ns-panel-title");
    const closeBtn = el("button", "ns-btn ns-btn-ghost ns-btn-icon");
    closeBtn.type = "button"; closeBtn.textContent = "✕"; closeBtn.title = "Close (Esc)";
    entry.bag.listen(closeBtn, "click", (e) => { e.stopPropagation(); close(rt, entry.name); });
    let headTree = null, chip = null;
    if (v2) {
        chip = el("span", "ns-pv2-chip");
        const fill = el("span", "ns-pv2-fill");
        head.append(title, chip, fill);
        if (spec.head) { headTree = renderTree(rt, spec.head, "menuhead:" + entry.name); const hx = el("div", "ns-pv2-headx"); hx.appendChild(headTree.root); head.append(hx); entry.bag.add(() => headTree.dispose()); }
        head.append(closeBtn);
    } else head.append(title, closeBtn);
    const body = el("div", "ns-panel-body");
    menu.append(head, body);
    layer.appendChild(menu);

    const tree = renderTree(rt, spec.tree, "menu:" + entry.name);
    body.appendChild(tree.root);
    entry.tree = tree;
    entry.bag.add(() => tree.dispose());
    const setTitle = () => { const t = evalValue(rt, spec.title); const s = t == null ? "" : String(t); if (title.textContent !== s) title.textContent = s; };
    setTitle();
    const setChip = () => { if (!chip) return; const t = evalValue(rt, spec.chip); const s2 = t == null || t === "*" ? "" : String(t); if (chip.textContent !== s2) chip.textContent = s2; };
    setChip();
    entry.update = () => { setTitle(); setChip(); tree.update(); headTree?.update(); };
    tree.update();

    // persisted geometry (kit state, JSON string)
    const gkey = spec.geometry?.state;
    const geom = gkey ? safeParse(rt.ctx.state.get(gkey), null) : null;
    if (!v2 && geom && Number.isFinite(geom.w)) menu.style.width = Math.max(270, geom.w) + "px";
    if (!v2 && geom && Number.isFinite(geom.h)) menu.style.height = Math.max(120, geom.h) + "px";
    entry.geomRestore = geom && Number.isFinite(geom.x) && Number.isFinite(geom.y) ? { x: geom.x, y: geom.y } : null;
    let ready = false;
    const saveGeom = () => {
        if (!gkey || !ready) return;
        const r = menu.getBoundingClientRect();
        try { rt.ctx.state.set(gkey, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })); } catch (_) {}
    };
    entry.bag.timeout(() => { ready = true; }, 150);

    // drag from the header
    entry.bag.listen(head, "pointerdown", (e) => {
        if (e.target.closest("button")) return;
        entry.docked = false;                                   // v2: dragging the header unhooks the menu from its subject
        const r = menu.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        head.classList.add("ns-drag");
        try { head.setPointerCapture(e.pointerId); } catch (_) {}
        const move = (ev) => {
            menu.style.left = clamp(ev.clientX - dx, 0, Math.max(0, innerWidth - 60)) + "px";
            menu.style.top = clamp(ev.clientY - dy, 0, Math.max(0, innerHeight - 40)) + "px";
        };
        const up = () => {
            head.classList.remove("ns-drag");
            head.removeEventListener("pointermove", move);
            head.removeEventListener("pointerup", up);
            head.removeEventListener("pointercancel", up);
            saveGeom();
        };
        head.addEventListener("pointermove", move);
        head.addEventListener("pointerup", up);
        head.addEventListener("pointercancel", up);
        // if the menu closes during the drag, remove it anyway
        entry.bag.add(() => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); head.removeEventListener("pointercancel", up); });
    });

    // native CSS resize -> kit observeResize (tracked, released in close)
    if (gkey) {
        let t = null;
        rt.ctx.perf.observeResize(menu, () => { clearTimeout(t); t = setTimeout(saveGeom, 250); });
        entry.bag.add(() => { clearTimeout(t); try { rt.ctx.perf.unobserveResize(menu); } catch (_) {} });
    }
    entry.menuEl = menu;
    return menu;
}

// ------------------------------------------------------------
export function open(rt, name, opts = {}) {
    if (rt.destroyed) return null;
    const spec = opts.spec || rt.spec.menus?.[name];     // opts.spec: menu synthesized by a kit piece (e.g. editor_element)
    if (!spec) { console.warn(`[NodeStructure] menu '${name}' not declared (${rt.def.type})`); return null; }
    const id = globalId(rt.ctx.key, "menu", name);

    if (OPEN.has(id) && !opts.reopen) { close(rt, name); return null; } // toggle
    // only one open, anywhere... except a picker opened OVER a menu (opts.over, D-85): the menu stays put, only other pickers leave
    if (opts.over) { for (const e of [...OPEN.values()]) if (e.spec?.kind === "picker") close(e.rt, e.name); }
    else closeEverything();

    ensureGuards(rt);
    const { host, root } = buildHost(rt, id, rt.spec);
    const entry = { id, name, rt, host, root, bag: new Bag("menu:" + name), spec, nav: null, update: null, menuEl: null, tree: null, onClose: opts.onClose };
    OPEN.set(id, entry);
    rt.menus.set(name, entry);
    entry.bag.add(() => { try { host.remove(); } catch (_) {} });

    // event isolation: the menu never reaches the canvas. What's said in the menu stays in the menu.
    const stop = (e) => e.stopPropagation();

    let menuEl;
    try {
        menuEl = spec.kind === "panel" ? openPanel(rt, entry, spec, root, opts) : spec.kind === "picker" ? openPicker(rt, entry, spec, root, opts) : openList(rt, entry, spec, root);
    } catch (e) {
        console.warn(`[NodeStructure] opening menu '${name}' failed:`, e);
        close(rt, name);
        return null;
    }
    for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel", "keyup", "touchstart"]) {
        entry.bag.listen(menuEl, ev, stop, ev === "wheel" ? { passive: true } : undefined);
    }
    entry.bag.listen(menuEl, "keydown", stop);

    // v2: anchored to the subject (follows pan/zoom/moves) or free; size recomputed on window resize
    const isV2 = spec.kind === "panel" && spec.look === "v2";
    if (isV2) {
        entry.docked = spec.dock === "subject";
        entry.bag.listen(window, "resize", () => { applySize(menuEl, spec); if (!entry.docked) place(menuEl, { point: { x: parseFloat(menuEl.style.left) || 8, y: parseFloat(menuEl.style.top) || 8 } }); });
    }
    // position (after append: we need the measurement)
    if (isV2 && entry.docked && subjectRect(rt)) dockPlace(menuEl, subjectRect(rt));
    else if (entry.geomRestore && !isV2) { menuEl.style.left = entry.geomRestore.x + "px"; menuEl.style.top = entry.geomRestore.y + "px"; place(menuEl, { point: entry.geomRestore }); }
    else place(menuEl, { anchor: opts.anchor, point: opts.point });
    try { menuEl.focus({ preventScroll: true }); } catch (_) {}

    // graph change / vanished node check (kit RAF, only while open)
    let last = 0;
    rt.ctx.perf.acquireRAF("ns-menu-watch", () => {
        // v2 anchored: follows the subject around. Cost: 1 geometry read per frame, writes to the DOM only on change.
        for (const en of OPEN.values()) if (en.rt === rt && en.docked && en.menuEl) { const r = subjectRect(rt); if (r) dockPlace(en.menuEl, r); }
        for (const en of OPEN.values()) if (en.rt === rt && en.tick) { try { en.tick(); } catch (e) { console.warn("[NodeStructure] picker tick:", e); } }
        const now = performance.now();
        if (now - last < 250) return;
        last = now;
        if (rt.destroyed || !graphStillActive(rt)) closeAllFor(rt);
    });
    entry.bag.add(() => {
        const stillMine = [...OPEN.values()].some((e) => e.rt === rt && e !== entry);
        if (!stillMine) { try { rt.ctx.perf.releaseRAF("ns-menu-watch"); } catch (_) {} }
    });
    return entry;
}

// ---------- picker (D-61): dropdown with filter + explicit confirmation ----------
// Arrows/click/hover ONLY highlight (preview: the object pulses on the canvas). Apply with ✓ or Enter. Consent matters.
// Closes without changing anything with Esc, ✕ or by opening another menu; clicking outside does NOT close it (explicit dismiss).
// Stays anchored to the element that opened it (opts.anchor) while the canvas moves.
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
export const supNum = (n) => String(n).split("").map((d) => SUP[+d] ?? d).join("");
function openPicker(rt, entry, spec, layer, opts) {
    const PAGE = 5;                                                    // rows per page: a long list is paged « 1/48 », not scrolled
    let page = 0, filtered = [];
    const menu = el("div", "ns-menu ns-pv2 ns-pick");
    menu.tabIndex = -1;
    menu.setAttribute("role", "dialog");
    ensureMenuFont();
    const head = el("div", "ns-panel-head");
    const title = el("span", "ns-panel-title"); title.textContent = String(spec.title ?? "");
    const chip = el("span", "ns-pv2-chip"); chip.textContent = spec.chip ? String(spec.chip) : "";
    const fill = el("span", "ns-pv2-fill");
    const x = el("button", "ns-btn ns-btn-ghost ns-btn-icon"); x.type = "button"; x.textContent = "✕"; x.title = "Close without changes (Esc)";
    head.append(title, chip, fill, x);
    const bar = el("div", "ns-pick-bar");
    const q = el("input", "ns-pick-q"); q.type = "text"; q.placeholder = String(spec.placeholder ?? "Filter…"); q.spellcheck = false; q.autocomplete = "off";
    bar.append(q);
    // "Via": the new wire's path (direct or through a reroute already carrying this output)
    const viaBar = el("div", "ns-pick-via");
    let via = null, viaOpts = [];
    const loadVia = () => {
        viaOpts = []; try { viaOpts = spec.via?.options?.() || []; } catch (e) { console.warn("[NodeStructure] picker via:", e); }
        viaBar.textContent = "";
        if (viaOpts.length < 2) { viaBar.style.display = "none"; via = viaOpts[0]?.key ?? null; return; }
        viaBar.style.display = "";
        if (!viaOpts.some((o) => o.key === via)) via = viaOpts[0].key;
        const lab = el("span", "ns-pick-via-l"); lab.textContent = "Via"; viaBar.append(lab);
        for (const o of viaOpts) {
            const b = el("button", "ns-pick-via-b" + (o.key === via ? " ns-on" : "")); b.type = "button"; b.textContent = String(o.label);
            entry.bag.listen(b, "click", (e) => { e.stopPropagation(); via = o.key; loadVia(); });
            entry.bag.listen(b, "mouseenter", () => { pingVia = o.key; });
            entry.bag.listen(b, "mouseleave", () => { pingVia = null; });
            viaBar.append(b);
        }
    };
    let pingVia = null;
    const list = el("div", "ns-pick-list"); list.setAttribute("role", "listbox");
    const msg = el("div", "ns-pick-msg");
    const warn = el("div", "ns-pick-warn"); warn.textContent = spec.warn ? String(spec.warn) : "";
    const hint = el("div", "ns-pick-hint"); hint.textContent = spec.hint ? String(spec.hint) : "";
    // pager « 1/48 »: shown only when the (filtered) list needs more than one page
    const pager = el("div", "ns-pick-pager"); pager.style.display = "none";
    const pgPrev = el("button", "ns-pick-pg"); pgPrev.type = "button"; pgPrev.textContent = "«"; pgPrev.title = "Previous page (PageUp)";
    const pgInfo = el("span", "ns-pick-pgi");
    const pgNext = el("button", "ns-pick-pg"); pgNext.type = "button"; pgNext.textContent = "»"; pgNext.title = "Next page (PageDown)";
    pager.append(pgPrev, pgInfo, pgNext);
    menu.append(head, bar, viaBar, list, pager, msg);
    if (spec.warn) menu.append(warn);
    if (spec.hint) menu.append(hint);
    const ping = el("div", "ns-pv2 ns-pick-ping");
    layer.append(menu, ping);

    let all = [], shown = [], hi = -1, rows = [];
    const load = () => { try { all = (typeof spec.items === "function" ? spec.items() : spec.items) || []; } catch (e) { console.warn("[NodeStructure] picker items:", e); all = []; } };
    // the list never starts a text selection, whatever the click count: no selection = no "Translate / Explore" bubble (D-119)
    entry.bag.listen(list, "selectstart", (e) => e.preventDefault());
    // class "ns-marquee", NOT "ns-mq": .ns-mq is the Crop's selection box (absolute, blue border) and would drag our text out of the row (D-119)
    const marquee = (row, on) => {
        const t = row?.querySelector(".ns-pick-in"), box = row?.querySelector(".ns-pick-txt");
        if (!t || !box) return;
        const over = box.scrollWidth - box.clientWidth;
        if (on && over > 2) { t.style.setProperty("--ns-mq", -over + "px"); t.style.setProperty("--ns-mq-s", Math.max(1.5, over / 40) + "s"); t.classList.add("ns-marquee"); }
        else t.classList.remove("ns-marquee");
    };
    const setHi = (i, scroll = true) => {
        if (rows[hi]) { rows[hi].classList.remove("ns-hi"); marquee(rows[hi], false); }
        hi = shown.length && i >= 0 ? Math.min(shown.length - 1, i) : -1;
        if (rows[hi]) { rows[hi].classList.add("ns-hi"); marquee(rows[hi], true); if (scroll) rows[hi].scrollIntoView?.({ block: "nearest" }); }
        msg.textContent = "";
    };
    const say = (r) => { msg.textContent = r === true || r === undefined ? "" : String(r || "Not done"); };
    const confirm = (k = hi) => {
        const it = shown[k];
        if (!it) return;
        if (it.state === "current" || it.group === "on") { if (!it.removable) close(rt, entry.name); return; }   // already like that: nothing to do
        let r;
        try { r = spec.pick?.(it, via); } catch (e) { console.warn("[NodeStructure] picker pick:", e); r = String(e?.message || e); }
        if (r === true || r === undefined) close(rt, entry.name);
        else { load(); render(); say(r); }
    };
    const remove = (k) => {
        const it = shown[k];
        if (!it?.removable) return;
        let r;
        try { r = spec.unpick?.(it); } catch (e) { console.warn("[NodeStructure] picker unpick:", e); r = String(e?.message || e); }
        load(); loadVia(); render(); say(r);
    };
    const groups = spec.groups || null;
    const render = () => {
        const f = q.value.trim().toLowerCase();
        const keep = shown[hi]?.key;
        filtered = f ? all.filter((it) => `${it.label} ${it.bold || ""} ${it.sub || ""}`.toLowerCase().includes(f)) : all.slice();
        const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
        if (keep !== undefined) { const gi = filtered.findIndex((it) => it.key === keep); if (gi >= 0) page = Math.floor(gi / PAGE); }   // a refresh keeps you where you were
        page = Math.max(0, Math.min(page, pages - 1));
        shown = filtered.slice(page * PAGE, (page + 1) * PAGE);
        pager.style.display = pages > 1 ? "" : "none";
        pgInfo.textContent = `${page + 1}/${pages}`;
        pgPrev.disabled = page <= 0; pgNext.disabled = page >= pages - 1;
        list.textContent = "";
        rows = [];
        let lastGroup;
        shown.forEach((it, k) => {
            const g = it.group || "";
            if (groups && g !== lastGroup && groups[g]) { const h = el("div", "ns-pick-group"); h.textContent = String(groups[g]); list.append(h); }
            lastGroup = g;
            const r = el("div", "ns-pick-row" + (it.state === "current" ? " ns-cur" : it.state === "warn" ? " ns-warn" : ""));
            r.setAttribute("role", "option");
            const sym = el("span", "ns-pick-sym"); sym.textContent = it.sym || "";
            const box = el("span", "ns-pick-txt"); const t = el("span", "ns-pick-in"); t.append(document.createTextNode(String(it.label ?? "")));
            if (it.bold) { const b = el("b"); b.textContent = ` (${it.bold})`; t.append(b); }
            box.append(t);
            const sub = el("span", "ns-pick-sub"); sub.textContent = it.sub || (it.state === "current" ? "current" : "");
            r.append(sym, box, sub);
            if (it.removable) {
                const bx = el("button", "ns-pick-x"); bx.type = "button"; bx.textContent = "✕"; bx.title = "Disconnect";
                entry.bag.listen(bx, "click", (e) => { e.stopPropagation(); remove(k); });
                r.append(bx);
            } else if (it.state !== "current") {
                const bv = el("button", "ns-pick-go"); bv.type = "button"; bv.textContent = "✓"; bv.title = "Connect";
                entry.bag.listen(bv, "click", (e) => { e.stopPropagation(); setHi(k, false); confirm(k); });
                r.append(bv);
            }
            entry.bag.listen(r, "click", (e) => { e.stopPropagation(); setHi(k, false); });
            // a second click never starts a text selection (the browser's "Translate / Explore" bubble on the connected row, D-118)
            entry.bag.listen(r, "mousedown", (e) => { if (e.detail > 1) e.preventDefault(); });
            entry.bag.listen(r, "dblclick", (e) => { e.stopPropagation(); setHi(k, false); if (!it.removable) confirm(k); });   // double click = connect
            entry.bag.listen(r, "mouseenter", () => marquee(r, true));
            entry.bag.listen(r, "mouseleave", () => { if (k !== hi) marquee(r, false); });
            list.append(r);
            rows.push(r);
        });
        if (!shown.length) { const e0 = el("div", "ns-pick-empty"); e0.textContent = all.length ? "No match" : String(spec.empty ?? "Nothing compatible"); list.append(e0); }
        let k = shown.findIndex((it) => it.key === keep);
        // never highlight a ⚠ row on our own (Enter would replace a wire): first normal row, otherwise nothing
        if (k < 0 || k >= rows.length) k = shown.findIndex((it) => !it.group && !it.state);
        hi = -1;
        setHi(k, false);
    };
    entry.bag.listen(x, "click", (e) => { e.stopPropagation(); close(rt, entry.name); });
    const pageCount = () => Math.max(1, Math.ceil(filtered.length / PAGE));
    const goPage = (n, last = false) => {
        const t = Math.max(0, Math.min(n, pageCount() - 1));
        if (t === page && !last) return;
        page = t; shown = []; hi = -1; render();
        if (last) setHi(shown.length - 1);
    };
    entry.bag.listen(pgPrev, "click", (e) => { e.stopPropagation(); goPage(page - 1); });
    entry.bag.listen(pgNext, "click", (e) => { e.stopPropagation(); goPage(page + 1); });
    entry.bag.listen(q, "input", () => { page = 0; shown = []; hi = -1; render(); });
    entry.nav = (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); if (hi + 1 >= shown.length && page < pageCount() - 1) goPage(page + 1); else setHi(hi + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); if (hi <= 0 && page > 0) goPage(page - 1, true); else setHi(Math.max(0, hi - 1)); }
        else if (e.key === "PageDown") { e.preventDefault(); goPage(page + 1); }
        else if (e.key === "PageUp") { e.preventDefault(); goPage(page - 1); }
        else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); confirm(); }
        else if (e.key === "Delete" && shown[hi]?.removable) { e.preventDefault(); e.stopPropagation(); remove(hi); }
    };
    // preview: the highlighted object (or the "Via" reroute under the mouse) pulses on the canvas
    let lastPing = "";
    entry.tick = () => {
        if (opts.anchor?.isConnected) place(menu, { anchor: opts.anchor });
        const it = shown[hi];
        let r = null;
        try { r = pingVia != null && spec.via?.preview ? spec.via.preview(pingVia) : it && spec.preview ? spec.preview(it) : null; } catch (e) { r = null; }
        const s2 = r ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)},${r.round ? 1 : 0}` : "";
        if (s2 === lastPing) return;
        lastPing = s2;
        if (!r) { ping.style.display = "none"; return; }
        ping.style.display = "block";
        ping.style.left = Math.round(r.left - 4) + "px"; ping.style.top = Math.round(r.top - 4) + "px";
        ping.style.width = Math.round(r.width + 8) + "px"; ping.style.height = Math.round(r.height + 8) + "px";
        ping.classList.toggle("ns-round", !!r.round);
    };
    entry.refresh = () => { load(); loadVia(); render(); };
    load(); loadVia(); render();
    entry.bag.timeout?.(() => { try { q.focus({ preventScroll: true }); } catch (_) {} }, 0);
    entry.menuEl = menu;
    return menu;
}

export function close(rt, name) {
    const id = globalId(rt.ctx.key, "menu", name);
    const entry = OPEN.get(id);
    if (!entry) return false;
    // a field still being typed in commits on blur: blur it BEFORE the tree goes, or a click outside eats the value (D-108)
    try {
        const root = entry.menuEl?.getRootNode?.();
        const a = root?.activeElement || document.activeElement;
        if (a && entry.menuEl?.contains?.(a) && typeof a.blur === "function") a.blur();
    } catch (_) { /* nothing focused, nothing to save */ }
    OPEN.delete(id);
    rt.menus.delete(name);
    try { entry.bag.dispose(); } catch (_) {}
    try { entry.onClose?.(); } catch (_) {}
    return true;
}

export function closeAllFor(rt) {
    let n = 0;
    for (const e of [...OPEN.values()]) if (e.rt === rt && close(rt, e.name)) n++;
    return n;
}

export function closeEverything() {
    let n = 0;
    for (const e of [...OPEN.values()]) if (close(e.rt, e.name)) n++;
    return n;
}

export const isOpen = (rt, name) => OPEN.has(globalId(rt.ctx.key, "menu", name));
export const stats = () => ({ open: OPEN.size, ids: [...OPEN.keys()] });

export const FloatMenu = { open, close, closeAllFor, closeEverything, isOpen, stats, graphStillActive };

// ---- menu cards (declared in spec.menus, NOT in the tree) ----
const MENU_NOTE = () => ({ el: Object.assign(document.createElement("div"), { className: "ns-missing", textContent: "[i menu si dichiarano in spec.menus]" }) });
const MENU_EX = (m) => ({ spec: { v: 1, regions: [{ id: "r", height: 30, tree: { t: "label_element", text: "x" } }], menus: { m } }, actions: { nop() {} } });
piece(C("menu_float_list", {
    scopo: "Menu a elenco fuori maschera: voci con azione, sottomenu, spunte, scorciatoie.", natura: "funziona", estado: "stable", archetipo: "container",
    tag: ["menu", "solo-menu"], alias: [], props: { items: { ...J("array di voci {label, action, icon, shortcut, checked, disabled, keepOpen, children} o ref a una lista"), required: true } },
    esempio: MENU_EX({ kind: "menu_float_list", items: [{ label: "uno", action: "$actions.nop" }, { type: "sep" }, { label: "due", action: "$actions.nop" }] }),
}), MENU_NOTE);
piece(C("menu_float_panel", {
    scopo: "Pannello fuori maschera (anche modale) con un albero di pezzi, trascinabile e con geometria persistita.", natura: "funziona", estado: "stable", archetipo: "container",
    tag: ["menu", "solo-menu"], alias: [],
    props: { title: S("titolo"), icon: S("icona"), tree: { ...J("albero di pezzi del pannello"), required: true }, modal: B("modale con sfondo", false), geometry: J("{state:'chiave'} dove persistere posizione/dimensione"), width: N("larghezza iniziale"), height: N("altezza iniziale"),
        look: E(["classic", "v2"], "aspetto: v2 = protocollo menu dedicato (dimensione fissa, token --nsm-*, D-57)", "classic"),
        size: E(["auto", "L", "M", "S", "fit"], "v2: taglia fissa (auto = scelta all'apertura dallo spazio libero; fit = larghezza `width`, altezza del contenuto)", "auto"),
        dock: E(["free", "subject"], "v2: subject = agganciato al nodo/reroute (lato con piu' spazio) e lo segue; trascinando l'header si stacca", "free"),
        dismiss: E(["outside", "explicit"], "v2: explicit = si chiude solo con ✕/Esc/comando; outside = anche cliccando fuori", "outside"),
        chip: S("v2: testo della pillola accanto al titolo (template, es. tipo del filo)"), head: J("v2: albero di pezzi nell'header, prima della ✕ (es. pulsante ricarica, pallino)") },
    esempio: MENU_EX({ kind: "menu_float_panel", title: "p", width: 240, tree: { t: "label_element", text: "dentro" } }),
}), MENU_NOTE);
void E;
