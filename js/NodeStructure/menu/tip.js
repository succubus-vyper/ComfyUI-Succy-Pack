// ============================================================
// NodeStructure/menu/tip.js — THE kit hover (D-63)
// ------------------------------------------------------------
// A single help box for the whole pack, same look as the v2 menus (--nsm-* tokens).
// No native `title` in the kit pieces: use Tip.attach(bag, el, () => content).
// And if one slips through anyway (or an old node still sets `el.title = ...`), the ADOPTER below swallows it: see adoptNative (D-80).
//   content = { title, chip?, body?: [line, ...], hint? }   (strings; empty lines skipped)
//   a body line can also be segments: ["plain ", { b: "bold" }, " plain"] — text only, never HTML
// While our hover is visible, ComfyUI's native tooltip (selector from Survival:
// SurvivalKit.inputLink.VUE.nativeTip) gets hidden: never two hovers at once. One at a time, please.
// ============================================================
import { registerCss } from "../theme/theme.js";

const DELAY = 350;
const NATIVE = () => globalThis.SurvivalKit?.inputLink?.VUE?.nativeTip || ".p-tooltip";

const TIP_CSS = () => `
.ns-tip{position:fixed;z-index:999995;pointer-events:none;max-width:280px;box-sizing:border-box;padding:8px 10px;border-radius:8px;
background:var(--nsm-bg);color:var(--nsm-text);border:1px solid var(--nsm-line-strong);box-shadow:0 10px 28px rgba(0,0,0,.5),0 1px 3px rgba(0,0,0,.4);
font:12px/1.4 var(--nsm-font);opacity:0;transform:translateY(2px);transition:opacity .12s,transform .12s}
.ns-tip.ns-on{opacity:1;transform:none}
.ns-tip-h{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--nsm-text-strong)}
.ns-tip-h>span:first-child{min-width:0;overflow-wrap:anywhere;word-break:break-word}
.ns-tip-h .ns-tip-c{flex:0 0 auto}
.ns-tip-c{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:9px;background:var(--nsm-chip-bg);color:var(--nsm-chip-text);font:10px var(--nsm-mono);font-weight:400}
.ns-tip-b{margin-top:4px;color:var(--nsm-text-dim);white-space:pre-wrap;word-break:break-word}
.ns-tip-i{margin-top:6px;color:var(--nsm-text-muted);font-size:11px}
body.ns-tip-mute ${NATIVE()}{display:none!important}
`;
let cssDone = false;
const ensureCss = () => { if (!cssDone) { cssDone = true; registerCss("ns-tip", TIP_CSS()); } };

let box = null, timer = null, owner = null;
function host() {
    if (box?.isConnected) return box;
    box = document.createElement("div");
    box.className = "ns-tip ns-pv2";
    box.setAttribute("role", "tooltip");
    document.body.appendChild(box);
    return box;
}
const mk = (cls, txt) => { const d = document.createElement("div"); d.className = cls; d.textContent = txt; return d; };

function render(c) {
    const b = host();
    b.textContent = "";
    const h = mk("ns-tip-h", "");
    const t = document.createElement("span"); t.textContent = String(c.title ?? ""); h.append(t);
    if (c.chip) { const s = document.createElement("span"); s.className = "ns-tip-c"; s.textContent = String(c.chip); h.append(s); }
    b.append(h);
    for (const line of c.body || []) {
        if (!line) continue;
        if (!Array.isArray(line)) { b.append(mk("ns-tip-b", String(line))); continue; }
        // segments: bold where asked, the rest plain — textContent all the way down, no HTML sneaks in, darling
        const d = mk("ns-tip-b", "");
        for (const s of line) { if (s && typeof s === "object") { const e = document.createElement("b"); e.textContent = String(s.b ?? ""); d.append(e); } else if (s != null) d.append(String(s)); }
        b.append(d);
    }
    if (c.hint) b.append(mk("ns-tip-i", String(c.hint)));
}
function place(el) {
    const b = host(), a = el.getBoundingClientRect(), r = b.getBoundingClientRect();
    let x = a.left, y = a.bottom + 8;
    if (y + r.height > innerHeight - 8) y = a.top - r.height - 8;              // above if there's no room below
    x = Math.min(Math.max(8, x), Math.max(8, innerWidth - r.width - 8));
    b.style.left = Math.round(x) + "px"; b.style.top = Math.round(Math.max(8, y)) + "px";
}

export function show(el, content) {
    ensureCss();
    let c;
    try { c = typeof content === "function" ? content() : content; } catch (e) { console.warn("[NodeStructure] tip content:", e); return; }
    if (!c) return hide();
    owner = el;
    render(c);
    place(el);
    document.body.classList.add("ns-tip-mute");
    host().classList.add("ns-on");
}
export function hide(el) {
    if (el && owner && el !== owner) return;
    clearTimeout(timer); timer = null; owner = null;
    document.body.classList.remove("ns-tip-mute");
    box?.classList.remove("ns-on");
}
// hook tracked in the piece's bag (released on dispose)
export function attach(bag, el, content) {
    ensureCss();
    const enter = () => {
        document.body.classList.add("ns-tip-mute");                                // the native one must not fire even during the delay
        clearTimeout(timer); timer = setTimeout(() => show(el, content), DELAY);
    };
    const leave = () => { if (!owner || owner === el) hide(); };
    bag.listen(el, "mouseenter", enter);
    bag.listen(el, "mouseleave", leave);
    bag.listen(el, "pointerdown", () => hide());
    bag.listen(el, "wheel", () => hide(), { passive: true });
    bag.add(() => { if (owner === el || timer) hide(); });
}

// ---- the adopter (D-80): "hide native tooltips", but make them ours --------------------------------------------------------
// ONE delegated listener for the whole page. When the mouse lands on an element that carries a native `title` AND lives inside
// pack DOM (a class starting with ns- / nsm- / succy), the title is moved to `data-ns-title` (so the browser has nothing to
// show) and rendered by Tip instead: same look, same delay, wraps, palette. ComfyUI's own elements are left strictly alone.
// First line = Tip title, the rest = Tip body. Past code, future code, old nodes: all adopted, nobody has to remember anything.
const adopt = { on: true, adopted: 0, installed: false };
let adoptEl = null;
const inPack = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
        const cl = n.classList;
        if (cl) for (const c of cl) if (c.startsWith("ns-") || c.startsWith("nsm-") || c.startsWith("succy")) return true;
    }
    return false;
};
const contentOf = (txt) => { const [first, ...rest] = String(txt).split("\n"); return { title: first, body: rest.length ? [rest.join("\n")] : undefined }; };

function onOver(e) {
    if (!adopt.on) return;
    const el = e.target?.closest?.("[title],[data-ns-title]");
    if (!el || el === adoptEl || !inPack(el)) return;
    let txt = el.getAttribute("data-ns-title");
    if (el.hasAttribute("title")) {                                           // (re)written by someone: it wins and gets swallowed
        txt = el.getAttribute("title");
        el.removeAttribute("title");
        el.setAttribute("data-ns-title", txt);
        adopt.adopted++;
        if (!el.hasAttribute("aria-label") && !(el.textContent || "").trim()) el.setAttribute("aria-label", txt);   // icon-only buttons keep a name
    }
    if (!txt) return;
    if (adoptEl) hide();
    adoptEl = el;
    ensureCss();
    document.body.classList.add("ns-tip-mute");
    clearTimeout(timer); timer = setTimeout(() => show(el, () => contentOf(el.getAttribute("data-ns-title"))), DELAY);
}
function onOut(e) {
    if (!adoptEl) return;
    if (e.relatedTarget && adoptEl.contains(e.relatedTarget)) return;        // still inside the same element
    const el = adoptEl; adoptEl = null; hide(el);
}
function onGone() { if (adoptEl) { adoptEl = null; hide(); } }

export function adoptNative(on = true) {
    adopt.on = !!on;
    if (!adopt.installed && typeof document !== "undefined") {
        adopt.installed = true;
        document.addEventListener("mouseover", onOver, true);
        document.addEventListener("mouseout", onOut, true);
        document.addEventListener("pointerdown", onGone, true);
        document.addEventListener("wheel", onGone, { capture: true, passive: true });
    }
    if (!adopt.on) onGone();
    return adopt.on;
}
adoptNative(true);

export const Tip = { attach, show, hide, isOpen: () => !!owner, adoptNative, stats: () => ({ on: adopt.on, adopted: adopt.adopted }) };
