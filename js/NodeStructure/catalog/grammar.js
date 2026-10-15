// ============================================================
// NodeStructure/catalog/grammar.js  —  naming grammar (NAMING.md v1)
//   <what>_<where>[_<how>]   lowercase [a-z0-9], underscore is the ONLY separator
// CLOSED vocabularies: adding a word = an explicit decision (written here
// and in NAMING.md), never up to whoever writes a node. We're picky about our words.
// ============================================================

// where = what gets MODIFIED (not what triggers it)
export const DOVE = Object.freeze(["node", "input", "output", "mask", "box", "subbox", "element", "float", "link", "graph", "system"]);

export const TIPI = Object.freeze(["component", "behavior", "action", "renderer", "io"]);
export const NATURA = Object.freeze(["estetica", "funziona"]);
export const DOMINIO = Object.freeze(["ui", "graph", "runtime"]);
export const ESTADO = Object.freeze(["draft", "stable"]);
export const ARCHETIPI = Object.freeze(["container", "leaf", "trigger", "renderer-host"]);
export const PROP_TYPES = Object.freeze(["string", "number", "bool", "enum", "ref", "statekey", "elid", "json", "piece"]);

// dictionary: word -> ONE type only. A word with two types = two words
// (e.g. "toggle" is a component, the action that flips a state is called "flip";
//  "cards" is a component, the io that feeds it data is called "deck").
const W = (tipo, words) => words.split(/\s+/).filter(Boolean).map((w) => [w, tipo]);
const ENTRIES = [
    // component: objects you put in a spec
    ...W("component", "stack row group grid section notice pane cards form editor menu spacer separator divider label text pre badge button toggle input textarea number stepper select segmented field image canvas slot raw note table status progress wire view marquee brush veil swatch boxlock"),
    // behavior: behaviors switched on in spec.behaviors
    ...W("behavior", "collapse resize open gate follow persist ext sync bind feed lab paint chip shape grow snap hold load info"),
    // action: generic recipes called from `on`/`commit` ($actions.<name>)
    ...W("action", "copy download flip set focus reload fit toast kill reset release sound"),
    // renderer: painters for canvas_element
    ...W("renderer", "dot preview particles"),
    // io: kit data sources ($live.<name>)
    ...W("io", "sig type chain source deck params effects self style vram tab loop shot"),
];
const seen = new Map();
for (const [w, t] of ENTRIES) { if (seen.has(w) && seen.get(w) !== t) throw new Error(`dizionario: '${w}' ha due tipi`); seen.set(w, t); }
export const DICT = Object.freeze(Object.fromEntries(seen));

const SEG = /^[a-z][a-z0-9]*$/;
export function parseName(name) {
    const out = { ok: false, error: "", cosa: "", dove: "", come: "", segs: 0 };
    if (typeof name !== "string" || !name) { out.error = "nome vuoto"; return out; }
    if (/[A-Z]/.test(name)) { out.error = "maiuscole non ammesse"; return out; }
    if (/[-.\s]/.test(name)) { out.error = "separatore ammesso solo '_' (trovato '-', '.' o spazio)"; return out; }
    const segs = name.split("_");
    out.segs = segs.length;
    if (segs.length < 2) { out.error = "serve almeno <cosa>_<dove> (la parola nuda e' solo nel dizionario)"; return out; }
    if (segs.length > 3) { out.error = "massimo 3 segmenti (il quarto non esiste)"; return out; }
    for (const s of segs) if (!SEG.test(s)) { out.error = `segmento '${s}' non valido ([a-z][a-z0-9]*)`; return out; }
    [out.cosa, out.dove, out.come = ""] = segs;
    if (!(out.cosa in DICT)) { out.error = `'${out.cosa}' non e' nel dizionario`; return out; }
    if (!DOVE.includes(out.dove)) { out.error = `'${out.dove}' non e' nel vocabolario dove (${DOVE.join("|")})`; return out; }
    out.tipo = DICT[out.cosa];
    out.ok = true;
    return out;
}
