/**
 * lib/revision_check.js — zapracoval agent připomínky advokáta ke konceptu?
 *
 * Serverový test 5. 10. 2026 (U7, 2/3): připomínka „Doplň odvolací důvod … (§ 205 odst. 2
 * písm. g) o. s. ř.)“ — model jednou vrátil novou verzi bez § 205. Program proto ověří, že
 * paragrafy zmíněné v otevřených připomínkách v novém znění jsou. Když ne: jedna oprava
 * modelem; když ani potom, připojí se pole [Doplnit – …], aby připomínka nezapadla.
 */
'use strict';

const RE_PAR = /§\s*(\d{1,4}[a-z]?)\b/gi;

/** Otevřené připomínky s paragrafy: [{ text, refs: ['205'] }] (jen ty, které nějaký § mají). */
function commentRefs(comments) {
    const out = [];
    for (const c of comments || []) {
        if (!c || c.resolved) continue;
        const text = String(c.text || '').trim();
        if (!text) continue;
        const refs = [];
        RE_PAR.lastIndex = 0; let m;
        while ((m = RE_PAR.exec(text))) if (!refs.includes(m[1].toLowerCase())) refs.push(m[1].toLowerCase());
        if (refs.length) out.push({ text, refs });
    }
    return out;
}

function _has(text, ref) {
    return new RegExp('§\\s*' + ref.replace(/[a-z]$/, '$&?') + '(?![\\d])', 'i').test(String(text || ''));
}

/** Připomínky, jejichž paragraf v textu chybí. */
function missingComments(text, items) {
    return (items || []).filter(it => it.refs.some(r => !_has(text, r)));
}

function retryMessage(miss) {
    return 'V novém znění chybí zapracování těchto připomínek advokáta:\n' +
        miss.map(it => `- ${it.text}`).join('\n') +
        '\nZapracuj je přímo do textu dokumentu (včetně uvedených paragrafů) a vrať znovu CELÉ nové znění dokumentu, bez komentářů k úpravám.';
}

function appendix(miss) {
    if (!miss.length) return '';
    return '\n\n' + miss.map(it => `[Doplnit – zapracovat připomínku advokáta: ${it.text.replace(/\s+/g, ' ')}]`).join('\n');
}

module.exports = { commentRefs, missingComments, retryMessage, appendix };
