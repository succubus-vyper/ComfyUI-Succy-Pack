// ============================================================
// NodeStructure/fx/engine.js — graphics engine for the effects (wires and dot)
// ------------------------------------------------------------
// EXTRACTED VERBATIM from Succy_Reroute.js (lines 25-117 and 180-542 of the original), now PART OF THE KIT:
// pure drawing functions (stroke/dots layers, dot skin), no
// access to app/api/structural DOM.
//
// WARNING (DECISIONS.md D-12): SuccyRR_compile() uses `new Function` for the
// "=..." expressions in the effects json. It's LEGACY code quarantined here:
// NodeStructure contains NO eval. The expressions come from the pack's local json
// (not from user input), but replacing it with a safe parser is
// future work (KIT_REQUESTS / DECISIONS "not done"). A guilty pleasure, kept on a short leash.
// ============================================================
const SUCCY_RR_TEST = {};
const SUCCY_RR_TYPE    = "Succy_Reroute";
const SUCCY_RR_PROP    = "succy_rr";
const SUCCY_RR_W       = 72;     // small square node (change it here to make it bigger/smaller)
const SUCCY_RR_H       = 76;
const SUCCY_RR_DOT_H   = 40;     // height of the dot's area inside the node
const SUCCY_RR_WNAME   = "succy_rr_dot";
const SUCCY_RR_R       = 10;     // dot radius
const SUCCY_RR_ROUTE   = "/succy/reroute/effects";
const SUCCY_RR_MAXPTS  = 1024;
const SUCCY_RR_NOCOLOR = "rgba(0,0,0,0)";
const SUCCY_RR_AUTOFB  = "#9A9";
const SUCCY_RR_TAU     = Math.PI * 2;

/* ============================================================
 *  Math / expression helpers
 * ============================================================ */
const SuccyRR_fract = (x) => x - Math.floor(x);
const SuccyRR_mix   = (a, b, k) => a + (b - a) * k;
const SuccyRR_clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const SuccyRR_rnd   = (x) => SuccyRR_fract(Math.sin(x * 127.1 + 311.7) * 43758.5453);
const SuccyRR_tri   = (x) => Math.abs(SuccyRR_fract(x) * 2 - 1);
const SuccyRR_hsl   = (h, s = 90, l = 60, a = 1) => `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a})`;
const SuccyRR_rgba  = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

function SuccyRR_alpha(c, a) {
    if (typeof c !== "string") return c;
    let m;
    if (c[0] === "#") {
        let h = c.slice(1);
        if (h.length === 3) h = h.split("").map((x) => x + x).join("");
        const n = parseInt(h.slice(0, 6), 16);
        if (Number.isNaN(n)) return c;
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    if ((m = c.match(/^(rgb|hsl)a?\(([^)]*)\)$/i))) {
        const parts = m[2].split(",").map((s) => s.trim()).slice(0, 3);
        return `${m[1].toLowerCase()}a(${parts.join(",")},${a})`;
    }
    return c;
}

const SUCCY_RR_HELPERS = {
    fract: SuccyRR_fract, mix: SuccyRR_mix, clamp: SuccyRR_clamp, rnd: SuccyRR_rnd,
    tri: SuccyRR_tri, hsl: SuccyRR_hsl, rgba: SuccyRR_rgba, alpha: SuccyRR_alpha,
};
const SUCCY_RR_EXPR_CACHE = new Map();

function SuccyRR_compile(src) {
    let fn = SUCCY_RR_EXPR_CACHE.get(src);
    if (fn !== undefined) return fn;
    try {
        const body = src.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, "P.$1");
        const make = new Function(
            "H",
            "return function(P,t,u,s,i,n,L,v){" +
            "const {sin,cos,tan,abs,min,max,pow,sqrt,floor,ceil,round,atan2,log,exp,PI}=Math;" +
            "const {fract,mix,clamp,rnd,tri,hsl,rgba,alpha}=H;" +
            "return (" + body + ");}"
        );
        fn = make(SUCCY_RR_HELPERS);
    } catch (e) {
        console.warn("[Succy Reroute] bad expression:", src, e);
        fn = null;
    }
    SUCCY_RR_EXPR_CACHE.set(src, fn);
    return fn;
}

/* Evaluates a json field: literal | "$param" | "auto" | "=expression".
 * c = { P, t, u, s, i, n, L, auto } (reused context, never allocated per frame) */
function SuccyRR_val(v, c, def) {
    if (v === undefined || v === null) return def;
    if (typeof v === "string") {
        const k = v.charCodeAt(0);
        if (k === 61) {                                   // "="
            const fn = SuccyRR_compile(v.slice(1));
            if (!fn) return def;
            try {
                const r = fn(c.P, c.t, c.u, c.s, c.i, c.n, c.L, c.v);
                if (r === undefined || r === null || (typeof r === "number" && !Number.isFinite(r))) return def;
                return r;
            } catch (_) { return def; }
        }
        if (k === 36 && /^\$[A-Za-z_]\w*$/.test(v)) {     // "$param"
            const r = c.P[v.slice(1)];
            return r === undefined ? def : r;
        }
        if (v === "auto") return c.auto ?? def;
    }
    return v;
}

const SUCCY_RR_PATH = {
    x: new Float32Array(SUCCY_RR_MAXPTS), y: new Float32Array(SUCCY_RR_MAXPTS),
    s: new Float32Array(SUCCY_RR_MAXPTS), n: 0, len: 0,
};
const SUCCY_RR_BX = new Float32Array(SUCCY_RR_MAXPTS);
const SUCCY_RR_BY = new Float32Array(SUCCY_RR_MAXPTS);
const SUCCY_RR_PT  = { x: 0, y: 0, tx: 1, ty: 0 };
const SUCCY_RR_PT2 = { x: 0, y: 0, tx: 1, ty: 0 };
const SUCCY_RR_PT3 = { x: 0, y: 0, tx: 1, ty: 0 };

function SuccyRR_buildPath(a, b, straight, da, db, cp) {   // da/db: tangent unit vectors [x,y] (default: out to the right, in from the left); cp: absolute [c1x,c1y,c2x,c2y] (wins over da/db)
    const p = SUCCY_RR_PATH;
    const dx = b[0] - a[0], dy = b[1] - a[1], dist = Math.hypot(dx, dy);
    const n = Math.max(6, Math.min(SUCCY_RR_MAXPTS - 1, Math.round(dist / 5)));
    const k = dist * 0.25;
    const ax = da ? da[0] : 1, ay = da ? da[1] : 0, bx = db ? db[0] : -1, by = db ? db[1] : 0;
    const ex = !straight && cp && cp.length === 4;
    const c1x = ex ? cp[0] : straight ? a[0] + dx / 3 : a[0] + ax * k, c1y = ex ? cp[1] : straight ? a[1] + dy / 3 : a[1] + ay * k;
    const c2x = ex ? cp[2] : straight ? a[0] + dx * 2 / 3 : b[0] + bx * k, c2y = ex ? cp[3] : straight ? a[1] + dy * 2 / 3 : b[1] + by * k;
    let len = 0;
    for (let i = 0; i <= n; i++) {
        const t = i / n, m = 1 - t;
        const w0 = m * m * m, w1 = 3 * m * m * t, w2 = 3 * m * t * t, w3 = t * t * t;
        const x = w0 * a[0] + w1 * c1x + w2 * c2x + w3 * b[0];
        const y = w0 * a[1] + w1 * c1y + w2 * c2y + w3 * b[1];
        p.x[i] = x; p.y[i] = y;
        if (i > 0) len += Math.hypot(x - p.x[i - 1], y - p.y[i - 1]);
        p.s[i] = len;
    }
    p.n = n + 1; p.len = len;
    return p;
}

function SuccyRR_at(p, s, o = SUCCY_RR_PT) {
    if (s < 0) s = 0; else if (s > p.len) s = p.len;
    let lo = 0, hi = p.n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (p.s[mid] <= s) lo = mid; else hi = mid;
    }
    const seg = p.s[hi] - p.s[lo];
    const f = seg > 1e-6 ? (s - p.s[lo]) / seg : 0;
    const dx = p.x[hi] - p.x[lo], dy = p.y[hi] - p.y[lo], dl = Math.hypot(dx, dy) || 1;
    o.x = p.x[lo] + dx * f; o.y = p.y[lo] + dy * f; o.tx = dx / dl; o.ty = dy / dl;
    return o;
}

/* ============================================================
 *  Wire layers
 * ============================================================ */
function SuccyRR_setCtx(c, u, s, i, n) {
    c.u = u; c.s = s; c.i = i; c.n = n;
    // u = position 0..1 along the WHOLE path, v = position 0..1 along the current wire
    c.v = c.pl > 0 ? SuccyRR_clamp((s - (c.S0 || 0)) / c.pl, 0, 1) : u;
}

function SuccyRR_layerBegin(ctx, L, c, color, scale, lq) {
    ctx.save();
    const al = Number(SuccyRR_val(L.alpha, c, 1));
    ctx.globalAlpha = SuccyRR_clamp(Number.isFinite(al) ? al : 1, 0, 1) * (c.A ?? 1);      // c.A: external attenuation (floating wires)
    if (L.composite) ctx.globalCompositeOperation = L.composite;
    const blur = Number(SuccyRR_val(L.blur, c, 0)) || 0;
    if (blur > 0 && !lq) { ctx.shadowBlur = Math.min(40, blur * scale); ctx.shadowColor = color; }
    return lq ? 0 : blur;                                   // low quality: no blur, no fake glow
}

/* CHEAP "fake" glow: shadowBlur on every segment is painfully slow (one gaussian blur per stroke).
   Here 3 wide, transparent strokes nested on a polyline => looks like a glow, costs next to nothing. Faking it, beautifully. */
const SUCCY_RR_GLOW_K = [1.4, 0.9, 0.4], SUCCY_RR_GLOW_A = [0.2, 0.3, 0.5];
const SUCCY_RR_TRX = new Float64Array(96), SUCCY_RR_TRY = new Float64Array(96), SUCCY_RR_TRS = new Float64Array(96);
function SuccyRR_glow(ctx, xs, ys, i0, i1, w, blur, chunkLen) {
    const base = ctx.globalAlpha;
    const cov = Math.max(1, (w + blur * 0.9) / Math.max(1, chunkLen));
    for (let k = 0; k < 3; k++) {
        ctx.globalAlpha = Math.min(1, base * 0.8 * SUCCY_RR_GLOW_A[k] / cov);
        ctx.lineWidth = w + blur * SUCCY_RR_GLOW_K[k];
        ctx.beginPath(); ctx.moveTo(xs[i0], ys[i0]);
        for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(xs[i], ys[i]);
        ctx.stroke();
    }
    ctx.globalAlpha = base;
}

function SuccyRR_layerStroke(ctx, L, c, p, scale, lq) {
    const S0 = c.S0 || 0, LT = c.LT > 0 ? c.LT : p.len;
    SuccyRR_setCtx(c, (S0 + p.len / 2) / LT, S0 + p.len / 2, 0, 1);
    const color = SuccyRR_val(L.color, c, c.auto);
    const width = Number(SuccyRR_val(L.width, c, 3));
    if (!(width > 0)) return;
    const hasD = L.displace != null, perSeg = !!L.perSegment, hasOff = L.offset != null;
    let n, X = SUCCY_RR_BX, Y = SUCCY_RR_BY;
    if (!hasD && !perSeg && !hasOff) {
        n = p.n; X = p.x; Y = p.y;
    } else {
        const step = Math.max(2, Number(SuccyRR_val(L.step, c, 6)) || 6) * ((c.Q || 0) >= 1 ? 2 : 1);   // throttle: half the points
        n = Math.max(2, Math.min(900, Math.ceil(p.len / step) + 1));
        for (let i = 0; i < n; i++) {
            const s = p.len * i / (n - 1);
            const q = SuccyRR_at(p, s);
            SuccyRR_setCtx(c, (S0 + s) / LT, S0 + s, i, n);
            let d = 0;
            if (hasD) d += Number(SuccyRR_val(L.displace, c, 0)) || 0;
            if (hasOff) d += Number(SuccyRR_val(L.offset, c, 0)) || 0;
            X[i] = q.x - q.ty * d; Y[i] = q.y + q.tx * d;
        }
    }
    SuccyRR_setCtx(c, (S0 + p.len / 2) / LT, S0 + p.len / 2, 0, n);
    const rawBlur = SuccyRR_layerBegin(ctx, L, c, color, scale, lq);
    try {
        ctx.lineCap = L.cap || "round";
        ctx.lineJoin = L.join || "round";
        if (!perSeg) {
            ctx.strokeStyle = color; ctx.lineWidth = width;
            if (Array.isArray(L.dash)) {
                ctx.setLineDash(L.dash.map((v) => Math.max(0.01, Number(SuccyRR_val(v, c, 1)) || 1)));
                ctx.lineDashOffset = S0 - (Number(SuccyRR_val(L.dashSpeed, c, 0)) || 0) * c.t;
            }
            ctx.beginPath(); ctx.moveTo(X[0], Y[0]);
            for (let i = 1; i < n; i++) ctx.lineTo(X[i], Y[i]);
            ctx.stroke();
        } else {
            const baseA = ctx.globalAlpha;
            ctx.shadowBlur = 0;                                  // never shadowBlur per segment: chunky fake glow
            const HS = 4;
            for (let i = 1; i < n; i++) {
                const sl = (i - 0.5) / (n - 1) * p.len;
                SuccyRR_setCtx(c, (S0 + sl) / LT, S0 + sl, i, n);
                const col = SuccyRR_val(L.color, c, c.auto);
                ctx.strokeStyle = col;
                const wi = Math.max(0.1, Number(SuccyRR_val(L.width, c, 3)) || 3);
                ctx.lineWidth = wi;
                ctx.globalAlpha = baseA;
                if (L.alpha != null) ctx.globalAlpha = SuccyRR_clamp(Number(SuccyRR_val(L.alpha, c, 1)) || 0, 0, 1) * baseA;
                if (rawBlur > 0 && (i % HS === 0 || i === n - 1)) {
                    const i0 = Math.max(0, i - HS);
                    SuccyRR_glow(ctx, X, Y, i0, i, wi, rawBlur, Math.hypot(X[i] - X[i0], Y[i] - Y[i0]));
                    ctx.lineWidth = wi;
                }
                ctx.beginPath(); ctx.moveTo(X[i - 1], Y[i - 1]); ctx.lineTo(X[i], Y[i]); ctx.stroke();
            }
        }
    } finally { ctx.restore(); }
}

function SuccyRR_shape(ctx, shape, x, y, tx, ty, r) {
    const X = (lx, ly) => x + lx * tx - ly * ty, Y = (lx, ly) => y + lx * ty + ly * tx;
    ctx.beginPath();
    switch (shape) {
        case "square":
            ctx.moveTo(X(-r, -r), Y(-r, -r)); ctx.lineTo(X(r, -r), Y(r, -r));
            ctx.lineTo(X(r, r), Y(r, r)); ctx.lineTo(X(-r, r), Y(-r, r)); ctx.closePath();
            return "fill";
        case "diamond":
            ctx.moveTo(X(r * 1.3, 0), Y(r * 1.3, 0)); ctx.lineTo(X(0, r), Y(0, r));
            ctx.lineTo(X(-r * 1.3, 0), Y(-r * 1.3, 0)); ctx.lineTo(X(0, -r), Y(0, -r)); ctx.closePath();
            return "fill";
        case "star":
            for (let k = 0; k < 10; k++) {
                const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r * 1.25;
                const lx = Math.cos(a) * rr, ly = Math.sin(a) * rr;
                if (k) ctx.lineTo(X(lx, ly), Y(lx, ly)); else ctx.moveTo(X(lx, ly), Y(lx, ly));
            }
            ctx.closePath();
            return "fill";
        case "chevron":
            ctx.lineWidth = Math.max(0.8, r * 0.7);
            ctx.moveTo(X(-r, -r * 0.9), Y(-r, -r * 0.9)); ctx.lineTo(X(r * 0.5, 0), Y(r * 0.5, 0));
            ctx.lineTo(X(-r, r * 0.9), Y(-r, r * 0.9));
            return "stroke";
        case "dash":
            ctx.lineWidth = Math.max(0.8, r * 0.8);
            ctx.moveTo(X(-r * 1.4, 0), Y(-r * 1.4, 0)); ctx.lineTo(X(r * 1.4, 0), Y(r * 1.4, 0));
            return "stroke";
        default:
            ctx.arc(x, y, Math.max(0.2, r), 0, SUCCY_RR_TAU);
            return "fill";
    }
}

function SuccyRR_layerDots(ctx, L, c, p, scale, lq) {
    const S0 = c.S0 || 0, LT = c.LT > 0 ? c.LT : p.len;
    if (LT < 1) return;
    SuccyRR_setCtx(c, (S0 + p.len / 2) / LT, S0 + p.len / 2, 0, 1);
    let spacing, count, period;
    if (L.count != null) {
        count = Math.max(1, Math.min(120, Math.round(Number(SuccyRR_val(L.count, c, 8)) || 8)));
        spacing = LT / count; period = LT;
    } else {
        spacing = Math.max(4, Number(SuccyRR_val(L.spacing, c, 40)) || 40);
        count = Math.max(1, Math.min(120, Math.ceil(LT / spacing)));
        period = spacing * count;
    }
    const speed = Number(SuccyRR_val(L.speed, c, 60)) || 0;
    const trail = Number(SuccyRR_val(L.trail, c, 0)) || 0;
    const tSteps = Math.max(4, Math.min(80, Math.round(Number(SuccyRR_val(L.trailSteps, c, 8)) || 8)));
    const tTaper = SuccyRR_clamp(Number(SuccyRR_val(L.trailTaper, c, 1)), 0, 1);
    const tFade = SuccyRR_clamp(Number(SuccyRR_val(L.trailFade, c, 1)), 0, 1);
    const lead = Number(SuccyRR_val(L.lead, c, 0)) || 0;
    const dir = speed >= 0 ? 1 : -1;
    const reach = (trail > 0 && speed !== 0) ? trail : 0;
    const baseColor = SuccyRR_val(L.color, c, c.auto);
    const rawBlur = SuccyRR_layerBegin(ctx, L, c, baseColor, scale, lq);
    const headBlur = ctx.shadowBlur;
    if (count > 16) ctx.shadowBlur = 0;                          // too many points with blur => cost, so we drop it
    try {
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        // lateral shift at a local position sl (0..len of the current wire)
        const dsp = (sl) => {
            if (L.displace == null) return 0;
            SuccyRR_setCtx(c, (S0 + sl) / LT, S0 + sl, c.i, c.n);
            return Number(SuccyRR_val(L.displace, c, 0)) || 0;
        };
        for (let k = 0; k < count; k++) {
            const phase = (((k * spacing + c.t * speed + lead) % period) + period) % period;
            const sg = (dir < 0 && reach) ? phase - reach : phase;   // head, in coordinates of the WHOLE path
            const sl = sg - S0;                                      // ... and in coordinates of this wire
            const lo = Math.min(sl, sl - dir * reach), hi = Math.max(sl, sl - dir * reach);
            if (hi < 0 || lo > p.len) continue;                      // none of this snake on this wire
            const slc = SuccyRR_clamp(sl, 0, p.len);
            SuccyRR_setCtx(c, (S0 + slc) / LT, S0 + slc, k, count);
            const size = Math.max(0.2, Number(SuccyRR_val(L.size, c, 3)) || 3);
            const color = SuccyRR_val(L.color, c, c.auto);
            const shape = SuccyRR_val(L.shape, c, "circle");
            if (L.alpha != null) ctx.globalAlpha = SuccyRR_clamp(Number(SuccyRR_val(L.alpha, c, 1)) || 0, 0, 1) * (c.A ?? 1);
            const headA = ctx.globalAlpha;
            const bo = Number(SuccyRR_val(L.offset, c, 0)) || 0;
            const off = bo + dsp(slc);
            const q = SuccyRR_at(p, slc, SUCCY_RR_PT2);
            const hx = q.x - q.ty * off, hy = q.y + q.tx * off, tx = q.tx, ty = q.ty;
            ctx.fillStyle = color; ctx.strokeStyle = color;
            if (ctx.shadowBlur) ctx.shadowColor = color;
            if (reach > 0) {
                // the tail slides out/in "seamless": pieces off the wire stay in the node (clamp)
                const TRX = SUCCY_RR_TRX, TRY = SUCCY_RR_TRY, TRS = SUCCY_RR_TRS;
                const m = Math.min(tSteps, 90);
                for (let j = 0; j <= m; j++) {                   // each point of the tail computed ONCE only
                    const sj = SuccyRR_clamp(sl - dir * trail * (j / m), 0, p.len);
                    const qj = SuccyRR_at(p, sj, SUCCY_RR_PT3);
                    const oj = bo + dsp(sj);
                    TRX[j] = qj.x - qj.ty * oj; TRY[j] = qj.y + qj.tx * oj; TRS[j] = sj;
                }
                const shb = ctx.shadowBlur; ctx.shadowBlur = 0;  // no shadowBlur on the segments
                if (rawBlur > 0) {
                    const HS = 4;
                    for (let j0 = 1; j0 <= m; j0 += HS) {
                        const j1 = Math.min(m, j0 + HS - 1);
                        const len = Math.abs(TRS[j0 - 1] - TRS[j1]);
                        if (len < 0.5) continue;
                        const f = (j0 + j1 - 1) / 2 / m;
                        ctx.globalAlpha = headA * (1 - tFade * f) * 0.9;
                        SuccyRR_glow(ctx, TRX, TRY, j0 - 1, j1, Math.max(0.3, size * 2 * (1 - tTaper * f)), rawBlur, len);
                    }
                }
                for (let j = 1; j <= m; j++) {
                    if (Math.abs(TRS[j - 1] - TRS[j]) < 0.001) continue;
                    const f = (j - 0.5) / m;
                    ctx.globalAlpha = headA * (1 - tFade * f) * 0.9;
                    ctx.lineWidth = Math.max(0.3, size * 2 * (1 - tTaper * f));
                    ctx.beginPath(); ctx.moveTo(TRX[j - 1], TRY[j - 1]); ctx.lineTo(TRX[j], TRY[j]); ctx.stroke();
                }
                ctx.globalAlpha = headA;
                ctx.shadowBlur = shb;
            }
            if (sl >= 0 && sl <= p.len) {
                const mode = SuccyRR_shape(ctx, shape, hx, hy, tx, ty, size);
                if (mode === "stroke") ctx.stroke(); else ctx.fill();
            }
        }
    } finally { ctx.restore(); }
}

/* Throttle level 2 ("simple"): a single solid stroke with the color/width of the first stroke layer,
   evaluated ONCE at mid-wire. Cost ~ that of the native wire. Plain, but it still gets the job done. */
function SuccyRR_simple(ctx, effect, c, p) {
    const L = (effect.layers || []).find((x) => x && x.type === "stroke" && !x._rrErr);
    SuccyRR_setCtx(c, ((c.S0 || 0) + p.len / 2) / (c.LT || p.len || 1), (c.S0 || 0) + p.len / 2, 0, 1);
    let color = c.auto, width = 3;
    try { if (L) { color = SuccyRR_val(L.color, c, c.auto); width = Math.max(1, Math.min(8, Number(SuccyRR_val(L.width, c, 3)) || 3)); } } catch (_) {}
    ctx.save();
    try {
        ctx.globalAlpha = c.A ?? 1; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath(); ctx.moveTo(p.x[0], p.y[0]);
        for (let i = 1; i < p.n; i++) ctx.lineTo(p.x[i], p.y[i]);
        ctx.stroke();
    } finally { ctx.restore(); }
}

/* Draws all the layers of an effect on a wire a->b */
function SuccyRR_drawLinkLayers(ctx, effect, c, a, b, straight, scale, lq, onPath, dirs, cp) {
    const p = SuccyRR_buildPath(a, b, straight, dirs?.[0], dirs?.[1], cp);
    c.S0 = c.S0 || 0;                                    // this wire's offset along the whole path
    c.LT = c.LT > 0 ? c.LT : p.len;                      // total path length (L in the expressions)
    c.L = c.LT; c.pl = p.len;
    if ((c.Q || 0) >= 2) { SuccyRR_simple(ctx, effect, c, p); onPath?.(p); return p; }
    for (const L of effect.layers || []) {
        if (!L || L._rrErr) continue;
        try {
            if (L.type === "stroke") SuccyRR_layerStroke(ctx, L, c, p, scale, lq);
            else if (L.type === "dots") SuccyRR_layerDots(ctx, L, c, p, scale, lq);
        } catch (e) {
            L._rrErr = true;
            console.warn(`[Succy Reroute] layer error in '${effect.id}':`, e);
            SUCCY_RR_TEST.onError?.(e);
        }
    }
    onPath?.(p);
    return p;
}

/* ============================================================
 *  Dot skin (origin = dot center, unit = radius)
 * ============================================================ */
function SuccyRR_drawSkin(ctx, layers, c, R, scale, lq) {
    for (const L of layers || []) {
        if (!L || L._rrErr) continue;
        SuccyRR_setCtx(c, 0.5, 0, 0, 1);
        ctx.save();
        try {
            const color = SuccyRR_val(L.color, c, c.auto);
            const rad = R * (Number(SuccyRR_val(L.radius, c, 1)) || 0);
            const al = Number(SuccyRR_val(L.alpha, c, 1));
            ctx.globalAlpha = SuccyRR_clamp(Number.isFinite(al) ? al : 1, 0, 1) * (c.A ?? 1);
            const blur = lq ? 0 : Number(SuccyRR_val(L.blur, c, 0)) || 0;
            if (blur > 0) { ctx.shadowBlur = blur * scale; ctx.shadowColor = color; }
            const w = R * (Number(SuccyRR_val(L.width, c, 0.12)) || 0.12);
            switch (L.type) {
                case "disc":
                    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, Math.max(0.1, rad), 0, SUCCY_RR_TAU); ctx.fill();
                    break;
                case "ring":
                    ctx.strokeStyle = color; ctx.lineWidth = w;
                    if (Array.isArray(L.dash)) {
                        ctx.setLineDash(L.dash.map((v) => Math.max(0.05, R * (Number(SuccyRR_val(v, c, 0.3)) || 0.3))));
                        ctx.lineDashOffset = -R * (Number(SuccyRR_val(L.speed, c, 0)) || 0) * c.t;
                    }
                    ctx.beginPath(); ctx.arc(0, 0, Math.max(0.1, rad - w / 2), 0, SUCCY_RR_TAU); ctx.stroke();
                    break;
                case "glow": {
                    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(0.5, rad));
                    g.addColorStop(0, color); g.addColorStop(1, SuccyRR_alpha(color, 0));
                    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, Math.max(0.5, rad), 0, SUCCY_RR_TAU); ctx.fill();
                    break;
                }
                case "orbit": {
                    const cnt = Math.max(1, Math.round(Number(SuccyRR_val(L.count, c, 3)) || 3));
                    const sz = R * (Number(SuccyRR_val(L.size, c, 0.18)) || 0.18);
                    const sp = Number(SuccyRR_val(L.speed, c, 0.5)) || 0, ph = Number(SuccyRR_val(L.phase, c, 0)) || 0;
                    ctx.fillStyle = color;
                    for (let k = 0; k < cnt; k++) {
                        const ang = c.t * sp * SUCCY_RR_TAU + k * SUCCY_RR_TAU / cnt + ph;
                        ctx.beginPath(); ctx.arc(Math.cos(ang) * rad, Math.sin(ang) * rad, Math.max(0.2, sz), 0, SUCCY_RR_TAU); ctx.fill();
                    }
                    break;
                }
                case "pulse": {
                    const per = Math.max(0.1, Number(SuccyRR_val(L.period, c, 1.6)) || 1.6);
                    const ph = SuccyRR_fract(c.t / per);
                    const r = R * SuccyRR_mix(Number(SuccyRR_val(L.from, c, 1)) || 1, Number(SuccyRR_val(L.to, c, 2)) || 2, ph);
                    ctx.globalAlpha *= (1 - ph);
                    ctx.strokeStyle = color; ctx.lineWidth = w;
                    ctx.beginPath(); ctx.arc(0, 0, Math.max(0.1, r), 0, SUCCY_RR_TAU); ctx.stroke();
                    break;
                }
                case "spin": {
                    const cnt = Math.max(1, Math.round(Number(SuccyRR_val(L.count, c, 3)) || 3));
                    const span = SuccyRR_clamp(Number(SuccyRR_val(L.span, c, 0.5)) || 0.5, 0.02, 1);
                    const sp = Number(SuccyRR_val(L.speed, c, 0.5)) || 0;
                    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = "round";
                    for (let k = 0; k < cnt; k++) {
                        const a0 = c.t * sp * SUCCY_RR_TAU + k * SUCCY_RR_TAU / cnt;
                        ctx.beginPath(); ctx.arc(0, 0, Math.max(0.1, rad - w / 2), a0, a0 + SUCCY_RR_TAU / cnt * span); ctx.stroke();
                    }
                    break;
                }
            }
        } catch (e) {
            L._rrErr = true;
            console.warn("[Succy Reroute] skin layer error:", e);
            SUCCY_RR_TEST.onError?.(e);
        } finally { ctx.restore(); }
    }
}
export {
    SuccyRR_drawLinkLayers as drawLinkLayers, SuccyRR_drawSkin as drawSkin, 
    SUCCY_RR_EXPR_CACHE as EXPR_CACHE, SUCCY_RR_TAU as TAU, SUCCY_RR_AUTOFB as AUTOFB, SUCCY_RR_NOCOLOR as NOCOLOR,
};
