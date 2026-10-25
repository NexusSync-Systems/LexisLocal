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


function extractDecisions(text) {
    const out = [];
    RE_DECISION.lastIndex = 0; let m;
    while ((m = RE_DECISION.exec(String(text || '')))) if (!out.includes(m[0].trim())) out.push(m[0].trim());
    return out;
}

/**
 * Klíč rozhodnutí pro porovnání: agenda + číslo/rok (rok vždy čtyřmístně), u pléna ÚS
 * s předponou „pl". Senát se nebere v potaz — čísla jsou v rámci agendy a roku jedinečná
 * a zápis senátu se liší („III.ÚS" vs. „III. ÚS"), takže by porovnání zbytečně selhávalo.
 *   „III. ÚS 2498/23" → „ús 2498/2023";  „Pl.ÚS 43/23" → „plús 43/2023";
 *   „21 Cdo 1234/2019" → „cdo 1234/2019".
 */
function decisionKey(z) {
    const m = /(Pl\.\s*)?(ÚS|Cdo|Tdo|Odo|Afs|As|Ads|Azs|Ao|Aps|Ncu|Nd|Konf|Cdon|Tz)\s+(\d+)\/(\d{2,4})\b/i.exec(String(z || ''));
    if (!m) return null;
    const y = parseInt(m[4], 10);
    const year = m[4].length === 2 ? (y > 50 ? 1900 + y : 2000 + y) : y;
    return `${m[1] ? 'pl' : ''}${m[2].toLowerCase()} ${parseInt(m[3], 10)}/${year}`;
}

/** Klíče všech rozhodnutí zmíněných v textu. */
function keysOf(text, into) {
    const set = into || new Set();
    RE_DECISION.lastIndex = 0; let m;
    const s = String(text || '');
    while ((m = RE_DECISION.exec(s))) { const k = decisionKey(m[0]); if (k) set.add(k); }
    return set;
}

/**
 * Klíče rozhodnutí zmíněných kdekoli v bázi (zákony + judikatura), cache 10 min.
 * Dřív se celá báze slévala do JEDNOHO řetězce — s judikaturou NS a ÚS (~450 mil. znaků)
 * to naráží na limit délky řetězce ve V8; výjimka se tiše spolkla a program pak tvrdil,
 * že nemá ani rozhodnutí, která v bázi jsou. Množina klíčů je malá a roste lineárně.
 */
function kbKeys() {
    if (_cache != null && Date.now() - _at < TTL_MS) return _cache;
    const keys = new Set();
    try {
        const rag = require('./rag');
        for (const scope of rag.listKbScopes()) {
            const p = rag.loadPartition(scope);
            for (const c of (p && p.chunks) || []) keysOf(c.text, keys);
        }
    } catch (e) { /* bez báze: nic nemáme — rozhodnutí se pak hlásí jako neznámá */ }
    _cache = keys; _at = Date.now();
    return keys;
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
    const known = keysOf(opts.context || '', new Set(opts.kb != null ? keysOf(opts.kb) : kbKeys()));
    const future = decisions.filter(z => { const y = yearOf(z); return y != null && y > thisYear; });
    const unknown = decisions.filter(z => !future.includes(z) && !known.has(decisionKey(z)));
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

module.exports = { check, extractDecisions, yearOf, decisionKey, _reset };
