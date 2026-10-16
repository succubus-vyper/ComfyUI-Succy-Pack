// ============================================================
// NodeStructure/components/stitch.js — Stitch, LIVE (Crop & Stitch phase 4, D-124)
//   peek_system     (io) the node at the other end of an input wire (R2: SurvivalKit nodePorts.inputNode / snapshot), "as it is now":
//                   { ok, id, type, widgets, linked, post, sig, src, width, height } — src/width/height = the picture it is looking at
//                   (shot feed), at WORKSPACE size like its Python. Re-reads itself every 400 ms and redraws only when something changed.
//   stitch_element  the stitched result over a view_box that shows the Crop's picture: the region is fetched from the Crop's Python
//                   (/succy/crop/stitch: info, base, mask), the worked picture and the retouch brush are fitted with the Python's
//                   geometry (util/blend-math.js fitMode / fitRect), the retouch brush is painted on the same view (whole picture, D-125),
//                   then colour match, feather, retouch, opacity and blend run with
//                   the Python's own formulas. Reduced size (res, default 1024 on the long side), only when something changed.
//                   Pure eye candy: Copy / Download ask the Python for the full-resolution result (/succy/stitch/render).
// The node only names the refs. Succubus was here — she puts it back where it came from, and you can't see where she touched.
// ============================================================
import { mkEl } from "./index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, N, S, R } from "../catalog/kit.js";
import { ShotFeed } from "../runtime/shot-feed.js";
import { inputUrl } from "./brush.js";
import { colorMatch, detailMatch, stitchMask, blend, fitMode, fitRect, placeRect } from "../util/blend-math.js";
import { parseRef } from "../core/parser.js";
import { writeRef } from "../core/binding.js";

const STITCHES = new Set();                    // live previews (Governor counts them)
const SSTATS = { renders: 0, fetches: 0, failed: 0, lastMs: 0, last: "" };
export const stitchStats = () => ({ previews: STITCHES.size, shown: [...STITCHES].filter((s) => s.shown).length, ...SSTATS });

const CSS = `
.ns-st{position:absolute;left:0;top:0;pointer-events:none}
.ns-st canvas{position:absolute;display:block;image-rendering:auto}
.ns-st-dim{position:absolute;left:0;top:0;width:100%;height:100%;background:#000}
.ns-st[hidden]{display:none}
.ns-st-layer{position:absolute;left:0;top:0;width:100%;height:100%}
.ns-st-cut{position:absolute;top:0;height:100%;width:calc(2px / var(--ns-vs, 1));margin-left:calc(-1px / var(--ns-vs, 1));background:#fff;box-shadow:0 0 calc(4px / var(--ns-vs, 1)) #000}
.ns-st-cut[hidden]{display:none}
.ns-st-cut b{position:absolute;top:50%;left:50%;width:calc(22px / var(--ns-vs, 1));height:calc(22px / var(--ns-vs, 1));transform:translate(-50%,-50%);border-radius:50%;background:#fff;box-shadow:0 0 calc(4px / var(--ns-vs, 1)) #000}
.ns-st-cut i{position:absolute;top:calc(6px / var(--ns-vs, 1));font:600 calc(10px / var(--ns-vs, 1))/1.4 sans-serif;font-style:normal;color:#fff;background:rgba(0,0,0,.65);padding:0 calc(5px / var(--ns-vs, 1));border-radius:calc(3px / var(--ns-vs, 1));white-space:nowrap}
.ns-st-cut i:first-of-type{right:calc(8px / var(--ns-vs, 1))}
.ns-st-cut i:last-of-type{left:calc(8px / var(--ns-vs, 1))}
.ns-view.ns-st-moving{cursor:move}
.ns-view.ns-st-comparing{cursor:ew-resize}
`;

const RES = 1024;
// FNV-1a: a long string (a brush PNG) -> a short signature
const fnv = (u) => { let x = 0x811c9dc5; for (let i = 0; i < u.length; i++) x = Math.imul(x ^ u.charCodeAt(i), 16777619); return (x >>> 0).toString(36); };
const KP = () => globalThis.SurvivalKit?.nodePorts;

// ---------- peek_system (io) ----------
// config peek_system.input: the input to follow (default "stitch")
// config peek_system.file: a native holding a picture loaded on THIS node (input folder) that replaces the other node's picture (D-128):
//   src = that file, width/height 0 (the view measures it)
const peekOverride = (api) => { const f = api.cfg?.("peek_system")?.file; const v = f ? String(api.native?.get?.(f) || "") : ""; return v ? inputUrl(v) : ""; };
const peekBase = (snap) => ({ ok: true, id: snap.id, type: snap.type, widgets: snap.widgets, linked: snap.linked, post: { node_id: snap.id, widgets: snap.widgets, linked: snap.linked } });
const peekOf = (api) => {
    const me = api.liveNode?.() || api.node;
    const input = api.cfg?.("peek_system")?.input || "stitch";
    const src = KP()?.inputNode?.(me, input)?.node || null;
    if (!src) { const ov = peekOverride(api); return { ok: false, id: null, type: "", widgets: {}, linked: [], post: null, sig: "none", src: ov, width: 0, height: 0 }; }
    const snap = KP().snapshot(src);
    const shot = ShotFeed.get(src);
    const ov = peekOverride(api);
    if (ov) return { ...peekBase(snap), src: ov, width: 0, height: 0, sig: "file:" + ov };
    let width = shot?.width || 0, height = shot?.height || 0;
    const mp = shot?.raw ? Number(snap.widgets.workspace_mp) || 0 : 0;      // a picture loaded on the Crop: scaled like its Python (D-120)
    if (mp > 0 && width > 0 && height > 0) {
        const k2 = Math.sqrt((mp * 1e6) / (width * height));
        width = Math.max(1, Math.round(width * k2)); height = Math.max(1, Math.round(height * k2));
    }
    const { brush = "", ...rest } = snap.widgets;
    const sig = `${snap.id}|${JSON.stringify(rest)}|${String(brush).length}:${fnv(String(brush))}|${snap.linked.join(",")}|${shot?.v ?? ""}`;
    return { ok: true, id: snap.id, type: snap.type, widgets: snap.widgets, linked: snap.linked,
        post: { node_id: snap.id, widgets: snap.widgets, linked: snap.linked }, sig, src: shot?.src || "", width, height };
};
peekOf.ensure = (api) => {
    let last = "";
    const tick = () => {
        const n = api.liveNode?.() || api.node;
        if (n?.flags?.collapsed) return;
        const s = peekOf(api).sig;
        if (s !== last) { last = s; api.refresh(); }
    };
    api.onDispose(ShotFeed.subscribe(() => api.refresh()));
    api.every(tick, 400);
};
piece(C("peek_system", {
    scopo: "Il nodo dall'altra parte di un filo d'ingresso (R2), com'e' ORA: widget, ingressi collegati, immagine che guarda; per le rotte Python.",
    natura: "funziona", dominio: "runtime", estado: "draft", tag: ["grafo", "stato", "stitch", "crop"], props: {},
    esempio: ex({ t: "label_element", text: "{{$live.peek_system.id}}" }),
}), peekOf);

// ---------- stitch_element ----------
const loadImg = (url) => new Promise((ok, ko) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ko(new Error("picture not readable")); im.src = url; });
const pixels = (src, w, h, draw) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingQuality = "high";
    if (draw) draw(cx); else cx.drawImage(src, 0, 0, w, h);
    return cx.getImageData(0, 0, w, h).data;
};
const rgbOf = (px, n) => { const o = new Float32Array(n * 3); for (let i = 0; i < n; i++) { o[i * 3] = px[i * 4] / 255; o[i * 3 + 1] = px[i * 4 + 1] / 255; o[i * 3 + 2] = px[i * 4 + 2] / 255; } return o; };
const chOf = (px, n, ch) => { const o = new Float32Array(n); let any = false; for (let i = 0; i < n; i++) { o[i] = px[i * 4 + ch] / 255; any ||= o[i] > 0; } return any ? o : null; };
// a mask file: its alpha when it has transparency, otherwise its luminance (PIL "L"), like the Python's _load_mask
const alphaUsed = (px) => { for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true; return false; };
const maskAt = (px, i, useA) => (useA ? px[i * 4 + 3] : px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
const ringOf = (sel) => { let r = 0; for (let i = 0; i < sel.length; i++) if (sel[i] < 0.5) r++; return r / Math.max(1, sel.length); };   // share of context ring
const parsePlace = (s) => { try { const o = JSON.parse(String(s || "")); return o && typeof o === "object" && Number.isFinite(o.w) ? o : null; } catch (_) { return null; } };

piece(C("stitch_element", {
    scopo: "Risultato LIVE di Stitch sopra un view_box con l'immagine del Crop: regione dal Python, formule del Python (blend-math), ritocco col brush.",
    natura: "funziona", dominio: "ui", estado: "draft", archetipo: "renderer-host",
    tag: ["stitch", "anteprima", "crop", "feather", "blend"], uses: ["view_box", "peek_system", "brush_element"], css: CSS,
    props: {
        crop: R("il Crop collegato (ref, es. $live.peek_system): serve {ok, id, post, sig}"),
        work: R("URL dell'immagine lavorata (ref, es. $live.shot_system.src)"),
        baseFile: R("immagine BASE caricata sul nodo (nome in input, ref es. $native.base_file): vince su quella del Crop (D-128)"),
        maskFile: R("MASCHERA caricata sul nodo (immagine intera, bianco = sostituisci; ref es. $native.mask_file): il taglio = il suo riquadro (D-128)"),
        wired: R("vero = base o maschera arrivano da un filo: l'anteprima non le vede (lo dice)"),
        feather: R("sfumatura della cucitura in px della regione (ref)"), mode: R("inside | outside | centered (ref)"), curve: R("smooth | linear (ref)"),
        colorMatch: R("color match 0..100 (ref)"), opacity: R("opacita' 0..1 (ref)"), aspect: R("auto | stretch | crop_center | fit (ref)"),
        brush: R("PNG del ritocco disegnato su QUESTO view_box, immagine intera (ref, es. $native.brush): R aggiunge, G toglie (D-125)"),
        place: R("JSON del tEXt succy_crop del PNG lasciato cadere (ref, es. $native.place): solo controllo"),
        show: R("falso = nascosto (ref)"),
        dim: R("0..100: velo nero sull'ORIGINALE (fuori dal ritaglio e sotto la cucitura), 100 = nero pieno: resta solo il lavorato e si giudica la sfumatura (ref, D-127)"),
        seam: R("vero = mostra la maschera della cucitura M invece del risultato: bianco = lavorato, nero = originale (ref, D-126)"),
        sharp: R("sharpness match 0..100: il dettaglio fine del lavorato portato a quello dell'originale, misurato sull'anello (ref, D-129)"),
        grain: R("grain match 0..200: la grana che manca al lavorato, rimessa come rumore monocromatico (ref, D-129)"),
        offsetX: R("spostamento del lavorato nel taglio, px della regione (ref SCRIVIBILE, es. $native.offset_x, D-129)"),
        offsetY: R("spostamento verticale (ref SCRIVIBILE, es. $native.offset_y)"),
        scale: R("scala del lavorato attorno al centro del taglio, % (ref SCRIVIBILE, es. $native.scale)"),
        move: R("vero = modo Sposta: trascina = sposta il lavorato, Alt + trascina / Alt + rotella = scala (ref)"),
        compare: R("vero = confronto prima/dopo: a sinistra della linea l'originale, a destra il risultato; trascina = sposta la linea (ref)"),
        split: R("posizione della linea del confronto 0..1 (ref SCRIVIBILE, es. $state.split)"),
        report: S("chiave cache dove scrive lo stato in una riga (e <chiave>Tone: ok | warn | danger | mute)"),
        res: N("lato lungo del calcolo (px)", RES),
    },
    esempio: ex({ t: "view_box", children: [{ t: "stitch_element", show: true }] }),
}), (node, h) => {
    const wrap = mkEl("div", "ns-st");
    const layer = mkEl("div", "ns-st-layer"), cv = mkEl("canvas"), dimEl = mkEl("div", "ns-st-dim");
    const cut = mkEl("div", "ns-st-cut"), knob = mkEl("b"), tagL = mkEl("i"), tagR = mkEl("i");
    tagL.textContent = "Before"; tagR.textContent = "After";
    cut.append(knob, tagL, tagR); cut.hidden = true;
    dimEl.style.opacity = "0";
    layer.append(dimEl, cv);
    wrap.append(layer, cut); wrap.hidden = true;
    const me = { shown: false, timer: 0, ftimer: 0, token: 0, cropSig: "", sig: "", region: null, err: "", work: { url: "", img: null }, brush: { url: "", img: null } };
    STITCHES.add(me);
    h.bag.add(() => { STITCHES.delete(me); clearTimeout(me.timer); clearTimeout(me.ftimer); me.token++; });
    const view = () => wrap.closest(".ns-view")?.__nsView || null;
    const num = (v, d = 0) => { const n = Number(h.val(v)); return Number.isFinite(n) ? n : d; };
    let said = "";
    const say = (text, tone = "mute") => {
        const k = node.report; if (!k) return;
        if (said === text + tone) return;
        said = text + tone;
        const c = h.rt.api.cache; c.set(k, text); c.set(k + "Tone", tone); h.rt.api.refresh();
    };

    // the region of the Crop as it is NOW: info (JSON) + base and mask (PNG) at the preview size
    // the cut from the files loaded on the node (D-128): a MASK makes the region its bounding box over the base picture (Crop's or the loaded one)
    const localRegion = async (t, crop, bf, mf) => {
        const res = Number(node.res) || RES;
        const baseUrl = bf ? inputUrl(bf) : crop?.src || "";
        if (!baseUrl) throw new Error("Load a BASE IMAGE (or wire a Succy Crop with a picture)");
        const [bi, mi] = await Promise.all([loadImg(baseUrl), mf ? loadImg(inputUrl(mf)) : null]);
        if (t !== me.token) return null;
        const W = bf ? bi.naturalWidth : (crop.width || bi.naturalWidth), H = bf ? bi.naturalHeight : (crop.height || bi.naturalHeight);
        let info, sel = null;
        if (mi) {
            const a = Math.min(1, 1024 / Math.max(W, H)), aw = Math.max(1, Math.round(W * a)), ah = Math.max(1, Math.round(H * a));
            const mp = pixels(mi, aw, ah), useA = alphaUsed(mp);
            let x0 = aw, y0 = ah, x1 = -1, y1 = -1;
            for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) if (maskAt(mp, y * aw + x, useA) > 0.01) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
            if (x1 < 0) throw new Error("The MASK is empty: nothing to replace");
            const X0 = Math.max(0, Math.floor(x0 / a)), Y0 = Math.max(0, Math.floor(y0 / a)), X1 = Math.min(W, Math.ceil((x1 + 1) / a)), Y1 = Math.min(H, Math.ceil((y1 + 1) / a));
            info = { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0, orig_w: W, orig_h: H };
            const s = Math.min(1, res / Math.max(info.w, info.h)), pw = Math.max(1, Math.round(info.w * s)), ph = Math.max(1, Math.round(info.h * s));
            const km = mi.naturalWidth / W, kmy = mi.naturalHeight / H;
            const sp = pixels(null, pw, ph, (cx) => cx.drawImage(mi, X0 * km, Y0 * kmy, info.w * km, info.h * kmy, 0, 0, pw, ph));
            sel = new Float32Array(pw * ph); for (let i = 0; i < sel.length; i++) sel[i] = maskAt(sp, i, useA);
        } else {
            info = await askInfo(crop);
        }
        if (t !== me.token) return null;
        const s = Math.min(1, res / Math.max(info.w, info.h)), pw = Math.max(1, Math.round(info.w * s)), ph = Math.max(1, Math.round(info.h * s)), n = pw * ph;
        if (!sel) { const mb = await createImageBitmap(await (await askPng(crop, "mask")).blob()); sel = chOf(pixels(mb, pw, ph), n, 0) || new Float32Array(n); mb.close?.(); }
        const kb = bi.naturalWidth / W, kby = bi.naturalHeight / H;
        const base = rgbOf(pixels(null, pw, ph, (cx) => cx.drawImage(bi, info.x * kb, info.y * kby, info.w * kb, info.h * kby, 0, 0, pw, ph)), n);
        return { info, pw, ph, s, base, sel };
    };
    const ask = (crop, what) => globalThis.app.api.fetchApi(`/succy/crop/stitch?node_id=${encodeURIComponent(crop.id)}&what=${what}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ widgets: crop.widgets, linked: crop.linked }) });
    const failOf = async (r) => { let m = `HTTP ${r.status}`; try { m = (await r.json()).error || m; } catch (_) { /* not json */ } return new Error(m); };
    const askInfo = async (crop) => { const r = await ask(crop, "info"); if (!r.ok) throw await failOf(r); return r.json(); };
    const askPng = async (crop, what) => { const r = await ask(crop, what); if (!r.ok) throw await failOf(r); return r; };

    const fetchRegion = async (crop, bf = "", mf = "") => {
        const t = ++me.token;
        const api = globalThis.app?.api;
        if (bf || mf) {
            try {
                SSTATS.fetches++;
                const r = await localRegion(t, crop?.ok ? crop : (bf ? null : crop), bf, mf);
                if (!r || t !== me.token) return;
                me.region = r; me.err = ""; me.sig = ""; schedule();
            } catch (e) {
                if (t !== me.token) return;
                me.region = null; me.err = String(e?.message || e); SSTATS.failed++; SSTATS.last = me.err;
                wrap.hidden = true; say(me.err, "warn");
            }
            return;
        }
        const ask = (what) => api.fetchApi(`/succy/crop/stitch?node_id=${encodeURIComponent(crop.id)}&what=${what}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ widgets: crop.widgets, linked: crop.linked }) });
        try {
            SSTATS.fetches++;
            const ri = await ask("info");
            if (!ri.ok) { let m = `HTTP ${ri.status}`; try { m = (await ri.json()).error || m; } catch (_) { /* not json */ } throw new Error(m); }
            const info = await ri.json();
            const [rb, rm] = await Promise.all([ask("base"), ask("mask")]);
            if (!rb.ok || !rm.ok) throw new Error(`HTTP ${rb.ok ? rm.status : rb.status}`);
            const [bb, mb] = await Promise.all([createImageBitmap(await rb.blob()), createImageBitmap(await rm.blob())]);
            if (t !== me.token) { bb.close?.(); mb.close?.(); return; }
            const s = Math.min(1, (Number(node.res) || RES) / Math.max(info.w, info.h));
            const pw = Math.max(1, Math.round(info.w * s)), ph = Math.max(1, Math.round(info.h * s)), n = pw * ph;
            const base = rgbOf(pixels(bb, pw, ph), n), sel = chOf(pixels(mb, pw, ph), n, 0) || new Float32Array(n);
            bb.close?.(); mb.close?.();
            me.region = { info, pw, ph, s, base, sel };
            me.err = ""; me.sig = ""; schedule();
        } catch (e) {
            if (t !== me.token) return;
            me.region = null; me.err = String(e?.message || e); SSTATS.failed++; SSTATS.last = me.err;
            wrap.hidden = true; say(me.err, "warn");
        }
    };
    const loadInto = async (slot, url) => {
        if (slot.url === url) return;
        slot.url = url; slot.img = null;
        if (!url) { me.sig = ""; schedule(); return; }
        try { const im = await loadImg(url); if (slot.url === url) { slot.img = im; me.sig = ""; schedule(); } } catch (_) { if (slot.url === url) slot.img = null; }
    };

    const render = () => {
        me.timer = 0;
        const R0 = me.region, wi = me.work.img;
        if (!me.shown || !R0) return;
        if (!wi) { wrap.hidden = true; say("Drop / paste the REPLACEMENT on the picture — or Run once", "mute"); return; }
        const t0 = performance.now();
        const { info, pw, ph, s, base, sel } = R0, n = pw * ph;
        const ww = wi.naturalWidth, wh = wi.naturalHeight;
        const aspect = String(h.val(node.aspect) || "auto"), mode = fitMode(ww, wh, info.w, info.h, aspect);
        const g = fitRect(ww, wh, info.w, info.h, mode);
        // moved / scaled by hand (D-129): the fitted picture lands in placeRect, what it leaves uncovered shows the original
        const ox = num(node.offsetX), oy = num(node.offsetY), sc = Math.max(0.1, num(node.scale, 100) / 100), moved = ox !== 0 || oy !== 0 || sc !== 1;
        const pr = placeRect(info.w, info.h, ox, oy, sc), kx = pr.w / info.w, ky = pr.h / info.h;
        const dx = (pr.x + g.dx * kx) * s, dy = (pr.y + g.dy * ky) * s, dw = g.dw * kx * s, dh = g.dh * ky * s;
        // the worked picture at the preview size, fitted like the Python (fit: the original shows around it)
        const wpx = pixels(null, pw, ph, (cx) => cx.drawImage(wi, g.sx, g.sy, g.sw, g.sh, dx, dy, dw, dh));
        let work = rgbOf(wpx, n), fit = null;
        if (g.fit || moved) {
            fit = new Float32Array(n);
            const x0 = Math.round(dx), y0 = Math.round(dy), x1 = Math.round(dx + dw), y1 = Math.round(dy + dh);
            for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
                const i = y * pw + x;
                if (x >= x0 && x < x1 && y >= y0 && y < y1) fit[i] = 1;
                else { work[i * 3] = base[i * 3]; work[i * 3 + 1] = base[i * 3 + 1]; work[i * 3 + 2] = base[i * 3 + 2]; }
            }
        }
        // the retouch brush is painted on THIS view, over the whole picture (D-125): cut the region out of it (its PNG may be smaller)
        let add = null, erase = null;
        const bi = me.brush.img;
        if (bi && bi.naturalWidth) {
            const kx = bi.naturalWidth / info.orig_w, ky = bi.naturalHeight / info.orig_h;
            const bpx = pixels(null, pw, ph, (cx) => cx.drawImage(bi, info.x * kx, info.y * ky, info.w * kx, info.h * ky, 0, 0, pw, ph));
            add = chOf(bpx, n, 0); erase = chOf(bpx, n, 1);
        }
        const cm = num(node.colorMatch);
        if (cm > 0) work = colorMatch(work, base, sel, pw, ph, 3, cm / 100);
        const shp = num(node.sharp), grn = num(node.grain);
        if (shp > 0 || grn > 0) work = detailMatch(work, base, sel, pw, ph, 3, shp / 100, grn / 100, s);
        const borders = [info.x === 0, info.y === 0, info.x + info.w === info.orig_w, info.y + info.h === info.orig_h];
        const M = stitchMask(sel, pw, ph, { feather: num(node.feather, 24) * s, mode: h.val(node.mode) || "inside", curve: h.val(node.curve) || "smooth",
            borders, opacity: node.opacity === undefined ? 1 : num(node.opacity, 1), add, erase, fit });
        const seam = !!h.val(node.seam);
        // debug mask surface (D-127): the original fades to black (outside by the dim layer, under the seam here), only the worked part stays lit
        const dim = Math.min(1, Math.max(0, num(node.dim) / 100));
        dimEl.style.opacity = String(seam ? 0 : dim);
        const under = dim > 0 ? base.map((v) => v * (1 - dim)) : base;
        const out = seam ? null : blend(under, work, M, 3);
        cv.width = pw; cv.height = ph;
        const cx = cv.getContext("2d"), img = cx.createImageData(pw, ph), d = img.data;
        if (seam) for (let i = 0; i < n; i++) { const v = Math.round(M[i] * 255); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }   // the seam itself: white = worked
        else for (let i = 0; i < n; i++) { d[i * 4] = Math.round(out[i * 3] * 255); d[i * 4 + 1] = Math.round(out[i * 3 + 1] * 255); d[i * 4 + 2] = Math.round(out[i * 3 + 2] * 255); d[i * 4 + 3] = 255; }
        cx.putImageData(img, 0, 0);
        Object.assign(cv.style, { left: info.x + "px", top: info.y + "px", width: info.w + "px", height: info.h + "px" });
        me.info = info;
        wrap.hidden = false;
        paintCompare();
        SSTATS.renders++; SSTATS.lastMs = Math.round(performance.now() - t0);
        // one line of truth: where it goes, and what does not add up
        const place = parsePlace(h.val(node.place));
        const off = Math.abs((ww / wh) / (info.w / info.h) - 1);
        if (place && (place.x !== info.x || place.y !== info.y || place.w !== info.w || place.h !== info.h || place.orig_w !== info.orig_w || place.orig_h !== info.orig_h))
            say(`⚠ The PNG was cut at ${place.x},${place.y} ${place.w}×${place.h} (of ${place.orig_w}×${place.orig_h}); the Crop is now at ${info.x},${info.y} ${info.w}×${info.h}`, "warn");
        else if (aspect === "auto" && mode === "stretch")
            say(`⚠ Worked ${ww}×${wh} vs region ${info.w}×${info.h}: ${(off * 100).toFixed(1)}% off, stretched (pick Crop centre / Fit)`, "warn");
        // why Feather / Mode / Curve may change nothing (D-126): no side to fade into, or no context ring for Outside
        else if (borders.every(Boolean) && ringOf(sel) < 0.01)
            say("ⓘ The cut is the whole picture: there is no seam to soften (draw a box on the Crop)", "warn");
        else if (String(h.val(node.mode) || "inside") === "outside" && ringOf(sel) < 0.01)
            say("ⓘ No context around the selection: Outside has no room to fade — use Inside / Centre (Outside needs room around a soft or hand-drawn selection)", "warn");
        else if (h.val(node.move))
            say(`✥ Move: drag = move · Alt + drag / Alt + wheel = scale · offset ${ox}, ${oy} · ${Math.round(sc * 1000) / 10}%`, "ok");
        else if (h.val(node.compare))
            say("A|B Compare: left of the line = before, right = after · drag anywhere to move the line", "ok");
        else if (h.val(node.wired))
            say("ⓘ Base image / mask come from a wire: the live view can't see them — ⧉ ⬇ and Run use them", "warn");
        else say(`${place ? "♥ PNG matches · " : ""}Region ${info.w}×${info.h} at ${info.x},${info.y} · worked ${ww}×${wh}`, "ok");
    };
    const schedule = () => { if (!me.timer) me.timer = setTimeout(render, 40); };

    // A|B compare (D-129, was ⇆ until D-130): the result is clipped at the line, the original under it shows on the left
    const splitRef = parseRef(node.split), oxRef = parseRef(node.offsetX), oyRef = parseRef(node.offsetY), scRef = parseRef(node.scale);
    const splitAt = () => Math.min(1, Math.max(0, h.val(node.split) === undefined ? 0.5 : num(node.split, 0.5)));
    const paintCompare = () => {
        const on = !!h.val(node.compare) && !wrap.hidden;
        const x = splitAt() * 100;
        layer.style.clipPath = on ? `inset(0 0 0 ${x}%)` : "";
        cut.hidden = !on; cut.style.left = x + "%";
        const root = wrap.closest(".ns-view");
        root?.classList.toggle("ns-st-comparing", on);
        root?.classList.toggle("ns-st-moving", !!h.val(node.move) && !on);
    };
    // the gestures live on the view: compare = drag the line, move = drag the picture, Alt + drag / Alt + wheel = scale
    let groot = null, unAlt = null;
    const gestures = () => {
        const V = view(), root = wrap.closest(".ns-view");
        if (!V || !root || root === groot) return;
        groot = root;
        const down = (e) => {
            const cmp = !!h.val(node.compare), mv = !!h.val(node.move) && !cmp;
            if (e.button !== 0 || e.altKey || (!cmp && !mv) || V.isBusy?.() || e.target?.closest?.("button,.ns-view-hud,.ns-view-tools")) return;
            e.preventDefault(); e.stopPropagation();
            const id = e.pointerId, p0 = V.toImage(e.clientX, e.clientY), o0 = { x: num(node.offsetX), y: num(node.offsetY) };
            const at = (m) => {
                const p = V.toImage(m.clientX, m.clientY), W = V.size().w || 1;
                if (cmp) writeRef(h.rt, splitRef, Math.min(1, Math.max(0, p.x / W)));
                else { writeRef(h.rt, oxRef, Math.round(o0.x + p.x - p0.x)); writeRef(h.rt, oyRef, Math.round(o0.y + p.y - p0.y)); }
                h.rt.update?.();
            };
            if (cmp) at(e);
            const move = (m) => { if (m.pointerId === id) { m.preventDefault(); at(m); } };
            const end = (m) => { if (m.pointerId !== id) return; window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", end, true); window.removeEventListener("pointercancel", end, true); };
            window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", end, true); window.addEventListener("pointercancel", end, true);
        };
        root.addEventListener("pointerdown", down);
        const setScale = (v) => writeRef(h.rt, scRef, Math.round(Math.min(400, Math.max(10, v)) * 10) / 10);
        unAlt = V.alt({
            active: () => !!h.val(node.move) && !h.val(node.compare),
            start: () => ({ s0: num(node.scale, 100) }),
            drag: (st, d) => { setScale(st.s0 * Math.exp(d.sx * 0.004)); h.rt.update?.(); },
            wheel: (e) => { setScale(num(node.scale, 100) * Math.exp(-e.deltaY * 0.0012)); h.rt.update?.(); },
        });
        h.bag.add(() => { root.removeEventListener("pointerdown", down); unAlt?.(); });
    };

    let unsub = null, seen = null;
    const hook = () => { const V = view(); if (!V || V === seen) return; unsub?.(); seen = V; unsub = V.onChange(() => update()); };
    h.bag.add(() => unsub?.());

    const update = () => {
        hook(); gestures();
        const crop = h.val(node.crop);
        me.shown = node.show === undefined || !!h.val(node.show);
        if (!me.shown) { wrap.hidden = true; return; }
        const bf = String(h.val(node.baseFile) || ""), mf = String(h.val(node.maskFile) || "");
        if (!crop?.ok && !mf) { me.region = null; me.cropSig = ""; me.token++; wrap.hidden = true; say("Wire a Succy Crop into stitch — or load a BASE IMAGE + a MASK", "mute"); return; }
        const V = view(), S = V ? V.size() : { w: 0, h: 0 };
        if (S.w > 0) { wrap.style.width = S.w + "px"; wrap.style.height = S.h + "px"; }
        // the Crop (or a loaded file) changed: ask again, but not on every tick of a drag
        const ck = `${crop?.ok ? crop.sig : "none"}|${bf}|${mf}`;
        if (ck !== me.cropSig) { me.cropSig = ck; clearTimeout(me.ftimer); me.ftimer = setTimeout(() => fetchRegion(crop, bf, mf), me.region ? 250 : 0); }
        loadInto(me.work, String(h.val(node.work) || ""));
        loadInto(me.brush, String(h.val(node.brush) || ""));
        paintCompare();
        const sig = [h.val(node.offsetX), h.val(node.offsetY), h.val(node.scale), h.val(node.sharp), h.val(node.grain), h.val(node.dim), h.val(node.seam), h.val(node.feather), h.val(node.mode), h.val(node.curve), h.val(node.colorMatch), h.val(node.opacity), h.val(node.aspect), h.val(node.place), me.work.url, me.brush.url.length].join("|");
        if (sig !== me.sig) { me.sig = sig; schedule(); }
    };
    queueMicrotask(update); setTimeout(update, 50); setTimeout(update, 400);
    return { el: wrap, update, handlesText: true };
});
