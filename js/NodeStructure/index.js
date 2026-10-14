// ============================================================
// NodeStructure/index.js  —  public API
// ------------------------------------------------------------
//   import { NodeStructure } from "./NodeStructure/index.js";
//   NodeStructure.define("Succy_X", { spec, actions, live, state, natives, hooks });
//
// The kit (SurvivalKit) must be imported FIRST (it sets globalThis.SurvivalKit) — foreplay before the main act:
//   import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
//
// NodeStructure v0.1.0 — PHASE 2, first draft. The kit is left untouched.
// ============================================================

import "./components/layout.js";
import "./components/controls.js";
import "./components/media.js";
import "./components/progress.js";
import "./behaviors/builtin.js";
import "./pieces/panes.js";
import "./pieces/actions.js";
import "./pieces/composite.js";
import "./pieces/fx.js";
import "./pieces/runtime.js";
import "./pieces/note.js";
import "./pieces/wire.js";
import { Chips } from "./pieces/chip.js";
import { Tip } from "./menu/tip.js";
import { Ports } from "./pieces/ports.js";
import { Ext } from "./pieces/node.js";
import { Tables } from "./pieces/table.js";

import { define, DEFS } from "./core/define.js";
import { normalizeSpec, checkRefs, parseRef, SPEC_VERSION } from "./core/parser.js";
import * as Catalog from "./catalog/registry.js";
import * as Grammar from "./catalog/grammar.js";
import { FloatMenu } from "./menu/float-menu.js";
import { AnimGate, animConfig } from "./runtime/anim-gate.js";
import { hostConfig } from "./core/host.js";
import { INSTANCES, runtimeStats, liveRuntimes } from "./core/runtime.js";
import { THEME_CSS, TOKENS_DARK, registerCss as _registerCss, setMenuPalette, getMenuPalette, MENU_PALETTES, setNodePalette, getNodePalette, NODE_COLOR_ROLES } from "./theme/theme.js";
import { Bag } from "./util/tracker.js";
import { wiresStats } from "./fx/overlay.js";
import { NATIVE, nativeActive, dump as dumpNative, info as infoNative } from "./fx/native.js";
import { extend, EXTS } from "./core/extend.js";
import { Governor } from "../Governor/governor.js";
import { deepClone, deepEqual, propertyViolations, findNonJson } from "./util/json.js";

export const VERSION = "0.3.0";

// CSS outside the kit = drift (nodes have no CSS): it still gets registered but stays on record
const LATE_CSS = [];
const registerCss = (id, css) => { if (Catalog.isSealed()) { LATE_CSS.push(String(id)); console.warn(`[NodeStructure] registerCss('${id}') after seal(): styles belong in a catalog piece`); } return _registerCss(id, css); };

export const NodeStructure = {
    version: VERSION,
    specVersion: SPEC_VERSION,

    define,
    extend,                                 // graph extensions (not nodes): config + spec.behaviors only (D-44)
    extensions: EXTS,
    piece: Catalog.piece,                   // registering a piece: ONLY inside the kit (after seal() it's drift)
    registerComponent: Catalog.piece,       // historic alias: now it wants a card
    registerBehavior: Catalog.piece,

    // validation without registering anything (handy in the console and in tests) — look, don't touch
    validateSpec(spec, def = null) {
        const r = normalizeSpec(spec, {});
        const errors = [...r.errors];
        if (r.spec && def) errors.push(...checkRefs(r.refs, def));
        return { ok: errors.length === 0, errors, warnings: r.warnings, spec: r.spec };
    },

    FloatMenu,
    anim: { setMode: AnimGate.setMode, getMode: AnimGate.getMode, modes: AnimGate.modes, stats: AnimGate.stats, config: animConfig },
    config: hostConfig,                       // { shadowDefault:false }
    // menu v2 (D-57): --nsm-* token palette. The future pack menu will call setMenuPalette(name | {token: value}).
    theme: { css: THEME_CSS, tokens: TOKENS_DARK, setMenuPalette, getMenuPalette, menuPalettes: MENU_PALETTES,
        setNodePalette, getNodePalette, nodeColorRoles: NODE_COLOR_ROLES },     // D-58: palette for the node UIs (Preview, X...)
    registerCss,                               // the node's own CSS (light + shadow)

    // Effects throttle (D-49): NodeStructure.fx.hold("llm") / .release("llm") · .setMode("auto"|0..3) · .stats()
    fx: Governor,

    // Native reroutes (D-43): global switch + diagnostics. The drawing is done by the paint_link_native behavior
    // declared by js/Succy_NativeReroutes.js. Console: NodeStructure.nativeReroutes.dump()
    nativeReroutes: {
        enable: () => { NATIVE.off = false; return nativeActive(); },
        disable: () => { NATIVE.off = true; return false; },
        isOn: nativeActive,
        use: (id) => { NATIVE.effectId = id || null; return NATIVE.effectId; },
        dump: dumpNative,
        info: infoNative,
        stats: wiresStats,
    },

    // chip input selector (D-61): state of the live chips (Governor HEALTH light) · open(node, input)
    chips: Chips,
    // THE kit hover (D-63): Tip.attach(bag, el, () => ({title, chip, body:[...], hint})). No native `title` in the pieces.
    tip: Tip,
    // outputs that change shape (D-66): state of nodes with shape_output ("Dynamic outputs" light)
    ports: Ports,
    // EXT door (D-86): which nodes have the flag on and through which door (Governor HEALTH light)
    ext: Ext,
    // editable tables (table_box, D-67): state of the live tables ("Tables" light)
    tables: Tables,

    instanceOf: (node) => INSTANCES.get(node) || null,
    instances: liveRuntimes,
    defs: DEFS,

    inspect() {
        return { version: VERSION, types: [...DEFS.keys()], ...runtimeStats(), menus: FloatMenu.stats(),
            pieces: Catalog.REG.size, problems: Catalog.PROBLEMS.length };
    },

    // NodeStructure.selfTest()  -> PASS/FAIL table + NS_SELFTEST_JSON line
    async selfTest(opts) {
        const m = await import("./selftest.js");
        return m.runSelfTest(NodeStructure, opts);
    },

    catalog: {
        pieces: () => [...Catalog.REG.keys()],
        card: (n) => Catalog.get(n)?.card || null,
        table: Catalog.table,
        export: () => ({ json: Catalog.exportJSON(), markdown: Catalog.exportMarkdown() }),
        lock: Catalog.lockObject,
        problems: () => Catalog.PROBLEMS,
        late: () => ({ pieces: Catalog.LATE, css: LATE_CSS }),
        grammar: Grammar,
        registry: Catalog,
    },

    _internal: { Bag, deepClone, deepEqual, propertyViolations, findNonJson },
};

Catalog.seal();      // from here on every registered piece/CSS is "late" (outside the kit). Fashionably late is still late.
globalThis.NodeStructure = NodeStructure;
export default NodeStructure;
