/**
 * lib/kb_law_index.js — které § (a které zákony) jsou ve znalostní bázi.
 *
 * Test 2. 10. 2026: „§ 57 OSŘ“ byl označen jako neověřený, přestože OSŘ je v bázi
 * (4 471 dokumentů z split-zakon.js s hlavičkou „Zákon č. 99/1963 Sb. — § 57“).
 * Verifier dřív znal jen pasáže, které RAG zrovna vrátil. Tady z hlaviček všech
 * KB pasáží sestavíme { '99/1963': Set('57', …) } — bez embeddingů, jen regex.
 * Cache v paměti, obnova po TTL (výchozí 10 min), ať upload nového zákona zabere.
 */
'use strict';

const TTL_MS = parseInt(process.env.LEXIS_KB_LAW_INDEX_TTL_MS || '', 10) || 10 * 60 * 1000;
const HEADER_RE = /Zákon\s+č\.\s*(\d{1,4}\/\d{4})\s*Sb\.\s*[—–-]\s*§\s*(\d+[a-z]?)/gi;
let _cache = null, _at = 0;

function indexFromTexts(texts) {
    const laws = {};
    for (const t of texts) {
        HEADER_RE.lastIndex = 0; let m;
        while ((m = HEADER_RE.exec(String(t || '')))) {
            (laws[m[1]] = laws[m[1]] || new Set()).add(m[2].toLowerCase());
        }
    }
    return laws;
}

function getKbLawIndex() {
    if (_cache && Date.now() - _at < TTL_MS) return _cache;
    let laws = {};
    try {
        const rag = require('./rag');
        const texts = [];
        for (const scope of rag.listKbScopes()) {
            if (String(scope).indexOf('_kb_obor_') === 0) continue; // judikatura
            const part = rag.loadPartition(scope);
            for (const c of (part && part.chunks) || []) texts.push(c.text);
        }
        laws = indexFromTexts(texts);
    } catch (e) { laws = {}; }
    _cache = laws; _at = Date.now();
    return laws;
}

function _reset() { _cache = null; _at = 0; }

module.exports = { getKbLawIndex, indexFromTexts, _reset };
