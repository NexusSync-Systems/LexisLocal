/**
 * LexisLocal GDPR Sovereign Data Shield
 * Provides local-first, zero-dependency Czech PII anonymizer.
 * Redacts names, birth numbers (rodná čísla), e-mails, and phone numbers.
 */

const fs = require('fs');
const path = require('path');

const CZECH_GIVEN_NAMES = new Set([
    'jan', 'jana', 'petr', 'jiri', 'jiří', 'marie', 'josef', 'pavel', 'martin', 'tomas', 'tomáš',
    'jaroslav', 'miroslav', 'frantisek', 'františek', 'vaclav', 'václav', 'michal', 'zdenek', 'zdeněk',
    'jakub', 'lenka', 'katerina', 'kateřina', 'alena', 'hana', 'ludmila', 'david', 'filip',
    'lukas', 'lukáš', 'ondrej', 'ondřej', 'veronika', 'monika', 'kristyna', 'kristýna', 'barbora',
    // Rozšíření o další běžná česká jména (dřív jen ~30).
    'anna', 'eva', 'lucie', 'tereza', 'jitka', 'zuzana', 'ivana', 'jaroslava', 'helena', 'vera', 'věra',
    'daniela', 'simona', 'gabriela', 'nikola', 'adela', 'adéla', 'eliska', 'eliška', 'natalie', 'aneta',
    'karel', 'milan', 'roman', 'radek', 'marek', 'vojtech', 'vojtěch', 'matej', 'matěj', 'daniel',
    'antonin', 'antonín', 'stanislav', 'ladislav', 'vladimir', 'vladimír', 'oldrich', 'oldřich',
    'rudolf', 'robert', 'richard', 'patrik', 'dominik', 'adam', 'stepan', 'štěpán', 'radim', 'igor'
]);

/**
 * Anonymizes PII (Personally Identifiable Information) in a Czech legal text.
 * @param {string} text - Raw input text
 * @param {function} [assign] - (kind, original) => placeholder; výchozí = pevný štítek
 * @returns {string} - Pseudonymized text
 */
const FIXED = { email: '[E-MAIL]', rc: '[RODNÉ ČÍSLO]', ucet: '[ÚČET]', adresa: '[ADRESA]',
    telefon: '[TELEFON]', titul: '[JMÉNO A TITUL]', osoba: '[JMÉNO A PŘÍJMENÍ]' };

function anonymizeText(text, assign) {
    if (!text) return text;
    const A = assign || (kind => FIXED[kind]);

    let result = text;

    // 1. Anonymize Emails
    result = result.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, m => A('email', m));

    // 2. Anonymize Czech Birth Numbers (rodná čísla: e.g. 850708/1234 or 901231/123)
    result = result.replace(/\b\d{6}\/\d{3,4}\b/g, m => A('rc', m));

    // 2b. Bankovní účty a IBAN (test 2. 10. 2026: „účet 123456789/0800“ zůstal čitelný).
    //     Spisové značky („12 C 45/2026“) mají za lomítkem rok — proto bez kontextu
    //     redigujeme jen čísla s ≥ 6 číslicemi před lomítkem, s kontextem (účet, č. ú.,
    //     bankovní spojení) i kratší.
    result = result.replace(/\bCZ\d{2}(?:\s?\d{4}){5}\b/g, m => A('ucet', m));
    result = result.replace(/((?:č\.\s?ú\.|čísl[oa]\s+účtu|účt?[uě]?|účet|bankovní\s+spojení|bank\.\s*spoj\.)\s*(?:č\.\s*)?:?\s*)((?:\d{1,6}-)?\d{2,10}\s?\/\s?\d{4})\b/gi, (m, p1, num) => p1 + A('ucet', num));
    result = result.replace(/\b(?:\d{1,6}-)?\d{6,10}\/\d{4}\b/g, m => A('ucet', m));

    // 2c. Adresa bydliště fyzické osoby („bytem Okružní 5, Jihlava“). Sídlo firmy
    //     je veřejný údaj, proto jen bytem / bydliště / trvalý pobyt.
    result = result.replace(/\b(bytem|trvale\s+bytem|bydli[šs]t[eě]m?|trval[ýé]m?\s+pobytem|adresa\s+bydli[šs]t[eě])(\s*:?\s*)([^\n;]{3,120}?)(?=\.\s|\.$|;|\n|$)/gi, (m, kw, sep, addr) => kw + sep + A('adresa', addr));

    // 3. Anonymize Czech Phone Numbers. Dřívější vzor bral JAKÉKOLI 9místné číslo
    //    (spisové značky, částky, IČO). Nově vyžadujeme předvolbu, oddělovače,
    //    nebo telefonní klíčové slovo, aby nedocházelo k nadměrné redakci.
    // 3a. S mezinárodní předvolbou: +420 123 456 789
    result = result.replace(/\+(?:420|421)\s*\d{3}\s*\d{3}\s*\d{3}\b/g, m => A('telefon', m));
    // 3b. Klasický zápis s oddělovači (mezery/pomlčky): 777 123 456.
    //     České telefony nezačínají 0 ani 1 (mobil 6/7, pevná 2–5) → [2-9] vyloučí
    //     částky jako „123 456 789". Negativní lookahead navíc vyloučí čísla následovaná
    //     měnou (Kč/EUR/…) nebo další skupinou číslic (delší částky), aby se neredigovaly
    //     peněžní částky (jinak by z „Dluh činí 123 456 789 Kč" vzniklo „[TELEFON] Kč").
    result = result.replace(/\b[2-9]\d{2}[ \-]\d{3}[ \-]\d{3}\b(?!\s*(?:\d|Kč|Kc|CZK|EUR|€|USD|\$))/g, m => A('telefon', m));
    // 3c. Po telefonním klíčovém slově i bez oddělovačů: "tel: 777123456"
    result = result.replace(/\b(tel\.?|telefon|mobil|mob\.?|gsm)(\s*:?\s*)(\+?(?:420|421)?\s*[1-9](?:[\s\-]?\d){8})\b/gi,
        (m, kw, sep, num) => `${kw}${sep}${A('telefon', num)}`);
    // 3d. Po výzvě k volání ("volejte / zavolejte 602987654") i bez oddělovačů.
    //     Klíčové slovo drží redakci u skutečných čísel — holé 9místné číslo bez
    //     tohoto kontextu (spisové značky, IČO, částky) se dál záměrně neredaguje.
    result = result.replace(/\b(volejte|zavolejte|zavolej|volej|volat)(\s+)(\+?(?:420|421)?\s*[1-9](?:[\s\-]?\d){8})\b/gi,
        (m, kw, sep, num) => `${kw}${sep}${A('telefon', num)}`);

    // 4. Anonymize Czech Academics/Titles + Name patterns (e.g. Mgr. Novák, JUDr. Petr Novotný)
    const titleRegex = /\b(?:Mgr|Ing|JUDr|PhDr|MUDr|doc|prof|Bc)\.?\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+(?:\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)?/g;
    result = result.replace(titleRegex, m => A('titul', m));

    // 5. Anonymize Common Czech Name + Surname combinations
    const words = result.split(/(\s+)/);
    for (let i = 0; i < words.length - 2; i += 2) {
        const currentWord = words[i].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
        if (CZECH_GIVEN_NAMES.has(currentWord)) {
            const nextWord = words[i + 2];
            if (nextWord && /^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(nextWord)) {
                if (assign) {
                    // interpunkci za příjmením („Horák,“) necháme v textu
                    const mm = nextWord.match(/^([^\s.,;:!?)"“”]+)(.*)$/);
                    words[i] = A('osoba', words[i] + ' ' + mm[1]) + mm[2];
                    words[i + 1] = ''; words[i + 2] = '';
                } else {
                    words[i] = '[JMÉNO]';
                    words[i + 2] = '[PŘÍJMENÍ]';
                }
            }
        }
    }
    result = words.join('');

    // Clean up consecutive placeholders
    result = result.replace(/\[JMÉNO\]\s*\[PŘÍJMENÍ\]/g, '[JMÉNO A PŘÍJMENÍ]');
    result = result.replace(/\[JMÉNO\]\s*\[JMÉNO\]/g, '[JMÉNO]');

    return result;
}

/**
 * VRATNÁ pseudonymizace pro lokální model (test 2. 10. 2026: Spisovatel po anonymizaci
 * kontextu nemohl v plné moci uvést klienta „Horák“ — místo jména psal [JMÉNO]).
 * Každý údaj dostane číslovaný zástupný symbol ([OSOBA_1], [ADRESA_1] …), stejné
 * hodnoty stejný symbol. Model pracuje se symboly, restorePseudonyms() je po odpovědi
 * vrátí. Mapa žije jen v paměti požadavku — nikam se neukládá ani neloguje.
 * @returns {{ text: string, map: Object<string,string> }}  map: symbol → originál
 */
const PSEUDO_LABEL = { email: 'E-MAIL', rc: 'RČ', ucet: 'ÚČET', adresa: 'ADRESA', telefon: 'TELEFON', titul: 'OSOBA', osoba: 'OSOBA' };
function pseudonymizeText(text) {
    const map = {}; const byValue = {}; const counters = {};
    if (!text) return { text, map };
    const assign = (kind, original) => {
        const label = PSEUDO_LABEL[kind] || 'ÚDAJ';
        const key = label + '|' + String(original).replace(/\s+/g, ' ').trim();
        if (byValue[key]) return byValue[key];
        counters[label] = (counters[label] || 0) + 1;
        const ph = `[${label}_${counters[label]}]`;
        byValue[key] = ph; map[ph] = String(original).replace(/\s+/g, ' ').trim();
        return ph;
    };
    let out = anonymizeText(text, assign);
    // Samotné příjmení jinde v textu („pan Horák“, „Horákovi“) → stejný symbol.
    Object.keys(map).filter(ph => ph.startsWith('[OSOBA_')).forEach(ph => {
        const parts = map[ph].split(' ');
        const surname = parts[parts.length - 1];
        if (!surname || surname.length < 4) return;
        const stem = surname.length > 5 ? surname.slice(0, -1) : surname;
        const re = new RegExp('(^|[^A-Za-zÁ-žá-ž])' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[a-záčďéěíňóřšťúůýž]{0,4}(?![A-Za-zÁ-žá-ž])', 'g');
        out = out.replace(re, (m, pre) => pre + ph);
    });
    return { text: out, map };
}

/**
 * Vrátí originální údaje místo symbolů z pseudonymizeText.
 * Automaticky se vrací jen JMÉNA a ADRESY (potřebné v podáních). Rodné číslo, číslo
 * účtu, telefon a e-mail se NEvracejí — model je mohl vložit i tam, kam nepatří
 * (test 2. 10. 2026, W3: dopis protistraně obsahoval rodné číslo klientky). Místo
 * nich zůstane pole „[doplňte: …]“, které advokát vyplní vědomě.
 * Symbol, který v mapě není (model si vymyslel [ADRESA_2]), se také nahradí polem.
 */
const RESTORE_DEFAULT = ['OSOBA', 'ADRESA'];
const FILL_LABEL = { 'RČ': 'rodné číslo', 'ÚČET': 'číslo účtu', 'TELEFON': 'telefon', 'E-MAIL': 'e-mail', 'OSOBA': 'jméno', 'ADRESA': 'adresa' };
function restorePseudonyms(text, map, opts = {}) {
    if (!text) return text;
    const restoreKinds = new Set(opts.restoreKinds || RESTORE_DEFAULT);
    let out = String(text);
    Object.keys(map || {}).forEach(ph => {
        const m = ph.match(/^\[(.+)_(\d+)\]$/);
        if (!m) return;
        const label = m[1].replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
        const re = new RegExp('\\[\\s*' + label + '[_\\s-]?' + m[2] + '\\s*\\]', 'gi');
        out = out.replace(re, () => restoreKinds.has(m[1]) ? map[ph] : `[doplňte: ${FILL_LABEL[m[1]] || 'údaj'}]`);
    });
    // zbylé (neznámé) symboly → pole k doplnění
    out = out.replace(/\[\s*(OSOBA|ADRESA|RČ|ÚČET|TELEFON|E-MAIL)[_\s-]?\d+\s*\]/gi,
        (all, lab) => `[doplňte: ${FILL_LABEL[lab.toUpperCase()] || 'údaj'}]`);
    return out;
}

module.exports = {
    anonymizeText,
    pseudonymizeText,
    restorePseudonyms,
    CZECH_GIVEN_NAMES
};
