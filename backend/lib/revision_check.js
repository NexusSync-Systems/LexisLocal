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

// Obsahová slova připomínky (bez § a pokynů typu „doplň“) → kmeny pro porovnání s textem u §.
const _deacc = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const GENERIC = new Set(['dopln', 'doplnit', 'uprav', 'oprav', 'prosim', 'odvol', 'duvod', 'zapra', 'pridat', 'pridej',
    'zakon', 'odsta', 'pismo', 'text', 'konce', 'dokum', 'uvest', 'uved']);
function _stems(t) {
    const out = new Set();
    for (const w of _deacc(String(t).replace(/§[^)]*\)?/g, ' ')).split(/[^a-z]+/)) {
        if (w.length < 5) continue;
        const st = w.slice(0, 5);
        if (!GENERIC.has(st)) out.add(st);
    }
    return out;
}
// Úsek textu kolem každého výskytu § ref (řádek; u dlouhých řádků ±200 znaků).
function _contexts(text, ref) {
    const re = new RegExp('§\\s*' + ref.replace(/[a-z]$/, '$&?') + '(?![\\d])', 'gi');
    const t = String(text || ''); const out = []; let m;
    while ((m = re.exec(t))) {
        const ls = t.lastIndexOf('\n', m.index) + 1; let le = t.indexOf('\n', m.index); if (le < 0) le = t.length;
        out.push(le - ls > 500 ? t.slice(Math.max(ls, m.index - 200), Math.min(le, m.index + 200)) : t.slice(ls, le));
    }
    return out;
}
/**
 * Stojí paragraf u obsahu, o který připomínka žádá? (run 6: „§ 205 odst. 2 písm. g)“ model
 * připojil k „nesprávnému zjištění skutkového stavu“, ne k „nesprávnému právnímu posouzení“.)
 * Stačí, když aspoň jeden výskyt § sdílí s připomínkou ≥ 2 obsahová slova (nebo všechna, má-li méně).
 */
function _placedWell(text, it) {
    const want = _stems(it.text);
    if (!want.size) return true;
    const need = Math.min(2, want.size);
    return it.refs.every(r => _contexts(text, r).some(c => {
        const got = _stems(c); let n = 0;
        for (const w of want) if (got.has(w)) n++;
        return n >= need;
    }));
}

/** Připomínky, jejichž paragraf v textu chybí, nebo stojí u jiného obsahu. Každá má .reason. */
function missingComments(text, items) {
    const out = [];
    for (const it of items || []) {
        if (it.refs.some(r => !_has(text, r))) out.push(Object.assign({}, it, { reason: 'missing' }));
        else if (!_placedWell(text, it)) out.push(Object.assign({}, it, { reason: 'misplaced' }));
    }
    return out;
}

// Označení stran, která se v právních textech objevují; nová oproti podkladům = k ověření.
const ROLES = ['Žalobce', 'Žalobkyně', 'Žalovaný', 'Žalovaná', 'Výrobce', 'Prodávající', 'Kupující', 'Objednatel', 'Zhotovitel',
    'Pronajímatel', 'Nájemce', 'Dodavatel', 'Odběratel', 'Věřitel', 'Dlužník', 'Zaměstnavatel', 'Zaměstnanec', 'Pojistitel',
    'Pojišťovna', 'Ručitel', 'Zástavní věřitel', 'Poškozený', 'Obviněný', 'Navrhovatel', 'Odpůrce', 'Vedlejší účastník'];
/**
 * Strany / osoby v novém znění, které nejsou v původním konceptu, připomínkách ani zadání
 * (run 6: model do odvolání přidal „Výrobce“). Jen upozornění — text se nemění.
 */
function newParties(text, sourceText) {
    const src = _deacc(sourceText);
    const t = String(text || '');
    const found = [];
    for (const r of ROLES) {
        const stem = _deacc(r).slice(0, Math.max(5, _deacc(r).length - 2));
        if (new RegExp('(^|[^\\p{L}])' + r.slice(0, Math.max(5, r.length - 2)), 'u').test(t) && !src.includes(stem)) found.push(r);
    }
    // Celá jména (Jméno Příjmení) — dvě slova s velkým písmenem uprostřed věty.
    const re = /(?<=[a-zá-ž,]\s)([A-ZÁ-Ž][a-zá-ž]{2,})\s([A-ZÁ-Ž][a-zá-ž]{2,}(?:ová|á)?)\b/g; let m;
    while ((m = re.exec(t))) {
        const name = m[1] + ' ' + m[2];
        if (!src.includes(_deacc(m[2]).slice(0, 4)) && !found.includes(name)) found.push(name);
    }
    return found.slice(0, 8);
}

function retryMessage(miss) {
    return 'V novém znění chybí zapracování těchto připomínek advokáta (nebo je paragraf připojen k jinému obsahu, než připomínka žádá):\n' +
        miss.map(it => `- ${it.text}${it.reason === 'misplaced' ? ' — paragraf v textu stojí u jiného důvodu/obsahu; uveď ho přesně u toho, co připomínka požaduje' : ''}`).join('\n') +
        '\nZapracuj je přímo do textu dokumentu (včetně uvedených paragrafů) a vrať znovu CELÉ nové znění dokumentu, bez komentářů k úpravám.';
}

function appendix(miss) {
    if (!miss.length) return '';
    return '\n\n' + miss.map(it => it.reason === 'misplaced'
        ? `[Ověřit – § ${it.refs.join(', § ')} je v textu u jiného obsahu, než žádá připomínka advokáta: ${it.text.replace(/\s+/g, ' ')}]`
        : `[Doplnit – zapracovat připomínku advokáta: ${it.text.replace(/\s+/g, ' ')}]`).join('\n');
}

module.exports = { commentRefs, missingComments, retryMessage, appendix, newParties, _placedWell };
