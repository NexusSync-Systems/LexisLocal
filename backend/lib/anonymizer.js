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
 * @returns {string} - Pseudonymized text
 */
function anonymizeText(text) {
    if (!text) return text;
    
    let result = text;
    
    // 1. Anonymize Emails
    result = result.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[E-MAIL]');
    
    // 2. Anonymize Czech Birth Numbers (rodná čísla: e.g. 850708/1234 or 901231/123)
    result = result.replace(/\b\d{6}\/\d{3,4}\b/g, '[RODNÉ ČÍSLO]');
    
    // 2b. Bankovní účty a IBAN (test 2. 10. 2026: „účet 123456789/0800“ zůstal čitelný).
    //     Spisové značky („12 C 45/2026“) mají za lomítkem rok — proto bez kontextu
    //     redigujeme jen čísla s ≥ 6 číslicemi před lomítkem, s kontextem (účet, č. ú.,
    //     bankovní spojení) i kratší.
    result = result.replace(/\bCZ\d{2}(?:\s?\d{4}){5}\b/g, '[ÚČET]');
    result = result.replace(/((?:č\.\s?ú\.|čísl[oa]\s+účtu|účt?[uě]?|účet|bankovní\s+spojení|bank\.\s*spoj\.)\s*(?:č\.\s*)?:?\s*)((?:\d{1,6}-)?\d{2,10}\s?\/\s?\d{4})\b/gi, '$1[ÚČET]');
    result = result.replace(/\b(?:\d{1,6}-)?\d{6,10}\/\d{4}\b/g, '[ÚČET]');

    // 2c. Adresa bydliště fyzické osoby („bytem Okružní 5, Jihlava“). Sídlo firmy
    //     je veřejný údaj, proto jen bytem / bydliště / trvalý pobyt.
    result = result.replace(/\b(bytem|trvale\s+bytem|bydli[šs]t[eě]m?|trval[ýé]m?\s+pobytem|adresa\s+bydli[šs]t[eě])(\s*:?\s*)([^\n;]{3,120}?)(?=\.\s|\.$|;|\n|$)/gi, '$1$2[ADRESA]');

    // 3. Anonymize Czech Phone Numbers. Dřívější vzor bral JAKÉKOLI 9místné číslo
    //    (spisové značky, částky, IČO). Nově vyžadujeme předvolbu, oddělovače,
    //    nebo telefonní klíčové slovo, aby nedocházelo k nadměrné redakci.
    // 3a. S mezinárodní předvolbou: +420 123 456 789
    result = result.replace(/\+(?:420|421)\s*\d{3}\s*\d{3}\s*\d{3}\b/g, '[TELEFON]');
    // 3b. Klasický zápis s oddělovači (mezery/pomlčky): 777 123 456.
    //     České telefony nezačínají 0 ani 1 (mobil 6/7, pevná 2–5) → [2-9] vyloučí
    //     částky jako „123 456 789". Negativní lookahead navíc vyloučí čísla následovaná
    //     měnou (Kč/EUR/…) nebo další skupinou číslic (delší částky), aby se neredigovaly
    //     peněžní částky (jinak by z „Dluh činí 123 456 789 Kč" vzniklo „[TELEFON] Kč").
    result = result.replace(/\b[2-9]\d{2}[ \-]\d{3}[ \-]\d{3}\b(?!\s*(?:\d|Kč|Kc|CZK|EUR|€|USD|\$))/g, '[TELEFON]');
    // 3c. Po telefonním klíčovém slově i bez oddělovačů: "tel: 777123456"
    result = result.replace(/\b(tel\.?|telefon|mobil|mob\.?|gsm)(\s*:?\s*)(\+?(?:420|421)?\s*[1-9](?:[\s\-]?\d){8})\b/gi,
        (m, kw, sep) => `${kw}${sep}[TELEFON]`);
    // 3d. Po výzvě k volání ("volejte / zavolejte 602987654") i bez oddělovačů.
    //     Klíčové slovo drží redakci u skutečných čísel — holé 9místné číslo bez
    //     tohoto kontextu (spisové značky, IČO, částky) se dál záměrně neredaguje.
    result = result.replace(/\b(volejte|zavolejte|zavolej|volej|volat)(\s+)(\+?(?:420|421)?\s*[1-9](?:[\s\-]?\d){8})\b/gi,
        (m, kw, sep) => `${kw}${sep}[TELEFON]`);
    
    // 4. Anonymize Czech Academics/Titles + Name patterns (e.g. Mgr. Novák, JUDr. Petr Novotný)
    const titleRegex = /\b(?:Mgr|Ing|JUDr|PhDr|MUDr|doc|prof|Bc)\.?\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+(?:\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)?/g;
    result = result.replace(titleRegex, '[JMÉNO A TITUL]');
    
    // 5. Anonymize Common Czech Name + Surname combinations
    const words = result.split(/(\s+)/);
    for (let i = 0; i < words.length - 2; i += 2) {
        const currentWord = words[i].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (CZECH_GIVEN_NAMES.has(currentWord)) {
            const nextWord = words[i + 2];
            if (nextWord && /^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(nextWord)) {
                words[i] = '[JMÉNO]';
                words[i + 2] = '[PŘÍJMENÍ]';
            }
        }
    }
    result = words.join('');
    
    // Clean up consecutive placeholders
    result = result.replace(/\[JMÉNO\]\s*\[PŘÍJMENÍ\]/g, '[JMÉNO A PŘÍJMENÍ]');
    result = result.replace(/\[JMÉNO\]\s*\[JMÉNO\]/g, '[JMÉNO]');
    
    return result;
}

module.exports = {
    anonymizeText,
    CZECH_GIVEN_NAMES
};
