// ============================================================
// SurvivalKit/persistence/graph-store.js
// ------------------------------------------------------------
// Persistent data for GRAPH OBJECTS that aren't nodes (e.g. native reroutes).
// They live in graph.extra.succy[ns][id] (pure JSON), so they travel with:
//   - workflow save (graph.extra is serialized, subgraphs included)
//   - undo/redo (every set() checkpoints the changeTracker, like node state)
//   - copy/paste, even across workflows: copied reroute data rides along in LiteGraph's
//     clipboard (_serializeItems) and gets remapped onto the NEW ids on paste (_deserializeItems)
// Heal: on every set(), entries for objects that no longer exist are removed.
// No permanent prototype patch: the wrapper is an own property of the canvas, put back if the
// canvas changes. v1.0.0 — 2026-10-12 (added for native reroutes, DECISIONS D-51)
// v1.1.0 — subgraph: convert/unpack via SubgraphShield, remapped by position (D-54)
// ============================================================

const ROOT = "succy";
const KINDS = {
    // does the object with this id still exist in the graph?
    reroute: (graph, id) => !!graph?.reroutes?.has?.(Number(id)),
};

const isReroute = (x) => !!x && typeof x === "object" && typeof x.linkIds?.has === "function" && !!x.pos && !("inputs" in x);
const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function jsonOnly(v, depth = 0) {
    if (depth > 6) return false;
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (Array.isArray(v)) return v.every((x) => jsonOnly(x, depth + 1));
    if (isPlain(v)) return Object.values(v).every((x) => jsonOnly(x, depth + 1));
    return false;
}

// Matches reroutes before/after (convert/unpack) by finding the common shift: same id+position, or
// all moved by the same vector (unpack shifts them by one offset). 1 px tolerance — we're not that strict.
export function matchByShape(oldL, newL) {
    const map = new Map();
    if (!oldL.length || !newL.length) return map;
    const near = (a, b) => Math.abs(a) <= 1 && Math.abs(b) <= 1;
    let best = null, bestN = -1;
    for (const n of newL) {
        const dx = n.x - oldL[0].x, dy = n.y - oldL[0].y;
        let c = 0;
        for (const o of oldL) if (newL.some((m) => near(m.x - o.x - dx, m.y - o.y - dy))) c++;
        if (c > bestN) { bestN = c; best = [dx, dy]; }
    }
    const used = new Set();
    for (const o of oldL) {
        const sameId = newL.find((m) => m.id === o.id && near(m.x - o.x - best[0], m.y - o.y - best[1]) && !used.has(m.id));
        const m = sameId || newL.find((q) => !used.has(q.id) && near(q.x - o.x - best[0], q.y - o.y - best[1]));
        if (m) { map.set(o.id, m.id); used.add(m.id); }
    }
    return map;
}

export class GraphStore {
    constructor({ perf } = {}) {
        this.perf = perf;
        this.kinds = new Map();          // ns -> kind
        this.subs = new Set();
        this._cv = null;
        this._wrap = null;
        this._tries = 0;
        this._timer = null;
        this.stats = { sets: 0, pruned: 0, copied: 0, pasted: 0, moved: 0, rejected: 0 };
    }

    // ns: container name (e.g. "reroutes"); kind: object type (only "reroute" for now)
    register(ns, { kind = "reroute" } = {}) {
        if (!ns || typeof ns !== "string") return false;
        if (!KINDS[kind]) { console.warn(`[SurvivalKit] graphStore: unknown kind '${kind}'`); return false; }
        this.kinds.set(ns, kind);
        this._ensureClipboard();
        return true;
    }

    _bucket(graph, ns, create) {
        let ex;
        try { ex = graph?.extra; } catch (_) { return null; }
        if (!ex || typeof ex !== "object") return null;
        let root = ex[ROOT];
        if (!isPlain(root)) { if (!create) return null; root = ex[ROOT] = {}; }
        let b = root[ns];
        if (!isPlain(b)) { if (!create) return null; b = root[ns] = {}; }
        return { ex, b };
    }

    get(graph, ns, id) {
        if (this._cv !== globalThis.app?.canvas) this._ensureClipboard();
        const r = this._bucket(graph, ns, false);
        const v = r?.b[String(id)];
        return isPlain(v) ? { ...v } : null;
    }

    all(graph, ns) {
        const r = this._bucket(graph, ns, false);
        return r ? JSON.parse(JSON.stringify(r.b)) : {};
    }

    // patch: object to merge (key with value undefined = deleted); null = delete the entry
    set(graph, ns, id, patch, { checkpoint = true } = {}) {
        if (!graph) return false;
        if (patch !== null && !isPlain(patch)) { this.stats.rejected++; return false; }
        const clean = {};
        if (patch) for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) { clean[k] = undefined; continue; }
            if (!jsonOnly(v)) { this.stats.rejected++; console.warn(`[SurvivalKit] graphStore: '${ns}.${id}.${k}' is not JSON, ignored`); continue; }
            clean[k] = v;
        }
        const r = this._bucket(graph, ns, true);
        if (!r) return false;
        const key = String(id);
        if (patch === null) delete r.b[key];
        else {
            const next = { ...(isPlain(r.b[key]) ? r.b[key] : {}) };
            for (const [k, v] of Object.entries(clean)) { if (v === undefined) delete next[k]; else next[k] = v; }
            if (Object.keys(next).length) r.b[key] = next; else delete r.b[key];
        }
        this._prune(graph, ns, r.b);
        try { graph.extra = r.ex; } catch (_) {}          // reassign: works even if the getter hands back a copy
        this.stats.sets++;
        if (checkpoint) { try { this.perf?.change?.scheduleGraph?.(graph); } catch (_) {} }
        for (const fn of this.subs) { try { fn(graph, ns, id); } catch (e) { console.warn("[SurvivalKit] graphStore subscriber:", e); } }
        return true;
    }

    _prune(graph, ns, b) {
        const exists = KINDS[this.kinds.get(ns)];
        if (!exists) return;
        for (const k of Object.keys(b)) if (!exists(graph, k)) { delete b[k]; this.stats.pruned++; }
    }

    subscribe(fn) {
        if (typeof fn !== "function") return () => {};
        this.subs.add(fn);
        return () => this.subs.delete(fn);
    }

    // ---- copy/paste: the data follows the reroutes into LiteGraph's clipboard ----
    _ensureClipboard() {
        const cv = globalThis.app?.canvas;
        if (!cv) {
            if (!this._timer && this._tries < 120) { this._timer = setTimeout(() => { this._timer = null; this._tries++; this._ensureClipboard(); }, 500); }
            return;
        }
        if (this._cv === cv && cv._serializeItems === this._wrap?.ser) return;
        if (typeof cv._serializeItems !== "function" || typeof cv._deserializeItems !== "function") { this._cv = cv; return; }
        const store = this;
        const ser0 = cv._serializeItems, de0 = cv._deserializeItems;
        const ser = function (...args) {
            const res = ser0.apply(this, args);
            try {
                const ids = Array.isArray(res?.reroutes) ? res.reroutes.map((r) => r?.id).filter((x) => x != null) : [];
                if (ids.length && store.kinds.size) {
                    const out = {};
                    for (const [ns, kind] of store.kinds) {
                        if (kind !== "reroute") continue;
                        const b = store._bucket(this.graph, ns, false)?.b;
                        if (!b) continue;
                        for (const id of ids) if (isPlain(b[String(id)])) (out[ns] ||= {})[String(id)] = { ...b[String(id)] };
                    }
                    if (Object.keys(out).length) { res.succyGraphStore = out; store.stats.copied++; }
                }
            } catch (e) { console.warn("[SurvivalKit] graphStore copy:", e); }
            return res;
        };
        const de = function (parsed, ...rest) {
            const res = de0.call(this, parsed, ...rest);
            try {
                const data = parsed?.succyGraphStore, map = res?.reroutes;
                if (data && map && typeof map.get === "function") {
                    for (const [ns, entries] of Object.entries(data)) {
                        if (!store.kinds.has(ns)) continue;
                        for (const [oldId, d] of Object.entries(entries || {})) {
                            const nr = map.get(Number(oldId)) ?? map.get(oldId);
                            if (nr?.id != null && isPlain(d)) { store.set(this.graph, ns, nr.id, d, { checkpoint: false }); store.stats.pasted++; }
                        }
                    }
                }
            } catch (e) { console.warn("[SurvivalKit] graphStore paste:", e); }
            return res;
        };
        cv._serializeItems = ser; cv._deserializeItems = de;
        this._cv = cv; this._wrap = { ser, de };
    }

    // ---- subgraph: convert (reroute ids stay) and unpack (new ids) — via SubgraphShield ----
    attachShield(shield) {
        if (!shield?.addHook || this._shieldOff) return;
        const store = this;
        const pick = (graph, list) => {
            const out = {};
            for (const [ns, kind] of store.kinds) {
                if (kind !== "reroute") continue;
                const b = store._bucket(graph, ns, false)?.b;
                if (!b) continue;
                for (const r of list) if (isPlain(b[String(r.id)])) (out[ns] ||= {})[String(r.id)] = { ...b[String(r.id)] };
            }
            return out;
        };
        const shape = (rs) => [...rs].filter((r) => r && r.id != null && r.pos).map((r) => ({ id: r.id, x: +r.pos[0], y: +r.pos[1] }));
        this._shieldOff = shield.addHook({
            before(name, graph, args) {
                if (!store.kinds.size) return null;
                if (name === "convertToSubgraph") {
                    const items = args[0];
                    const list = shape([...(items || [])].filter(isReroute));
                    const data = pick(graph, list);
                    return Object.keys(data).length ? { list, data, src: graph } : null;
                }
                if (name === "unpackSubgraph") {
                    const sub = args[0]?.subgraph;
                    if (!sub?.reroutes) return null;
                    const list = shape(sub.reroutes.values());
                    const data = pick(sub, list);
                    return Object.keys(data).length ? { list, data, before: new Set(graph.reroutes?.keys?.() ?? []) } : null;
                }
                return null;
            },
            after(name, graph, args, res, tok) {
                if (!tok) return;
                const target = name === "convertToSubgraph" ? res?.subgraph : graph;
                if (!target?.reroutes) return;
                const fresh = shape([...target.reroutes.values()].filter((r) => !tok.before || !tok.before.has(r.id)));
                const map = matchByShape(tok.list, fresh);
                for (const [ns, entries] of Object.entries(tok.data)) {
                    for (const [oldId, d] of Object.entries(entries)) {
                        const nid = map.get(Number(oldId));
                        if (nid == null) continue;
                        store.set(target, ns, nid, d, { checkpoint: false });
                        store.stats.moved = (store.stats.moved || 0) + 1;
                    }
                    if (tok.src) for (const oldId of Object.keys(entries)) store.set(tok.src, ns, oldId, null, { checkpoint: false });
                }
            },
        });
    }

    info() { return { namespaces: Object.fromEntries(this.kinds), clipboard: !!this._wrap && this._cv?._serializeItems === this._wrap.ser, ...this.stats }; }
}
