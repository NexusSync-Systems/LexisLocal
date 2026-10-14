'use strict';
/**
 * audit_export.js — export auditní stopy JEDNOHO spisu (CSV pro Excel, DOCX protokol).
 * Kdo, kdy a co se spisem dělal: zápisy (logEvent) i čtení (logRead, details.access='read').
 */
const audit = require('./audit');

const SKIP_DETAIL_KEYS = new Set(['spisId', 'access']);

function _who(e) {
    if (e.actor && e.actor.name) return e.actor.name;
    return e.user || 'Systém';
}
function _kind(e) { return e.details && e.details.access === 'read' ? 'čtení' : 'změna'; }
function _local(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return String(ts || '');
    const p = n => String(n).padStart(2, '0');
    return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function _details(e) {
    const d = e.details || {};
    const parts = [];
    Object.keys(d).forEach(k => {
        if (SKIP_DETAIL_KEYS.has(k)) return;
        const v = d[k];
        if (v === null || v === undefined || v === '') return;
        parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : (typeof v === 'object' ? JSON.stringify(v) : v)}`);
    });
    return parts.join('; ');
}

/** Řádky exportu (od nejstaršího). */
function rowsForSpis(spisId) {
    return audit.getLogsForSpis(spisId).map(e => ({
        timestamp: e.timestamp,
        cas: _local(e.timestamp),
        uzivatel: _who(e),
        zarizeni: (e.actor && e.actor.device) || '',
        druh: _kind(e),
        ukon: e.operation || '',
        predmet: e.target || '',
        podrobnosti: _details(e),
        hash: e.hash ? String(e.hash).slice(0, 12) : ''
    }));
}

// CSV pro český Excel: BOM, středník, CRLF. Hodnoty začínající = + - @ se
// prefixují apostrofem (ochrana proti CSV/formula injection).
function _csvCell(v) {
    let s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
    const head = ['Čas (ISO)', 'Čas', 'Uživatel', 'Zařízení', 'Druh', 'Úkon', 'Předmět', 'Podrobnosti', 'Hash'];
    const lines = [head.map(_csvCell).join(';')];
    rows.forEach(r => lines.push([r.timestamp, r.cas, r.uzivatel, r.zarizeni, r.druh, r.ukon, r.predmet, r.podrobnosti, r.hash].map(_csvCell).join(';')));
    return '﻿' + lines.join('\r\n') + '\r\n';
}

function _e(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/** HTML protokol (podklad pro DOCX). */
function toHtml(spis, rows, chain, exportedBy) {
    const title = `Auditní stopa spisu ${spis.spisZn || spis.nazev || spis.id}`;
    const chainTxt = chain && chain.ok
        ? `Integrita auditního řetězu: v pořádku (ověřeno ${chain.checked} záznamů aktivního logu).`
        : `Integrita auditního řetězu: NARUŠENA${chain && chain.brokenAt !== undefined ? ` (záznam č. ${chain.brokenAt})` : ''} — kontaktujte správce.`;
    const body = rows.map(r => `<tr><td>${_e(r.cas)}</td><td>${_e(r.uzivatel)}</td><td>${_e(r.druh)}</td><td>${_e(r.ukon)}</td><td>${_e(r.predmet)}</td><td>${_e(r.podrobnosti)}</td></tr>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${_e(title)}</title></head><body>
<h1>${_e(title)}</h1>
<p>Spis: ${_e(spis.nazev || '')}${spis.klient ? ' — klient ' + _e(spis.klient) : ''}<br>
Vyhotoveno: ${_e(_local(new Date().toISOString()))}${exportedBy ? ', ' + _e(exportedBy) : ''}<br>
Počet záznamů: ${rows.length}<br>${_e(chainTxt)}</p>
<table border="1" cellpadding="3"><thead><tr><th>Čas</th><th>Uživatel</th><th>Druh</th><th>Úkon</th><th>Předmět</th><th>Podrobnosti</th></tr></thead>
<tbody>${body}</tbody></table>
<p>Čtení se zaznamenává nejvýš jednou za 15 minut na uživatele a spis.</p>
</body></html>`;
}

async function toDocx(spis, rows, chain, exportedBy) {
    const HTMLtoDOCX = require('html-to-docx');
    const html = toHtml(spis, rows, chain, exportedBy);
    const out = await HTMLtoDOCX(html, null, { title: 'Auditní stopa spisu', creator: 'LexisLocal', lang: 'cs-CZ', orientation: 'landscape', table: { row: { cantSplit: true } } });
    return Buffer.isBuffer(out) ? out : Buffer.from(out instanceof ArrayBuffer ? new Uint8Array(out) : await out.arrayBuffer());
}

module.exports = { rowsForSpis, toCsv, toHtml, toDocx, _csvCell };
