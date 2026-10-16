// ============================================================
// NodeStructure/components/drop.js — a LOAD box for one picture input (Crop & Stitch, D-128)
//   drop_element   a coloured box with a big title, 📂 in the middle and "click · drop · Ctrl+V": the picture goes to ComfyUI's input
//                  folder (native upload, same door as load_mask), its name into a native. Loaded = its thumbnail + name + ✕.
//                  A wire on the matching input wins at Run: the box says so (`wired`). Optional: a PNG's tEXt into another native.
// The node only names the native, the title and the colour. Succubus was here — open wide, darling: drop it right in.
// ============================================================
import { mkEl } from "./index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, S, R, E, B } from "../catalog/kit.js";
import { ShotFeed } from "../runtime/shot-feed.js";
import { isImg, pickFile, pngText, uploadPicture, inputUrl } from "./brush.js";

const DROPS = new Set();
const DSTATS = { loads: 0, failed: 0, last: "" };
export const dropStats = () => ({ boxes: DROPS.size, ...DSTATS });

const CSS = `
.ns-dropbox{--tone:var(--ns-t-info);position:relative;flex:1 1 120px;min-width:110px;min-height:110px;display:flex;flex-direction:column;border:2px dashed color-mix(in srgb,var(--tone) 70%,transparent);border-radius:8px;background:color-mix(in srgb,var(--tone) 8%,var(--ns-bg-2,#1a1a1a));cursor:pointer;overflow:hidden;user-select:none}
.ns-dropbox:hover,.ns-dropbox.ns-drop-over{border-style:solid;background:color-mix(in srgb,var(--tone) 18%,var(--ns-bg-2,#1a1a1a))}
.ns-dropbox-title{position:relative;z-index:1;padding:5px 8px;font:bold 13px monospace;letter-spacing:1px;text-transform:uppercase;color:var(--tone);text-shadow:0 1px 2px #000}
.ns-dropbox-body{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:4px 8px 8px;text-align:center}
.ns-dropbox-icon{font-size:26px;line-height:1}
.ns-dropbox-hint{font:10px monospace;color:var(--ns-c-text-3,#aaa)}
.ns-dropbox-name{font:10px monospace;color:#fff;background:rgba(0,0,0,.6);padding:1px 5px;border-radius:3px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ns-dropbox-thumb{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:.55;pointer-events:none}
.ns-dropbox-x{position:absolute;z-index:2;right:4px;top:4px;border:none;border-radius:4px;background:rgba(0,0,0,.65);color:#fff;font:bold 11px monospace;padding:2px 6px;cursor:pointer}
.ns-dropbox-x:hover{background:#8b1a1a}
.ns-dropbox.ns-loaded .ns-dropbox-icon,.ns-dropbox.ns-loaded .ns-dropbox-hint{display:none}
.ns-dropbox.ns-wired{border-style:solid;opacity:.75}
`;
const TONES = { info: "--ns-t-info", warn: "--ns-t-warn", ok: "--ns-t-ok", danger: "--ns-t-danger", orange: "--ns-t-orange", calm: "--ns-t-calm" };
const toast = (detail) => { try { globalThis.app?.extensionManager?.toast?.add?.({ severity: "warn", summary: "Load", detail, life: 5000 }); } catch (_) { /* no toast here */ } };

piece(C("drop_element", {
    scopo: "Riquadro di caricamento di una immagine: titolo colorato, 📂, clic / trascina / Ctrl+V; upload nativo, miniatura e ✕.",
    natura: "funziona", dominio: "ui", estado: "draft", archetipo: "leaf",
    tag: ["immagine", "upload", "incolla", "drop", "stitch"], css: CSS,
    props: {
        native: { ...S("widget nativo che tiene il nome del file (cartella input)"), required: true },
        label: S("titolo grande (es. BASE IMAGE)"), hint: S("testo sotto l'icona", "Click · drop · Ctrl+V"),
        tone: E(Object.keys(TONES), "colore del riquadro", "info"),
        wired: R("vero = l'ingresso corrispondente ha un filo: vince lui al Run (il riquadro lo dice)"),
        meta: S("widget nativo dove scrivere il tEXt `chunk` del PNG (assente = non si legge)"), chunk: S("nome del chunk tEXt", "succy_crop"),
        subfolder: S("sottocartella di input", "succy"),
        shot: B("vero = e' anche l'immagine che il nodo guarda ($live.shot_system), come load_mask", false),
    },
    esempio: ex({ t: "drop_element", native: "source", label: "Picture" }),
}), (node, h) => {
    const api = h.rt.api, NAT = node.native;
    const el = mkEl("div", "ns-dropbox");
    el.style.setProperty("--tone", `var(${TONES[node.tone] || TONES.info})`);
    const title = mkEl("div", "ns-dropbox-title"); title.textContent = node.label || "Picture";
    const thumb = mkEl("img", "ns-dropbox-thumb"); thumb.draggable = false; thumb.hidden = true;
    const body = mkEl("div", "ns-dropbox-body");
    const icon = mkEl("div", "ns-dropbox-icon"); icon.textContent = "📂";
    const hint = mkEl("div", "ns-dropbox-hint"); hint.textContent = node.hint || "Click · drop · Ctrl+V";
    const name = mkEl("div", "ns-dropbox-name"); name.hidden = true;
    const x = mkEl("button", "ns-dropbox-x"); x.type = "button"; x.textContent = "✕"; x.title = "Forget this picture"; x.hidden = true;
    const inp = mkEl("input"); inp.type = "file"; inp.accept = "image/*"; inp.style.display = "none";
    body.append(icon, hint, name);
    el.append(thumb, title, body, x, inp);
    const me = { el };
    DROPS.add(me); h.bag.add(() => DROPS.delete(me));

    const take = async (file) => {
        if (!isImg(file)) { toast("That file is not a picture."); return; }
        try {
            const up = await uploadPicture(file, node.subfolder ?? "succy");
            if (node.meta) api.native.set(node.meta, await pngText(file, node.chunk || "succy_crop"));
            api.native.set(NAT, up.name);
            if (node.shot) ShotFeed.put(api.liveNode?.() || api.node, { src: inputUrl(up.name), width: up.w, height: up.h });
            try { (api.liveNode?.() || api.node)?.graph?.change?.(); } catch (_) {}
            DSTATS.loads++; update(); api.refresh?.();
        } catch (e) { DSTATS.failed++; DSTATS.last = String(e?.message || e); toast("Picture not loaded: " + DSTATS.last); }
    };
    const stop = (e) => e.stopPropagation();
    el.addEventListener("pointerdown", stop);
    el.addEventListener("click", (e) => { e.stopPropagation(); inp.click(); });
    x.addEventListener("click", (e) => { e.stopPropagation(); if (node.meta) api.native.set(node.meta, ""); api.native.set(NAT, ""); update(); api.refresh?.(); });
    inp.addEventListener("click", stop);
    inp.addEventListener("change", () => { const f = inp.files?.[0]; inp.value = ""; if (f) take(f); });
    // drop + paste: WINDOW capture, so ComfyUI never turns the picture into a new Load Image node
    const mine = (e) => e.target?.closest?.(".ns-dropbox") === el;
    const over = (e) => { if (!mine(e)) return; e.preventDefault(); e.stopImmediatePropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; el.classList.add("ns-drop-over"); };
    const leave = (e) => { if (!e.relatedTarget || !el.contains(e.relatedTarget)) el.classList.remove("ns-drop-over"); };
    const drop = (e) => { if (!mine(e)) return; e.preventDefault(); e.stopImmediatePropagation(); el.classList.remove("ns-drop-over"); const f = pickFile(e.dataTransfer); if (f) take(f); else toast("Drop a picture FILE here (from a web page: save it first, or copy it and Ctrl+V)."); };
    const paste = (e) => {
        if (!el.matches(":hover") || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
        const f = pickFile(e.clipboardData); if (!f) return;
        e.preventDefault(); e.stopImmediatePropagation(); take(f);
    };
    for (const [ev, fn] of [["dragover", over], ["dragleave", leave], ["drop", drop], ["paste", paste]]) {
        window.addEventListener(ev, fn, true);
        h.bag.add(() => window.removeEventListener(ev, fn, true));
    }

    let last = null;
    const update = () => {
        const v = String(api.native.get(NAT) || ""), wired = !!h.val(node.wired);
        const key = v + "|" + wired;
        if (key === last) return;
        last = key;
        el.classList.toggle("ns-loaded", !!v && !wired);
        el.classList.toggle("ns-wired", wired);
        thumb.hidden = !v || wired; if (v && !wired) thumb.src = inputUrl(v);
        x.hidden = !v;
        name.hidden = !v && !wired;
        name.textContent = wired ? "⟵ from the wire (wins at Run)" : v.split("/").pop();
    };
    update();
    return { el, update, handlesText: true };
});
