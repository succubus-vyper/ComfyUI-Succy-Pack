// ============================================================
// NodeStructure/core/env.js
// ------------------------------------------------------------
// Environment detection (Vue Nodes 2.0 / frontend version).
// NOT verified live: everything in try/catch, never blocking.
// The builder doesn't change course based on this: it only uses it to
// (a) declare heights with BOTH APIs (legacy computeSize and
//     computeLayoutSize, see heights.js) and (b) expose it to the nodes.
// ============================================================

function settingGet(id) {
    try { return globalThis.app?.extensionManager?.setting?.get?.(id); } catch (_) { return undefined; }
}

export const envInfo = {
    vueNodes() {
        const v = settingGet("Comfy.VueNodes.Enabled");
        if (typeof v === "boolean") return v;
        try { return !!document.querySelector("[data-node-id], .lg-node-widgets, [data-testid='node']"); } catch (_) { return false; }
    },
    version() {
        try { return globalThis.SurvivalKit?.compat?.getComfyVersion?.() || ""; } catch (_) { return ""; }
    },
};
