// ============================================================
// NodeStructure/util/blend-math.js — the Stitch seam, computed in the BROWSER with the Python's own formulas (D-123)
// Pure functions on Float32Array in 0..1, no DOM: Node can test them against Succy_Crop_Stitch.py.
//   stitchMask   `_feather` + retouch brush + opacity: the crop's mask -> the seam mask M (borders = region sides sitting on the picture edge)
//   fitMode / fitRect   `_fit_mode` / `_fit_to_region` as geometry: the canvas moves the pixels, these say where
//   colorMatch   `_color_match`: pull the worked crop's colour toward the original using the context ring
//   blend        base * (1 - M) + work * M
//   detailMatch  `_detail_match`: sharpness / grain match measured on the selection (D-129, D-130) · placeRect `_place`: offset + scale of the worked picture
// Images are interleaved [h*w*c] (c = 3 or 4), masks are [h*w]. Resizing the worked crop to the region (Python: bicubic + antialias)
// is NOT here: the preview uses the canvas for that and the full-quality Copy/Download is redone on the originals — it is the one
// place where a pixel of rounding may differ (the test below leaves it out on purpose).
// Succubus was here — same seam on both sides of the wire, and not a stitch showing. Mostly.
// ============================================================

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** `_feather`: m [h*w] 0..1, f px, mode inside|outside|centered, curve smooth|linear, borders [left, top, right, bottom] booleans. */
export function feather(m, w, h, f, mode, curve, borders) {
    const src = Float32Array.from(m, clamp01);
    if (!(f > 0)) return src;
    let k = Math.trunc(mode === "centered" ? f : 2 * f);
    if (k % 2 === 0) k += 1;
    const p = k >> 1, [bl, bt, br, bb] = borders;
    // padded copy: replicate on the sides that sit on the picture edge, zero on the others (same order as Python: zero wins in corners)
    const pw = w + 2 * p, ph = h + 2 * p;
    let x = new Float32Array(pw * ph);
    for (let yy = 0; yy < ph; yy++) {
        const sy = Math.min(h - 1, Math.max(0, yy - p));
        const zeroY = (yy < p && !bt) || (yy >= h + p && !bb);
        for (let xx = 0; xx < pw; xx++) {
            const zeroX = (xx < p && !bl) || (xx >= w + p && !br);
            if (zeroX || zeroY) continue;
            x[yy * pw + xx] = src[sy * w + Math.min(w - 1, Math.max(0, xx - p))];
        }
    }
    // separable box mean, valid window (avg_pool2d stride 1, no padding): ph x pw -> ph x w -> h x w
    const tmp = new Float32Array(ph * w);
    for (let yy = 0; yy < ph; yy++) {
        let s = 0;
        for (let i = 0; i < k; i++) s += x[yy * pw + i];
        for (let xx = 0; xx < w; xx++) {
            tmp[yy * w + xx] = s / k;
            if (xx + k < pw) s += x[yy * pw + xx + k] - x[yy * pw + xx];
        }
    }
    const out = new Float32Array(w * h);
    for (let xx = 0; xx < w; xx++) {
        let s = 0;
        for (let i = 0; i < k; i++) s += tmp[i * w + xx];
        for (let yy = 0; yy < h; yy++) {
            out[yy * w + xx] = s / k;
            if (yy + k < ph) s += tmp[(yy + k) * w + xx] - tmp[yy * w + xx];
        }
    }
    for (let i = 0; i < out.length; i++) {
        let v = out[i];
        if (mode === "inside") v = Math.min(clamp01(2 * v - 1), src[i]);
        else if (mode === "outside") v = Math.max(clamp01(2 * v), src[i]);
        if (curve === "smooth") v = v * v * (3 - 2 * v);
        out[i] = clamp01(v);
    }
    return out;
}

/** The seam mask Stitch uses: feather, then the retouch brush (add = max, erase = times 1 - erase, D-124), times the fit mask
 *  (optional), times opacity, clamped. add / erase / fit are [h*w] or null. */
export function stitchMask(sel, w, h, o) {
    const M = feather(sel, w, h, o.feather || 0, o.mode || "inside", o.curve || "smooth", o.borders || [false, false, false, false]);
    const op = o.opacity ?? 1, add = o.add || null, erase = o.erase || null, fit = o.fit || null;
    for (let i = 0; i < M.length; i++) {
        let v = add ? Math.max(M[i], add[i]) : M[i];
        if (erase) v *= 1 - erase[i];
        M[i] = clamp01(v * (fit ? fit[i] : 1) * op);
    }
    return M;
}

/** Python `_fit_mode`: auto -> crop_center under 2% difference in proportions, otherwise stretch. */
export function fitMode(w, h, rw, rh, mode) {
    if (mode && mode !== "auto") return mode;
    return Math.abs((w / h) / (rw / rh) - 1) < 0.02 ? "crop_center" : "stretch";
}

/** Python `_fit_to_region` as GEOMETRY (the pixels are moved by the canvas): where to read in the worked picture (sx, sy, sw, sh)
 *  and where to write in the region (dx, dy, dw, dh), both in pixels. mode = stretch | crop_center | fit (already resolved). */
export function fitRect(w, h, rw, rh, mode) {
    if (mode === "crop_center") {
        if (w / h > rw / rh) { const nw = Math.max(1, Math.round(h * rw / rh)); return { sx: Math.trunc((w - nw) / 2), sy: 0, sw: nw, sh: h, dx: 0, dy: 0, dw: rw, dh: rh }; }
        const nh = Math.max(1, Math.round(w * rh / rw)); return { sx: 0, sy: Math.trunc((h - nh) / 2), sw: w, sh: nh, dx: 0, dy: 0, dw: rw, dh: rh };
    }
    if (mode === "fit") {
        const s = Math.min(rw / w, rh / h), nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
        return { sx: 0, sy: 0, sw: w, sh: h, dx: Math.trunc((rw - nw) / 2), dy: Math.trunc((rh - nh) / 2), dw: nw, dh: nh, fit: true };
    }
    return { sx: 0, sy: 0, sw: w, sh: h, dx: 0, dy: 0, dw: rw, dh: rh };
}

// weighted per-channel mean / std over the pixels where wt > 0 (Python `_wstats`; the ring weight is 0 or 1)
function wstats(img, wt, n, c) {
    let tot = 0;
    for (let i = 0; i < n; i++) tot += wt[i];
    tot = Math.max(tot, 1);
    const mu = new Float32Array(c), sd = new Float32Array(c);
    for (let ch = 0; ch < c; ch++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += img[i * c + ch] * wt[i];
        mu[ch] = s / tot;
        let v = 0;
        for (let i = 0; i < n; i++) { const d = img[i * c + ch] - mu[ch]; v += d * d * wt[i]; }
        sd[ch] = Math.sqrt(v / tot + 1e-8);
    }
    return { mu, sd };
}

/** Python `_ring`: the context ring (sel < 0.5); no context at all: a thin band along the region edge. */
export function ringMask(sel, w, h) {
    const n = w * h, ring = new Float32Array(n);
    let cnt = 0;
    for (let i = 0; i < n; i++) if (sel[i] < 0.5) { ring[i] = 1; cnt++; }
    if (cnt < 0.01 * n) {
        const bw = Math.max(4, Math.floor(Math.min(h, w) / 16));
        ring.fill(0);
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (yy < bw || yy >= h - bw || xx < bw || xx >= w - bw) ring[yy * w + xx] = 1;
    }
    return ring;
}

/** Python `_box`: separable k x k box mean, replicate padding, same size out. img [h*w*c]. */
export function boxBlur(img, w, h, c, k) {
    k = Math.trunc(k);
    if (k <= 1) return Float32Array.from(img);
    const p = k >> 1, tmp = new Float32Array(img.length), out = new Float32Array(img.length);
    const cx = (x) => (x < 0 ? 0 : x >= w ? w - 1 : x), cy = (y) => (y < 0 ? 0 : y >= h ? h - 1 : y);
    for (let ch = 0; ch < c; ch++) {
        for (let y = 0; y < h; y++) {
            let s = 0;
            for (let i = -p; i <= p; i++) s += img[(y * w + cx(i)) * c + ch];
            for (let x = 0; x < w; x++) {
                tmp[(y * w + x) * c + ch] = s / k;
                s += img[(y * w + cx(x + p + 1)) * c + ch] - img[(y * w + cx(x - p)) * c + ch];
            }
        }
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let i = -p; i <= p; i++) s += tmp[(cy(i) * w + x) * c + ch];
            for (let y = 0; y < h; y++) {
                out[(y * w + x) * c + ch] = s / k;
                s += tmp[(cy(y + p + 1) * w + x) * c + ch] - tmp[(cy(y - p) * w + x) * c + ch];
            }
        }
    }
    return out;
}

// Python `_hp_energy`: std of the luminance high-pass (x - box k) over the weights
function hpEnergy(img, w, h, c, k, ring) {
    const n = w * h, lum = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let ch = 0; ch < c; ch++) s += img[i * c + ch]; lum[i] = s / c; }
    const lo = boxBlur(lum, w, h, 1, k);
    for (let i = 0; i < n; i++) lum[i] -= lo[i];
    return wstats(lum, ring, n, 1).sd[0];
}

export const SHARP_K = 5, GRAIN_K = 3;       // Python SHARP_K / GRAIN_K (region px); the preview scales them with its size

/** Python `_detail_area` (D-130): detail is measured on the selection (original vs worked in the same place), the region if it is tiny. */
export function detailArea(sel, w, h) {
    const n = w * h, area = new Float32Array(n);
    let cnt = 0;
    for (let i = 0; i < n; i++) if (sel[i] >= 0.5) { area[i] = 1; cnt++; }
    if (cnt < 0.01 * n) area.fill(1);
    return area;
}

/** Python `_detail_match` (D-129, D-130): sharpness match then grain match, strengths 0..1. ks = preview scale (1 = full size).
 *  sharp 1 = the original's detail energy for real (one secant step corrects the unsharp gain).
 *  The grain is noise: same strength as the Python, not the same pattern (a seeded hash here, torch's generator there). */
export function detailMatch(work, base, sel, w, h, c, sharp, grain, ks = 1) {
    const odd = (k) => { k = Math.max(1, Math.round(k * ks)); return k % 2 ? k : k + 1; };
    const area = detailArea(sel, w, h), n = w * h;
    let out = work;
    if (sharp > 0) {
        const k = odd(SHARP_K), low = boxBlur(work, w, h, c, k);
        const ew = Math.max(hpEnergy(work, w, h, c, k, area), 1e-4);
        const ratio = Math.min(4, Math.max(0.25, hpEnergy(base, w, h, c, k, area) / ew));
        out = new Float32Array(work.length);
        for (let i = 0; i < work.length; i++) out[i] = low[i] + (work[i] - low[i]) * ratio;
        // e1 - ew = what gain `ratio` really moved; scale the push so the target (ratio - 1) * ew is met
        const d1 = hpEnergy(out, w, h, c, k, area) - ew;
        const gain = Math.min(8, Math.max(0, Math.abs(d1) > 1e-6 ? 1 + (ratio - 1) * (ratio - 1) * ew / d1 : ratio));
        const g = Math.max(0, 1 + sharp * (gain - 1));
        for (let i = 0; i < work.length; i++) out[i] = low[i] + (work[i] - low[i]) * g;
    }
    if (grain > 0) {
        const k = odd(GRAIN_K), gb = hpEnergy(base, w, h, c, k, area), gw = hpEnergy(out, w, h, c, k, area);
        const amt = Math.sqrt(Math.max(0, gb * gb - gw * gw)) * grain;
        if (out === work) out = Float32Array.from(work);
        let sd = 0x5cc;
        const rnd = () => { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; return sd / 4294967296; };
        for (let i = 0; i < n; i++) {
            const z = (rnd() + rnd() + rnd() - 1.5) * 2;                     // ~ N(0, 1)
            for (let ch = 0; ch < Math.min(3, c); ch++) out[i * c + ch] += z * amt;
        }
    }
    if (out !== work) for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i]);
    return out;
}

/** Python `_place` as GEOMETRY (D-129): where the fitted worked picture lands after offset (region px) and scale (1 = as is),
 *  for a region of rw x rh. Returns { x, y, w, h } in region px. */
export function placeRect(rw, rh, ox, oy, scale) {
    const nw = Math.max(1, Math.round(rw * scale)), nh = Math.max(1, Math.round(rh * scale));
    return { x: Math.floor((rw - nw) / 2) + Math.trunc(ox), y: Math.floor((rh - nh) / 2) + Math.trunc(oy), w: nw, h: nh };
}

/** `_color_match`: work and base are [h*w*c], sel is the crop mask [h*w], strength 0..1. Returns a new array. */
export function colorMatch(work, base, sel, w, h, c, strength) {
    const n = w * h, ring = ringMask(sel, w, h);
    const a = wstats(work, ring, n, c), b = wstats(base, ring, n, c);
    const out = new Float32Array(work.length);
    for (let ch = 0; ch < c; ch++) {
        const scale = Math.min(2, Math.max(0.5, b.sd[ch] / Math.max(a.sd[ch], 1e-4)));
        for (let i = 0; i < n; i++) {
            const v = work[i * c + ch], matched = (v - a.mu[ch]) * scale + b.mu[ch];
            out[i * c + ch] = clamp01(v + strength * (matched - v));
        }
    }
    return out;
}

/** base * (1 - M) + work * M, per channel, clamped. */
export function blend(base, work, M, c) {
    const out = new Float32Array(base.length);
    for (let i = 0; i < M.length; i++) {
        for (let ch = 0; ch < c; ch++) out[i * c + ch] = clamp01(base[i * c + ch] * (1 - M[i]) + work[i * c + ch] * M[i]);
    }
    return out;
}
