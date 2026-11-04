/**
 * lib/agent_outlines.js — pevná osnova odpovědi a teplota podle TYPU úkolu.
 *
 * Malý model (qwen2.5:7b) drží pevnou strukturu výrazně lépe než volné zadání
 * (server test 2. 10. 2026: rozbor bez lhůt, stylista přepsal větu místo opravy,
 * odpověď na anglický dopis bez anglické části). Osnova se přidává jako SAMOSTATNÁ
 * systémová zpráva — platí i pro agenty, jejichž prompt si kancelář upravila.
 *
 * taskProfile({ agentId, prompt, context, hasClauseFindings }) →
 *   { kind, outline, temperature|null }
 */
'use strict';

const RE = {
    contractReview: /zkontroluj|kontrol|rizik|nevyv[aá][žz]|ustanoven|dolo[žz]k/i,
    contract: /smlouv/i,
    proofread: /oprav\S*\s+(gramatik|pravopis|chyb|stylistik)|korektur|zkontroluj\s+pravopis/i,
    analysis: /rozbor|posou|anal[yý]z|mů[žz]e\s|jestli|zda\s|do kdy|lh[uů]t|promlč|nárok/i,
    contradictions: /rozpor|nesoulad|neshod|protiřeč|srovn\S* dokument|liší se/i,
    letterToOpponent: /(dopis|výzv|předžalobní)[^.]{0,80}(protistran|povinn|dlužník|žalovan)|(protistran|povinn|dlužník)[^.]{0,80}(dopis|výzv)/i,
    englishAsked: /anglick|in english|english|v angličtině|pro klienta.*angl/i
};

function _englishContext(text) {
    const t = String(text || '');
    if (t.length < 80) return false;
    const en = (t.match(/\b(the|and|of|to|is|are|we|you|our|my|they|them|their|have|has|do|not|can|in|on|under|please|would|could|with|dear|regards)\b/gi) || []).length;
    const cs = (t.match(/(?:^|[\s,.])(je|se|na|že|pro|jsem|jste|bych|které|není|jsou|také|prosím|dobrý)(?=[\s,.]|$)/gi) || []).length;
    return en >= 6 && en > cs * 2;
}

const OUTLINES = {
    contract_review:
        'OSNOVA ODPOVĚDI (dodrž):\n' +
        '1. Celkové hodnocení jednou větou (u spotřebitele/nájemce uveď, že jde o slabší stranu).\n' +
        '2. Rizika — pro KAŽDÉ: „Čl. X — co ustanovení říká → proč je to riziko pro klienta → Opora: § a předpis → Návrh úpravy (úprava/škrt) — i návrh má oporu: § a předpis, podle kterého je úprava potřebná nebo přípustná“.\n' +
        '   Uveď konkrétní hodnoty ze smlouvy (procenta, částky, lhůty, počty měsíců/let).\n' +
        '3. Možnosti klienta — podepsat / vyjednat úpravy / nepodepsat: u každé Pro a Proti.\n' +
        '4. Doporučení pro klienta — kterou možnost a proč, s oporou (§ a předpis).\n' +
        'Nikdy netvrď, že smlouva je bez rizik, pokud jsi rizika našel nebo je našel program.',
    contradictions:
        'OSNOVA ODPOVĚDI (dodrž):\n' +
        '1. Přehled — kolik rozporů a které jsou podstatné (1–2 věty).\n' +
        '2. Každý rozpor zvlášť: „Rozpor N — čeho se týká: verze A „hodnota“ (název dokumentu, čl./bod) × verze B „hodnota“ (název dokumentu, čl./bod)“.\n' +
        '   Každá hodnota má VLASTNÍ citaci s celým názvem dokumentu (ne zkratkou). Neslučuj hodnoty z různých dokumentů pod jednu citaci; v tabulce piš název dokumentu do každé buňky s citací.\n' +
        '3. U každého rozporu: která verze nejspíš platí a proč — Opora: článek dokumentu nebo § a předpis; případně co ověřit.\n' +
        '4. Sjednaná změna (dodatek) není rozpor — uveď ji zvlášť jako změnu.\n' +
        'Nevypisuj rozpory, které v dokumentech nejsou.',
    legal_analysis:
        'OSNOVA ODPOVĚDI (dodrž):\n' +
        '1. Stručná odpověď (2–3 věty).\n' +
        '2. Skutkový stav — jen to, co je v podkladech.\n' +
        '3. Právní úprava — konkrétní § s číslem a názvem předpisu (89/2012 Sb. = občanský zákoník).\n' +
        '4. Lhůty a data — převezmi DOSLOVA výpočty programu, sám data nepočítej.\n' +
        '5. Varianty postupu — 2 až 3 reálné možnosti (např. výzva / žaloba / smír / nečinnost), je-li jich víc; u každé:\n' +
        '   „Pro: …“ (výhody, šance na úspěch), „Proti: …“ (rizika, náklady, doba, procesní nebezpečí), „Opora: § a předpis“.\n' +
        '   Když je možný jen jeden postup, napiš proč (jednou větou).\n' +
        '6. Doporučená varianta — kterou a proč, s oporou (§ a předpis, příp. sp. zn. rozhodnutí) a hlavním rizikem.\n' +
        '7. Co ještě ověřit.',
    proofread:
        'OSNOVA ODPOVĚDI (dodrž):\n' +
        '1. Opravený text — zachovej původní formulace, slovosled a význam; opravuj JEN chyby ' +
        '(pravopis, i/y, čárky, shoda podmětu s přísudkem, např. „my jsme nuceni“, ne „jsme nucený“).\n' +
        '2. Seznam oprav: jen OPRAVENÉ tvary a druh chyby, např. „uběhla (pravopis)“ (max. 6 bodů; chybné tvary neopakuj).',
    opponent_letter:
        'PRAVIDLA PRO DOPIS PROTISTRANĚ (dodrž):\n' +
        '• Uveď jen údaje nutné k věci: kdo píše a za koho, výše dluhu/nároku, právní důvod, lhůta, následky. Platební údaje nech jako [Doplnit – číslo účtu pro platbu].\n' +
        '• NEUVÁDĚJ rodné číslo, číslo dokladu, zdravotní údaje, rodinné poměry ani jiné citlivé údaje klienta — protistrana je nepotřebuje.\n' +
        '• Chybějící údaje nech jako [Doplnit …].',
    secretary:
        'OSNOVA ODPOVĚDI (stručně):\n' +
        '1. Odpověď / termín (u lhůt přesné datum z výpočtu programu).\n' +
        '2. Z čeho vychází (dokument, datum doručení).\n' +
        '3. Upozornění — rozpory v podkladech, nejasnosti.\n' +
        '4. Další kroky.'
};

const BILINGUAL = 'JAZYK: Odpověz nejprve česky (pro advokáta). Potom přidej oddíl „English summary for the client“ ' +
    's krátkou anglickou verzí odpovědí na otázky klienta (stejný obsah, stejná data a lhůty).';

function taskProfile({ agentId, prompt, context, hasClauseFindings } = {}) {
    const p = String(prompt || '');
    const ctx = String(context || '');
    const parts = [];
    let kind = 'general', temperature = null;

    if (RE.proofread.test(p) || agentId === 'stylista' && /oprav/i.test(p)) {
        kind = 'proofread'; parts.push(OUTLINES.proofread); temperature = 0.1;
    } else if (hasClauseFindings || (RE.contractReview.test(p) && (RE.contract.test(p) || RE.contract.test(ctx)))) {
        kind = 'contract_review'; parts.push(OUTLINES.contract_review); temperature = 0.1;
    } else if (RE.contradictions.test(p) && !RE.letterToOpponent.test(p)) {
        kind = 'contradictions'; parts.push(OUTLINES.contradictions); temperature = 0.1;
    } else if (RE.letterToOpponent.test(p) || require('./demand_letter').isDemandLetter(p)) {
        kind = 'opponent_letter'; parts.push(OUTLINES.opponent_letter);
    } else if (agentId === 'sekretarka') {
        kind = 'secretary'; parts.push(OUTLINES.secretary); temperature = 0.1;
    } else if (agentId === 'resersnik' || RE.analysis.test(p)) {
        kind = 'legal_analysis'; parts.push(OUTLINES.legal_analysis); temperature = 0.1;
    }
    const bilingual = RE.englishAsked.test(p) || _englishContext(ctx);
    if (bilingual) parts.push(BILINGUAL);
    return { kind, bilingual, outline: parts.join('\n\n'), temperature };
}

/**
 * Dopis protistraně: rodná čísla a čísla účtů z podkladů klienta ve výstupu nahradí
 * (protistrana je nepotřebuje; účet pro platbu doplní advokát vědomě).
 * Vrací { text, removed: ['rodné číslo', …] }.
 */
function redactForOpponent(text, sourceText) {
    let t = String(text || '');
    const removed = [];
    const src = String(sourceText || '');
    t = t.replace(/(?<!\d)\d{6}\s?\/\s?\d{3,4}(?!\d)/g, () => { removed.push('rodné číslo'); return '[neuvádět]'; });
    const accounts = new Set();
    const reAcc = /(?<![\d\/])((?:\d{1,6}-)?\d{2,10})\s?\/\s?(\d{4})(?![\d])/g; let m;
    while ((m = reAcc.exec(src))) {
        // Čísla dokumentů a spisové značky nejsou účty (eval 4. 11. 2026: „č. EV-NS-03/2026“ a „12 C 101/2026“
        // se v dopisu měnily na „[Doplnit – číslo účtu]“): před číslem písmeno nebo „-“ s písmenem, nebo „kód banky“
        // jako rok (1990–2099) bez slova účet poblíž → není účet.
        const pred = src.slice(Math.max(0, m.index - 25), m.index);
        if (/[A-Za-zÁ-ž]-?$/.test(pred) || /[A-Za-zÁ-ž]\s+$/.test(pred) && /\b[A-Z][a-z]{0,3}\s+$/.test(pred)) continue;
        const kod = +m[2];
        if (kod >= 1990 && kod <= 2099 && !/(účt|účet|č\.\s?ú\.|bankovní|IBAN)/i.test(pred)) continue;
        accounts.add(m[1].replace(/\s/g, '') + '/' + m[2]);
    }
    for (const a of accounts) {
        const esc = a.replace(/[-/]/g, (c) => '\\s?\\' + c + '\\s?');
        const re = new RegExp('(?<!\\d)' + esc + '(?!\\d)', 'g');
        if (re.test(t)) { t = t.replace(re, '[Doplnit – číslo účtu pro platbu]'); removed.push('číslo účtu klienta'); }
    }
    // Zdravotní údaje uvedené v podkladech („Zdravotní stav dcery: astma, …“, „Diagnóza: …“).
    const reHealth = /(zdravotní\s+stav|diagnóz\S*|onemocnění|nemoc)[^:\n]{0,40}:\s*([^\n]+)/gi;
    let h;
    while ((h = reHealth.exec(src))) {
        for (const term of h[2].split(/[,;(]/).map(x => x.trim()).filter(x => x.length >= 4 && x.length <= 40)) {
            const words = term.split(/\s+/).slice(0, 3).join(' ');
            if (/^(pravideln|důvod|léčba$)/i.test(words)) continue;
            const re = new RegExp('(?<![\\p{L}])' + words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}])', 'giu');
            if (re.test(t)) { t = t.replace(re, '[neuvádět – zdravotní údaj]'); removed.push('zdravotní údaj'); }
        }
    }
    return { text: t, removed: [...new Set(removed)] };
}

module.exports = { taskProfile, redactForOpponent, OUTLINES, _englishContext };
