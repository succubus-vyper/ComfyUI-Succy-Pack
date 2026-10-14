// ============================================================
// NodeStructure/components/status.js — status_element (D-82)
// The dark little display of Succy Pause (status + big countdown) and Succy Clean VRAM (status + bar + reading), as ONE piece.
// A caption line, an optional bar and a big value, all coloured by a TONE (info warn danger ok orange calm mute: the
// --ns-t-* palette). Reusable by any node that wants to say "how things stand" — Loop and the LLM node are next in line.
// Succubus was here — she likes a node that shows its status, and doesn't hide what it's doing.
// ============================================================
import { mkEl } from "./index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, E, R } from "../catalog/kit.js";

const TONES = ["info", "warn", "danger", "ok", "orange", "calm", "mute"];
const safeTone = (t, def) => (TONES.includes(String(t)) ? String(t) : def);

const CSS = `
.ns-status{display:flex;flex-direction:column;justify-content:center;gap:5px;padding:10px;min-height:44px;background:#0e0e0e;border-radius:4px;box-shadow:inset 0 0 5px rgba(0,0,0,.5);text-align:center;box-sizing:border-box;min-width:0}
.ns-status-label{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--ns-t-mute);transition:color .2s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-status-bar{width:100%;height:6px;background:rgba(255,255,255,.05);border-radius:3px;overflow:hidden}
.ns-status-bar>i{display:block;height:100%;width:0;background:var(--ns-t-info);transition:width .3s ease,background .3s ease}
.ns-status-value{font-weight:bold;line-height:1;color:var(--ns-t-info);transition:color .2s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-status-l .ns-status-value{font-size:20px;min-height:20px}
.ns-status-m .ns-status-value{font-size:13px}
.ns-status-value:empty,.ns-status-label:empty,.ns-status-bar[hidden]{display:none}
.ns-status-l{padding:12px 10px 10px 10px;gap:4px}
`;

piece(C("status_element", {
    scopo: "Display scuro di stato: caption, barra 0-100 opzionale e valore grande, colorati da un tono (info, warn, danger...).",
    natura: "estetica", estado: "draft", archetipo: "leaf",
    tag: ["stato", "barra", "display"], css: CSS,
    props: {
        label: R("riga piccola in maiuscolo (testo o ref)"),
        value: R("valore grande (testo o ref); vuoto = nascosto"),
        bar: R("percentuale 0-100 della barra (numero o ref); vuoto/non numerico = barra nascosta"),
        tone: R("tono del valore e della barra (info warn danger ok orange calm mute)"),
        labelTone: R("tono della riga piccola (default mute)"),
        size: E(["l", "m"], "l = valore a 20px (countdown), m = 13px (lettura)", "m"),
    },
    esempio: ex({ t: "status_element", label: "READY TO USE", value: "12s", bar: 40, tone: "warn", size: "l" }),
}), (node, h) => {
    const el = mkEl("div", "ns-status");
    const label = mkEl("div", "ns-status-label");
    const bar = mkEl("div", "ns-status-bar"); const fill = mkEl("i"); bar.appendChild(fill);
    const value = mkEl("div", "ns-status-value");
    el.append(label, bar, value);
    const s = { size: "", tone: "", ltone: "", txtL: null, txtV: null, pct: null };
    const apply = () => {
        const size = h.val(node.size) === "l" ? "l" : "m";
        if (size !== s.size) { el.classList.remove("ns-status-" + (s.size || "m")); el.classList.add("ns-status-" + size); s.size = size; }
        const tone = safeTone(h.val(node.tone), "info");
        const ltone = safeTone(h.val(node.labelTone), "mute");
        const t = String(h.val(node.label) ?? ""), v = String(h.val(node.value) ?? "");
        if (t !== s.txtL) { s.txtL = t; label.textContent = t; }
        if (v !== s.txtV) { s.txtV = v; value.textContent = v; }
        if (tone !== s.tone) { s.tone = tone; value.style.color = `var(--ns-t-${tone})`; fill.style.background = `var(--ns-t-${tone})`; }
        if (ltone !== s.ltone) { s.ltone = ltone; label.style.color = `var(--ns-t-${ltone})`; }
        const raw = h.val(node.bar);
        const n = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
        const pct = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
        if (pct !== s.pct) { s.pct = pct; bar.hidden = pct === null; fill.style.width = (pct ?? 0) + "%"; }
    };
    apply();
    return { el, update: apply, handlesText: true };
});
