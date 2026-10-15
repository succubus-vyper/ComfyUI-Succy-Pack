// ============================================================
// Succy_RerouteCarry.js — a graph extension (not a node): native reroutes that sit on a wire BETWEEN two selected nodes travel with them.
// Before: Ctrl+C / Ctrl+V, Duplicate and "Convert to Subgraph" copied the nodes and the wire but left the reroute at home (it only came along if
// you selected it too). Now the reroutes on internal wires join the selection, the whole chain of them, right at the two doors the frontend uses:
//   LGraphCanvas._serializeItems(items)   <- copy, paste, duplicate        LGraph.convertToSubgraph(items) <- subgraph
// Wires that leave the selection keep the old behaviour (that reroute is not ours to take). Any surprise = the original runs untouched.
// Succubus was here — take your toys with you when you go, darling.
// ============================================================
import { app } from "../../scripts/app.js";

const isNode = (it) => !!it && Array.isArray(it.inputs) && typeof it.type === "string";
const isReroute = (it) => !!it && it.linkIds !== undefined && "parentId" in it;
const values = (m) => (typeof m?.values === "function" ? [...m.values()] : Object.values(m || {}));
const getR = (g, id) => g?.reroutes?.get?.(id) ?? g?.reroutes?.[id] ?? null;

// reroutes on wires whose two ends are both in `items`, plus their parents up the chain; only the ones not already in `items`
export function carriedReroutes(graph, items) {
    const list = [...(items || [])];
    const nodes = new Set(list.filter(isNode).map((n) => n.id));
    if (nodes.size < 2 || !graph) return [];
    const have = new Set(list.filter(isReroute).map((r) => r.id));
    const out = [];
    for (const l of values(graph.links)) {
        if (!l || l.parentId == null || !nodes.has(l.origin_id) || !nodes.has(l.target_id)) continue;
        for (let r = getR(graph, l.parentId), guard = 0; r && !have.has(r.id) && guard < 256; guard++) {
            have.add(r.id); out.push(r);
            r = r.parentId != null ? getR(graph, r.parentId) : null;
        }
    }
    return out;
}

// wrap `name` on whichever prototype in the chain really owns it; `pick(args, self)` -> [index of the items argument, graph]
function wrap(start, name, itemsOf, graphOf, rebuild) {
    let owner = start;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
    const orig = owner?.[name];
    if (typeof orig !== "function" || orig.__succyCarry) return false;
    const patched = function (...args) {
        try {
            const items = itemsOf(this, args);
            const extra = carriedReroutes(graphOf(this), items);
            if (extra.length) return orig.apply(this, rebuild(args, [...items, ...extra]));
        } catch (e) { console.warn("[Succy RerouteCarry] fell back to the original:", e); }
        return orig.apply(this, args);
    };
    patched.__succyCarry = true;
    owner[name] = patched;
    return true;
}

app.registerExtension({
    name: "SuccyPack.RerouteCarry",
    setup() {
        const cv = app.canvas, g = app.graph;
        const a = cv && wrap(Object.getPrototypeOf(cv), "_serializeItems",
            (self, args) => [...(args[0] ?? self.selectedItems ?? [])], (self) => self.graph ?? self._graph,
            (args, items) => [items, ...args.slice(1)]);
        const b = g && wrap(Object.getPrototypeOf(g), "convertToSubgraph",
            (self, args) => [...(args[0] ?? [])], (self) => self,
            (args, items) => [new Set(items), ...args.slice(1)]);
        console.log("SUCCY_REROUTECARRY " + JSON.stringify({ serialize: !!a, subgraph: !!b }));
    },
});
