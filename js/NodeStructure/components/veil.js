// ============================================================
// NodeStructure/components/veil.js — LIVE preview of the final Crop mask on a view_box (D-107)
//   veil_element       a layer over the picture that covers what the mask leaves OUT (Solid colour or Alpha checkerboard): (box -> box feather) ∪ brush -> minus
//                      eraser -> grow -> feather (D-112), computed in the browser with util/mask-math.js (the Python's own recipe, tested
//                      pixel for pixel). Works at a reduced size (res, default 512 px on the long side) and only when something
//                      it reads has changed. It never writes a native: pure eye candy, the natives stay the truth.
//                      `report` (D-130): one line of measures in the cache — picture · cut (where, how big) · output size (out_mp + multiple),
//                      the Python's own arithmetic. With a report the mask is computed even while the veil is hidden.
// The node only names the natives. Succubus was here — she shows you exactly what she'll keep, and blacks out the rest.
// ============================================================
import { mkEl } from "./index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, N, R, S } from "../catalog/kit.js";
import { cropMask, mpSize, snapTo } from "../util/mask-math.js";

const MASKS = new Set();                       // live previews (Governor counts them)
const MSTATS = { renders: 0, lastMs: 0 };
export const maskStats = () => ({ previews: MASKS.size, shown: [...MASKS].filter((m) => m.shown).length, ...MSTATS });

const CSS = `
.ns-mv{position:absolute;left:0;top:0;pointer-events:none}
.ns-mv canvas{position:absolute;display:block;image-rendering:auto}
.ns-mv[hidden]{display:none}
`;

const RES = 1536;                              // preview resolution, long side (D-116: was 512, too coarse to judge a fine stroke)
// the last veils and brush layers by what they were made of: a node rebuilt by Ctrl+Z (D-109) shows its veil in the same frame
const SEEN = new Map(), LAYERS = new Map(), CUTS = new Map();
// and the LAST veil of every node (graph uuid + node id + piece id): a node rebuilt by Ctrl+Z shows it at once, even after a slider
// drag pushed it out of SEEN, while the real one is computed. She never leaves you in the dark — well, not the wrong dark.
const LAST = new Map();
const nodeKey = (rt, id) => { const n = rt?.node; return `${n?.graph?.id ?? "g"}:${n?.id ?? "?"}:${id ?? "veil"}`; };
// FNV-1a of the whole brush PNG: two masks of the same length must never share a cached veil
let lastUrl = "", lastHash = "";
const hashUrl = (u) => { if (u === lastUrl) return lastHash; let x = 0x811c9dc5; for (let i = 0; i < u.length; i++) x = Math.imul(x ^ u.charCodeAt(i), 16777619); lastUrl = u; lastHash = (x >>> 0).toString(36); return lastHash; };
const keep = (m, k, v, max) => { m.delete(k); m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); };
// what the mask leaves out shows what the cutout output will have there (D-111): the Solid colour, or a checkerboard for Alpha.
// Soft edges and opacity read as blends of it.
const hexRgb = (c) => { let x = String(c || "").trim().replace(/^#/, ""); if (/^[0-9a-f]{3}$/i.test(x)) x = x.replace(/./g, "$&$&"); return /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(x) ? [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)) : [0, 0, 0]; };
const CHECK = [[154, 154, 160], [102, 102, 108]];

piece(C("veil_element", {
    scopo: "Anteprima dal vivo della maschera finale del Crop su un view_box: copre il fuori col colore Solid o la scacchiera Alpha.",
    natura: "funziona", dominio: "ui", estado: "draft", archetipo: "renderer-host",
    tag: ["maschera", "anteprima", "crop", "feather"], uses: ["view_box", "brush_element", "marquee_element"], css: CSS,
    props: {
        show: R("vero = anteprima visibile (ref, es. $state.maskView)"),
        x: R("x del rettangolo (ref)"), y: R("y (ref)"), w: R("larghezza, 0 = al bordo (ref)"), h: R("altezza, 0 = al bordo (ref)"),
        box: R("falso = nessun rettangolo (ref, es. $native.box)"), boxFeather: R("sfumatura del solo rettangolo in px (ref)"),
        brush: R("PNG del brush_element (ref, es. $native.brush): R dipinto, G cancellato"),
        grow: R("grow/shrink in px (ref)"), feather: R("sfumatura finale in px (ref)"),
        off: R("vero = non si puo' prevedere (es. maschera collegata all'ingresso): niente velo"),
        res: N("lato lungo del calcolo (px): piu' alto = piu' fedele e piu' lento", RES),
        strength: N("quanto e' coperto il fuori (0..1): 1 = pieno, si leggono sfumature e opacita'", 1),
        fill: R("colore del fuori, #rrggbb (ref, es. $native.solid_color); default nero"),
        alpha: R("vero = il fuori e' trasparente nell'uscita: scacchiera al posto del colore (ref, es. $native.alpha)"),
        report: S("chiave cache dove scrive le misure in una riga: immagine · taglio · uscita (D-130)"),
        outMp: R("megapixel dell'uscita, 0 = misura vera (ref, es. $native.out_mp)"),
        multiple: R("multiplo dell'uscita (ref, es. $native.multiple)"),
        outWired: R("vero = misura dell'uscita da un filo: la riga lo dice (ref)"),
    },
    esempio: ex({ t: "view_box", children: [{ t: "veil_element", show: true, x: 8, y: 8, w: 32, h: 32, box: true }] }),
}), (node, h) => {
    const wrap = mkEl("div", "ns-mv");
    const cv = mkEl("canvas");
    wrap.appendChild(cv);
    const lkey = nodeKey(h.rt, node.id);
    const me = { painted: false, shown: false, empty: true, cut: null, approx: false, PW: 0, PH: 0, W: 0, H: 0, mw: 0, mh: 0, sig: "", timer: 0, brush: { url: "", add: null, erase: null, mw: 0, token: 0 } };
    MASKS.add(me);
    h.bag.add(() => { MASKS.delete(me); clearTimeout(me.timer); me.brush.token++; });
    const view = () => wrap.closest(".ns-view")?.__nsView || null;
    const num = (v, d = 0) => { const n = Number(h.val(v)); return Number.isFinite(n) ? n : d; };
    // the measures line (D-130): picture · cut · output, like the Python counts them. me.cut = [x0, y0, x1, y1] in picture px
    // (null = nothing chosen = whole picture, false = the eraser took it all). k < 1: measured on the smaller preview, ± a pixel.
    let said = "";
    const tell = () => {
        const key = node.report; if (!key) return;
        const W = me.PW, H = me.PH;
        let text;
        if (!(W > 0 && H > 0)) text = "";
        else if (h.val(node.off)) text = `Picture ${W}×${H} · cut = the wired mask's box (known at Run)`;
        else if (me.cut === false) text = `Picture ${W}×${H} · ⚠ the eraser took the whole selection`;
        else {
            const [x0, y0, x1, y1] = me.cut || [0, 0, W, H], rw = x1 - x0, rh = y1 - y0, mp = num(node.outMp), m = Math.max(1, Math.round(num(node.multiple, 1)));
            let [ow, oh] = mp > 0 ? mpSize(rw, rh, mp) : [rw, rh];
            ow = snapTo(ow, m); oh = snapTo(oh, m);
            const out = h.val(node.outWired) ? "out from the wire (known at Run)" : `out ${ow}×${oh}`;
            text = `Picture ${W}×${H} · cut ${me.approx ? "≈" : ""}${rw}×${rh} at ${x0},${y0} · ${out}`;
        }
        if (text === said) return;
        said = text;
        const c = h.rt.api.cache; c.set(key, text); h.rt.api.refresh();
    };
    // the hard selection box (mask px) -> the Python's crop region in picture px: padded by the feather, clamped, no context (D-130)
    // returns { cut, approx }: a plain rectangle (no brush, no box feather) is counted EXACTLY like the Python, at full size;
    // anything else is read off the preview mask (picture over 1536 px: ± a pixel, the line says "≈")
    const cutOf = (r) => {
        if (r.empty) return { cut: null, approx: false };
        if (!r.bbox) return { cut: false, approx: false };
        const W = me.W, H = me.H, pad = Math.max(0, Math.trunc(num(node.feather)));
        const boxOn = node.box === undefined || !!h.val(node.box);
        if (boxOn && !String(h.val(node.brush) || "") && !(num(node.boxFeather) > 0)) {
            const g = Math.trunc(num(node.grow)), x0 = Math.min(Math.trunc(num(node.x)), W - 1), y0 = Math.min(Math.trunc(num(node.y)), H - 1);
            const x1 = num(node.w) === 0 ? W : Math.min(W, x0 + Math.trunc(num(node.w))), y1 = num(node.h) === 0 ? H : Math.min(H, y0 + Math.trunc(num(node.h)));
            const a = Math.max(0, x0 - g), b = Math.max(0, y0 - g), c = Math.min(W, x1 + g), d = Math.min(H, y1 + g);
            if (c <= a || d <= b) return { cut: false, approx: false };
            return { cut: [Math.max(0, a - pad), Math.max(0, b - pad), Math.min(W, c + pad), Math.min(H, d + pad)], approx: false };
        }
        const k = me.mw / W, [a, b, c, d] = r.bbox;
        return { cut: [Math.max(0, Math.floor(a / k) - pad), Math.max(0, Math.floor(b / k) - pad), Math.min(W, Math.ceil(c / k) + pad), Math.min(H, Math.ceil(d / k) + pad)], approx: k < 1 };
    };

    // the brush PNG -> two float layers at the preview size (stretched like the Python does, bilinear by the browser)
    const brushLayers = (url) => {
        const b = me.brush;
        if (!url) { b.url = ""; b.add = b.erase = null; return true; }
        if (b.url === url && b.mw === me.mw && b.add) return true;
        const hit = LAYERS.get(`${me.mw}x${me.mh}:${url}`);
        if (hit) { Object.assign(b, { url, mw: me.mw, add: hit.add, erase: hit.erase }); return true; }
        const t = ++b.token, im = new Image();
        im.onload = () => {
            if (t !== b.token || !me.mw) return;
            const c = document.createElement("canvas"); c.width = me.mw; c.height = me.mh;
            const cx = c.getContext("2d", { willReadFrequently: true });
            cx.imageSmoothingQuality = "high";
            cx.drawImage(im, 0, 0, me.mw, me.mh);
            const px = cx.getImageData(0, 0, me.mw, me.mh).data, n = me.mw * me.mh;
            const add = new Float32Array(n), erase = new Float32Array(n);
            let anyA = false, anyE = false;
            for (let i = 0; i < n; i++) { add[i] = px[i * 4] / 255; erase[i] = px[i * 4 + 1] / 255; anyA ||= add[i] > 0; anyE ||= erase[i] > 0; }
            Object.assign(b, { url, mw: me.mw, add: anyA ? add : null, erase: anyE ? erase : null });
            keep(LAYERS, `${me.mw}x${me.mh}:${url}`, { add: b.add, erase: b.erase }, 3);
            me.sig = ""; schedule();
        };
        im.onerror = () => { if (t === b.token) { b.url = url; b.add = b.erase = null; } };
        im.src = url;
        return false;                                        // not ready yet: render again when it is
    };

    const render = () => {
        me.timer = 0;
        const t0 = performance.now();
        const { mw, mh, W } = me, k = mw / W;
        const url = String(h.val(node.brush) || "");
        if (!brushLayers(url)) return;
        const boxOn = node.box === undefined || !!h.val(node.box);
        const r = cropMask(mw, mh, {
            k, box: boxOn ? { x: num(node.x), y: num(node.y), w: num(node.w), h: num(node.h) } : null,
            boxFeather: num(node.boxFeather), add: me.brush.add, erase: me.brush.erase, grow: num(node.grow), feather: num(node.feather),
        });
        const cx = cv.getContext("2d");
        me.empty = r.empty;
        const got = cutOf(r); me.cut = got.cut; me.approx = got.approx; tell();
        if (me.sig) keep(CUTS, me.sig, got, 8);
        if (r.empty) { cx.clearRect(0, 0, mw + 2, mh + 2); wrap.hidden = true; me.painted = true; if (me.sig) keep(SEEN, me.sig, null, 4); keep(LAST, lkey, { img: null, mw, mh }, 12); return; }    // nothing chosen = the whole picture: no veil
        wrap.hidden = !me.shown;
        // the canvas is ONE mask pixel larger on every side (edge values repeated): zoomed, the picture's antialiased rim
        // stays under the veil instead of peeking out as thin lines (D-111)
        const cw = mw + 2, ch = mh + 2;
        const img = cx.createImageData(cw, ch), d = img.data, m = r.mask;
        const A = 255 * Math.min(1, Math.max(0, Number(node.strength ?? 1)));
        const checker = !!h.val(node.alpha), rgb = hexRgb(h.val(node.fill)), cell = Math.max(4, Math.round(mw / 48));
        for (let y = 0; y < ch; y++) {
            const sy = Math.min(mh - 1, Math.max(0, y - 1));
            for (let x = 0; x < cw; x++) {
                const sx = Math.min(mw - 1, Math.max(0, x - 1)), j = (y * cw + x) * 4;
                const c = checker ? CHECK[(Math.floor(x / cell) + Math.floor(y / cell)) & 1] : rgb;
                d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2];
                d[j + 3] = Math.round(A * (1 - m[sy * mw + sx]));
            }
        }
        cx.putImageData(img, 0, 0);
        me.painted = true;
        if (me.sig) keep(SEEN, me.sig, img, 4);
        keep(LAST, lkey, { img, mw, mh }, 12);
        MSTATS.lastAddPx = me.brush.add ? me.brush.add.reduce((a, v) => a + (v > 0.01 ? 1 : 0), 0) : 0;
        MSTATS.lastClearPx = m.reduce((a, v) => a + (v > 0.01 ? 1 : 0), 0);
        MSTATS.renders++; MSTATS.lastMs = Math.round(performance.now() - t0);
    };
    const schedule = () => { if (!me.timer) me.timer = setTimeout(render, 40); };

    // follow the view (a new picture changes its size) once it exists: the stage is attached after the factory returns
    let unsub = null, seen = null;
    const hook = () => { const V = view(); if (!V || V === seen) return; unsub?.(); seen = V; unsub = V.onChange(() => update()); };
    h.bag.add(() => unsub?.());

    const update = () => {
        hook();
        const V = view(); const S = V ? V.size() : { w: 0, h: 0 };
        me.PW = S.w; me.PH = S.h;
        me.shown = !!h.val(node.show) && !h.val(node.off) && S.w > 0 && S.h > 0;
        // a report keeps the mask computed while the veil is hidden: the measures line needs the cut (D-130)
        const measure = !!node.report && !h.val(node.off) && S.w > 0 && S.h > 0;
        if (!me.shown && !measure) { wrap.hidden = true; me.sig = ""; tell(); return; }
        if (S.w !== me.W || S.h !== me.H) {
            me.W = S.w; me.H = S.h;
            const s = Math.min(1, (Number(node.res) || RES) / Math.max(S.w, S.h));
            me.mw = Math.max(1, Math.round(S.w * s)); me.mh = Math.max(1, Math.round(S.h * s));
            cv.width = me.mw + 2; cv.height = me.mh + 2;
            const px = S.w / me.mw, py = S.h / me.mh;                  // one mask pixel, in picture pixels
            Object.assign(cv.style, { left: -px + "px", top: -py + "px", width: S.w + 2 * px + "px", height: S.h + 2 * py + "px" });
            wrap.style.width = S.w + "px"; wrap.style.height = S.h + "px";
            me.sig = "";
            // freshly built (undo): put this node's last veil up right now, the exact one follows
            const last = !me.painted && LAST.get(lkey);
            if (last && last.mw === me.mw && last.mh === me.mh) {
                me.empty = !last.img; wrap.hidden = me.empty || !me.shown;
                if (last.img) cv.getContext("2d").putImageData(last.img, 0, 0);
            }
        }
        const url = String(h.val(node.brush) || "");
        const sig = [h.val(node.x), h.val(node.y), h.val(node.w), h.val(node.h), h.val(node.box), h.val(node.boxFeather),
            h.val(node.grow), h.val(node.feather), url.length, hashUrl(url), me.mw, me.mh, h.val(node.fill), !!h.val(node.alpha)].join("|");
        if (sig === me.sig) { wrap.hidden = me.empty || !me.shown; tell(); return; }
        me.sig = sig;
        if (SEEN.has(sig) && CUTS.has(sig)) {                   // already computed (undo, a twin node): paint it now, no wait, no flash
            const img = SEEN.get(sig);
            me.empty = !img; wrap.hidden = me.empty || !me.shown; const got = CUTS.get(sig); me.cut = got.cut; me.approx = got.approx; tell();
            if (img) cv.getContext("2d").putImageData(img, 0, 0);
            me.painted = true;
            if (img || me.empty) keep(LAST, lkey, { img, mw: me.mw, mh: me.mh }, 12);
            return;
        }
        if (!me.painted) render(); else schedule();          // first time: no 40 ms wait (the debounce is for slider drags)
    };
    queueMicrotask(update); setTimeout(update, 50); setTimeout(update, 400);
    return { el: wrap, update, handlesText: true };
});
