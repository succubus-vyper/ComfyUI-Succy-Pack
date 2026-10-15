// ============================================================
// NodeStructure/runtime/shot-feed.js — ONE listener for "the picture a node is looking at right now" (Crop phase 2, D-105)
// The Python side saves a downscaled preview in ComfyUI's temp folder and sends { node_id, filename, subfolder, type, width, height, v }
// (event `succy-crop-image`). This feed keeps the latest per node id and hands it to view_box as { src, width, height }.
// width/height are the ORIGINAL size (the preview may be smaller): the selection always lives in original pixels.
//   subscribe(fn) -> off      get(node) -> { src, width, height } | null      put(node, {src,width,height})      clear()
// Succubus was here — she keeps one eye on the picture while the other is busy.
// ============================================================

const EVENT = "succy-crop-image";
const subs = new Set();
const last = new Map();          // display id -> { src, width, height, v }
let wired = false;

const A = () => globalThis.app?.api;

function publish() {
    for (const fn of [...subs]) { try { fn(); } catch (e) { console.warn("[NodeStructure] shot-feed subscriber:", e); } }
}

function wire() {
    if (wired || !A()) return;
    wired = true;
    A().addEventListener(EVENT, (e) => {
        const d = e?.detail;
        if (!d || d.node_id == null || !d.filename) return;
        const q = new URLSearchParams({ filename: d.filename, type: d.type || "temp", subfolder: d.subfolder || "", rand: String(d.v || Date.now()) });
        last.set(String(d.node_id), { src: A().apiURL("/view?" + q.toString()), width: Number(d.width) || 0, height: Number(d.height) || 0, v: d.v });
        publish();
    });
}

// the id the backend speaks: `5:3` = node 3 inside subgraph node 5; plain id otherwise
function execId(node) {
    const g = node?.graph, root = globalThis.app?.graph?.rootGraph || globalThis.app?.graph;
    if (!g || g === root) return String(node?.id);
    const holder = (root?._nodes || []).find((n) => n.subgraph === g);
    return holder ? `${execId(holder)}:${node.id}` : String(node?.id);
}

export const ShotFeed = {
    subscribe(fn) { wire(); subs.add(fn); return () => subs.delete(fn); },
    get(node) {
        wire();
        if (!node || node.id == null) return null;
        return last.get(execId(node)) || null;
    },
    // a picture the node got WITHOUT a run (dropped / pasted / loaded, D-106): shown at once, replaced by the next real run
    // `raw` = the file as it is on disk: a node with a WORKSPACE size (D-120) shows it scaled like its Python will, see shot_system
    put(node, { src, width = 0, height = 0 } = {}) {
        if (!node || node.id == null || !src) return;
        last.set(execId(node), { src, width: Number(width) || 0, height: Number(height) || 0, v: Date.now(), raw: true });
        publish();
    },
    clear() { last.clear(); publish(); },
    stats() { return { wired, nodes: last.size, subs: subs.size, ids: [...last.keys()] }; },
};
