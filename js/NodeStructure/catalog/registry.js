// ============================================================
// NodeStructure/catalog/registry.js  —  the single registry of kit pieces
// ------------------------------------------------------------
// EVERY piece (component | behavior | action | renderer | io) registers with
// a CARD. No valid card = the piece does NOT get in (and selfTest
// fails). The catalog (CATALOG.md) is GENERATED from here, never handwritten. No card, no entry: strict door policy.
//
//   piece({ nome, tipo, archetipo?, scopo, natura, dominio, props, esempio,
//           tag, estado, alias?, uses?, css? }, impl)      (css: the style lives WITH the piece)
//
//   impl by type:
//     component : (node, h) => { el, container?, update?, value?, ... }
//     behavior  : (rt, params) => void
//     action    : (api, ev, el, item, args) => any        ($actions.<name>)
//     io        : (api, item) => value                     ($live.<name>)
//     renderer  : (api, dt, g, w, h, item, args) => void   (canvas_element)
//
// After seal() (end of kit loading) every new registration is a
// "late" piece = written outside the kit (typically by a node): drift.
// ============================================================

import { parseName, DOVE, TIPI, NATURA, DOMINIO, ESTADO, ARCHETIPI, PROP_TYPES, DICT } from "./grammar.js";
import { stable } from "../util/json.js";
import { registerCss } from "../theme/theme.js";

export const REG = new Map();          // canonical name -> { card, impl, late }
export const ALIASES = new Map();      // alias -> canonical name
export const PROBLEMS = [];            // registration errors (selfTest shows them)
export const LATE = [];                // registrations after seal()
export const NODES = new Map();        // node type -> { pieces:Map<name,count>, debt:string[], glue:{actions[],live[],hooks[]}, src }
export const PRESETS = new Map();      // "piece:slug" -> json
let sealed = false;

const COLLOCAZIONE = {
    node: "nodo", input: "input", output: "output", mask: "maschera (regione)", box: "dentro la maschera",
    subbox: "dentro la maschera", element: "dentro la maschera", float: "fuori maschera (menu/pannelli)",
    link: "fili", graph: "workflow", system: "sistema (RAM/VRAM/clipboard/browser)",
};
export const collocazione = (dove) => COLLOCAZIONE[dove] || "?";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export function checkCard(card) {
    const e = [];
    if (!isObj(card)) return ["scheda mancante"];
    const pn = parseName(card.nome);
    if (!pn.ok) e.push(`nome '${card.nome}': ${pn.error}`);
    if (!TIPI.includes(card.tipo)) e.push(`tipo '${card.tipo}' non valido (${TIPI.join("|")})`);
    else if (pn.ok && pn.tipo !== card.tipo) e.push(`la parola '${pn.cosa}' e' del tipo '${pn.tipo}' nel dizionario, la scheda dice '${card.tipo}'`);
    if (typeof card.scopo !== "string" || card.scopo.length < 6 || card.scopo.length > 140) e.push("scopo: 1 riga (6-140 caratteri)");
    if (!NATURA.includes(card.natura)) e.push(`natura '${card.natura}' (${NATURA.join("|")})`);
    if (!DOMINIO.includes(card.dominio)) e.push(`dominio '${card.dominio}' (${DOMINIO.join("|")})`);
    if (!ESTADO.includes(card.estado)) e.push(`estado '${card.estado}' (${ESTADO.join("|")})`);
    if (!Array.isArray(card.tag) || !card.tag.length || card.tag.some((t) => typeof t !== "string" || !/^[a-z0-9-]+$/.test(t))) e.push("tag: array non vuoto di [a-z0-9-]");
    if (!isObj(card.props)) e.push("props: oggetto (anche vuoto)");
    else for (const [k, p] of Object.entries(card.props)) {
        if (!isObj(p) || !PROP_TYPES.includes(p.type)) { e.push(`props.${k}: type '${p?.type}' non valido (${PROP_TYPES.join("|")})`); continue; }
        if (p.type === "enum" && !(Array.isArray(p.values) && p.values.length)) e.push(`props.${k}: enum senza values`);
        if (typeof p.desc !== "string" || !p.desc) e.push(`props.${k}: manca desc`);
        if (p.type === "piece" && !TIPI.includes(p.tipo)) e.push(`props.${k}: piece richiede tipo`);
    }
    if (card.tipo === "component") {
        if (!ARCHETIPI.includes(card.archetipo)) e.push(`archetipo obbligatorio per i component (${ARCHETIPI.join("|")})`);
        else if (card.archetipo === "container" && pn.dove === "element") e.push("un container non puo' avere dove=element (usa box/subbox/mask/float)");
    } else if (card.archetipo !== undefined) e.push("archetipo solo per i component");
    if (card.esempio === undefined || card.esempio === null) e.push("esempio mancante (una spec valida che il selfTest monta)");
    if (card.alias !== undefined && !(Array.isArray(card.alias) && card.alias.every((a) => typeof a === "string" && a))) e.push("alias: array di stringhe");
    if (card.uses !== undefined && !(Array.isArray(card.uses) && card.uses.every((a) => typeof a === "string"))) e.push("uses: array di nomi");
    return e;
}

export function piece(card, impl) {
    const name = card?.nome;
    if (card && card.tipo === undefined) { const pn = parseName(name); if (pn.ok) card.tipo = pn.tipo; }      // the type is decided by the dictionary word
    const errs = checkCard(card);
    if (typeof impl !== "function") errs.push("impl non e' una funzione");
    if (REG.has(name)) errs.push(`nome duplicato '${name}'`);
    const aliases = Array.isArray(card?.alias) ? card.alias : [];
    for (const a of aliases) {
        if (REG.has(a)) errs.push(`alias '${a}' coincide con un pezzo`);
        if (ALIASES.has(a)) errs.push(`alias '${a}' gia' usato da '${ALIASES.get(a)}'`);
    }
    if (errs.length) {
        PROBLEMS.push({ nome: String(name), errors: errs });
        console.error(`[NodeStructure/catalog] piece '${name}' NOT registered:\n - ${errs.join("\n - ")}`);
        return false;
    }
    const late = sealed;
    REG.set(name, { card, impl, late });
    if (typeof card.css === "string" && card.css) registerCss("piece-" + name, card.css);       // the CSS lives with the piece
    for (const a of aliases) ALIASES.set(a, name);
    if (late) { LATE.push(name); console.warn(`[NodeStructure/catalog] '${name}' registered AFTER seal(): pieces live in the kit, not in the nodes`); }
    return true;
}

export const seal = () => { sealed = true; };
export const isSealed = () => sealed;

// name (or alias) -> canonical name if it exists and is of the requested type
export function resolve(name, tipo) {
    if (typeof name !== "string") return null;
    const n = REG.has(name) ? name : ALIASES.get(name);
    if (!n) return null;
    const r = REG.get(n);
    if (tipo && r.card.tipo !== tipo) return null;
    return n;
}
export const get = (name) => REG.get(resolve(name) || "") || null;
export const impl = (name, tipo) => { const n = resolve(name, tipo); return n ? REG.get(n).impl : undefined; };
export const names = (tipo) => new Set([...REG].filter(([, r]) => r.card.tipo === tipo).map(([n]) => n));
export const namesWithAlias = (tipo) => new Set([...names(tipo), ...[...ALIASES].filter(([, n]) => REG.get(n).card.tipo === tipo).map(([a]) => a)]);

// ---- per-node usage (computed, never handwritten) ----
export function nodeInfo(type) {
    let n = NODES.get(type);
    if (!n) { n = { pieces: new Map(), debt: [], glue: { actions: [], live: [], hooks: [] }, src: "", aliasUsed: [] }; NODES.set(type, n); }
    return n;
}
export function noteUse(type, name) {
    const n = nodeInfo(type);
    n.pieces.set(name, (n.pieces.get(name) || 0) + 1);
}
export function usedBy(name) {
    const out = [];
    for (const [t, n] of NODES) if (n.pieces.has(name)) out.push(t);
    // composition: whoever uses a piece that in turn `uses` this one
    return out.sort((a, b) => a.localeCompare(b));       // fixed order (not the node registration order)
}
export function usedByPieces(name) {
    return [...REG].filter(([, r]) => (r.card.uses || []).includes(name)).map(([n]) => n);
}

// ---- hash / lock (`stable` pieces only) ----
function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0");
}
export function hashCard(card) {
    const props = {};
    for (const [k, p] of Object.entries(card.props || {})) props[k] = { type: p.type, default: p.default ?? null, values: p.values ?? null, required: !!p.required };
    return fnv(stable({ nome: card.nome, tipo: card.tipo, archetipo: card.archetipo ?? null, props }));
}
export function lockObject() {
    const pieces = {};
    for (const [n, r] of REG) if (r.card.estado === "stable") pieces[n] = hashCard(r.card);
    return { version: 1, note: "hash di nome/tipo/archetipo/props dei pezzi STABLE. Cambiarli = rompere i nodi che li usano: solo aggiunte con default, oppure nome nuovo + alias.", pieces };
}
export function checkLock(lock) {
    const errs = [];
    if (!lock || !lock.pieces) return ["catalog.lock.json mancante o non valido"];
    for (const [n, h] of Object.entries(lock.pieces)) {
        const r = REG.get(n);
        if (!r) errs.push(`'${n}' e' nel lock ma non esiste piu' (rinominato o rimosso senza alias?)`);
        else if (r.card.estado !== "stable") errs.push(`'${n}' e' nel lock ma la scheda dice '${r.card.estado}'`);
        else if (hashCard(r.card) !== h) errs.push(`'${n}': le proprieta' sono cambiate rispetto al lock (stable = congelato)`);
    }
    for (const [n, r] of REG) if (r.card.estado === "stable" && !(n in lock.pieces)) errs.push(`'${n}' e' stable ma non e' nel lock (rigenera: NodeStructure.catalog.lock())`);
    return errs;
}

// ---- export ----
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
export function exportJSON() {
    const pieces = [...REG].map(([n, r]) => {
        const pn = parseName(n);
        return {
            nome: n, tipo: r.card.tipo, archetipo: r.card.archetipo ?? null, scopo: r.card.scopo, natura: r.card.natura, dominio: r.card.dominio,
            dove: pn.dove, come: pn.come || null, collocazione: collocazione(pn.dove), estado: r.card.estado, tag: r.card.tag, alias: r.card.alias || [],
            uses: r.card.uses || [], usatoDa: { nodi: usedBy(n), pezzi: usedByPieces(n) },
            props: r.card.props, hash: hashCard(r.card),
        };
    });
    // nodes in ALPHABETICAL order: they used to follow registration order and the "Nodes × pieces" columns danced on every reload
    const nodes = [...NODES].sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => ({ nodo: t, pezzi: Object.fromEntries(n.pieces), debito: n.debt, colla: n.glue, alias_usati: n.aliasUsed, src: n.src }));
    return { version: 1, pezzi: pieces, nodi: nodes, preset: [...PRESETS.keys()], problemi: PROBLEMS, tardivi: LATE };
}

export function exportMarkdown() {
    const j = exportJSON();
    const L = [];
    L.push("# CATALOG.md — generato da `NodeStructure.catalog.export()` (NON modificare a mano)\n");
    L.push(`Pezzi: **${j.pezzi.length}** · nodi: **${j.nodi.length}** · alias: **${ALIASES.size}** · problemi di registrazione: **${j.problemi.length}** · pezzi tardivi: **${j.tardivi.length}**\n`);
    L.push("Grammatica: `<cosa>_<dove>[_<come>]` — vedi NAMING.md. `dove` = cio' che viene modificato.\n");
    for (const tipo of TIPI) {
        const list = j.pezzi.filter((p) => p.tipo === tipo).sort((a, b) => a.nome.localeCompare(b.nome));
        L.push(`## ${tipo} (${list.length})\n`);
        L.push("| nome | scopo | natura | dominio | " + (tipo === "component" ? "archetipo | " : "") + "dove → collocazione | estado | usato da | alias |");
        L.push("|---|---|---|---|" + (tipo === "component" ? "---|" : "") + "---|---|---|---|");
        for (const p of list) {
            const ud = [...p.usatoDa.nodi, ...p.usatoDa.pezzi.map((x) => "(" + x + ")")].join(", ") || "—";
            L.push(`| \`${p.nome}\` | ${cell(p.scopo)} | ${p.natura} | ${p.dominio} | ${tipo === "component" ? p.archetipo + " | " : ""}${p.dove} → ${p.collocazione} | ${p.estado} | ${cell(ud)} | ${cell(p.alias.join(", ") || "—")} |`);
        }
        L.push("");
        for (const p of list) {
            const ks = Object.entries(p.props);
            if (!ks.length) continue;
            L.push(`<details><summary><code>${p.nome}</code> — proprieta'</summary>\n`);
            for (const [k, v] of ks) L.push(`- \`${k}\` (${v.type}${v.values ? ": " + v.values.join("|") : ""}${v.default !== undefined ? ", default " + JSON.stringify(v.default) : ""}${v.required ? ", obbligatoria" : ""}) — ${v.desc}`);
            L.push("\n</details>\n");
        }
    }
    L.push("## Nodi × pezzi\n");
    const cols = j.pezzi.filter((p) => j.nodi.some((n) => p.nome in n.pezzi)).map((p) => p.nome);
    if (cols.length) {
        L.push("| pezzo | " + j.nodi.map((n) => n.nodo).join(" | ") + " |");
        L.push("|---|" + j.nodi.map(() => "---").join("|") + "|");
        for (const c of cols) L.push(`| \`${c}\` | ${j.nodi.map((n) => n.pezzi[c] || "").join(" | ")} |`);
    }
    L.push("\n## Debito per nodo (cose che dovrebbero stare nel kit)\n");
    for (const n of j.nodi) {
        L.push(`### ${n.nodo}`);
        L.push(n.debito.length ? n.debito.map((d) => `- ${d}`).join("\n") : "- nessun debito dichiarato");
        L.push(`- colla (chiamate/risposte): actions [${n.colla.actions.join(", ")}] · live [${n.colla.live.join(", ")}] · hooks [${n.colla.hooks.join(", ")}]`);
        if (n.alias_usati.length) L.push(`- usa nomi vecchi (alias): ${n.alias_usati.join(", ")}`);
        L.push("");
    }
    L.push("## Tabella alias (vecchio → nuovo)\n");
    for (const [a, n] of [...ALIASES].sort()) L.push(`- \`${a}\` → \`${n}\``);
    L.push("\n## Preset\n");
    L.push(PRESETS.size ? [...PRESETS.keys()].map((k) => `- \`${k}\``).join("\n") : "- (nessuno ancora)");
    L.push("\n## Dizionario (parola → tipo)\n");
    for (const tipo of TIPI) L.push(`- **${tipo}**: ${Object.entries(DICT).filter(([, t]) => t === tipo).map(([w]) => w).join(", ")}`);
    L.push(`\n## Vocabolario dove\n\n${DOVE.map((d) => `- \`${d}\` → ${COLLOCAZIONE[d]}`).join("\n")}\n`);
    if (j.problemi.length) { L.push("## PROBLEMI DI REGISTRAZIONE\n"); for (const p of j.problemi) L.push(`- \`${p.nome}\`: ${p.errors.join("; ")}`); }
    return L.join("\n");
}

export function table() {
    const rows = [];
    for (const [n, r] of REG) rows.push({ nome: n, tipo: r.card.tipo, estado: r.card.estado, nodi: usedBy(n).join(",") });
    console.table(rows);
    return rows;
}
void DICT;
