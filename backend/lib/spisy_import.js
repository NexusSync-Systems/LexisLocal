/**
 * lib/spisy_import.js — import stávajících spisů z CSV (export z Excelu nebo jiného
 * spisového systému), aby hlídače (jednání, insolvence, lhůty) měly co hlídat od 1. dne.
 *
 * Oddělovač se pozná sám (; , tab — český Excel ukládá středník), první řádek je hlavička.
 * Sloupce se poznají podle názvu (česky i anglicky, bez ohledu na diakritiku a velikost):
 *   spisZn | nazev | klient | klientIco | protistrana | soud | soudKod | odpovednyAdvokat | insZn | agenda | poznamka
 * Spis se stejnou sp. zn. se nezakládá podruhé (jen se ohlásí).
 */
'use strict';

const ALIASES = {
    spisZn: ['spiszn', 'spisova znacka', 'sp. zn.', 'sp zn', 'spzn', 'znacka', 'case number', 'casenumber', 'spisova znacka soudu'],
    nazev: ['nazev', 'nazev spisu', 'vec', 'predmet', 'name', 'title'],
    klient: ['klient', 'client', 'mandant'],
    klientIco: ['klientico', 'ico klienta', 'ico', 'klient ico'],
    protistrana: ['protistrana', 'odpurce', 'counterparty', 'protistrana / odpurce'],
    soud: ['soud', 'court', 'nazev soudu'],
    soudKod: ['soudkod', 'kod soudu', 'court code'],
    odpovednyAdvokat: ['odpovednyadvokat', 'advokat', 'odpovedny advokat', 'lawyer', 'zpracovatel'],
    insZn: ['inszn', 'insolvence', 'insolvencni rizeni', 'ins sp. zn.', 'sp. zn. insolvence', 'isir'],
    agenda: ['agenda', 'obor', 'typ'],
    poznamka: ['poznamka', 'note', 'poznamky']
};
const _norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function detectDelimiter(firstLine) {
    const counts = [';', ',', '\t'].map(d => [d, (String(firstLine).match(new RegExp(d === '\t' ? '\t' : '\\' + d, 'g')) || []).length]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] ? counts[0][0] : ';';
}

/** RFC 4180-ish: uvozovky, zdvojené uvozovky, nové řádky v poli. */
function parseCsv(text, delim) {
    const t = String(text || '').replace(/^﻿/, '');
    const d = delim || detectDelimiter(t.split(/\r?\n/)[0]);
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (q) {
            if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else q = false; }
            else field += c;
        } else if (c === '"') q = true;
        else if (c === d) { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && t[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some(x => x.trim() !== '')) rows.push(row);
            row = [];
        } else field += c;
    }
    row.push(field);
    if (row.some(x => x.trim() !== '')) rows.push(row);
    return rows;
}

function mapHeader(header) {
    const map = {}; const unknown = [];
    header.forEach((h, i) => {
        const n = _norm(h);
        const key = Object.keys(ALIASES).find(k => _norm(k) === n || ALIASES[k].includes(n));
        if (key && map[key] === undefined) map[key] = i; else if (n) unknown.push(h.trim());
    });
    return { map, unknown };
}

/**
 * Rozbor + (volitelně) založení. opts.dryRun = jen náhled. opts.owner = vlastník
 * (ID uživatele) pro nové spisy. Vrací { rows:[{ line, status, spisZn, nazev, reason }], summary }.
 */
function importCsv(text, opts = {}) {
    const spisy = require('./spisy');
    const rows = parseCsv(text);
    if (rows.length < 2) return { ok: false, reason: 'Soubor nemá hlavičku a alespoň jeden řádek se spisem.' };
    const { map, unknown } = mapHeader(rows[0]);
    if (map.spisZn === undefined && map.nazev === undefined) {
        return { ok: false, reason: 'V hlavičce chybí sloupec „Spisová značka“ nebo „Název“.', header: rows[0] };
    }
    if (rows.length - 1 > 5000) return { ok: false, reason: 'Najednou lze importovat nejvýše 5000 spisů.' };
    const out = []; const seen = new Set();
    for (let r = 1; r < rows.length; r++) {
        const get = k => (map[k] !== undefined ? String(rows[r][map[k]] || '').trim() : '');
        const data = {}; Object.keys(ALIASES).forEach(k => { const v = get(k); if (v) data[k] = v; });
        const line = r + 1;
        if (!data.spisZn && !data.nazev) { out.push({ line, status: 'chyba', reason: 'Chybí spisová značka i název.' }); continue; }
        const key = _norm(data.spisZn);
        if (data.spisZn && seen.has(key)) { out.push({ line, status: 'duplicita', spisZn: data.spisZn, reason: 'Stejná sp. zn. je v souboru víckrát.' }); continue; }
        if (data.spisZn) seen.add(key);
        const existing = data.spisZn ? spisy.findByCase(data.spisZn) : null;
        if (existing) { out.push({ line, status: 'existuje', spisZn: data.spisZn, nazev: existing.nazev || '', id: existing.id }); continue; }
        let warn = null;
        if (data.insZn && !require('./isir_cases').parseInsZn(data.insZn)) {
            warn = `„${data.insZn}“ není sp. zn. insolvenčního řízení — insolvence se u spisu nebude hlídat.`;
            delete data.insZn;
        }
        if (opts.dryRun) { out.push({ line, status: 'nový', spisZn: data.spisZn || '', nazev: data.nazev || '', reason: warn }); continue; }
        try {
            if (opts.owner) data.owner = opts.owner;
            const s = spisy.createSpis(data);
            out.push({ line, status: 'založen', spisZn: s.spisZn, nazev: s.nazev, id: s.id, reason: warn });
        } catch (e) { out.push({ line, status: 'chyba', spisZn: data.spisZn, reason: e.message }); }
    }
    const count = st => out.filter(x => x.status === st).length;
    return {
        ok: true, dryRun: !!opts.dryRun, columns: Object.keys(map), unknownColumns: unknown, rows: out,
        summary: { total: rows.length - 1, nove: count('nový') + count('založen'), existuje: count('existuje'), duplicita: count('duplicita'), chyba: count('chyba'), upozorneni: out.filter(x => x.reason && (x.status === 'nový' || x.status === 'založen')).length }
    };
}

module.exports = { importCsv, parseCsv, detectDelimiter, mapHeader };
