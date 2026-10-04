/**
 * lib/output_checks.js — kontrola výstupu agenta PŘED odesláním advokátovi.
 *
 * Dvě skupiny:
 *   • opravy, které udělá program sám (oslovení, sjednocení polí [Doplnit – …]),
 *   • problémy, které musí opravit model → route ho JEDNOU požádá o opravu s konkrétní
 *     výtkou (chybí částka z podkladů, chybí lhůta, odpověď není česky, převzal údaje
 *     z ukázky…). Když ani druhý pokus neprojde, program použije lepší z obou verzí
 *     a co jde, doplní sám.
 *
 * checkOutput({ text, prompt, sourceText, demand, bilingual, agentId, examples })
 *   → { issues: [{ code, msg }], tokensFromExamples: [...] }
 * applyFixes(text, { sourceText, addressee }) → { text, fixes: [...] }
 * retryMessage(issues) → text pro model
 */
'use strict';

const { fixSalutations } = require('./cz_salutation');
const { _englishContext } = require('./agent_outlines');

const _digits = s => String(s || '').replace(/\D/g, '');

/** Sjednotí pole k doplnění: „[doplňte: jméno]“, „XXX“, „[jméno]“ → „[Doplnit – …]“. */
function normalizePlaceholders(text) {
    let n = 0;
    let t = String(text || '');
    t = t.replace(/\[\s*(?:doplňte|doplnit|doplň|DOPLNIT|Doplnit|DOPLŇTE)\s*[:\-–—]?\s*([^\]\n]{0,80})\]/g, (all, what) => {
        const w = String(what || '').trim();
        const out = w ? `[Doplnit – ${w}]` : '[Doplnit]';
        if (out !== all) n++;
        return out;
    });
    t = t.replace(/(?<![\p{L}\d])[Xx]{3,}(?![\p{L}\d])/gu, () => { n++; return '[Doplnit]'; });
    t = t.replace(/\[(jméno|příjmení|adresa|datum|částka|IČO?|číslo účtu|místo|podpis)\]/gi, (all, w) => { n++; return `[Doplnit – ${w.toLowerCase()}]`; });
    return { text: t, count: n };
}

/** Celková částka z podkladů: „celkem 86 000 Kč“, jinak nejvyšší částka v Kč. */
function sourceTotal(sourceText) {
    const s = String(sourceText || '');
    const amt = '(\\d{1,3}(?:[ \\u00a0.]\\d{3})+|\\d{3,})(?:,\\d{1,2}|,-)?\\s*(?:Kč|CZK|korun)';
    const tot = s.match(new RegExp('(?:celkem|celková|v\\s+celkové\\s+výši|dlužná\\s+částka|dluh\\s+činí|ve\\s+výši)[^\\d\\n]{0,30}' + amt, 'i'));
    if (tot) return { raw: tot[1], digits: _digits(tot[1]) };
    let best = null; const re = new RegExp(amt, 'gi'); let m;
    while ((m = re.exec(s))) { const d = _digits(m[1]); if (!best || Number(d) > Number(best.digits)) best = { raw: m[1], digits: d }; }
    return best;
}

const STOP = new Set(['okresní', 'okresního', 'okresním', 'krajský', 'krajského', 'krajském', 'městský', 'městského', 'nejvyšší', 'nejvyššího', 'ústavní', 'soud', 'soudu', 'česká', 'české', 'republika', 'republiky', 'občanský', 'občanského', 'zákoník', 'zákona', 'zákon', 'sb', 'kč', 'čak', 'věc', 'vážený', 'vážená', 'připrav', 'napiš', 'sepiš', 'vypracuj', 'navrhni', 'klient', 'klientka', 'klienta', 'klientku', 'naše', 'naší', 'náš', 'plná', 'plnou', 'moc', 'výzva', 'výzvu', 'doplnit']);

/** Údaje z ukázky (jména, místa, čísla ze ZADÁNÍ ukázky, která se objevila i ve výstupu ukázky). */
function exampleTokens(examples) {
    const out = new Set();
    for (const ex of examples || []) {
        const vy = String(ex.vystup || '');
        const words = String(ex.zadani || '').match(/[\p{Lu}][\p{L}]{2,}|\d{3,}/gu) || [];
        for (const w of words) {
            const low = w.toLowerCase();
            if (STOP.has(low)) continue;
            const stem = low.slice(0, Math.max(4, low.length - 3));
            if (vy.toLowerCase().includes(stem)) out.add(w);
        }
    }
    return [...out];
}

function _hasStem(text, token) {
    const low = token.toLowerCase();
    if (/^\d+$/.test(low)) return _digits(text).includes(low);
    const stem = low.slice(0, Math.max(4, low.length - 3));
    return new RegExp('(?<![\\p{L}])' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu').test(String(text || ''));
}

/** Tokeny ukázky, které model přenesl do výstupu (a nejsou v zadání ani podkladech). */
function copiedFromExamples(text, examples, sourceText) {
    return exampleTokens(examples).filter(t => _hasStem(text, t) && !_hasStem(sourceText, t));
}

function checkOutput({ text, prompt, sourceText, demand, bilingual, agentId, examples } = {}) {
    const t = String(text || '');
    const issues = [];
    const src = [prompt, sourceText].filter(Boolean).join('\n');
    const insufficient = /^\s*Nedostatek podkladů/i.test(t);
    const drafting = agentId === 'spisovatel' || demand;
    if (drafting && !insufficient && t.replace(/\s+/g, ' ').trim().length < 160) {
        issues.push({ code: 'too_short', msg: 'Výstup je příliš krátký — napiš celý dokument, ne jen úvod nebo komentář.' });
    }
    if (!bilingual && t.length > 200 && _englishContext(t)) {
        issues.push({ code: 'not_czech', msg: 'Odpověď není česky. Napiš ji celou česky.' });
    }
    if (demand && !insufficient) {
        const tot = sourceTotal(src);
        if (tot && tot.digits.length >= 3 && !_digits(t).includes(tot.digits)) {
            issues.push({ code: 'amount_missing', msg: `V dopise chybí celková požadovaná částka podle podkladů (${tot.raw} Kč). Uveď ji přesně.` });
        }
        if (!/do\s+\d{1,3}\s*(dn|dní|dnů|kalendářních)|lhůt|do\s+\d{1,2}\.\s?\d{1,2}\.\s?\d{4}|nejpozději/i.test(t)) {
            issues.push({ code: 'deadline_missing', msg: 'V dopise chybí lhůta k plnění (např. „do 15 dnů od doručení této výzvy“).' });
        }
        if (!/\[Doplnit/i.test(t)) {
            issues.push({ code: 'no_placeholders', msg: 'Údaje, které v podkladech nejsou (číslo účtu pro platbu, jméno a podpis advokáta), musí být jako [Doplnit – …], ne vynechané ani vymyšlené.' });
        }
    }
    const copied = copiedFromExamples(t, examples, src);
    if (copied.length) {
        issues.push({ code: 'copied_example', msg: `Převzal jsi údaje z ukázky (${copied.slice(0, 5).join(', ')}). Ukázka je jen vzor formy — použij údaje ze zadání a podkladů, chybějící jako [Doplnit – …].` });
    }
    return { issues, copied };
}

/** Deterministické opravy (bez modelu). */
function applyFixes(text, { addressee, gender, copied } = {}) {
    const fixes = [];
    let t = String(text || '');
    const ph = normalizePlaceholders(t);
    if (ph.count) { t = ph.text; fixes.push(`sjednocena pole k doplnění (${ph.count}×)`); }
    const sal = fixSalutations(t, { addressee, gender });
    if (sal.fixed.length) { t = sal.text; fixes.push(...sal.fixed.map(f => `oslovení „${f.from}“ → „${f.to}“`)); }
    for (const tok of copied || []) {
        const low = tok.toLowerCase();
        const stem = /^\d+$/.test(low) ? low : low.slice(0, Math.max(4, low.length - 3));
        const re = new RegExp('(?<![\\p{L}\\d])' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\p{L}]*', 'giu');
        if (re.test(t)) { t = t.replace(re, '[Doplnit – údaj z ukázky nepřebírat]'); fixes.push(`odstraněn údaj převzatý z ukázky (${tok})`); }
    }
    return { text: t, fixes };
}

function retryMessage(issues) {
    return 'Kontrola programu našla v tvé odpovědi tyto nedostatky:\n' +
        issues.map((i, n) => `${n + 1}. ${i.msg}`).join('\n') +
        '\nOprav je a vrať CELÝ opravený text (ne komentář k opravám). Ostatní obsah zachovej.';
}

/** Lepší ze dvou verzí: méně problémů; při shodě ta druhá (opravená). */
function better(a, b) { return (b.issues.length <= a.issues.length) ? b : a; }

module.exports = { checkOutput, applyFixes, retryMessage, normalizePlaceholders, sourceTotal, exampleTokens, copiedFromExamples, better };
