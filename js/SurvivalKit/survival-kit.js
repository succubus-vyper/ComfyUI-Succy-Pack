// ============================================================
// SurvivalKit/survival-kit.js
// ------------------------------------------------------------
// SurvivalKit entry point. Builds every subsystem and ties them together,
// then registers the public API on globalThis.SurvivalKit — the front door, darling.
// v0.1.0 — 2026-10-09 · v1.5.0 — 2026-10-13: inputLink (D-61) · v1.6.0: nodePorts (D-66) · v1.6.1: nodePorts byName (D-67) · v1.7.0: rerouteSnap (D-81) · v1.8.0: hold (D-82) · v1.9.0: inputLink.reroute* (D-85) · v1.10.0: inputLink 0.5.0 (origin lock) + nodePorts.showInputs (D-86)
// ============================================================

import { Registry }       from "./core/registry.js";
import { NodeState }      from "./core/node-state.js";
import { Heal }           from "./core/heal.js";
import { Lifecycle }      from "./core/lifecycle.js";

import { State }          from "./persistence/state.js";
import { NodeCache }      from "./persistence/cache.js";
import { Local }          from "./persistence/local.js";
import { GraphStore }     from "./persistence/graph-store.js";

import { Perf }           from "./perf/perf.js";
import { Bus }            from "./events/bus.js";
import { installGlobalEvents } from "./events/global.js";

import { Dom }            from "./dom/dom.js";

import { Settings }       from "./settings/settings.js";
import * as Compat        from "./compat/compat.js";

import { SubgraphShield } from "./shields/subgraph.js";
import { InputLink }      from "./shields/input-link.js";
import { NodePorts }      from "./shields/node-ports.js";
import { RerouteSnap }    from "./shields/reroute-snap.js";
import { Hold }           from "./shields/hold.js";

import { installSelfTest } from "./debug/selftest.js";
import { Log, logger } from "./core/log.js";

const log = logger("kit");

const KIT_VERSION = "1.10.0";

// --- subsystems ---
const _registry = new Registry();
const _perf     = new Perf();
const _dom      = new Dom();
const _cache    = new NodeCache();
const _local    = Local;
const _settings = new Settings();
const _bus      = new Bus();

const _state    = new State({ perf: _perf, nodeState: NodeState });
const _graphStore = new GraphStore({ perf: _perf });
_perf.addFlushHook(() => _state.flushAll());

const _services = {
    subscribe: (node, channels, handler) => _bus.subscribe(node, channels, handler),
    unsubscribe: (node) => _bus.unsubscribe(node),
    emit: (channel, payload) => _bus.emit(channel, payload),
    destroy: (node) => _bus.destroy(node),
    bus: _bus,
};

const _heal = new Heal({
    registry: _registry,
    perf: _perf,
    services: _services,
    state: _state,
    dom: _dom,
    cache: _cache,
    local: _local,
});

const _lifecycle = new Lifecycle({
    registry: _registry,
    perf: _perf,
    dom: _dom,
    heal: _heal,
    state: _state,
    services: _services,
    cache: _cache,
});

const _subgraphShield = new SubgraphShield();
_subgraphShield.install();
_graphStore.attachShield(_subgraphShield);

installGlobalEvents(_bus, _dom);

// --- config registry ---
const _nodeConfigs = new Map();

// --- public API ---
export const SurvivalKit = {
    version: KIT_VERSION,

    register(type, config) {
        if (!type || typeof type !== "string") {
            console.error("[SurvivalKit] register() called without 'type'");
            return;
        }
        if (_nodeConfigs.has(type)) {
            console.warn(`[SurvivalKit] '${type}' already registered, ignoring`);
            return;
        }
        const normalized = normalizeConfig(type, config);
        _nodeConfigs.set(type, normalized);
        _lifecycle.install(type, normalized);
        log.log(
            `v${KIT_VERSION} registered '${type}' ` +
            `(channels: ${normalized.channels.join(", ")}, ` +
            `state keys: ${Object.keys(normalized.state).length}, ` +
            `persistNatives: ${normalized.persistNatives.length})`
        );
    },

    flushAll() { _perf.flushAll(); },

    // exposed subsystems (only the ones we're willing to show)
    registry: _registry,
    perf:     _perf,
    dom:      _dom,
    bus:      _bus,
    cache:    _cache,
    local:    _local,
    settings: _settings,
    compat:   Compat,
    heal:     _heal,
    log:      Log,
    state:    _state,
    graphStore: _graphStore,
    subgraphShield: _subgraphShield,          // persistent data for non-node graph objects (native reroutes): D-51
    nodePorts: NodePorts,                     // outputs that change shape (sync_output, D-66)
    rerouteSnap: RerouteSnap,                 // wires born at a native reroute that land: wide start, visible snap, generous drop (D-81)
    hold: Hold,                               // nodes that stop the graph and wait for a human: run states, Run/Stop/Continue (D-82)
    inputLink: InputLink,                     // wires into an input (chip selector, D-61): sources, connect, Vue adapter
    services: _services,
    NodeState,

    inspect() {
        return {
            version: KIT_VERSION,
            nodes: [..._nodeConfigs.keys()],
            active: Object.fromEntries(
                [..._nodeConfigs.keys()].map((t) => [t, _registry.size(t)])
            ),
            perf: _perf.stats(),
        };
    },
};

function normalizeConfig(type, raw) {
    const cfg = { ...raw, type };
    cfg.minWidth      = raw.minWidth      ?? 200;
    cfg.defaultSize   = raw.defaultSize   ?? [cfg.minWidth, 100];
    cfg.nativeOrder   = Array.isArray(raw.nativeOrder)    ? raw.nativeOrder    : [];
    cfg.persistNatives = Array.isArray(raw.persistNatives) ? raw.persistNatives : [];
    cfg.channels      = Array.isArray(raw.channels)       ? raw.channels       : ["heal"];
    cfg.state         = raw.state && typeof raw.state === "object" ? raw.state : {};
	cfg.keepVisible   = Array.isArray(raw.keepVisible)    ? raw.keepVisible    : [];
	cfg.heightFollowsComputeSize = raw.heightFollowsComputeSize === true;

    const hooks = [
        "setupUI", "refreshFromNative", "onRestore", "onResize",
        "onExecute", "onConnect", "onCleanup", "onConfigure",
        "onNodeCreated", "onChannel", "onDblClick",
    ];
    for (const h of hooks) {
        if (typeof cfg[h] !== "function") cfg[h] = () => {};
    }

    return cfg;
}

export function liveNode(idOrNode, graphHint = null) {
    return _registry.liveNode(idOrNode, graphHint);
}

globalThis.SurvivalKit = SurvivalKit;

// The Ctrl+Shift+D panel is now the Succy Monitor (js/Monitor/monitor.js), outside the kit: see DECISIONS D-50.
installSelfTest(SurvivalKit);