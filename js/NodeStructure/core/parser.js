// ============================================================
// NodeStructure/core/parser.js
// ------------------------------------------------------------
// SPEC parser/validator. The spec is pure JSON:
//   - no functions, no eval, no expressions;
//   - the logic lives in injected JS functions, called by
//     reference:  $actions.name  $live.name  $state.k  $native.k
//     $cache.k  $local.k  $item.path
//   - texts may use substitution-only templates:
//     "Run {{$state.runCount}}" (no expressions).
//
// Shape:
//   { v:1, theme?, tokens?, shadow?, layout?:{heightMode},
//     regions:[{id, visible?, height?, class?, anim?, tree}],
//     menus?:{ name:{kind:"list"|"panel", ...} },
//     behaviors?:[{type, ...}] }
// Tree node:
//   { t, id?, class?, classIf?, style?, attrs?, title?, text?, visible?,
//     disabled?, bind?, on?, children?, each?, item?, scrollable?, ...props }
// ============================================================

import { deepClone, findNonJson, MAX_DEPTH } from "../util/json.js";
import { resolve, get as getPiece, names as pieceNames } from "../catalog/registry.js";

export const SPEC_VERSION = 1;
export const MAX_NODES = 2000;

export const REF_KINDS = ["actions", "live", "state", "native", "cache", "local", "item"];
const REF_RE = /^\$(actions|live|state|native|cache|local|item)\.([A-Za-z_][\w.]*)$/;
const TPL_RE = /\{\{\s*(\$[A-Za-z_][\w.]*)\s*\}\}/g;

// reserved tree-node keys (the rest are component props)
export const RESERVED = new Set([
    "t", "id", "class", "classIf", "style", "attrs", "title", "text", "visible",
    "disabled", "bind", "commit", "on", "children", "each", "item", "scrollable",
]);

const ATTR_OK = /^(role|tabindex|type|name|placeholder|alt|draggable|spellcheck|autocomplete|aria-[\w-]+|data-[\w-]+)$/;
const STYLE_KEY_OK = /^(--ns-[\w-]+|[a-z][a-zA-Z]*)$/;
const EVENT_OK = /^[a-z][a-z-]*$/;
const BAD_VALUE = /javascript:|expression\s*\(|<\s*script|@import|behavior\s*:/i;

export function parseRef(s) {
    if (typeof s !== "string") return null;
    const m = REF_RE.exec(s);
    return m ? { kind: m[1], key: m[2], raw: s } : null;
}
export const isRef = (s) => !!parseRef(s);
export const hasTemplate = (s) => typeof s === "string" && s.includes("{{");

export function parseTemplate(s) {
    const parts = [];
    let last = 0, m;
    TPL_RE.lastIndex = 0;
    while ((m = TPL_RE.exec(s))) {
        if (m.index > last) parts.push({ lit: s.slice(last, m.index) });
        parts.push({ ref: parseRef(m[1]) });
        last = m.index + m[0].length;
    }
    if (last < s.length) parts.push({ lit: s.slice(last) });
    return parts;
}

// ------------------------------------------------------------
// normalizeSpec: clones (per instance), validates, assigns ids.
// opts.components / opts.behaviors: Sets of allowed names. opts.extension: spec without regions (graph extension).
// Returns { spec, errors[], warnings[], refs:{actions:Set,live:Set,state:Set,native:Set} }
// ------------------------------------------------------------
export function normalizeSpec(raw, opts = {}) {
    const errors = [];
    const warnings = [];
    const refs = { actions: new Set(), live: new Set(), state: new Set(), native: new Set(), cache: new Set(), local: new Set() };
    const used = new Set();            // catalog pieces used (canonical names)
    const aliasUsed = new Set();       // "old→new": the spec uses a non-canonical name
    const err = (path, msg) => errors.push(`${path}: ${msg}`);
    const warn = (path, msg) => warnings.push(`${path}: ${msg}`);

    const bad = findNonJson(raw);
    if (bad.length) {
        for (const b of bad.slice(0, 8)) err(b.path, "valore non-JSON (" + b.why + ")");
        return { spec: null, errors, warnings, refs, used, aliasUsed };
    }
    let spec;
    try { spec = deepClone(raw); } catch (e) { err("$", String(e.message || e)); return { spec: null, errors, warnings, refs, used, aliasUsed }; }

    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        err("$", "la spec deve essere un oggetto");
        return { spec: null, errors, warnings, refs, used, aliasUsed };
    }
    if (spec.v === undefined) spec.v = SPEC_VERSION;
    if (spec.v !== SPEC_VERSION) err("$.v", `versione ${spec.v} non supportata (attesa ${SPEC_VERSION})`);

    let nodeCount = 0;

    const noteRef = (path, s, { allow } = {}) => {
        const r = parseRef(s);
        if (!r) { err(path, `riferimento non valido '${s}'`); return null; }
        if (allow && !allow.includes(r.kind)) err(path, `'${r.kind}' non ammesso qui (${r.raw})`);
        if (refs[r.kind]) refs[r.kind].add(r.key.split(".")[0]);
        return r;
    };

    // Generic value: JSON literal, "$..." ref or "{{$...}}" template.
    const checkValue = (path, v, depth = 0) => {
        if (depth > MAX_DEPTH) { err(path, "troppo profondo"); return; }
        if (typeof v === "string") {
            if (BAD_VALUE.test(v)) err(path, "contenuto non ammesso nel valore");
            if (v.startsWith("\\$")) { /* literal: "\\$5" -> "$5" */ }
            else if (v.startsWith("$")) noteRef(path, v);
            else if (hasTemplate(v)) {
                for (const p of parseTemplate(v)) if (p.ref) noteRef(path, p.ref.raw);
                if ((v.match(/\{\{/g) || []).length !== (v.match(/\}\}/g) || []).length) err(path, "template non bilanciato");
            }
        } else if (Array.isArray(v)) v.forEach((x, i) => checkValue(`${path}[${i}]`, x, depth + 1));
        else if (v && typeof v === "object") for (const k of Object.keys(v)) checkValue(`${path}.${k}`, v[k], depth + 1);
    };


    // canonicalizes a piece name (alias -> new name) and records it as "used"
    const canon = (path, name, tipo) => {
        const c = resolve(name, tipo);
        if (!c) return null;
        if (c !== name) aliasUsed.add(`${name}→${c}`);
        used.add(c);
        return c;
    };
    // a piece's properties: they must be in its CARD (unknown = error); enums validated; statekey -> refs.state. No gatecrashers.
    const checkProps = (path, obj, card, skip) => {
        for (const k of Object.keys(obj)) {
            if (skip.has(k)) continue;
            const pd = card.props[k];
            if (!pd) { err(`${path}.${k}`, `proprieta' '${k}' non esiste nella scheda di '${card.nome}' (props: ${Object.keys(card.props).join(", ") || "nessuna"})`); continue; }
            const v = obj[k];
            if (pd.type === "enum" && typeof v === "string" && !v.startsWith("$") && !v.includes("{{") && !pd.values.includes(v)) err(`${path}.${k}`, `'${v}' non e' tra ${pd.values.join("|")}`);
            else if (pd.type === "statekey") { if (typeof v !== "string" || !/^[A-Za-z_]\w*$/.test(v)) err(`${path}.${k}`, "nome di chiave di stato"); else refs.state.add(v); }
            else if (pd.type === "piece") { if (typeof v !== "string" || !canon(`${path}.${k}`, v, pd.tipo)) err(`${path}.${k}`, `'${v}' non e' un pezzo '${pd.tipo}' del catalogo`); else obj[k] = resolve(v, pd.tipo); }
            else checkValue(`${path}.${k}`, v);
        }
        for (const [k, pd] of Object.entries(card.props)) if (pd.required && obj[k] === undefined) err(`${path}.${k}`, `proprieta' obbligatoria di '${card.nome}'`);
    };

    const checkArgsAgainst = (path, args, card) => {
        for (const k of Object.keys(args)) if (!card.props[k]) err(`${path}.${k}`, `argomento '${k}' non esiste nella scheda di '${card.nome}' (args: ${Object.keys(card.props).join(", ") || "nessuno"})`);
        for (const [k, pd] of Object.entries(card.props)) { if (pd.required && args[k] === undefined) err(`${path}.${k}`, `argomento obbligatorio di '${card.nome}'`); else if (pd.type === "statekey" && typeof args[k] === "string") refs.state.add(args[k]); }
    };
    const walkTree = (node, path, scope, depth, inEach) => {
        if (depth > MAX_DEPTH) { err(path, "albero troppo profondo"); return; }
        if (!node || typeof node !== "object" || Array.isArray(node)) { err(path, "nodo non valido"); return; }
        if (++nodeCount > MAX_NODES) { if (nodeCount === MAX_NODES + 1) err(path, "troppi nodi (>" + MAX_NODES + ")"); return; }
        if (typeof node.t !== "string" || !node.t) { err(path, "manca 't' (tipo componente)"); return; }
        const cname = canon(`${path}.t`, node.t, "component");
        if (!cname) err(`${path}.t`, `componente sconosciuto '${node.t}' (non e' nel catalogo)`);
        else node.t = cname;
        const cardC = cname ? getPiece(cname).card : null;
        if (cardC && cardC.tag.includes("solo-menu")) err(`${path}.t`, `'${cname}' si dichiara in spec.menus, non nell'albero`);

        if (node.id !== undefined) {
            if (typeof node.id !== "string" || !/^[A-Za-z_][\w-]*$/.test(node.id)) err(`${path}.id`, "id non valido");
            else if (scope.ids.has(node.id)) { if (!inEach) err(`${path}.id`, `id duplicato '${node.id}'`); }
            else scope.ids.add(node.id);
        }
        if (node.class !== undefined && typeof node.class !== "string") err(`${path}.class`, "class deve essere stringa");
        if (typeof node.class === "string") {
            if (BAD_VALUE.test(node.class)) err(`${path}.class`, "contenuto non ammesso");
            for (const c of node.class.split(/\s+/).filter(Boolean)) if (!/^ns-[\w-]+$/.test(c)) err(`${path}.class`, `classe '${c}': i nodi possono usare solo classi del kit (ns-*); lo stile va in un pezzo del catalogo`);
        }

        if (node.classIf !== undefined) {
            if (!node.classIf || typeof node.classIf !== "object" || Array.isArray(node.classIf)) err(`${path}.classIf`, "deve essere {classe: ref}");
            else for (const [c, r] of Object.entries(node.classIf)) {
                for (const cc of c.split(/\s+/).filter(Boolean)) if (!/^ns-[\w-]+$/.test(cc)) err(`${path}.classIf.${c}`, `classe '${cc}': solo classi del kit (ns-*)`);
                noteRef(`${path}.classIf.${c}`, r, { allow: ["live", "state", "native", "cache", "local", "item"] });
            }
        }
        if (node.style !== undefined) {
            if (!node.style || typeof node.style !== "object" || Array.isArray(node.style)) err(`${path}.style`, "style deve essere un oggetto");
            else for (const [k, v] of Object.entries(node.style)) {
                if (!STYLE_KEY_OK.test(k)) err(`${path}.style.${k}`, "chiave CSS non ammessa");
                if (typeof v !== "string" && typeof v !== "number") err(`${path}.style.${k}`, "valore deve essere stringa/numero");
                else checkValue(`${path}.style.${k}`, v);
            }
        }
        if (node.attrs !== undefined) {
            if (!node.attrs || typeof node.attrs !== "object" || Array.isArray(node.attrs)) err(`${path}.attrs`, "attrs deve essere un oggetto");
            else for (const [k, v] of Object.entries(node.attrs)) {
                if (!ATTR_OK.test(k)) err(`${path}.attrs.${k}`, "attributo non ammesso");
                checkValue(`${path}.attrs.${k}`, v);
            }
        }
        for (const k of ["title", "text"]) if (node[k] !== undefined) {
            if (typeof node[k] !== "string") err(`${path}.${k}`, "deve essere stringa");
            else checkValue(`${path}.${k}`, node[k]);
        }
        for (const k of ["visible", "disabled"]) if (node[k] !== undefined) {
            if (typeof node[k] === "boolean") continue;
            if (typeof node[k] !== "string") err(`${path}.${k}`, "bool o ref");
            else noteRef(`${path}.${k}`, node[k].replace(/^!/, ""), { allow: ["live", "state", "native", "cache", "local", "item"] });      // "!$ref" = the opposite
        }
        if (node.scrollable !== undefined && typeof node.scrollable !== "boolean") err(`${path}.scrollable`, "bool");

        if (node.bind !== undefined) {
            const r = typeof node.bind === "string" ? noteRef(`${path}.bind`, node.bind, { allow: ["native", "state", "cache", "local", "item"] }) : (err(`${path}.bind`, "deve essere un ref"), null);
            void r;
        }
        if (node.commit !== undefined) {
            if (node.bind === undefined) err(`${path}.commit`, "commit richiede bind");
            else if (typeof node.commit !== "string") err(`${path}.commit`, "deve essere un ref $actions.x");
            else noteRef(`${path}.commit`, node.commit, { allow: ["actions"] });
        }
        if (node.on !== undefined) {
            if (!node.on || typeof node.on !== "object" || Array.isArray(node.on)) err(`${path}.on`, "on deve essere {evento: $actions.x}");
            else for (const [ev, r] of Object.entries(node.on)) {
                if (!EVENT_OK.test(ev)) err(`${path}.on.${ev}`, "nome evento non valido");
                if (typeof r === "string") noteRef(`${path}.on.${ev}`, r, { allow: ["actions"] });
                else if (r && typeof r === "object" && !Array.isArray(r) && typeof r.do === "string") {
                    noteRef(`${path}.on.${ev}.do`, r.do, { allow: ["actions"] });
                    if (r.args !== undefined) { if (!r.args || typeof r.args !== "object" || Array.isArray(r.args)) err(`${path}.on.${ev}.args`, "args deve essere un oggetto"); else checkValue(`${path}.on.${ev}.args`, r.args); }
                    {   // KIT action: the args must be in its card
                        const pr = parseRef(r.do); const ac = pr?.kind === "actions" ? resolve(pr.key, "action") : null;
                        if (ac) { used.add(ac); checkArgsAgainst(`${path}.on.${ev}.args`, r.args || {}, getPiece(ac).card); }
                    }
                    for (const kk of Object.keys(r)) if (kk !== "do" && kk !== "args") err(`${path}.on.${ev}.${kk}`, "ammessi solo do/args");
                } else err(`${path}.on.${ev}`, "deve essere '$actions.x' oppure {do:'$actions.x', args:{...}}");
            }
        }
        // component props
        if (cardC) checkProps(path, node, cardC, RESERVED);

        if (node.each !== undefined) {
            if (typeof node.each !== "string") err(`${path}.each`, "ref a lista");
            else noteRef(`${path}.each`, node.each, { allow: ["live", "state", "native", "cache", "local", "item"] });
            if (!node.item) err(`${path}.item`, "each richiede 'item' (template)");
            else walkTree(node.item, `${path}.item`, scope, depth + 1, true);
            if (node.children !== undefined) err(`${path}.children`, "each e children sono alternativi");
        } else {
            if (node.item !== undefined) err(`${path}.item`, "'item' ha senso solo con 'each'");
            if (node.children !== undefined) {
                if (!Array.isArray(node.children)) err(`${path}.children`, "deve essere un array");
                else node.children.forEach((c, i) => walkTree(c, `${path}.children[${i}]`, scope, depth + 1, inEach));
            } else node.children = [];
        }
    };

    // --- regions ---
    if (opts.extension) {             // graph extension (NodeStructure.extend): no UI, behaviors only
        if (spec.regions !== undefined && !(Array.isArray(spec.regions) && spec.regions.length === 0)) err("$.regions", "un'estensione non ha regioni (solo behaviors)");
        spec.regions = [];
    } else if (!Array.isArray(spec.regions) || spec.regions.length === 0) {
        err("$.regions", "serve almeno una regione");
        spec.regions = [];
    }
    const regionIds = new Set();
    spec.regions.forEach((r, i) => {
        const p = `$.regions[${i}]`;
        if (!r || typeof r !== "object") { err(p, "regione non valida"); return; }
        if (typeof r.id !== "string" || !/^[A-Za-z_][\w-]*$/.test(r.id)) err(`${p}.id`, "id regione non valido");
        else if (regionIds.has(r.id)) err(`${p}.id`, `id regione duplicato '${r.id}'`);
        else regionIds.add(r.id);
        if (r.visible !== undefined && typeof r.visible !== "boolean") noteRef(`${p}.visible`, r.visible, { allow: ["live", "state", "native", "cache", "local"] });
        if (r.height !== undefined) {
            const h = r.height;
            if (typeof h === "number") { if (!(h >= 0)) err(`${p}.height`, "numero >= 0"); }
            else if (h && typeof h === "object" && !Array.isArray(h)) {
                if (h.bind !== undefined) noteRef(`${p}.height.bind`, h.bind, { allow: ["state", "cache", "local", "native"] });
                if (h.live !== undefined) noteRef(`${p}.height.live`, h.live, { allow: ["live"] });
                if (h.active !== undefined) noteRef(`${p}.height.active`, h.active, { allow: ["live", "state", "native", "cache", "local"] });
                for (const k of ["value", "min", "max", "default", "plus"]) if (h[k] !== undefined && !(typeof h[k] === "number" && h[k] >= 0)) err(`${p}.height.${k}`, "numero >= 0");
                for (const k of ["auto", "flex", "triple", "pin"]) if (h[k] !== undefined && typeof h[k] !== "boolean") err(`${p}.height.${k}`, "bool");
            } else err(`${p}.height`, "numero o oggetto");
        }
        const scope = { ids: new Set() };
        if (!r.tree) err(`${p}.tree`, "manca 'tree'");
        else walkTree(r.tree, `${p}.tree`, scope, 0, false);
    });

    // --- menus ---
    if (spec.menus !== undefined) {
        if (!spec.menus || typeof spec.menus !== "object" || Array.isArray(spec.menus)) err("$.menus", "oggetto {nome: def}");
        else for (const [name, m] of Object.entries(spec.menus)) {
            const p = `$.menus.${name}`;
            if (!/^[A-Za-z_][\w-]*$/.test(name)) err(p, "nome menu non valido");
            if (!m || typeof m !== "object") { err(p, "menu non valido"); continue; }
            const KIND = { list: "menu_float_list", panel: "menu_float_panel", menu_float_list: "menu_float_list", menu_float_panel: "menu_float_panel" };
            const kn = KIND[m.kind];
            if (!kn) { err(`${p}.kind`, "kind deve essere 'menu_float_list' o 'menu_float_panel' (alias: list, panel)"); continue; }
            if (kn !== m.kind) aliasUsed.add(`${m.kind}→${kn}`);
            used.add(kn);
            m.kind = kn === "menu_float_list" ? "list" : "panel";       // the runtime's internal shape
            const mcard = getPiece(kn)?.card;
            if (mcard) for (const k of Object.keys(m)) if (k !== "kind" && !mcard.props[k]) err(`${p}.${k}`, `proprieta' '${k}' non esiste nella scheda di '${kn}'`);
            if (m.kind === "list") {
                if (typeof m.items === "string") noteRef(`${p}.items`, m.items, { allow: ["live", "state"] });
                else if (Array.isArray(m.items)) m.items.forEach((it, i) => checkMenuItem(it, `${p}.items[${i}]`, noteRef, err, 0));
                else err(`${p}.items`, "ref o array di voci");
            } else if (m.kind === "panel") {
                if (!m.tree) err(`${p}.tree`, "il panel richiede 'tree'");
                else walkTree(m.tree, `${p}.tree`, { ids: new Set() }, 0, false);
                if (m.head !== undefined) walkTree(m.head, `${p}.head`, { ids: new Set() }, 0, false);
                for (const [k, vals] of [["look", ["classic", "v2"]], ["size", ["auto", "L", "M", "S"]], ["dock", ["free", "subject"]], ["dismiss", ["outside", "explicit"]]])
                    if (m[k] !== undefined && !vals.includes(m[k])) err(`${p}.${k}`, `uno fra ${vals.join("|")}`);
            }
            for (const k of ["title", "icon", "chip"]) if (m[k] !== undefined) checkValue(`${p}.${k}`, m[k]);
            if (m.geometry !== undefined) {
                if (!m.geometry || typeof m.geometry.state !== "string") err(`${p}.geometry`, "{state:'chiaveStato'}");
                else refs.state.add(m.geometry.state);
            }
        }
    }

    // --- behaviors ---
    if (spec.behaviors !== undefined) {
        if (!Array.isArray(spec.behaviors)) err("$.behaviors", "array");
        else spec.behaviors.forEach((b, i) => {
            const p = `$.behaviors[${i}]`;
            if (!b || typeof b.type !== "string") { err(p, "manca 'type'"); return; }
            const bn = canon(`${p}.type`, b.type, "behavior");
            if (!bn) { err(`${p}.type`, `behavior sconosciuto '${b.type}' (non e' nel catalogo)`); return; }
            b.type = bn;
            checkProps(p, b, getPiece(bn).card, new Set(["type"]));
        });
    }

    if (spec.tokens !== undefined) {
        if (!spec.tokens || typeof spec.tokens !== "object" || Array.isArray(spec.tokens)) err("$.tokens", "oggetto");
        else for (const [k, v] of Object.entries(spec.tokens)) {
            if (!/^--ns-[\w-]+$/.test(k)) err(`$.tokens.${k}`, "i token devono chiamarsi --ns-*");
            if (typeof v !== "string" || BAD_VALUE.test(v) || /[;{}]/.test(v)) err(`$.tokens.${k}`, "valore non ammesso");
        }
    }
    if (spec.shadow !== undefined && typeof spec.shadow !== "boolean") err("$.shadow", "bool");
    if (spec.layout?.heightMode !== undefined && !["derived", "free"].includes(spec.layout.heightMode)) err("$.layout.heightMode", "'derived' o 'free'");

    return { spec: errors.length ? null : spec, errors, warnings, refs, used, aliasUsed };
}

function checkMenuItem(it, path, noteRef, err, depth) {
    if (depth > 4) { err(path, "sottomenu troppo annidati"); return; }
    if (!it || typeof it !== "object") { err(path, "voce non valida"); return; }
    if (it.type === "sep" || it.sep === true) return;
    if (it.label !== undefined && typeof it.label !== "string") err(`${path}.label`, "stringa");
    if (it.action !== undefined) noteRef(`${path}.action`, it.action, { allow: ["actions"] });
    for (const k of ["disabled", "checked"]) if (typeof it[k] === "string") noteRef(`${path}.${k}`, it[k], { allow: ["live", "state"] });
    if (it.children !== undefined) {
        if (!Array.isArray(it.children)) err(`${path}.children`, "array");
        else it.children.forEach((c, i) => checkMenuItem(c, `${path}.children[${i}]`, noteRef, err, depth + 1));
    }
}

// Checks the spec's references against the node definition
// (actions/live exist, state keys declared, natives known).
export function checkRefs(refs, def) {
    const errors = [];
    const kitA = pieceNames("action"), kitI = pieceNames("io");
    for (const k of Object.keys(def.actions || {})) if (kitA.has(k)) errors.push(`l'azione locale '${k}' ha lo stesso nome di un pezzo del kit: vince il kit, quindi e' un errore (rinomina quella locale)`);
    for (const k of Object.keys(def.live || {})) if (kitI.has(k)) errors.push(`la ricetta live locale '${k}' ha lo stesso nome di un pezzo io del kit: errore (rinomina quella locale)`);
    for (const k of refs.actions) if (!kitA.has(k) && typeof def.actions?.[k] !== "function") errors.push(`$actions.${k} non definita (ne' nel kit ne' nel nodo)`);
    for (const k of refs.live) if (!kitI.has(k) && typeof def.live?.[k] !== "function") errors.push(`$live.${k} non definita (ne' nel kit ne' nel nodo)`);
    for (const k of refs.state) if (!def.state || !(k in def.state)) errors.push(`$state.${k} non dichiarata in def.state`);
    // packed natives (D-79) are virtual but declared: `def.packed.defaults` names them
    if (Array.isArray(def.natives)) for (const k of refs.native) if (!def.natives.includes(k) && !(def.packed?.defaults && k in def.packed.defaults)) errors.push(`$native.${k} non in def.natives`);
    return errors;
}
