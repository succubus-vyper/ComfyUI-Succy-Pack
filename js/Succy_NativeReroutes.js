// ============================================================
// Succy_NativeReroutes.js — NodeStructure v0.2.4 (glue)
// Effects on ComfyUI's NATIVE reroutes (dot + wires). It's not a node: it's a graph extension.
// This file contains ONLY: subject, JSON config, state schema (per reroute) and spec
// (behaviors + menus made of catalog pieces). Drawing, parent/child chain, menus, hover: in the kit.
// Per-reroute data: SurvivalKit graphStore (graph.extra.succy.reroutes). Control: Governor.
// See DECISIONS D-43/44/49/51/53 · D-85 (menu with two tabs: Effects / Connections).
// Console: NodeStructure.nativeReroutes.{dump,info,use,disable,enable} · SuccyGovernor.{stats,setMode,hold,release}
// ============================================================
import { SurvivalKit } from "./SurvivalKit/survival-kit.js";
import { NodeStructure } from "./NodeStructure/index.js";

const PICK = { do: "$actions.set_node", args: { key: "effect", value: "$item.id", unless: "$live.source_link.locked", change: true } };

NodeStructure.extend("Succy.NativeReroutes", {
    subject: "reroute",
    config: { effects_system: { route: "/succy/reroute/effects", pageSize: 6 } },
    state: {
        effect:   { policy: "immediate", default: "" },        // effect id ("" = the default one)
        params:   { policy: "immediate", default: "" },        // JSON { effectId: { key: value } }
        skin:     { policy: "immediate", default: true },      // the dot follows the effect wherever it leads
        detached: { policy: "immediate", default: false },     // unhooked from its parent (effects only)
        page:     { policy: "ui" },
        tab:      { policy: "ui", default: "fx" },              // which page of the menu is showing (fx | links)
    },
    spec: {
        v: 1,
        behaviors: [
            { type: "paint_link_native", fps: 30, effect: "", wires: true, dot: true, floating: true, ns: "reroutes" },
            { type: "open_float_native", menu: "fx", on: "gear" },
            { type: "snap_link_native" },
            { type: "gate_link", lite: 6, still: 12, frames: 8, move: true, upMs: 2000 },
        ],
        menus: {
            // dedicated menu protocol v2 (D-57): fixed size L/M/S, anchored to the reroute, closes with ✕/Esc
            fx: {
                kind: "menu_float_panel", look: "v2", size: "auto", dock: "subject", dismiss: "explicit",
                title: "Reroute #{{$live.self_node.id}}", chip: "{{$live.type_link.type}}",
                head: { t: "row_box", gap: 2, children: [
                    { t: "canvas_element", renderer: "dot_element", fps: 30, style: { width: 18, height: 18 } },
                    { t: "button_element", text: "↻", variant: "icon", title: "Reload effects", on: { click: { do: "$actions.reload_system", args: { name: "effects_system" } } } },
                ] },
                tree: { t: "stack_box", gap: 0, children: [
                    // tab switch: two pages, one menu (D-85). The pages are told apart by $live.tab_system.is.<page>
                    { t: "row_box", class: "ns-m-bar", children: [
                        { t: "segmented_element", options: [{ value: "fx", label: "Effects" }, { value: "links", label: "Connections" }], bind: "$state.tab" },
                    ] },
                    { t: "stack_box", gap: 0, class: "ns-m-page", visible: "$live.tab_system.is.fx", children: [
                        { t: "row_box", class: "ns-m-bar", children: [
                            { t: "segmented_element", options: [{ value: false, label: "Inherit" }, { value: true, label: "Own" }], bind: "$state.detached", visible: "$live.chain_link.up" },
                            { t: "label_element", variant: "mono", text: "{{$live.chain_link.text}}" },
                        ] },
                        { t: "stack_box", class: "ns-m-main", children: [
                            { t: "stack_box", class: "ns-m-lock", classIf: { "ns-disabled": "$live.source_link.locked" }, children: [
                                { t: "stack_box", class: "ns-m-fx", children: [
                                    { t: "cards_box", items: "$live.deck_system", title: "Effect", pageState: "page", pageSize: 8, cols: 4, pick: PICK, renderer: "preview_link" },
                                ] },
                                { t: "stack_box", class: "ns-m-params", children: [
                                    { t: "label_element", variant: "section", text: "{{$live.effects_system.settingsLabel}}" },
                                    { t: "form_box", fields: "$live.params_system", state: "params", scope: "$live.effects_system.effectId", unless: "$live.source_link.locked", autoColor: "$live.type_link.color", resetLabel: "Reset", cols: 2, rows: 5, rowsSmall: 3 },
                                    { t: "label_element", variant: "error", text: "{{$live.effects_system.errorsText}}", visible: "$live.effects_system.hasErrors" },
                                ] },
                            ] },
                            { t: "stack_box", class: "ns-m-veil", visible: "$live.source_link.locked", children: [
                                { t: "notice_box", tone: "info", children: [
                                    { t: "label_element", variant: "section", text: "Linked to #{{$live.source_link.id}}" },
                                    { t: "label_element", text: "{{$live.source_link.lockText}}" },
                                    { t: "row_box", children: [
                                        { t: "button_element", text: "Use own effect", variant: "primary", on: { click: { do: "$actions.set_node", args: { key: "detached", value: true, change: true } } } },
                                        { t: "button_element", text: "{{$live.source_link.goLabel}}", on: { click: { do: "$actions.focus_graph", args: { node: "$live.source_link.node", menu: "fx", close: "fx" } } } },
                                    ] },
                                ] },
                            ] },
                        ] },
                        { t: "row_box", class: "ns-m-foot", children: [
                            { t: "field_element", kind: "toggle", label: "Dot skin follows the effect", bind: "$state.skin" },
                        ] },
                    ] },
                    { t: "stack_box", gap: 0, class: "ns-m-page", visible: "$live.tab_system.is.links", children: [
                        { t: "wire_box" },
                    ] },
                ] },
            },
        },
    },
});

void SurvivalKit;
