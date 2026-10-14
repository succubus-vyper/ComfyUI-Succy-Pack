// ============================================================
// pieces/table.js — table_box (D-67)
// Editable table inside the mask: a label column + N value columns, each with its own
// format. The data lives in ONE JSON written to a ref (usually a hidden native widget, so the Python can read it):
//   { "fmt": ["STRING", ...maxCols], "names": ["", ...maxCols], "rows": [["label", "v1", ..., "vMax"], ...maxRows] }
// `names` (D-90) = the label of each column, typed in the header (empty = the column keeps its own name, cmb1, cmb2...).
// Rows have always had a label; now the columns get to be called something too. Nobody likes being a number, honey.
// Visible rows and columns come from two refs (e.g. $native.num_options / $native.num_values); data beyond them stays
// saved (removing a column and putting it back loses nothing).
// - Typing: click in the cell. Pasting several lines into a cell = fills the column downwards (with TAB also
//   the columns to the right, Excel-style); if there aren't enough rows they grow (max maxRows).
// - ✎ at the head of a column = v2 editor (one entry per line, type or paste). Rows can only GROW
//   (agreed with the user): only the stepper shrinks them, and data in hidden rows stays saved.
// - Column format: click on the format at the top. Row number: click = picks that row (`selected` ref).
// - The node widens to the right one column at a time (api.wantWidth). It opens up slowly.
// ============================================================
import { mkEl } from "../components/index.js";
import { piece } from "../catalog/registry.js";
import { C, ex, N, S, B, R, J } from "../catalog/kit.js";
import { parseRef } from "../core/parser.js";
import { writeRef } from "../core/binding.js";
import { FloatMenu } from "../menu/float-menu.js";
import { Tip } from "../menu/tip.js";

const FORMATS = ["STRING", "INT", "FLOAT", "BOOLEAN", "LIST", "DICT", "ARRAY", "JSON", "COMBO"];
const HELP = "One item per line, top to bottom = row 1, row 2…\n"
    + "• Type them one under the other (Enter = next row)\n"
    + "• or paste a whole list (from a text file, Excel, a column…)\n"
    + "Empty lines become empty cells. Rows that get no line are emptied.";
const USERS = new Set();      // live tables (the Governor's "Tables" light)
let UID = 0;

const clampInt = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

piece(C("table_box", {
    scopo: "Tabella modificabile: etichette + N colonne di valori col loro formato, JSON su un ref; incolla multiriga ed editor di colonna.",
    natura: "funziona", estado: "draft", archetipo: "renderer-host",
    tag: ["tabella", "dati", "colonne", "incolla"], uses: ["menu_float_panel", "menu_float_list", "textarea_element", "button_element", "label_element", "stack_box", "row_box"],
    props: {
        data: { ...R("ref scrivibile al JSON {fmt:[...], names:[...], rows:[[label, v1, ...]]} (es. $native.table)"), required: true },
        rows: { ...R("ref al numero di righe visibili (scrivibile: incolla/editor lo aumentano)"), required: true },
        cols: { ...R("ref al numero di colonne di valori visibili"), required: true },
        maxRows: N("righe massime", 20), maxCols: N("colonne di valori massime", 8),
        selected: R("ref alla riga scelta (0 = prima): evidenziata; click sul numero la sceglie"),
        formats: J("voci del formato di colonna", FORMATS),
        colName: S("nome delle colonne (+ numero)", "cmb"), labelName: S("nome della colonna etichette", "Label"),
        labelW: N("larghezza minima colonna etichette (px)", 104), colW: N("larghezza minima colonna valori (px)", 92),
        grow: B("il nodo si allarga quando aumentano le colonne", true),
        help: S("guida dell'editor di colonna", HELP),
    },
    css: `
.ns-table{display:flex;flex-direction:column;gap:3px;padding:2px 0 4px;font:11px var(--ns-font,sans-serif);color:var(--ns-fg)}
.ns-table-row{display:grid;gap:4px;align-items:center}
.ns-table-head{color:var(--ns-fg-faint);font:bold 10px monospace;letter-spacing:.4px;text-transform:uppercase}
.ns-table-hcell{display:flex;align-items:center;gap:3px;min-width:0}
.ns-table-hcell{flex-wrap:wrap}
.ns-table-hname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ns-table-hin{flex:1 1 100%;min-width:0;height:18px;box-sizing:border-box;padding:0 5px;border:1px solid var(--ns-border);border-radius:4px;background:var(--ns-bg-2);color:var(--ns-fg);font:bold 10px monospace;letter-spacing:0;text-transform:none;outline:none}
.ns-table-hin:focus{border-color:var(--ns-border-hi)}
.ns-table-btn{flex:0 0 auto;height:18px;min-width:18px;padding:0 4px;border:1px solid var(--ns-border);border-radius:4px;background:var(--ns-bg-2);color:var(--ns-fg);font:10px monospace;cursor:pointer;line-height:16px}
.ns-table-btn:hover{border-color:var(--ns-border-hi)}
.ns-table-fmt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:left;color:var(--ns-accent)}
.ns-table-num{height:22px;border:1px solid var(--ns-border);border-radius:4px;background:var(--ns-bg-2);color:var(--ns-fg-faint);font:10px monospace;cursor:pointer;padding:0}
.ns-table-row.ns-sel .ns-table-num{background:var(--ns-accent);color:var(--ns-accent-fg);border-color:var(--ns-accent)}
.ns-table-cell{height:22px;min-width:0;box-sizing:border-box;padding:0 6px;border:1px solid var(--ns-border);border-radius:4px;background:var(--ns-bg-2);color:var(--ns-fg);font:11px var(--ns-font,sans-serif);outline:none}
.ns-table-cell:focus{border-color:var(--ns-border-hi)}
.ns-table-row.ns-sel .ns-table-cell{border-color:var(--ns-c-accent-tint,var(--ns-border-hi))}
.ns-table-note{min-height:12px;color:var(--ns-warn);font:10px monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-table-ta{flex:1 1 auto;min-height:150px;font:12px monospace;resize:none;white-space:pre}
.ns-table-help,.ns-pv2 .ns-label.ns-table-help{white-space:pre-line}
`,
    esempio: ex({ t: "table_box", data: "$state.t", rows: 2, cols: 2 }, { state: { t: { policy: "immediate", default: "" } } }),
}), (node, h) => {
    const { rt } = h;
    const uid = ++UID;
    const maxRows = clampInt(h.val(node.maxRows) ?? 20, 1, 200, 20);
    const maxCols = clampInt(h.val(node.maxCols) ?? 8, 1, 32, 8);
    const formats = Array.isArray(node.formats) && node.formats.length ? node.formats.map(String) : FORMATS;
    const colName = String(node.colName ?? "cmb"), labelName = String(node.labelName ?? "Label");
    const labelW = Number(node.labelW) || 104, colW = Number(node.colW) || 92, NUMW = 22, GAP = 4;
    const st = { rt, err: "", rows: 0, cols: 0, pastes: 0, edits: 0 };
    USERS.add(st); h.bag.add(() => USERS.delete(st));

    // ---- ref: read/write (a literal number in the spec is read-only) ----
    const writable = (p) => typeof p === "string" && p.startsWith("$");
    const put = (p, v) => (writable(p) ? writeRef(rt, parseRef(p), v) : false);
    const nRows = () => clampInt(h.val(node.rows), 1, maxRows, 1);
    const nCols = () => clampInt(h.val(node.cols), 1, maxCols, 1);
    const selIdx = () => (node.selected === undefined ? -1 : clampInt(h.val(node.selected), 0, maxRows - 1, 0));

    let rawSeen = null, model = null;
    const read = () => {
        const raw = h.val(node.data);
        if (raw === rawSeen && model) return model;
        rawSeen = raw;
        let o = null;
        if (typeof raw === "string" && raw.trim()) { try { o = JSON.parse(raw); st.err = ""; } catch (e) { st.err = "data is not JSON"; console.warn("[NodeStructure] table_box: data is not JSON", e); } }
        else if (raw && typeof raw === "object") o = raw;
        const fmt = Array.from({ length: maxCols }, (_, i) => { const f = String(o?.fmt?.[i] ?? "STRING").toUpperCase(); return formats.includes(f) ? f : formats[0]; });
        const rows = Array.from({ length: maxRows }, (_, r) => {
            const src = Array.isArray(o?.rows?.[r]) ? o.rows[r] : null;
            return Array.from({ length: maxCols + 1 }, (_, c) => (src && src[c] != null ? String(src[c]) : c === 0 && !src ? `Option ${r + 1}` : ""));
        });
        const names = Array.from({ length: maxCols }, (_, i) => String(o?.names?.[i] ?? ""));
        model = { fmt, names, rows };
        return model;
    };
    // callers hand over {fmt, rows}: the column names ride along untouched unless they bring their own
    const save = (m) => { if (!m.names) m.names = (model?.names || Array(maxCols).fill("")).slice(); model = m; rawSeen = JSON.stringify(m); put(node.data, rawSeen); };
    const setRows = (n) => { if (n !== nRows()) put(node.rows, clampInt(n, 1, maxRows, 1)); };

    // ---- DOM ----
    const el = mkEl("div", "ns-table");
    const head = mkEl("div", "ns-table-row ns-table-head");
    const body = mkEl("div", "ns-table-body");
    body.style.cssText = "display:flex;flex-direction:column;gap:3px";
    const note = mkEl("div", "ns-table-note");
    el.append(head, body, note);
    let noteTimer = null;
    const say = (t) => { note.textContent = t || ""; if (noteTimer) clearTimeout(noteTimer); if (t) noteTimer = setTimeout(() => { note.textContent = ""; }, 4000); };
    h.bag.add(() => { if (noteTimer) clearTimeout(noteTimer); });
    const stopKeys = (inp) => { for (const ev of ["keydown", "keyup", "keypress", "copy", "cut"]) h.listen(inp, ev, (e) => e.stopPropagation()); };

    let shape = "", cells = [];      // cells[r][c] = <input>
    const template = (k) => `${NUMW}px minmax(${labelW}px,1.2fr) repeat(${k},minmax(${colW}px,1fr))`;

    // ---- paste: several lines (and TAB) from a cell downwards / to the right ----
    const pasteAt = (r0, c0, text) => {
        let lines = String(text).replace(/\r\n?/g, "\n").split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        const k = nCols(), m = read(), rows = m.rows.map((r) => r.slice());
        const fit = Math.min(lines.length, maxRows - r0);
        let cut = 0;
        for (let i = 0; i < fit; i++) {
            const parts = lines[i].includes("\t") ? lines[i].split("\t") : [lines[i]];
            parts.forEach((v, j) => { const c = c0 + j; if (c <= k) rows[r0 + i][c] = v; else cut++; });
        }
        save({ fmt: m.fmt, rows });
        if (r0 + fit > nRows()) setRows(r0 + fit);
        st.pastes++;
        const lost = lines.length - fit;
        say(lost > 0 ? `max ${maxRows} rows: ${lost} line(s) dropped` : cut ? `${cut} value(s) beyond the last column dropped` : `pasted ${fit} line(s)`);
        rt.update();
    };

    // ---- column editor (menu v2) ----
    const menuName = "table-edit-" + uid, cacheKey = "__table_edit_" + uid;
    const openEditor = (c) => {
        const n = nRows(), m = read();
        rt.ctx.cache.set(cacheKey, m.rows.slice(0, n).map((r) => r[c]).join("\n"));
        const apply = () => {
            const txt = String(rt.ctx.cache.get(cacheKey) ?? "");
            let lines = txt.replace(/\r\n?/g, "\n").split("\n");
            while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
            const want = Math.min(maxRows, lines.length);
            const cur = read(), rows = cur.rows.map((r) => r.slice());
            const upto = Math.max(want, nRows());
            for (let i = 0; i < upto; i++) rows[i][c] = i < want ? lines[i] : "";
            save({ fmt: cur.fmt, rows });
            if (want > nRows()) setRows(want);          // the editor does NOT remove rows (agreed with the user): only the stepper shrinks them
            st.edits++;
            if (lines.length > maxRows) say(`max ${maxRows} rows: ${lines.length - maxRows} line(s) dropped`);
            FloatMenu.close(rt, menuName);
            rt.update();
        };
        FloatMenu.open(rt, menuName, {
            reopen: true, anchor: el,
            spec: { kind: "panel", look: "v2", size: "auto", dock: "subject", dismiss: "explicit",
                title: `Edit ${c === 0 ? labelName : colName + c}`,
                tree: { t: "stack_box", gap: 0, children: [
                    { t: "stack_box", class: "ns-m-main", children: [
                        { t: "stack_box", class: "ns-m-params", gap: 6, style: { height: "100%" }, children: [
                            { t: "label_element", variant: "hint", class: "ns-table-help", text: String(node.help ?? HELP).replace(/\{\{|\}\}/g, "").replace(/^\$/, "") },
                            { t: "textarea_element", class: "ns-table-ta", bind: "$cache." + cacheKey, stopKeys: true, placeholder: "one item per line…" },
                            { t: "row_box", justify: "flex-end", children: [
                                { t: "button_element", text: "Cancel", on: { click: () => FloatMenu.close(rt, menuName) } },
                                { t: "button_element", text: "Apply", variant: "primary", on: { click: apply } },
                            ] },
                        ] },
                    ] },
                ] } },
        });
    };

    // ---- column format: kit list ----
    const fmtMenu = "table-fmt-" + uid;
    const openFmt = (c, anchor) => {
        const m = read();
        FloatMenu.open(rt, fmtMenu, { anchor, reopen: true, spec: { kind: "list", items: formats.map((f) => ({ label: f, checked: m.fmt[c - 1] === f, action: () => { const cur = read(); const fmt = cur.fmt.slice(); fmt[c - 1] = f; save({ fmt, rows: cur.rows }); rt.update(); } })) } });
    };

    const build = (n, k) => {
        head.textContent = ""; body.textContent = ""; cells = [];
        head.style.gridTemplateColumns = template(k);
        head.append(mkEl("span"));
        for (let c = 0; c <= k; c++) {
            const hc = mkEl("div", "ns-table-hcell");
            const colTitle = () => (c === 0 ? labelName : read().names[c - 1] || `${colName}${c}`);
            const ed = mkEl("button", "ns-table-btn"); ed.type = "button"; ed.textContent = "✎";
            h.listen(ed, "click", (e) => { e.stopPropagation(); openEditor(c); });
            Tip.attach(h.bag, ed, () => ({ title: `Edit ${colTitle()}`, body: ["Write or paste the whole column, one item per line."] }));
            if (c === 0) { const name = mkEl("span", "ns-table-hname"); name.textContent = labelName; hc.append(name); }
            else {
                // D-90: the column label. Typing it renames the shown output (the wire stays cmbN); empty = back to cmbN
                const inp = mkEl("input", "ns-table-hin"); inp.type = "text"; inp.spellcheck = false; inp.placeholder = `${colName}${c}`; inp.dataset.col = String(c);
                inp.maxLength = 40; stopKeys(inp);
                h.listen(inp, "input", () => { const cur = read(); const names = cur.names.slice(); names[c - 1] = inp.value; save({ fmt: cur.fmt, names, rows: cur.rows }); });
                Tip.attach(h.bag, inp, () => ({ title: `${colName}${c} label`, body: [`Name shown on the output (the wire stays ${colName}${c}). Empty = ${colName}${c}.`] }));
                hc.append(inp);
            }
            if (c > 0) {
                const fb = mkEl("button", "ns-table-btn ns-table-fmt"); fb.type = "button"; fb.dataset.col = String(c);
                h.listen(fb, "click", (e) => { e.stopPropagation(); openFmt(c, fb); });
                Tip.attach(h.bag, fb, () => ({ title: `${colName}${c} format`, chip: read().fmt[c - 1], body: [`Output ${colName}${c} is converted to this type.`] }));
                hc.append(fb);
            }
            hc.append(ed);
            head.append(hc);
        }
        for (let r = 0; r < n; r++) {
            const row = mkEl("div", "ns-table-row"); row.style.gridTemplateColumns = template(k); row.dataset.row = String(r);
            const num = mkEl("button", "ns-table-num"); num.type = "button"; num.textContent = String(r);
            if (writable(node.selected)) {
                h.listen(num, "click", (e) => { e.stopPropagation(); put(node.selected, r); rt.update(); });
                Tip.attach(h.bag, num, () => ({ title: `Row ${r}`, body: [`Label: ${read().rows[r][0] || "(empty)"}`], hint: "Click to pick this row" }));
            }
            row.append(num);
            const line = [];
            for (let c = 0; c <= k; c++) {
                const inp = mkEl("input", "ns-table-cell"); inp.type = "text"; inp.spellcheck = false;
                inp.placeholder = c === 0 ? `Option ${r + 1}` : "value";
                stopKeys(inp);
                h.listen(inp, "input", () => { const cur = read(); const rows = cur.rows.map((x) => x.slice()); rows[r][c] = inp.value; save({ fmt: cur.fmt, rows }); });
                h.listen(inp, "paste", (e) => {
                    const t = e.clipboardData?.getData("text") ?? "";
                    e.stopPropagation();
                    if (!/[\n\t]/.test(t.replace(/\r?\n$/, ""))) return;     // a single entry: normal paste
                    e.preventDefault();
                    pasteAt(r, c, t);
                });
                row.append(inp); line.push(inp);
            }
            cells.push(line); body.append(row);
        }
    };

    const paint = () => {
        const n = nRows(), k = nCols(), m = read(), sel = selIdx();
        const sig = n + "x" + k;
        if (sig !== shape) {
            shape = sig; build(n, k);
            st.rows = n; st.cols = k;
            if (node.grow !== false) rt.api.wantWidth("table:" + uid, NUMW + labelW + k * colW + (k + 1) * GAP + 16);
        }
        const act = el.getRootNode?.()?.activeElement;
        cells.forEach((line, r) => line.forEach((inp, c) => { const v = m.rows[r][c]; if (inp !== act && inp.value !== v) inp.value = v; }));
        for (const hi of head.querySelectorAll(".ns-table-hin")) { const v = m.names[Number(hi.dataset.col) - 1] ?? ""; if (hi !== act && hi.value !== v) hi.value = v; }
        for (const fb of head.querySelectorAll(".ns-table-fmt")) { const f = m.fmt[Number(fb.dataset.col) - 1]; if (fb.textContent !== f) fb.textContent = f; }
        [...body.children].forEach((row, r) => row.classList.toggle("ns-sel", r === sel));
    };
    h.bag.add(() => { try { rt.api.wantWidth("table:" + uid, null); } catch (_) {} try { FloatMenu.close(rt, menuName); FloatMenu.close(rt, fmtMenu); } catch (_) {} rt.ctx.cache.delete?.(cacheKey); });
    paint();
    return { el, update: paint, handlesText: true };
});

export const Tables = {
    stats() {
        const all = [...USERS].filter((u) => !u.rt.destroyed);
        return { users: all.length, errors: all.filter((u) => u.err).map((u) => `${u.rt.node?.type} #${u.rt.node?.id}: ${u.err}`),
            shapes: all.map((u) => `${u.rows}x${u.cols}`), pastes: all.reduce((a, u) => a + u.pastes, 0), edits: all.reduce((a, u) => a + u.edits, 0) };
    },
};
