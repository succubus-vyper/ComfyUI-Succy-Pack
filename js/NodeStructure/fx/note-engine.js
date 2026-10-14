// ============================================================
// NodeStructure/fx/note-engine.js — engine for the note_box ANIMATED BACKGROUNDS (canvas)
// ------------------------------------------------------------
// EXTRACTED VERBATIM from Succy_Label.js v5 (class SuccyFxInterpreter), now PART OF THE KIT.
// Only change: run() receives the effect object (not the id) -> the engine doesn't know where
// the effects come from (fx/note-store.js loads them from the node's folder, glue config). Mystery is part of the charm.
//
// WARNING (D-12, like fx/engine.js): uses `new Function` for the expressions in the effects
// JSON. LEGACY code quarantined here; the JSONs are local pack files, not user input.
// ============================================================
export class NoteFx {
    constructor() {
        this.stateCache = new Map();
        this._evalCache = new Map();
        this._fnCache = {};
        this._fnCacheKey = null;
    }

    run(eff, ctx, { w, h, t, dt, colors, speed, scopeKey }) {
        if (!eff || !eff.frame) return false;
        const effectId = eff.id;

        const fns = eff.functions || {};
        const fnKey = Object.keys(fns).sort().join(",");
        if (this._fnCacheKey !== fnKey) {
            this._fnCache = {};
            this._evalCache.clear();
            this._fnCacheKey = fnKey;
        }
        for (const [name, src] of Object.entries(fns)) {
            if (this._fnCache[name] === undefined) {
                try {
                    this._fnCache[name] = new Function(`"use strict"; return (${src});`)();
                } catch (e) {
                    console.warn("[Succy FX] compile fn error:", name, e.message);
                    this._fnCache[name] = () => 0;
                }
            }
        }

        const stateKey = `${effectId}::${scopeKey}`;
        let state = this.stateCache.get(stateKey);
        const wChanged = state && (
            Math.abs((state.__w || 0) - w) > 2 ||
            Math.abs((state.__h || 0) - h) > 2
        );
        if (!state || (wChanged && eff.reinitOnResize === true)) {
            state = {};
            if (eff.state) {
                for (const [name, def] of Object.entries(eff.state)) {
                    state[name] = this._initState(def, { w, h, colors, speed });
                }
            }
            state.__w = w;
            state.__h = h;
            this.stateCache.set(stateKey, state);
        }

        const env = this._makeEnv({ w, h, t, dt, colors, speed, state });
        for (const [name, fn] of Object.entries(this._fnCache)) env[name] = fn;

        for (const cmd of eff.frame) this._exec(cmd, ctx, env);
        return true;
    }

    _initState(def, { w, h, colors, speed }) {
        if (!def || typeof def !== "object") return def;

        if (def.op === "initArray") {
            const arr = [];
            const env = this._makeEnv({ w, h, t: 0, dt: 0, colors, speed, state: {} });
            for (let i = 0; i < (def.count | 0); i++) {
                const item = {};
                env.i = i;
                for (const [k, expr] of Object.entries(def.each || {})) {
                    item[k] = this._eval(expr, env);
                }
                arr.push(item);
            }
            return arr;
        }

        if (def.op === "initList") {
            const arr = [];
            const env = this._makeEnv({ w, h, t: 0, dt: 0, colors, speed, state: {} });
            const vals = def.values || [];
            for (let i = 0; i < vals.length; i++) {
                env.i = i;
                arr.push(this._eval(vals[i], env));
            }
            return arr;
        }

        return def;
    }

    _makeEnv(base) {
        return {
            w: base.w, h: base.h, t: base.t, dt: base.dt,
            colors: base.colors || ["#000000","#888888","#ffffff"],
            speed: base.speed || 5,
            state: base.state || {},
            i: 0,
            PI: Math.PI,
            sin: Math.sin, cos: Math.cos, tan: Math.tan,
            random: Math.random,
            min: Math.min, max: Math.max, abs: Math.abs,
            floor: Math.floor, ceil: Math.ceil, round: Math.round,
            sqrt: Math.sqrt, hypot: Math.hypot,
            toRgba: (hex) => {
                const h = String(hex || "#000000").replace("#", "");
                const r = parseInt(h.substring(0, 2), 16) || 0;
                const g = parseInt(h.substring(2, 4), 16) || 0;
                const b = parseInt(h.substring(4, 6), 16) || 0;
                const a = h.length === 8 ? parseInt(h.substring(6, 8), 16) / 255 : 1;
                return `rgba(${r},${g},${b},${a})`;
            },
            darken: (hex, amount = 0.09) => {
                const h = String(hex || "#000000").replace("#", "");
                const r = parseInt(h.substring(0, 2), 16) || 0;
                const g = parseInt(h.substring(2, 4), 16) || 0;
                const b = parseInt(h.substring(4, 6), 16) || 0;
                const a = h.length === 8 ? parseInt(h.substring(6, 8), 16) / 255 : 1;
                return `rgba(${Math.round(r*amount)},${Math.round(g*amount)},${Math.round(b*amount)},${a})`;
            },
            lighten: (hex, amount = 0.5) => {
                const h = String(hex || "#000000").replace("#", "");
                const r = parseInt(h.substring(0, 2), 16) || 0;
                const g = parseInt(h.substring(2, 4), 16) || 0;
                const b = parseInt(h.substring(4, 6), 16) || 0;
                const a = h.length === 8 ? parseInt(h.substring(6, 8), 16) / 255 : 1;
                const m = (c) => Math.round(c + (255 - c) * amount);
                return `rgba(${m(r)},${m(g)},${m(b)},${a})`;
            },
            mixColor: (a, b, t) => {
                const pa = String(a || "#000000").replace("#", "");
                const pb = String(b || "#ffffff").replace("#", "");
                const r = Math.round((parseInt(pa.substring(0,2),16)||0) * (1-t) + (parseInt(pb.substring(0,2),16)||0) * t);
                const g = Math.round((parseInt(pa.substring(2,4),16)||0) * (1-t) + (parseInt(pb.substring(2,4),16)||0) * t);
                const bl = Math.round((parseInt(pa.substring(4,6),16)||0) * (1-t) + (parseInt(pb.substring(4,6),16)||0) * t);
                return `rgb(${r},${g},${bl})`;
            },
        };
    }


    _eval(expr, env) {
        if (typeof expr !== "string") return expr;
        const trimmed = expr.trim();

        if (trimmed.startsWith("#") ||
            trimmed.startsWith("rgba(") ||
            trimmed.startsWith("rgb(") ||
            trimmed.startsWith("hsla(") ||
            trimmed.startsWith("hsl(") ||
            (/^[a-z][a-z0-9 -]*$/.test(trimmed) &&
             !Object.prototype.hasOwnProperty.call(env, trimmed))) {
            return trimmed;
        }

        let fn = this._evalCache.get(expr);
        if (!fn) {
            try {
                const keys = Object.keys(env);
                fn = Function(...keys, `"use strict"; return (${expr});`);
                fn.__keys = keys;
                this._evalCache.set(expr, fn);
            } catch (e) {
                console.warn("[Succy FX] compile error:", expr, e.message);
                this._evalCache.set(expr, null);
                return expr;
            }
        }
        if (fn === null) return expr;

        try {
            const vals = fn.__keys.map(k => env[k]);
            return fn(...vals);
        } catch (e) {
            console.warn("[Succy FX] runtime error:", expr, e.message);
            return 0;
        }
    }

    _exec(cmd, ctx, env) {
        if (!cmd || !cmd.op) return;
        const E = (v) => this._eval(v, env);

        switch (cmd.op) {
            case "clear":
                ctx.clearRect(0, 0, env.w, env.h);
                if (cmd.color) { ctx.fillStyle = E(cmd.color); ctx.fillRect(0, 0, env.w, env.h); }
                break;
            case "fill":
                ctx.fillStyle = E(cmd.color); ctx.fillRect(0, 0, env.w, env.h);
                break;
            case "rect":
                ctx.beginPath(); ctx.rect(E(cmd.x), E(cmd.y), E(cmd.w), E(cmd.h));
                if (cmd.fill)   { ctx.fillStyle   = E(cmd.fill);   ctx.fill(); }
                if (cmd.stroke) { ctx.strokeStyle = E(cmd.stroke); ctx.stroke(); }
                if (!cmd.fill && !cmd.stroke) ctx.fill();
                break;
            case "circle":
                ctx.beginPath(); ctx.arc(E(cmd.cx), E(cmd.cy), E(cmd.r), 0, Math.PI*2);
                if (cmd.fill)   { ctx.fillStyle   = E(cmd.fill);   ctx.fill(); }
                if (cmd.stroke) { ctx.strokeStyle = E(cmd.stroke); ctx.stroke(); }
                if (!cmd.fill && !cmd.stroke) ctx.fill();
                break;
            case "arc":
                ctx.beginPath(); ctx.arc(E(cmd.cx), E(cmd.cy), E(cmd.r), E(cmd.a0 ?? 0), E(cmd.a1 ?? Math.PI*2));
                if (cmd.fill)   { ctx.fillStyle   = E(cmd.fill);   ctx.fill(); }
                if (cmd.stroke) { ctx.strokeStyle = E(cmd.stroke); ctx.stroke(); }
                break;

            case "ellipse":
                ctx.beginPath();
                ctx.ellipse(
                    E(cmd.cx), E(cmd.cy),
                    E(cmd.rx), E(cmd.ry),
                    E(cmd.rotation ?? 0),
                    E(cmd.a0 ?? 0), E(cmd.a1 ?? Math.PI * 2)
                );
                if (cmd.fill)   { ctx.fillStyle   = E(cmd.fill);   ctx.fill(); }
                if (cmd.stroke) { ctx.strokeStyle = E(cmd.stroke); ctx.stroke(); }
                break;

            case "line":
                ctx.beginPath();
                ctx.moveTo(E(cmd.x1), E(cmd.y1));
                ctx.lineTo(E(cmd.x2), E(cmd.y2));
                ctx.strokeStyle = E(cmd.stroke || "#fff");
                ctx.lineWidth = E(cmd.lineWidth || 1);
                ctx.stroke();
                break;
            case "path":
                if (typeof cmd.d === "string") {
                    const p = new Path2D(cmd.d);
                    if (cmd.fill)   { ctx.fillStyle   = E(cmd.fill);   ctx.fill(p); }
                    if (cmd.stroke) { ctx.strokeStyle = E(cmd.stroke); ctx.lineWidth = E(cmd.lineWidth || 1); ctx.stroke(p); }
                }
                break;

            case "polyline": {
                const pts = [];
                if (Array.isArray(cmd.points)) {
                    for (const p of cmd.points) pts.push({ x: E(p.x), y: E(p.y) });
                } else if (cmd.count !== undefined && cmd.each) {
                    const n = E(cmd.count) | 0;
                    const prevI = env.i;
                    for (let k = 0; k < n; k++) {
                        env.i = k;
                        pts.push({ x: E(cmd.each.x), y: E(cmd.each.y) });
                    }
                    env.i = prevI;
                }
                if (!pts.length) break;
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
                if (cmd.close) ctx.closePath();
                if (cmd.stroke) {
                    ctx.strokeStyle = E(cmd.stroke);
                    if (cmd.lineWidth !== undefined) ctx.lineWidth = E(cmd.lineWidth);
                    if (cmd.shadow) { ctx.shadowColor = E(cmd.shadow); ctx.shadowBlur = E(cmd.shadowBlur || 8); }
                    ctx.stroke();
                    ctx.shadowBlur = 0;
                }
                if (!cmd.fill && !cmd.stroke && !Array.isArray(cmd.fillGradientStops) && cmd.close) {
                    ctx.fill();
                } else if (cmd.fill) {
                    ctx.fillStyle = E(cmd.fill);
                    ctx.fill();
                } else if (Array.isArray(cmd.fillGradientStops) && cmd.fillGradientStops.length) {
                    let y1, y2;
                    if (cmd.fillGradientY1 !== undefined && cmd.fillGradientY2 !== undefined) {
                        y1 = E(cmd.fillGradientY1);
                        y2 = E(cmd.fillGradientY2);
                    } else {
                        let minY = Infinity, maxY = -Infinity;
                        for (const p of pts) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
                        if (!isFinite(minY)) { minY = 0; maxY = 1; }
                        if (minY === maxY) maxY = minY + 1;
                        y1 = minY; y2 = maxY;
                    }
                    if (y1 === y2) y2 = y1 + 1;
                    const g = ctx.createLinearGradient(0, y1, 0, y2);
                    for (const s of cmd.fillGradientStops) g.addColorStop(E(s.at), E(s.color));
                    ctx.fillStyle = g;
                    ctx.fill();
                }
                break;
            }

            case "clipRect":
                ctx.beginPath();
                ctx.rect(E(cmd.x), E(cmd.y), E(cmd.w), E(cmd.h));
                ctx.clip();
                break;

            case "text":
                ctx.font = `${E(cmd.size || 16)}px ${E(cmd.font || "monospace")}`;
                ctx.textBaseline = E(cmd.baseline || "top");
                ctx.textAlign = E(cmd.align || "left");
                if (cmd.fill)   { ctx.fillStyle   = E(cmd.fill);   ctx.fillText(String(E(cmd.value)), E(cmd.x), E(cmd.y)); }
                if (cmd.stroke) { ctx.strokeStyle = E(cmd.stroke); ctx.strokeText(String(E(cmd.value)), E(cmd.x), E(cmd.y)); }
                break;

            case "gradientLinear": {
                const g = ctx.createLinearGradient(E(cmd.x1), E(cmd.y1), E(cmd.x2), E(cmd.y2));
                for (const s of (cmd.stops || [])) g.addColorStop(E(s.at), E(s.color));
                ctx.fillStyle = g;
                break;
            }
            case "gradientRadial": {
                const g = ctx.createRadialGradient(E(cmd.cx), E(cmd.cy), 0, E(cmd.cx), E(cmd.cy), E(cmd.r));
                for (const s of (cmd.stops || [])) g.addColorStop(E(s.at), E(s.color));
                ctx.fillStyle = g;
                break;
            }
            case "alpha":      ctx.globalAlpha = E(cmd.value); break;
            case "composite":  ctx.globalCompositeOperation = E(cmd.value); break;
            case "shadow":     ctx.shadowBlur = E(cmd.blur || 0); ctx.shadowColor = E(cmd.color || "transparent"); break;
            case "lineWidth":  ctx.lineWidth = E(cmd.value); break;
            case "lineCap":    ctx.lineCap = E(cmd.value); break;
            case "dash":       ctx.setLineDash(Array.isArray(cmd.pattern) ? cmd.pattern.map(v => E(v)) : []); break;

            case "save":       ctx.save(); break;
            case "restore":    ctx.restore(); break;
            case "translate":  ctx.translate(E(cmd.x), E(cmd.y)); break;
            case "rotate":     ctx.rotate(E(cmd.angle)); break;
            case "scale":      ctx.scale(E(cmd.x), E(cmd.y)); break;

            case "loop": {
                const n = E(cmd.count) | 0;
                const key = cmd.as;
                const prevI = env.i;
                const prevVal = key ? env[key] : undefined;
                for (let k = 0; k < n; k++) {
                    env.i = k;
                    if (key) env[key] = k;
                    for (const sub of (cmd.body || [])) this._exec(sub, ctx, env);
                }
                env.i = prevI;
                if (key) {
                    if (prevVal === undefined) delete env[key]; else env[key] = prevVal;
                }
                break;
            }
            case "loopOver": {
                const arr = env.state[cmd.source] || [];
                const key = cmd.as;
                const prevVal = key ? env[key] : undefined;
                for (let k = 0; k < arr.length; k++) {
                    env[key] = arr[k];
                    env.i = k;
                    for (const sub of (cmd.body || [])) this._exec(sub, ctx, env);
                }
                if (key) {
                    if (prevVal === undefined) delete env[key]; else env[key] = prevVal;
                }
                break;
            }
            case "if": {
                const branch = E(cmd.cond) ? cmd.then : cmd.else;
                for (const sub of (branch || [])) this._exec(sub, ctx, env);
                break;
            }
            case "set": {
                const target = cmd.target;
                const value = E(cmd.value);
                if (target.startsWith("state.")) {
                    env.state[target.slice(6)] = value;
                } else if (target.includes(".")) {
                    const [vn, prop] = target.split(".");
                    if (env[vn]) env[vn][prop] = value;
                }
                break;
            }

            case "setItem": {
                const arr = env.state[cmd.list];
                if (!Array.isArray(arr)) break;
                const idx = E(cmd.index) | 0;
                const val = E(cmd.value);
                if (cmd.prop) {
                    if (arr[idx] && typeof arr[idx] === "object") arr[idx][cmd.prop] = val;
                } else {
                    arr[idx] = val;
                }
                break;
            }

            default:
                console.warn("[Succy FX] unknown op:", cmd.op);
        }
    }

    // per-instance state: released when the note_box is unmounted
    forget(scopeKey) {
        const suf = "::" + scopeKey;
        for (const k of [...this.stateCache.keys()]) if (k.endsWith(suf)) this.stateCache.delete(k);
    }
}
