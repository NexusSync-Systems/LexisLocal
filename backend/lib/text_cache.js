/**
 * lib/text_cache.js — přečtený text dokumentů (PDF/DOCX/OCR) v paměti procesu.
 *
 * Test 2. 10. 2026: /api/inbox/content vracel u DOCX a skenů (PNG) surová binární data,
 * takže „Zobrazit“, „Analyzovat AI“ i asistenti dostali místo smlouvy bajty ZIPu/PNG.
 * Text už jednou přečte watcher (včetně OCR) — uložíme ho sem a route ho jen vrátí.
 * Záměrně jen v paměti (žádný nešifrovaný text na disku); po restartu se text
 * přečte znovu přes extractTextFromFile.
 */
'use strict';
const fs = require('fs');

const MAX_ENTRIES = 500;
const cache = new Map(); // filePath -> { mtimeMs, text }

function _mtime(filePath) {
    try { return fs.statSync(filePath).mtimeMs; } catch (e) { return null; }
}

function setText(filePath, text) {
    if (!filePath || typeof text !== 'string') return;
    cache.delete(filePath);
    cache.set(filePath, { mtimeMs: _mtime(filePath), text });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

function getText(filePath) {
    const e = cache.get(filePath);
    if (!e) return null;
    if (e.mtimeMs !== _mtime(filePath)) { cache.delete(filePath); return null; }
    return e.text;
}

/** Vrátí text dokumentu: z cache, jinak přečte (PDF/DOCX/obrázek přes OCR, TXT). */
async function getOrExtract(filePath) {
    const hit = getText(filePath);
    if (hit != null) return hit;
    const { extractTextFromFile } = require('./ocr');
    const r = await extractTextFromFile(filePath);
    const text = (r && r.text) || '';
    if (text) setText(filePath, text);
    return text;
}

module.exports = { setText, getText, getOrExtract, _cache: cache };
