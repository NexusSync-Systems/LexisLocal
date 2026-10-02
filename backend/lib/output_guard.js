/**
 * lib/output_guard.js — deterministické kontroly výstupu agenta.
 *
 * 1) Vymyšlené identifikátory: Spisovatel (qwen2.5:7b) i přes pokyn v promptu dosadil
 *    do žaloby smyšlené IČO a č. smlouvy (test 1. 10. 2026). Každé IČO / DIČ / rodné
 *    číslo / číslo účtu / sp. zn. / č. smlouvy či faktury ve výstupu, které NENÍ v zadání
 *    ani v podkladech, nahradíme zástupným polem.
 * 2) Nesoulad čísla a názvu předpisu: Rešeršník napsal „zákona č. 89/2012 Sb. (Zákon
 *    o obchodním právu)“. Známá čísla předpisů porovnáme s názvem v okolí.
 */
'use strict';

const PLACEHOLDER = '[Doplnit – údaj nebyl v zadání]';

const _digits = s => String(s || '').replace(/\D/g, '');
const _norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');

// [label, regex] — skupina 1 = hodnota, kterou ověřujeme proti zdroji.
const ID_PATTERNS = [
    ['IČO', /(IČO?[\s:*]*)(\d{2}\s?\d{3}\s?\d{3})(?!\d)/g],
    ['DIČ', /(DIČ[\s:*]*)(CZ\s?\d{8,10})(?!\d)/gi],
    ['rodné číslo', /(rodn[éeého]+\s+čísl[oa]\s*:?\s*|r\.\s?č\.[\s:*]*)(\d{6}\s?\/\s?\d{3,4})(?!\d)/gi],
    ['číslo účtu', /((?:č\.\s?ú\.|čísl[oa]\s+účtu|účet(?:\s+č\.)?)[\s:*]*)((?:\d{1,6}-)?\d{2,10}\s?\/\s?\d{4})(?!\d)/gi],
    ['sp. zn.', /((?:sp\.\s?zn\.|spisov[áé]\s+značk[ay])[\s:*]*)(\d{1,3}\s?[A-Za-zČŘŠŽ]{1,4}\s?\d{1,6}\s?\/\s?\d{4}(?:-\d+)?)/gi],
    ['č. smlouvy/faktury', /((?:smlouv[ay]|faktur[ay]|objednávk[ay])\s+(?:č\.|číslo)[\s:*]*)([A-Z0-9][A-Z0-9\/\-]{2,})/gi]
];

function guardInventedIdentifiers(output, sourceText) {
    const srcDigits = _digits(sourceText);
    const srcNorm = _norm(sourceText);
    const replaced = [];
    let text = String(output || '');
    for (const [label, re] of ID_PATTERNS) {
        text = text.replace(re, (all, prefix, value) => {
            const dv = _digits(value);
            const known = (dv.length >= 4 && srcDigits.includes(dv)) || srcNorm.includes(_norm(value));
            if (known) return all;
            replaced.push({ label, value });
            return prefix + PLACEHOLDER;
        });
    }
    return { text, replaced };
}

// Číslo předpisu → klíčová slova, z nichž aspoň jedno musí být v názvu uvedeném u čísla.
const LAWS = {
    '89/2012': { name: 'občanský zákoník', kw: ['občansk', 'oz'] },
    '99/1963': { name: 'občanský soudní řád', kw: ['soudní řád', 'osř', 'o.s.ř'] },
    '90/2012': { name: 'zákon o obchodních korporacích', kw: ['korporac', 'zok'] },
    '262/2006': { name: 'zákoník práce', kw: ['práce', 'zp'] },
    '40/2009': { name: 'trestní zákoník', kw: ['trestní zákoník', 'tz'] },
    '141/1961': { name: 'trestní řád', kw: ['trestní řád', 'tř'] },
    '500/2004': { name: 'správní řád', kw: ['správní řád'] },
    '150/2002': { name: 'soudní řád správní', kw: ['soudní řád správní', 'súř', 's.ř.s'] },
    '182/2006': { name: 'insolvenční zákon', kw: ['insolven'] },
    '292/2013': { name: 'zákon o zvláštních řízeních soudních', kw: ['zvláštních řízeních', 'zřs'] },
    '120/2001': { name: 'exekuční řád', kw: ['exekuční'] },
    '85/1996': { name: 'zákon o advokacii', kw: ['advokaci'] },
    '110/2019': { name: 'zákon o zpracování osobních údajů', kw: ['osobních údajů'] },
    '634/1992': { name: 'zákon o ochraně spotřebitele', kw: ['spotřebitel'] }
};

function checkLawNames(output) {
    const issues = [];
    const t = String(output || '');
    // „č. 89/2012 Sb. (Zákon o …)“ nebo „č. 89/2012 Sb., zákon o …“ / „…, občanský zákoník“
    const re = /(\d{1,4}\/\d{4})\s*Sb\.?\s*(?:\(|,\s*)((?:zákon|zákoník|občansk|trestn|správn|soudní|insolven|exekuč|obchodní)[^)\n;]{0,60})/gi;
    let m;
    while ((m = re.exec(t))) {
        const law = LAWS[m[1]];
        if (!law) continue;
        const named = m[2].toLowerCase();
        if (!law.kw.some(k => named.includes(k))) {
            issues.push({ number: m[1], stated: m[2].trim(), expected: law.name });
        }
    }
    return issues;
}

/** Sestaví upozornění pro advokáta (nebo '' když je vše v pořádku). */
function buildWarnings({ replaced = [], lawIssues = [], unverifiedCount = 0, extra = [] }) {
    const w = [];
    for (const e of extra) if (e) w.push(e);
    if (replaced.length) {
        w.push(`• ${replaced.length}× identifikátor, který nebyl v zadání (${[...new Set(replaced.map(r => r.label))].join(', ')}), byl nahrazen polem k doplnění.`);
    }
    for (const i of lawIssues) {
        w.push(`• Předpis č. ${i.number} Sb. je ${i.expected}, ne „${i.stated}“.`);
    }
    if (unverifiedCount > 0) {
        w.push(`• ${unverifiedCount}× citace, kterou se nepodařilo ověřit v bázi zákonů — před použitím zkontrolujte.`);
    }
    return w.length ? '\n\n---\n⚠️ Automatická kontrola LexisLocal:\n' + w.join('\n') : '';
}

module.exports = { guardInventedIdentifiers, checkLawNames, buildWarnings, PLACEHOLDER };
