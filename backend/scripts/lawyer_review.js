#!/usr/bin/env node
'use strict';
/**
 * lawyer_review.js — podklady pro hodnocení výstupů agentů advokátem (naslepo).
 *
 *   node backend/scripts/lawyer_review.js [report.json]          → DOCX k přečtení + CSV k vyplnění
 *   node backend/scripts/lawyer_review.js --import vyplneno.csv  → souhrn hodnocení (Markdown + JSON)
 *
 * report.json = výstup server_suite (eval/server_suite/reports/*.json); bez argumentu se
 * vezme nejnovější. Z každé úlohy se bere 1. běh. Automatické skóre (regexy) se advokátovi
 * NEUKAZUJE — hodnotí naslepo; porovnání s automatem až v souhrnu po importu.
 */
const fs = require('fs');
const path = require('path');

const SUITE = path.join(__dirname, '..', 'eval', 'server_suite');
const OUT_ROOT = path.join(__dirname, '..', 'eval', 'lawyer_review');

const CRITERIA = [
    ['spravnost', 'Věcná a právní správnost', '1–5 (5 = bez chyby)'],
    ['citace', 'Citace zákonů / judikatury', 'A = správně, C = částečně, N = chybně / vymyšlené, - = nejsou potřeba'],
    ['uplnost', 'Úplnost (nic podstatného nechybí)', '1–5'],
    ['forma', 'Forma, tón, čeština', '1–5'],
    ['pouzitelnost', 'Použitelnost', 'A = poslal bych bez úprav, B = drobné úpravy, C = zásadní přepis, D = nepoužitelné'],
    ['kriticka', 'Kritická chyba (mohla by klienta poškodit)', 'A = ano / N = ne'],
    ['poznamka', 'Poznámka', 'volný text']
];
const CAT_LABEL = {
    kontrola_smluv: 'Kontrola smluv', bezpecnost_ai: 'Bezpečnost AI', dlouhy_kontext: 'Dlouhý dokument',
    lhuty: 'Lhůty', reserse: 'Rešerše', negativni: 'Neexistující zdroj (nesmí vymýšlet)', cizi_jazyk: 'Cizí jazyk',
    navrh_podani: 'Návrh podání', osobni_udaje: 'Osobní údaje', styl: 'Styl', reserse_judikatura: 'Rešerše judikatury'
};

function _e(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function _csv(v) { const s = String(v == null ? '' : v); return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

function latestReport() {
    const dir = path.join(SUITE, 'reports');
    const f = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort().pop();
    if (!f) throw new Error('V eval/server_suite/reports není žádný report.');
    return path.join(dir, f);
}

// Jednoduchý převod Markdownu odpovědi na HTML (nadpisy, odrážky, tučné) pro čitelný DOCX.
function mdToHtml(md) {
    const lines = String(md || '').split(/\r?\n/);
    const out = []; let inList = false;
    const inline = t => _e(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<i>$2</i>');
    let table = null;
    const flushTable = () => {
        if (!table) return;
        const [h, ...body] = table.filter(r => !r.every(c => /^:?-{2,}:?$/.test(c.trim())));
        out.push('<table border="1" cellpadding="3"><tr>' + h.map(c => '<th>' + inline(c.trim()) + '</th>').join('') + '</tr>' +
            body.map(r => '<tr>' + r.map(c => '<td>' + inline(c.trim()) + '</td>').join('') + '</tr>').join('') + '</table>');
        table = null;
    };
    for (const raw of lines) {
        const l = raw.trimEnd();
        if (/^\s*\|.*\|\s*$/.test(l)) {
            if (inList) { out.push('</ul>'); inList = false; }
            (table = table || []).push(l.trim().replace(/^\||\|$/g, '').split('|'));
            continue;
        }
        flushTable();
        const li = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
        if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(li[1]) + '</li>'); continue; }
        if (inList) { out.push('</ul>'); inList = false; }
        const h = l.match(/^#{1,6}\s+(.*)$/);
        if (h) out.push('<p><b>' + inline(h[1]) + '</b></p>');
        else if (l.trim()) out.push('<p>' + inline(l) + '</p>');
    }
    if (inList) out.push('</ul>');
    flushTable();
    return out.join('');
}

function buildItems(report, cases) {
    const byId = Object.fromEntries(cases.map(c => [c.id, c]));
    const first = {};
    (report.agentRuns || []).forEach(r => { if (!first[r.id] || (r.attempt || 1) < (first[r.id].attempt || 1)) first[r.id] = r; });
    return cases.filter(c => first[c.id]).map((c, i) => ({
        n: i + 1, id: c.id, category: c.category, categoryLabel: CAT_LABEL[c.category] || c.category,
        agent: c.agent, doc: c.doc || null, prompt: c.prompt, response: first[c.id].response || '',
        auto: { pass: !!first[c.id].pass, score: first[c.id].score }
    }));
}

async function generate(reportPath) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const cases = JSON.parse(fs.readFileSync(path.join(SUITE, 'cases.json'), 'utf8')).cases;
    const items = buildItems(report, cases);
    const label = path.basename(reportPath, '.json');
    const dir = path.join(OUT_ROOT, label);
    fs.mkdirSync(dir, { recursive: true });
    const meta = report.meta || {};

    const crit = CRITERIA.map(([, name, scale]) => `<tr><td>${_e(name)}</td><td>${_e(scale)}</td></tr>`).join('');
    const blocks = items.map(it => `
<h2>${it.n}. ${_e(it.id)} — ${_e(it.categoryLabel)} (asistent: ${_e(it.agent)})</h2>
<p><b>Zadání:</b> ${_e(it.prompt)}</p>
${it.doc ? `<p><b>Přiložený dokument:</b> ${_e(it.doc)} (smyšlený)</p>` : ''}
<p><b>Odpověď asistenta:</b></p>
${mdToHtml(it.response)}
<p><i>Hodnocení zapište do tabulky (CSV/Excel) na řádek ${_e(it.id)}.</i></p>`).join('');
    let key = '';
    try {
        const k = fs.readFileSync(path.join(SUITE, 'fixtures', 'ZADANI_A_OCEKAVANI.md'), 'utf8');
        key = `<h1>Příloha — očekávané body (číst až PO vlastním hodnocení)</h1>${mdToHtml(k)}`;
    } catch (e) { /* bez přílohy */ }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Hodnocení výstupů LexisLocal</title></head><body>
<h1>Hodnocení výstupů asistentů LexisLocal</h1>
<p>Běh: ${_e(meta.label || label)} · model ${_e(meta.model || '?')} · ${_e(String(meta.startedAt || '').slice(0, 10))} · ${items.length} úloh.
Všechny osoby, spisy a dokumenty jsou SMYŠLENÉ.</p>
<p>Prosíme, hodnoťte každou odpověď tak, jako by ji připravil koncipient: šlo by ji po kontrole použít?
Hodnocení zapisujte do přiloženého souboru <b>hodnoceni_${_e(label)}.csv</b> (otevře se v Excelu), jeden řádek = jedna úloha.</p>
<table border="1" cellpadding="3"><tr><th>Kritérium</th><th>Stupnice</th></tr>${crit}</table>
${blocks}
${key}
</body></html>`;
    const HTMLtoDOCX = require('html-to-docx');
    const out = await HTMLtoDOCX(html, null, { title: 'Hodnocení výstupů LexisLocal', creator: 'LexisLocal', lang: 'cs-CZ' });
    const buf = Buffer.isBuffer(out) ? out : Buffer.from(out instanceof ArrayBuffer ? new Uint8Array(out) : await out.arrayBuffer());
    const docx = path.join(dir, `hodnoceni_${label}.docx`);
    fs.writeFileSync(docx, buf);

    const head = ['ID', 'Kategorie', 'Asistent', ...CRITERIA.map(c => c[1])];
    const rows = [head, ...items.map(it => [it.id, it.categoryLabel, it.agent, ...CRITERIA.map(() => '')])];
    const csv = path.join(dir, `hodnoceni_${label}.csv`);
    fs.writeFileSync(csv, '﻿' + rows.map(r => r.map(_csv).join(';')).join('\r\n') + '\r\n');
    // Automatické skóre zvlášť (pro porovnání po importu, advokátovi se neposílá).
    fs.writeFileSync(path.join(dir, '_auto.json'), JSON.stringify({ report: path.basename(reportPath), items: items.map(i => ({ id: i.id, category: i.category, auto: i.auto })) }, null, 2));
    return { docx, csv, count: items.length };
}

function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const sep = (text.split(/\r?\n/)[0].match(/;/g) || []).length >= (text.split(/\r?\n/)[0].match(/,/g) || []).length ? ';' : ',';
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
        if (ch === '"') q = true;
        else if (ch === sep) { row.push(cell); cell = ''; }
        else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
        else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim()));
}

/** Souhrn vyplněného hodnocení. Čistá funkce nad řádky CSV (+ volitelně automat). */
function summarize(rows, auto) {
    const [head, ...data] = rows;
    const idx = name => head.findIndex(h => h.trim() === name);
    const col = k => idx(CRITERIA.find(c => c[0] === k)[1]);
    const num = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
    const items = data.map(r => ({
        id: r[0], category: r[1],
        spravnost: num(r[col('spravnost')]), uplnost: num(r[col('uplnost')]), forma: num(r[col('forma')]),
        citace: String(r[col('citace')] || '').trim().toUpperCase(),
        pouzitelnost: String(r[col('pouzitelnost')] || '').trim().toUpperCase(),
        kriticka: String(r[col('kriticka')] || '').trim().toUpperCase() === 'A',
        poznamka: r[col('poznamka')] || ''
    })).filter(i => i.spravnost !== null || i.pouzitelnost);
    const avg = k => { const v = items.map(i => i[k]).filter(x => x !== null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null; };
    const usable = items.filter(i => i.pouzitelnost === 'A' || i.pouzitelnost === 'B').length;
    const autoById = Object.fromEntries(((auto && auto.items) || []).map(a => [a.id, a.auto]));
    const disagree = items.filter(i => autoById[i.id] && (autoById[i.id].pass !== (i.pouzitelnost === 'A' || i.pouzitelnost === 'B')));
    const byCat = {};
    items.forEach(i => { const c = byCat[i.category] = byCat[i.category] || { n: 0, usable: 0 }; c.n++; if (i.pouzitelnost === 'A' || i.pouzitelnost === 'B') c.usable++; });
    return {
        n: items.length, spravnost: avg('spravnost'), uplnost: avg('uplnost'), forma: avg('forma'),
        usable, usablePct: items.length ? Math.round(usable / items.length * 100) : 0,
        critical: items.filter(i => i.kriticka).map(i => ({ id: i.id, poznamka: i.poznamka })),
        citaceChybne: items.filter(i => i.citace === 'N').map(i => i.id),
        byCat, disagreeWithAuto: disagree.map(i => ({ id: i.id, auto: autoById[i.id].pass ? 'prošlo' : 'neprošlo', advokat: i.pouzitelnost }))
    };
}

function toMarkdown(s, label) {
    const L = [`# Hodnocení advokátem — ${label}`, '',
        `- Ohodnoceno úloh: **${s.n}**`,
        `- Použitelné (bez úprav / drobné úpravy): **${s.usable}/${s.n} (${s.usablePct} %)**`,
        `- Průměr: správnost **${s.spravnost}**, úplnost **${s.uplnost}**, forma **${s.forma}** (z 5)`,
        `- Kritické chyby: **${s.critical.length}**${s.critical.length ? ' — ' + s.critical.map(c => `${c.id}${c.poznamka ? ' (' + c.poznamka + ')' : ''}`).join('; ') : ''}`,
        `- Chybné/vymyšlené citace: ${s.citaceChybne.length ? s.citaceChybne.join(', ') : 'žádné'}`, '',
        '| Kategorie | Použitelné |', '|---|---|',
        ...Object.entries(s.byCat).map(([c, v]) => `| ${c} | ${v.usable}/${v.n} |`), ''];
    if (s.disagreeWithAuto.length) {
        L.push('Kde se advokát rozchází s automatickým testem (kandidáti na úpravu regexů nebo promptů):', '');
        s.disagreeWithAuto.forEach(d => L.push(`- ${d.id}: automat ${d.auto}, advokát ${d.advokat}`));
    }
    return L.join('\n') + '\n';
}

async function main(argv) {
    if (argv[0] === '--import') {
        const csvPath = argv[1];
        if (!csvPath) throw new Error('Použití: --import vyplneno.csv');
        const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
        let auto = null;
        try { auto = JSON.parse(fs.readFileSync(path.join(path.dirname(csvPath), '_auto.json'), 'utf8')); } catch (e) { auto = null; }
        const s = summarize(rows, auto);
        const label = path.basename(csvPath, '.csv');
        const md = toMarkdown(s, label);
        fs.writeFileSync(path.join(path.dirname(csvPath), `souhrn_${label}.md`), md);
        fs.writeFileSync(path.join(path.dirname(csvPath), `souhrn_${label}.json`), JSON.stringify(s, null, 2));
        process.stdout.write(md);
        return;
    }
    const r = await generate(argv[0] ? path.resolve(argv[0]) : latestReport());
    console.log(`Hotovo: ${r.count} úloh\n  k přečtení: ${r.docx}\n  k vyplnění: ${r.csv}`);
}

if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error('❌ ' + e.message); process.exit(1); });

module.exports = { buildItems, summarize, parseCsv, mdToHtml, toMarkdown, CRITERIA };
