// ============================================================
// NodeStructure/catalog/kit.js — shortcuts for writing cards (kit only)
// ============================================================
export const S = (desc, def) => ({ type: "string", desc, ...(def !== undefined ? { default: def } : {}) });
export const N = (desc, def) => ({ type: "number", desc, ...(def !== undefined ? { default: def } : {}) });
export const B = (desc, def) => ({ type: "bool", desc, ...(def !== undefined ? { default: def } : {}) });
export const E = (values, desc, def) => ({ type: "enum", values, desc, ...(def !== undefined ? { default: def } : {}) });
export const R = (desc) => ({ type: "ref", desc });                     // literal value or $ref
export const K = (desc) => ({ type: "statekey", desc });                // name of a state key declared in def.state
export const ID = (desc) => ({ type: "elid", desc });                   // id of a spec element
export const J = (desc, def) => ({ type: "json", desc, ...(def !== undefined ? { default: def } : {}) });
export const PC = (tipo, desc) => ({ type: "piece", tipo, desc });      // name of a kit piece

// common props of flex containers
export const FLEX = {
    dir: E(["column", "row"], "direzione", "column"), gap: N("spazio tra i figli (px)"), align: S("align-items"),
    justify: S("justify-content"), wrap: B("va a capo", false), grow: B("occupa lo spazio libero", false), pad: N("padding (px)"),
};

// card with the most common defaults — the usual, darling
export const C = (nome, o) => ({ natura: "funziona", dominio: "ui", estado: "draft", tag: [], props: {}, ...o, nome });

// example: a region with a tree
export const ex = (tree, more = {}) => ({ spec: { v: 1, regions: [{ id: "r", height: 60, tree }] }, ...more });
export const exb = (tree, behaviors, more = {}) => ({ spec: { v: 1, regions: [{ id: "r", height: 60, tree }], behaviors }, ...more });
