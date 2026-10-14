// ============================================================
// SurvivalKit/persistence/local.js
// ------------------------------------------------------------
// Per-node localStorage. Key succy:wf:<wid>:nid:<id>:<key>.
// Survives a full reload, never touches the workflow, zero undo. What happens here stays here.
//
// <wid> = id of the active workflow. Taken, in order, from:
//   app.workflowManager.activeWorkflow.{path|id|key}
//   app.extensionManager.workflow.activeWorkflow.{path|id|key}
//   app.workflow.activeWorkflow.{path|id|key}
// Fallback: session id in sessionStorage (survives a reload
// of the same tab, dies when the tab closes).
//
// KNOWN LIMIT: the key uses node.id, not nodeKey (gid is volatile
// across reloads). Two nodes with the same id in different graphs
// (root + subgraph) share the same key. Acceptable
// as long as Succy_X is used top-level; to revisit if subgraphs
// become a primary use case for ctx.local.
// v0.1.1 — 2026-10-10
// ============================================================

let _fallbackWid = null;

function _workflowId() {
    const wf = globalThis.app?.workflowManager?.activeWorkflow
            ?? globalThis.app?.extensionManager?.workflow?.activeWorkflow
            ?? globalThis.app?.workflow?.activeWorkflow;
    if (wf) {
        const id = wf.path ?? wf.id ?? wf.key;
        if (id) return String(id);
    }
    if (_fallbackWid === null) {
        try {
            _fallbackWid = sessionStorage.getItem("succy:wf-fallback");
            if (!_fallbackWid) {
                _fallbackWid = "sess-" + Math.random().toString(36).slice(2, 10);
                sessionStorage.setItem("succy:wf-fallback", _fallbackWid);
            }
        } catch (_) {
            _fallbackWid = "anon";
        }
    }
    return _fallbackWid;
}

function buildKey(node, key) {
    return `succy:wf:${_workflowId()}:nid:${node.id}:${key}`;
}

export const Local = {
    get(node, key, def) {
        try {
            const v = localStorage.getItem(buildKey(node, key));
            return v === null ? def : JSON.parse(v);
        } catch (_) { return def; }
    },

    set(node, key, value) {
        try {
            localStorage.setItem(buildKey(node, key), JSON.stringify(value));
            return true;
        } catch (_) { return false; }
    },

    delete(node, key) {
        try { localStorage.removeItem(buildKey(node, key)); } catch (_) {}
    },
};