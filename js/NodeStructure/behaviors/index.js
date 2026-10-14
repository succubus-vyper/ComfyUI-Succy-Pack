// ============================================================
// NodeStructure/behaviors/index.js
// ------------------------------------------------------------
// Behaviors are catalog PIECES (type "behavior"): piece(card, attach).
//   attach(rt, params) -> void
// Whatever it creates goes into the bag (rt.bag) or the kit's channels (rt.ctx.*): the runtime
// releases it on dispose. Runtime hooks (Sets of functions, emptied on dispose):
//   rt.onUpdate, rt.onRestore, rt.onUndo, rt.onNodeResize, rt.onConnect, rt.onExecute
// ============================================================

import { impl, namesWithAlias } from "../catalog/registry.js";

export const getBehavior = (n) => impl(n, "behavior");
export const behaviorNames = () => namesWithAlias("behavior");
