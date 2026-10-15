// ============================================================
// NodeStructure/util/mask-math.js — the Crop mask, computed in the BROWSER with the Python's own formulas (D-107)
// Pure functions on Float32Array [h*w] in 0..1: no DOM, no canvas, so Node can test them against Succy_Crop_Stitch.py.
//   rectMask   the rectangle (x, y, w, h in mask pixels; 0 = to the edge, like the native)
//   grow       square max-pool dilate (+) / min-pool erode (-): the same k = 2|px|+1 window as F.max_pool2d
//   blur       three box blurs with replicate padding (the Python `_blur`): a near-gaussian soft edge ~px wide
//   cropMask   the whole recipe: (box -> box feather) ∪ painted -> minus erased -> grow -> feather (D-112)
// Mirrors `Succy_Crop.crop` step by step: change one, change the other (and the test in dev/Theorycrafting).
// Succubus was here — same curves on both sides of the wire, darling. No surprises after the Run.
// ============================================================

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function rectMask(w, h, x, y, rw, rh) {
    const m = new Float32Array(w * h);
    const x0 = Math.min(Math.max(0, Math.round(x)), w - 1), y0 = Math.min(Math.max(0, Math.round(y)), h - 1);
    const x1 = rw > 0 ? Math.min(w, x0 + Math.round(rw)) : w, y1 = rh > 0 ? Math.min(h, y0 + Math.round(rh)) : h;
    for (let yy = y0; yy < y1; yy++) m.fill(1, yy * w + x0, yy * w + x1);
    return m;
}

// 1-D running max (or min) of radius r along rows or columns; samples outside the picture are ignored (padding = -inf).
// Monotonic deque: O(n) whatever the radius — a 1000 px grow costs the same as a 1 px one.
function pool1(src, w, h, r, horiz, useMax) {
    const out = new Float32Array(w * h);
    const n = horiz ? w : h, lines = horiz ? h : w, step = horiz ? 1 : w, lineStep = horiz ? w : 1;
    const q = new Int32Array(n);
    const better = useMax ? (a, b) => a >= b : (a, b) => a <= b;
    for (let l = 0; l < lines; l++) {
        const base = l * lineStep;
        let head = 0, tail = 0, next = 0;                    // q[head..tail) = indices, values monotonic
        for (let i = 0; i < n; i++) {
            const hi = Math.min(n - 1, i + r);
            for (; next <= hi; next++) {
                const v = src[base + next * step];
                while (tail > head && better(v, src[base + q[tail - 1] * step])) tail--;
                q[tail++] = next;
            }
            while (q[head] < i - r) head++;
            out[base + i * step] = src[base + q[head] * step];
        }
    }
    return out;
}

export function grow(m, w, h, px) {
    px = Math.round(px);
    if (!px) return m;
    const r = Math.abs(px), mx = px > 0;
    return pool1(pool1(m, w, h, r, true, mx), w, h, r, false, mx);
}

// 1-D box mean of radius r with replicate padding (sliding sum: cheap at any radius)
function box1(src, w, h, r, horiz) {
    const out = new Float32Array(w * h);
    const n = horiz ? w : h, lines = horiz ? h : w, step = horiz ? 1 : w, lineStep = horiz ? w : 1, k = 2 * r + 1;
    const at = (base, i) => src[base + (i < 0 ? 0 : i >= n ? n - 1 : i) * step];
    for (let l = 0; l < lines; l++) {
        const base = l * lineStep;
        let s = 0;
        for (let i = -r; i <= r; i++) s += at(base, i);
        for (let i = 0; i < n; i++) {
            out[base + i * step] = s / k;
            s += at(base, i + r + 1) - at(base, i - r);
        }
    }
    return out;
}

export function blur(m, w, h, px) {
    if (px <= 0) return m;
    const r = Math.max(1, Math.round(px / 3));
    let x = m;
    for (let i = 0; i < 3; i++) x = box1(box1(x, w, h, r, true), w, h, r, false);
    for (let i = 0; i < x.length; i++) x[i] = clamp01(x[i]);
    return x;
}

/**
 * The final Crop mask at w x h (any scale: `k` = mask pixels per ORIGINAL pixel, sizes in original pixels are scaled by it).
 * o = { box: {x,y,w,h} | null, boxFeather, add: Float32Array | null, erase: Float32Array | null, grow, feather, k }
 * Returns { mask, empty } — empty = nothing chosen: the Python then takes the whole picture.
 */
export function cropMask(w, h, o) {
    const k = o.k || 1;
    let sel = null;
    if (o.box) {
        sel = rectMask(w, h, o.box.x * k, o.box.y * k, o.box.w * k, o.box.h * k);
        if (o.boxFeather > 0) sel = blur(sel, w, h, o.boxFeather * k);
    }
    if (o.add) {
        if (!sel) sel = Float32Array.from(o.add);
        else for (let i = 0; i < sel.length; i++) if (o.add[i] > sel[i]) sel[i] = o.add[i];
    }
    let any = false;
    if (sel) for (let i = 0; i < sel.length; i++) if (sel[i] > 0.01) { any = true; break; }
    if (!any) return { mask: new Float32Array(w * h).fill(1), empty: true };
    if (o.erase) for (let i = 0; i < sel.length; i++) sel[i] *= 1 - o.erase[i];
    sel = grow(sel, w, h, (o.grow || 0) * k);              // after the eraser: grow/shrink moves the erased edge too (D-112)
    if (o.feather > 0) sel = blur(sel, w, h, o.feather * k);
    return { mask: sel, empty: false };
}
