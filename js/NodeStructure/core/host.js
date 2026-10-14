// ============================================================
// NodeStructure/core/host.js
// ------------------------------------------------------------
// DOM host of a region (= a LiteGraph DOM widget).
//
//  light  : <div class="ns-host"><div class="ns-root">…</div></div>
//           global CSS injected once into <head>.
//  shadow : <div class="ns-host"> #shadow-root(open)
//               <style|adoptedStyleSheets/> <div class="ns-root">…</div>
//           Real isolation from Tailwind/Vue/other packs. What happens in the shadow stays in the shadow.
//
// DEFAULT: light. Shadow is implemented but OFF by default, because:
//  1. Selection/Range (contenteditable) inside a shadow root isn't
//     consistent across browsers (window.getSelection can't see inside on
//     Firefox/Safari): Succy_X and Multi_Math depend on it.
//  2. The kit's wheel-guard uses e.target.closest(...): with shadow
//     the target is retargeted to the host (see KIT_REQUESTS.md R1).
//     Here we make up for it with a wheel handler INSIDE the shadow root.
//  Enable it per node with  spec.shadow:true  (or globally:
//  NodeStructure.config.shadowDefault = true).
// ============================================================

import { ensureGlobalTheme, sharedSheet, THEME_CSS, applyTheme, extraCss } from "../theme/theme.js";

export const hostConfig = { shadowDefault: false };

export function createHost(rt, region, spec) {
    const wantShadow = spec.shadow === undefined ? hostConfig.shadowDefault : !!spec.shadow;
    const host = document.createElement("div");
    host.className = "ns-host";
    host.style.cssText = "width:100%;height:100%;min-width:0;box-sizing:border-box;";
    host.dataset.nsRegion = region.id;

    let root = document.createElement("div");
    const auto = !!(region.height && typeof region.height === "object" && region.height.auto);
    root.className = "ns-root" + (auto ? " ns-auto" : "");
    let mode = "light";

    if (wantShadow && typeof host.attachShadow === "function") {
        try {
            const sr = host.attachShadow({ mode: "open" });
            const sheet = sharedSheet();
            const extras = extraCss();
            if (sheet && "adoptedStyleSheets" in sr && extras.every((x) => x.sheet)) sr.adoptedStyleSheets = [sheet, ...extras.map((x) => x.sheet)];
            else { const st = document.createElement("style"); st.textContent = THEME_CSS + extras.map((x) => x.css).join("\n"); sr.appendChild(st); }
            sr.appendChild(root);
            // wheel INSIDE the shadow: the kit's global guard can't see the inner scrollables
            rt.bag.listen(sr, "wheel", (e) => {
                const t = e.target;
                const sc = t?.closest?.("[data-succy-scrollable]");
                if (sc && sc.scrollHeight > sc.clientHeight + 1) { sc.scrollTop += e.deltaY; e.preventDefault(); e.stopPropagation(); }
            }, { passive: false });
            mode = "shadow";
        } catch (e) {
            console.warn("[NodeStructure] attachShadow failed, falling back to light DOM:", e);
            host.appendChild(root);
        }
    } else {
        ensureGlobalTheme();
        host.appendChild(root);
    }
    host.dataset.nsMode = mode;
    applyTheme(root, { theme: spec.theme || "dark", tokens: spec.tokens });
    return { host, root, mode };
}
