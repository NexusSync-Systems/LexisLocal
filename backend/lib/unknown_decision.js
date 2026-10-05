/**
 * lib/unknown_decision.js — dotaz na KONKRÉTNÍ soudní rozhodnutí, které nemáme.
 *
 * Serverový test 5. 10. 2026 (R3, 2/3): „Shrň závěry rozsudku NS sp. zn. 99 Cdo 9999/2031“ —
 * model dvakrát správně odmítl, jednou začal popisovat, k čemu soud „dospěl“. Spoléhat na
 * model nestačí, proto to rozhoduje program:
 *   • rozhodnutí s rokem v budoucnosti nemůže existovat,
 *   • rozhodnutí, které není v bázi judikatury, v podkladech ani v kontextu, nelze shrnout.
 * Když se uživatel ptá právě na obsah takového rozhodnutí, odpoví program sám (bez modelu).
 * Když ho jen zmíní, k odpovědi modelu se připojí upozornění.
 */
'use strict';

// Rozhodnutí vyšších soudů a ÚS (ne prvostupňové „C“) — stejné zkratky jako citation_verifier.
const RE_DECISION = /\b(?:\d{1,3}\s+|[IVX]{1,4}\.?\s+)?(?:Pl\.\s*ÚS|ÚS|Cdo|Tdo|Odo|Afs|As|Ads|Azs|Ao|Aps|Ncu|Nd|Konf|Cdon|Tz)\s+\d+\/\d{2,4}\b/g;
const RE_ASKS = /shr[nň]|shrnut|popi[šs]|z[aá]v[eě]r|co\s+(?:v\s+n[eě]m\s+)?(?:soud\s+)?(?:rozhodl|uvedl|konstatoval)|rozeb|obsah\s+(?:rozsudku|rozhodnut|usnesen|n[aá]lezu)|vysv[eě]tli\s+(?:rozsudek|rozhodnut|usnesen|n[aá]lez)|o\s+[čc]em\s+(?:je|byl)/i;
const TTL_MS = 10 * 60 * 1000;
let _cache = null, _at = 0;

const norm = s => String(s || '').replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/').trim().toLowerCase();

function extractDecisions(text) {
    const out = [];
    RE_DECISION.lastIndex = 0; let m;
    while ((m = RE_DECISION.exec(String(text || '')))) if (!out.includes(m[0].trim())) out.push(m[0].trim());
    return out;
}

/** Znormalizovaný text celé báze (zákony + judikatura), cache 10 min. */
function kbText() {
    if (_cache != null && Date.now() - _at < TTL_MS) return _cache;
    let t = '';
    try {
        const rag = require('./rag');
        const parts = [];
        for (const scope of rag.listKbScopes()) {
            const p = rag.loadPartition(scope);
            for (const c of (p && p.chunks) || []) parts.push(c.text);
        }
        t = norm(parts.join('\n'));
    } catch (e) { t = ''; }
    _cache = t; _at = Date.now();
    return t;
}
function _reset() { _cache = null; _at = 0; }

function yearOf(zn) {
    const m = /\/(\d{2,4})\b/.exec(zn);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    return m[1].length === 2 ? (y > 50 ? 1900 + y : 2000 + y) : y;
}

/**
 * @param {string} prompt
 * @param {object} [opts] { context, kb (text pro testy), now }
 * @returns {null | { future: string[], unknown: string[], asks: boolean, direct: boolean, text: string, notice: string }}
 */
function check(prompt, opts) {
    opts = opts || {};
    const decisions = extractDecisions(prompt);
    if (!decisions.length) return null;
    const thisYear = (opts.now || new Date()).getFullYear();
    const hay = norm(opts.context || '') + '\n' + (opts.kb != null ? norm(opts.kb) : kbText());
    const future = decisions.filter(z => { const y = yearOf(z); return y != null && y > thisYear; });
    const unknown = decisions.filter(z => !future.includes(z) && !hay.includes(norm(z)));
    if (!future.length && !unknown.length) return null;
    const asks = RE_ASKS.test(prompt);
    const missing = future.concat(unknown);
    const lines = [];
    future.forEach(z => lines.push(`Rozhodnutí sp. zn. ${z} nemůže existovat — rok ${yearOf(z)} je v budoucnosti. Spisovou značku prosím zkontrolujte.`));
    unknown.forEach(z => lines.push(`Rozhodnutí sp. zn. ${z} nemám k dispozici — není v bázi judikatury ani v podkladech, takže jeho obsah nelze ověřit ani shrnout.`));
    const text = lines.join('\n') + '\n\nCo s tím: ověřte spisovou značku a text rozhodnutí vložte do dotazu (nebo nahrajte do báze judikatury v záložce AI asistenti) — pak ho shrnu z jeho skutečného znění. Odhadovat obsah rozhodnutí, které nemám, nebudu.';
    const notice = '⚠️ ' + lines.join(' ') + ' Případné zmínky o něm níže nejsou ověřené.';
    // Program odpoví sám, jen když se dotaz týká obsahu rozhodnutí a žádné zmíněné nemáme.
    const direct = asks && missing.length === decisions.length;
    return { future, unknown, asks, direct, text, notice };
}

module.exports = { check, extractDecisions, yearOf, _reset };
