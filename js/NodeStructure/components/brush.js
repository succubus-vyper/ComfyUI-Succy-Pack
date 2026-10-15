// ============================================================
// NodeStructure/components/brush.js — FREE HAND mask and picture LOADING on a view_box (Crop & Stitch phase 3, D-106)
//   brush_element  a paint layer over a view_box, in ORIGINAL image pixels: size, hardness, opacity, eraser, [ ] to resize the tip.
//                  Two layers live in ONE PNG (data URL) written to a native: R = painted, G = erased (the eraser can also bite the
//                  rectangle). The native is the only truth: ComfyUI's undo/redo, copy/paste and subgraphs carry the mask for free,
//                  and a copy never shares a file with its twin. The Python reads the same PNG.
//   load_mask      drop / paste (Ctrl+V) / pick (📂) a picture on the view_box: NATIVE upload to ComfyUI's input folder
//                  (SurvivalKit.compat.uploadImage), file name in a native, shown at once through the shot feed — no Queue needed.
// The node never touches the DOM: it only names the pieces, the natives and the state keys. Succubus was here — soft tip, firm hand.
// ============================================================
import { mkEl } from "./index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, exb, N, S, R, ID } from "../catalog/kit.js";
import { parseRef } from "../core/parser.js";
import { writeRef } from "../core/binding.js";
import { ShotFeed } from "../runtime/shot-feed.js";

const BRUSHES = new Set();                    // live brushes (Governor counts them)
const LOADS = { drops: 0, pastes: 0, picks: 0, failed: 0, last: "" };
export const brushStats = () => ({ brushes: BRUSHES.size, painting: [...BRUSHES].filter((b) => b.painting).length, active: [...BRUSHES].filter((b) => b.active).length, ...LOADS });

const CSS = `
.ns-br{position:absolute;left:0;top:0;pointer-events:none}
.ns-br canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.ns-br-add{opacity:.5}.ns-br-ers{opacity:.55}
.ns-br-ring{position:absolute;box-sizing:border-box;border-radius:50%;pointer-events:none;border:calc(1.5px / var(--ns-vs,1)) solid #fff;box-shadow:0 0 0 calc(1px / var(--ns-vs,1)) rgba(0,0,0,.7)}
.ns-br-ring.erase{border-style:dashed}
.ns-br-ring[hidden]{display:none}
.ns-view.ns-br-on{cursor:none}
.ns-view.ns-br-on.pan{cursor:grab}
.ns-view.ns-drop{box-shadow:inset 0 0 0 2px #7cbcff,inset 0 0 18px rgba(124,188,255,.35)}
`;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const RES = 1024;                              // longest side of the stored mask (the Python scales it to the real picture)
const ADD = [255, 79, 163], ERS = [0, 0, 0];   // display tints: pink = painted, black = erased

// ---------- brush_element ----------
piece(C("brush_element", {
    scopo: "Maschera a mano libera su un view_box (pixel originali, gomma, [ ]); salva un PNG (R dipinto, G cancellato) in un nativo.",
    natura: "funziona", dominio: "ui", estado: "draft", archetipo: "renderer-host",
    tag: ["maschera", "brush", "pennello", "crop"], uses: ["view_box"], css: CSS,
    props: {
        data: R("ref del PNG data URL (es. $native.brush); vuoto = maschera vuota"),
        active: R("vero = si dipinge (falso = solo si vede)"),
        size: R("diametro in px immagine (ref di stato, [ ] lo cambiano)"), hardness: R("durezza 0..100"), opacity: R("opacita' 0..100"),
        erase: R("vero = gomma"),
        res: N("lato lungo della maschera salvata (px)", RES),
    },
    esempio: ex({ t: "view_box", children: [{ t: "brush_element", data: "", active: false }] }),
}), (node, h) => {
    const { rt } = h;
    const wrap = mkEl("div", "ns-br");
    const ers = mkEl("canvas", "ns-br-ers"), add = mkEl("canvas", "ns-br-add"), stk = mkEl("canvas", "ns-br-stk");
    const ring = mkEl("div", "ns-br-ring"); ring.hidden = true;
    wrap.append(ers, add, stk, ring);
    const ctx = (c) => c.getContext("2d", { willReadFrequently: true });

    const me = { W: 0, H: 0, mw: 0, mh: 0, last: null, token: 0, painting: false, active: false };
    BRUSHES.add(me); h.bag.add(() => BRUSHES.delete(me));
    const dataRef = parseRef(node.data), sizeRef = parseRef(node.size);
    const view = () => wrap.closest(".ns-view")?.__nsView || null;
    const num = (v, d) => { const n = Number(h.val(v)); return Number.isFinite(n) ? n : d; };
    const tip = () => ({ size: clamp(num(node.size, 64), 1, 4096), hard: clamp(num(node.hardness, 50), 0, 100) / 100, op: clamp(num(node.opacity, 100), 1, 100) / 100, erase: !!h.val(node.erase) });

    // ---- the two layers <-> one PNG (R = painted alpha, G = erased alpha, B = 0, A = 255: lossless both ways)
    const clearAll = () => { for (const c of [add, ers, stk]) ctx(c).clearRect(0, 0, c.width, c.height); };
    const encode = () => {
        const { mw, mh } = me; if (!mw) return "";
        const a = ctx(add).getImageData(0, 0, mw, mh).data, e = ctx(ers).getImageData(0, 0, mw, mh).data;
        const out = new ImageData(mw, mh); const o = out.data; let any = false;
        for (let i = 3; i < a.length; i += 4) { o[i - 3] = a[i]; o[i - 2] = e[i]; o[i] = 255; if (a[i] || e[i]) any = true; }
        if (!any) return "";
        const c = document.createElement("canvas"); c.width = mw; c.height = mh; ctx(c).putImageData(out, 0, 0);
        return c.toDataURL("image/png");
    };
    const decode = (url) => {
        const t = ++me.token;
        const im = new Image();
        im.onload = () => {
            if (t !== me.token || !me.mw) return;
            const { mw, mh } = me;
            const c = document.createElement("canvas"); c.width = mw; c.height = mh; const cx = ctx(c);
            cx.drawImage(im, 0, 0, mw, mh);                         // a mask saved on another picture size is stretched: same as the Python
            const src = cx.getImageData(0, 0, mw, mh).data;
            const A = new ImageData(mw, mh), E = new ImageData(mw, mh);
            for (let i = 0; i < src.length; i += 4) {
                A.data[i] = ADD[0]; A.data[i + 1] = ADD[1]; A.data[i + 2] = ADD[2]; A.data[i + 3] = src[i];
                E.data[i] = ERS[0]; E.data[i + 1] = ERS[1]; E.data[i + 2] = ERS[2]; E.data[i + 3] = src[i + 1];
            }
            clearAll(); ctx(add).putImageData(A, 0, 0); ctx(ers).putImageData(E, 0, 0);
        };
        im.onerror = () => { if (t === me.token) rt.warnOnce?.("brush.decode", "brush mask could not be read"); };
        im.src = url;
    };
    const load = (val) => { me.last = val; if (!val) { me.token++; clearAll(); } else decode(val); };

    // ---- size follows the picture the view shows
    const fitSize = () => {
        const V = view(); const S = V ? V.size() : { w: 0, h: 0 };
        if (!S.w || !S.h || (S.w === me.W && S.h === me.H)) return;
        me.W = S.w; me.H = S.h;
        const k = Math.min(1, (Number(node.res) || RES) / Math.max(S.w, S.h));
        me.mw = Math.max(1, Math.round(S.w * k)); me.mh = Math.max(1, Math.round(S.h * k));
        for (const c of [add, ers, stk]) { c.width = me.mw; c.height = me.mh; }
        wrap.style.width = S.w + "px"; wrap.style.height = S.h + "px";
        load(me.last ?? String(h.val(node.data) || ""));          // canvases were reset: paint the stored mask back
    };

    // ---- painting: dabs along the path on a stroke layer, merged with the opacity when you let go
    const dab = (c, x, y, r, hard, rgb) => {
        const g = c.createRadialGradient(x, y, r * Math.min(hard, 0.98), x, y, r);
        g.addColorStop(0, `rgba(${rgb},1)`); g.addColorStop(1, `rgba(${rgb},0)`);
        c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    };
    const ringAt = (p) => {
        const t = tip();
        ring.hidden = !me.active || !p;
        if (ring.hidden) return;
        ring.classList.toggle("erase", t.erase);
        ring.style.width = ring.style.height = t.size + "px";
        ring.style.left = (p.x - t.size / 2) + "px"; ring.style.top = (p.y - t.size / 2) + "px";
    };
    const begin = (e, root) => {
        const V = view();
        if (!me.active || !V || !me.mw || e.button !== 0 || e.altKey || root.classList.contains("pan") || V.isBusy()) return;
        e.preventDefault(); e.stopPropagation();
        const t = tip(), k = me.mw / me.W, r = Math.max(0.5, (t.size / 2) * k), rgb = (t.erase ? ERS : ADD).join(",");
        const sc = ctx(stk); sc.clearRect(0, 0, me.mw, me.mh);
        stk.style.opacity = String(t.op * (t.erase ? 0.55 : 0.5));
        me.painting = true;
        const step = Math.max(0.5, r * 0.18);
        const segment = (a, p) => {             // dabs from a to p (image coords), spaced so the line stays smooth
            const dx = (p.x - a.x) * k, dy = (p.y - a.y) * k, n = Math.max(1, Math.floor(Math.hypot(dx, dy) / step));
            for (let i = 1; i <= n; i++) dab(sc, a.x * k + dx * (i / n), a.y * k + dy * (i / n), r, t.hard, rgb);
        };
        let last = V.toImage(e.clientX, e.clientY);
        // Shift + click = straight line from where the last stroke ended (classic: click A, Shift+click B). Straight and to the point.
        if (e.shiftKey && me.lastPt) segment(me.lastPt, last); else dab(sc, last.x * k, last.y * k, r, t.hard, rgb);
        const id = e.pointerId;
        try { root.setPointerCapture(id); } catch (_) {}
        const move = (m) => {
            if (m.pointerId !== id) return;
            const p = V.toImage(m.clientX, m.clientY); ringAt(p);
            if (Math.hypot(p.x - last.x, p.y - last.y) * k < step) return;
            segment(last, p);
            last = p;
        };
        const up = (m) => {
            if (m.pointerId !== id) return;
            root.removeEventListener("pointermove", move); root.removeEventListener("pointerup", up); root.removeEventListener("pointercancel", up);
            me.painting = false;
            me.lastPt = last;
            const [into, from] = t.erase ? [ers, add] : [add, ers];
            const a = ctx(into), b = ctx(from);
            a.globalAlpha = t.op; a.globalCompositeOperation = "source-over"; a.drawImage(stk, 0, 0); a.globalAlpha = 1;
            b.globalAlpha = t.op; b.globalCompositeOperation = "destination-out"; b.drawImage(stk, 0, 0); b.globalAlpha = 1; b.globalCompositeOperation = "source-over";
            sc.clearRect(0, 0, me.mw, me.mh);
            const url = encode();
            me.last = url;                                           // so update() does not decode what we just wrote
            writeRef(rt, dataRef, url); rt.update?.();
        };
        root.addEventListener("pointermove", move); root.addEventListener("pointerup", up); root.addEventListener("pointercancel", up);
    };

    // hook the view once it exists (the stage is attached after the factory returns)
    let off = null, offRoot = null;
    const hook = () => {
        const V = view(); const root = wrap.closest(".ns-view");
        if (!V || !root || root === offRoot) return;
        if (off) off();
        offRoot = root;
        const down = (e) => begin(e, root);
        const hover = (e) => { if (!me.painting) ringAt(me.active ? V.toImage(e.clientX, e.clientY) : null); };
        const leave = () => { if (!me.painting) ring.hidden = true; };
        const key = (e) => {
            if (!me.active || !root.matches(":hover") || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
            if (e.key !== "[" && e.key !== "]") return;
            e.preventDefault(); e.stopImmediatePropagation();
            const s = tip().size, n = Math.round(clamp(e.key === "]" ? s * 1.2 + 1 : s / 1.2, 1, 4096));
            writeRef(rt, sizeRef, n); rt.update?.();
        };
        root.addEventListener("pointerdown", down);
        root.addEventListener("pointermove", hover);
        root.addEventListener("pointerleave", leave);
        window.addEventListener("keydown", key, true);
        const unsub = V.onChange(() => update());
        off = () => { root.removeEventListener("pointerdown", down); root.removeEventListener("pointermove", hover); root.removeEventListener("pointerleave", leave); window.removeEventListener("keydown", key, true); unsub(); };
    };
    h.bag.add(() => { if (off) off(); me.token++; });

    // the erased layer only MEANS something where it bites the rectangle: show it there, nowhere else (no grey ghosts on the picture).
    // The rectangle is a sibling marquee in the same stage; we follow its box while it moves.
    let mqSeen = null, mo = null;
    const clipErase = () => {
        const mq = wrap.parentElement?.querySelector?.(".ns-mq");
        if (mq && mq !== mqSeen && typeof MutationObserver === "function") {
            mo?.disconnect(); mqSeen = mq;
            mo = new MutationObserver(clipErase); mo.observe(mq, { attributes: true, attributeFilter: ["style", "hidden"] });
        }
        if (!mq || mq.hidden || !me.W) { ers.style.visibility = "hidden"; return; }
        const l = parseFloat(mq.style.left) || 0, t = parseFloat(mq.style.top) || 0, w = parseFloat(mq.style.width) || 0, hh = parseFloat(mq.style.height) || 0;
        ers.style.visibility = "visible";
        ers.style.clipPath = `inset(${(t / me.H) * 100}% ${(1 - (l + w) / me.W) * 100}% ${(1 - (t + hh) / me.H) * 100}% ${(l / me.W) * 100}%)`;
    };
    h.bag.add(() => mo?.disconnect());

    const update = () => {
        hook(); fitSize(); clipErase();
        me.active = !!h.val(node.active);
        offRoot?.classList.toggle("ns-br-on", me.active);
        if (!me.active) ring.hidden = true;
        const val = String(h.val(node.data) || "");
        if (me.W && val !== me.last && !me.painting) load(val);      // undo/redo, Clear brush, paste of the node: the native moved
    };
    queueMicrotask(update); setTimeout(update, 50); setTimeout(update, 400);
    return { el: wrap, update, handlesText: true };
});

// ---------- behavior: load_mask ----------
// a picture by MIME type, or by extension when the OS hands it over without one (.jfif, some .webp/.jpg from Windows)
const EXT_RE = /\.(png|jpe?g|jfif|pjpeg|webp|gif|bmp|avif|tiff?)$/i;
const isImg = (f) => !!f && (/^image\//.test(f.type || "") || EXT_RE.test(f.name || ""));
const pickFile = (dt) => [...(dt?.files || [])].find(isImg) || [...(dt?.items || [])].map((i) => (i.kind === "file" ? i.getAsFile() : null)).find(isImg) || null;
// a picture dragged from a web page or another node arrives as a URL, not a file
const pickUrl = (dt) => {
    const u = (dt?.getData?.("text/uri-list") || "").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
    if (u) return u.trim();
    const m = /<img[^>]+src="([^"]+)"/i.exec(dt?.getData?.("text/html") || "");
    return m ? m[1].replace(/&amp;/g, "&") : "";
};
const toast = (detail) => { try { globalThis.app?.extensionManager?.toast?.add?.({ severity: "warn", summary: "Succy Crop", detail, life: 5000 }); } catch (_) { /* no toast here */ } };

piece(C("load_mask", {
    scopo: "Trascina, incolla o scegli un'immagine sul view_box: upload nativo in input, nome nel nativo, vista subito senza Queue.",
    natura: "funziona", dominio: "ui", estado: "draft",
    tag: ["comportamento", "immagine", "upload", "incolla", "crop"], uses: ["view_box", "shot_system"],
    props: {
        view: { ...ID("id del view_box"), required: true },
        native: S("widget nativo che tiene il nome del file (cartella input)", "source"),
        subfolder: S("sottocartella di input", "succy"),
    },
    esempio: exb({ t: "view_box", id: "vp", children: [] }, [{ type: "load_mask", view: "vp" }]),
}), (rt, p) => {
    const NAT = p.native || "source";
    const node = () => rt.api.liveNode?.() || rt.node;
    const viewUrl = (f) => globalThis.SurvivalKit?.compat?.viewUrl?.(f) || "";
    const show = (name, w = 0, hh = 0) => {
        if (!name) return;
        const i = name.lastIndexOf("/");
        ShotFeed.put(node(), { src: viewUrl({ filename: i < 0 ? name : name.slice(i + 1), subfolder: i < 0 ? "" : name.slice(0, i), type: "input" }), width: w, height: hh });
    };
    // a saved workflow comes back with the file name: show it until a real run says otherwise
    const restore = () => { const n = String(rt.api.native.get(NAT) || ""); if (n && !ShotFeed.get(node())) show(n); };

    const take = async (file, how) => {
        if (!isImg(file)) return;
        LOADS[how]++;
        try {
            let w = 0, hh = 0;
            try { const bm = await createImageBitmap(file); w = bm.width; hh = bm.height; bm.close?.(); } catch (_) { /* the view measures it itself */ }
            const ext = ((file.type || "").split("/")[1] || (EXT_RE.exec(file.name || "")?.[1]) || "png").toLowerCase().replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
            // ComfyUI's /view refuses any name with ".." in it (path-traversal guard): "uhm....jpg" uploads fine and then never shows. Clean it.
            const clean = (file.name || "").replace(/\.[^.]*$/, "").replace(/\.{2,}/g, "_").replace(/[\\/:*?"<>|]+/g, "_").replace(/^[._\s]+|[._\s]+$/g, "");
            const base = clean && !/^image$/i.test(clean) && EXT_RE.test(file.name) ? `${clean}.${ext}` : `succy_${Date.now()}.${ext}`;
            const up = await globalThis.SurvivalKit.compat.uploadImage(file, { name: base, subfolder: p.subfolder ?? "succy", type: "input" });
            const name = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
            rt.api.native.set(NAT, name);
            try { node().graph?.change?.(); } catch (_) {}
            show(name, w, hh);
        } catch (e) {
            LOADS.failed++; LOADS.last = String(e?.message || e);
            rt.warnOnce?.("load_mask:" + LOADS.last, "picture upload failed: " + LOADS.last);
            toast("Picture not loaded: " + LOADS.last);
        }
    };
    const takeUrl = async (url) => {
        try {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const blob = await r.blob();
            const name = decodeURIComponent((new URL(url, location.href).searchParams.get("filename") || url.split(/[?#]/)[0].split("/").pop() || ""));
            const file = new File([blob], EXT_RE.test(name) ? name : "", { type: blob.type });
            if (!isImg(file)) throw new Error("not a picture (" + (blob.type || "unknown type") + ")");
            await take(file, "drops");
        } catch (e) {
            LOADS.failed++; LOADS.last = String(e?.message || e);
            // another site usually refuses (CORS): save the picture, then drop the FILE
            toast("Could not take the picture from that page (" + LOADS.last + "). Save it and drop the file, or copy it and Ctrl+V.");
        }
    };

    let root = null;
    const wire = () => {
        const el = rt.el(p.view);
        const r = el?.classList?.contains("ns-view") ? el : el?.querySelector?.(".ns-view");
        if (!r || r === root) return;
        root = r;
        // 📂 next to the fit button
        const hud = r.querySelector(".ns-view-hud");
        const btn = mkEl("button"); btn.type = "button"; btn.textContent = "📂"; btn.title = "Load an image (or drop / paste it here)";
        const inp = mkEl("input"); inp.type = "file"; inp.accept = "image/*"; inp.style.display = "none";
        btn.addEventListener("pointerdown", (e) => e.stopPropagation());
        btn.addEventListener("click", (e) => { e.stopPropagation(); inp.click(); });
        inp.addEventListener("change", () => { const f = inp.files?.[0]; inp.value = ""; if (f) take(f, "picks"); });
        hud?.prepend(btn); r.appendChild(inp);
        rt.bag.add(() => { btn.remove(); inp.remove(); });
    };

    // drop + paste: WINDOW capture, so ComfyUI never turns the picture into a new Load Image node
    const inside = (e) => root && e.target?.closest?.(".ns-view") === root;
    const WANT = ["Files", "text/uri-list", "text/html"];
    const over = (e) => { if (!inside(e) || !(e.dataTransfer?.types && [...e.dataTransfer.types].some((t) => WANT.includes(t)))) return; e.preventDefault(); e.stopImmediatePropagation(); e.dataTransfer.dropEffect = "copy"; root.classList.add("ns-drop"); };
    const leave = (e) => { if (root && (!e.relatedTarget || !root.contains(e.relatedTarget))) root.classList.remove("ns-drop"); };
    const drop = (e) => {
        if (!inside(e)) return;
        root.classList.remove("ns-drop");
        const dt = e.dataTransfer, f = pickFile(dt), url = f ? "" : pickUrl(dt);
        if (!f && !url) { if ([...(dt?.files || [])].length) { e.preventDefault(); e.stopImmediatePropagation(); toast("That file is not a picture."); } return; }
        e.preventDefault(); e.stopImmediatePropagation();
        if (f) take(f, "drops"); else takeUrl(url);
    };
    const paste = (e) => {
        if (!root || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
        const sel = globalThis.app?.canvas?.selected_nodes || {};
        const ids = Object.keys(sel);
        const mine = root.matches(":hover") || (ids.length === 1 && String(ids[0]) === String(node().id));
        if (!mine) return;
        const f = pickFile(e.clipboardData); if (!f) return;           // no picture in the clipboard: ComfyUI pastes nodes as usual
        e.preventDefault(); e.stopImmediatePropagation(); take(f, "pastes");
    };
    for (const [ev, fn] of [["dragover", over], ["dragleave", leave], ["drop", drop], ["paste", paste]]) {
        window.addEventListener(ev, fn, true);
        rt.bag.add(() => window.removeEventListener(ev, fn, true));
    }

    const tick = () => { wire(); restore(); };
    tick(); rt.api.after?.(tick, 50); rt.api.after?.(tick, 400);
    rt.onRestore?.add?.(tick);
});
