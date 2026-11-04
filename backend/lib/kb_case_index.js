/**
 * kb_case_index.js — spisové značky rozhodnutí, která jsou ve znalostní bázi (revize 4. 11. 2026).
 *
 * Inspirace CENDAI / iSoud (Vrchní soud v Praze): judikatura se ověřuje JEN proti přesně vymezeným
 * důvěryhodným zdrojům a neověřená rozhodnutí se do výstupu nedostanou. Dosud citation_verifier znal
 * sp. zn. jen z pasáží, které RAG zrovna vrátil, takže správně citované rozhodnutí z báze (mimo top-k)
 * bylo „neověřené“ a vymyšlené se jen označilo. Tady z názvů souborů judikatury v bázi (NS_/US_/NSS_,
 * lib/judikatura_cite.spznFromFileName) sestavíme množinu sp. zn. pro referenceIndex.caseNumbers.
 *
 * vypustNeoverene(text, citations): rozhodnutí, která nejsou v bázi, v podkladech ani v externím zdroji,
 * nahradí v odpovědi polem „[rozhodnutí neověřeno — vypuštěno]“ — jen když báze judikatury opravdu
 * existuje (≥ MIN_INDEX sp. zn.), jinak by mizela i skutečná rozhodnutí. LEXIS_NEOVERENE_JUDIKATY=oznacit
 * vrátí dřívější chování (jen ⚠ NEOVĚŘENO).
 */
'use strict';

const { normalizeCitation } = require('./citation_verifier');

const TTL_MS = parseInt(process.env.LEXIS_KB_CASE_INDEX_TTL_MS || '', 10) || 30 * 60 * 1000;
const MIN_INDEX = parseInt(process.env.LEXIS_KB_CASE_INDEX_MIN || '', 10) || 100;
const ZNACKA = '[rozhodnutí neověřeno — vypuštěno]';
let _cache = null, _at = 0;

/** Klíče sp. zn. pro porovnání (i bez pořadového čísla NSS „-36“). */
function klice(spzn) {
    const k = normalizeCitation(spzn);
    const out = new Set([k]);
    out.add(k.replace(/-\d+$/, ''));
    return out;
}

function indexZNazvu(fileNames) {
    const { spznFromFileName } = require('./judikatura_cite');
    const set = new Set();
    for (const f of fileNames) {
        const s = spznFromFileName(f);
        if (s) for (const k of klice(s)) set.add(k);
    }
    return set;
}

// Báze judikatury je velká (stovky tisíc pasáží) → index se staví ASYNCHRONNĚ na pozadí (nesmí blokovat
// server, viz noční test 31. 10.). Do té doby je prázdný = nic se nevypouští, jen označuje (bezpečná strana).
let _building = null;
async function _build() {
    const rag = require('./rag');
    const names = new Set();
    for (const scope of rag.listKbScopes()) {
        const part = await (rag.loadPartitionShared ? rag.loadPartitionShared(scope) : rag.loadPartitionAsync(scope));
        for (const c of (part && part.chunks) || []) if (c && c.fileName && /^(NSS|NS|US)_/.test(String(c.fileName).split('/').pop())) names.add(c.fileName);
    }
    return indexZNazvu(names);
}
function obnov() {
    if (_building) return _building;
    _building = _build().then(set => { _cache = set; _at = Date.now(); return set; })
        .catch(() => _cache || new Set()).finally(() => { _building = null; });
    return _building;
}
/** Aktuální index (synchronně, případně zastaralý); po TTL se na pozadí obnoví. */
function getKbCaseIndex() {
    if (!_cache || Date.now() - _at >= TTL_MS) { if (typeof process.env.JEST_WORKER_ID === 'undefined' || _testBuild) obnov(); }
    return _cache || new Set();
}
let _testBuild = false;

/** referenceIndex pro citation_verifier (prázdný, když báze judikatury není). */
function referenceIndex() {
    const caseNumbers = getKbCaseIndex();
    return { laws: {}, caseNumbers: caseNumbers.size >= MIN_INDEX ? caseNumbers : new Set() };
}

/**
 * Vypustí neověřená rozhodnutí z textu. citations = výstup verifyCitationsWithSources().citations.
 * → { text, vypusteno: [sp. zn.…] }
 */
function vypustNeoverene(text, citations, opts) {
    const o = opts || {};
    const rezim = String(process.env.LEXIS_NEOVERENE_JUDIKATY || 'vypustit').toLowerCase();
    const velikost = o.indexSize != null ? o.indexSize : getKbCaseIndex().size;
    if (rezim === 'oznacit' || velikost < MIN_INDEX) return { text: String(text || ''), vypusteno: [] };
    const spatne = [...new Set((citations || []).filter(c => c && c.type === 'judikat' && c.status === 'unverified_case').map(c => c.raw))]
        .sort((a, b) => b.length - a.length);
    let out = String(text || '');
    const vypusteno = [];
    for (const raw of spatne) {
        const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // i s případným „sp. zn.“ před a „⚠ NEOVĚŘENO“ za značkou
        const re = new RegExp('(?:sp\\.\\s*zn\\.\\s*)?' + esc + '(?:\\s*⚠ NEOVĚŘENO)?', 'g');
        if (re.test(out)) { out = out.replace(re, ZNACKA); vypusteno.push(raw); }
    }
    return { text: out, vypusteno };
}

function upozorneni(vypusteno) {
    if (!vypusteno || !vypusteno.length) return '';
    return `• Vypuštěno ${vypusteno.length}× rozhodnutí, které není v bázi judikatury ani v podkladech (${vypusteno.slice(0, 4).join(', ')}${vypusteno.length > 4 ? ' …' : ''}) — model ho mohl vymyslet; existenci ověřte, než ho použijete.`;
}

function _reset() { _cache = null; _at = 0; _building = null; }
function _setForTest(set) { _cache = set; _at = Date.now(); }

module.exports = { getKbCaseIndex, obnov, referenceIndex, vypustNeoverene, upozorneni, indexZNazvu, ZNACKA, MIN_INDEX, _reset, _setForTest };
