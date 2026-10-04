/**
 * lib/agent_examples.js — vzorové výstupy (few-shot) pro jednotlivé agenty.
 *
 * Malý model drží formu a styl kanceláře mnohem lépe podle 1–2 ukázek než podle dlouhých
 * pravidel. Kancelář si u každého agenta uloží ukázky „zadání → výstup“ (Nastavení →
 * Agenti → Vzorové výstupy). Před dotazem se vyberou nejvýše 2 nejpodobnější zadání
 * (shoda slov) a ukázky „vždy použít“; vloží se jako dvojice zpráv user/assistant.
 * Údaje z ukázek model přebírat nesmí — hlídá to lib/output_checks (copied_example).
 *
 * Ukázka: { id, title, zadani, vystup, enabled, always }
 */
'use strict';

const crypto = require('crypto');

const LIMITS = { count: 8, title: 120, zadani: 2000, vystup: 8000 };
const _norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const _words = s => new Set((_norm(s).match(/[a-z0-9]{4,}/g) || []).map(w => w.slice(0, 6)));
const STOPW = new Set(['napis', 'priprav', 'sepis', 'vypracu', 'klient', 'klientk', 'nasi', 'ktere', 'ktery', 'ktera', 'pros', 'stru', 'nase', 'kancel', 'zastup', 'kterou', 'ktereh']);

/** Validace a očištění seznamu ukázek z UI. Vyhodí Error s českou hláškou. */
function validateExamples(list) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new Error('Ukázky musí být seznam.');
    if (list.length > LIMITS.count) throw new Error(`Nejvýše ${LIMITS.count} ukázek na agenta.`);
    return list.map((e, i) => {
        const zadani = String((e && e.zadani) || '').trim();
        const vystup = String((e && e.vystup) || '').trim();
        if (!zadani || !vystup) throw new Error(`Ukázka ${i + 1}: vyplňte zadání i vzorový výstup.`);
        if (zadani.length > LIMITS.zadani) throw new Error(`Ukázka ${i + 1}: zadání je delší než ${LIMITS.zadani} znaků.`);
        if (vystup.length > LIMITS.vystup) throw new Error(`Ukázka ${i + 1}: výstup je delší než ${LIMITS.vystup} znaků.`);
        const id = /^[a-z0-9_-]{1,40}$/i.test(String(e.id || '')) ? String(e.id) : 'ex_' + crypto.randomBytes(4).toString('hex');
        return {
            id, title: String(e.title || '').trim().slice(0, LIMITS.title) || zadani.slice(0, 60),
            zadani, vystup, enabled: e.enabled !== false, always: e.always === true
        };
    });
}

function _score(ex, prompt) {
    const p = _words(prompt); let s = 0;
    for (const w of _words(ex.title + ' ' + ex.zadani)) if (!STOPW.has(w) && p.has(w)) s++;
    return s;
}

/**
 * Vybere ukázky pro dané zadání: „vždy“ + nejpodobnější (skóre ≥ 2 shodná slova),
 * celkem nejvýše max (env AGENT_EXAMPLES_MAX, výchozí 2).
 */
function selectExamples(agent, prompt, opts = {}) {
    const list = ((agent && agent.examples) || []).filter(e => e && e.enabled !== false && e.zadani && e.vystup);
    if (!list.length || process.env.AGENT_EXAMPLES === '0') return [];
    const max = Math.max(0, Math.min(4, Number(opts.max != null ? opts.max : (process.env.AGENT_EXAMPLES_MAX || 2))));
    const scored = list.map((e, i) => ({ e, i, s: _score(e, prompt) }));
    const picked = scored.filter(x => x.e.always);
    scored.filter(x => !x.e.always && x.s >= 2).sort((a, b) => b.s - a.s || a.i - b.i)
        .forEach(x => { if (picked.length < max) picked.push(x); });
    return picked.slice(0, max).map(x => x.e);
}

const HEAD = 'VZOROVÁ UKÁZKA kanceláře (jen vzor formy a stylu — jména, data, částky a další údaje z ní NEPŘEBÍREJ):\n';

/** Zprávy pro model: dvojice user/assistant. asNote = jen systémová poznámka (pro JSON režim). */
function examplesMessages(selected, opts = {}) {
    if (!selected || !selected.length) return [];
    if (opts.asNote) {
        return [{ role: 'system', content: 'Styl kanceláře — ukázky textu (údaje z nich nepřebírej, slouží jen pro tón a formulace):\n\n' +
            selected.map((e, i) => `--- Ukázka ${i + 1}: ${e.title} ---\n${e.vystup}`).join('\n\n') }];
    }
    const out = [];
    for (const e of selected) {
        out.push({ role: 'user', content: HEAD + e.zadani });
        out.push({ role: 'assistant', content: e.vystup });
    }
    return out;
}

// Výchozí ukázky systémových agentů (fiktivní osoby; skutečné údaje = [Doplnit]).
const DEFAULT_EXAMPLES = {
    spisovatel: [
        {
            id: 'vychozi_plna_moc', title: 'Procesní plná moc', enabled: true, always: false,
            zadani: 'Připrav procesní plnou moc pro klienta Jana Vzorového, kterého zastupuje naše kancelář ve sporu o zaplacení kupní ceny u Okresního soudu v Kladně.',
            vystup: 'PLNÁ MOC\n\n' +
                'Zmocnitel:\nJan Vzorový, nar. [Doplnit – datum narození], bytem [Doplnit – adresa]\n\n' +
                'Zmocněnec:\n[Doplnit – jméno advokáta], advokát, ev. č. ČAK [Doplnit], se sídlem [Doplnit – adresa sídla]\n\n' +
                'Zmocnitel tímto zmocňuje zmocněnce, aby jej zastupoval ve sporu o zaplacení kupní ceny vedeném u Okresního soudu v Kladně, sp. zn. [Doplnit – je-li přidělena], ' +
                'a to ve všech úkonech řízení, včetně podání opravných prostředků, uzavření smíru, vzetí návrhu zpět, uznání nároku, vzdání se nároku a přijímání písemností.\n\n' +
                'Tato plná moc se uděluje pro celé řízení jako procesní plná moc podle § 28 občanského soudního řádu (zákon č. 99/1963 Sb.). Zmocněnec je oprávněn dát se zastoupit dalším advokátem nebo advokátním koncipientem.\n\n' +
                'V [Doplnit – místo] dne [Doplnit – datum]\n\n………………………………\nJan Vzorový, zmocnitel\n\n' +
                'Plnou moc přijímám.\n\nV [Doplnit – místo] dne [Doplnit – datum]\n\n………………………………\n[Doplnit – jméno advokáta], advokát'
        },
        {
            id: 'vychozi_vyzva', title: 'Předžalobní výzva k úhradě', enabled: true, always: false,
            zadani: 'Napiš předžalobní výzvu Petru Ukázkovému k zaplacení nedoplatku za dílo 54 300 Kč pro klientku Marii Příkladnou.',
            vystup: 'Věc: Předžalobní výzva k úhradě ceny díla\n\nVážený pane Ukázkový,\n\n' +
                'obracíme se na Vás jako právní zástupce naší klientky (Marie Příkladná). Na základě smlouvy o dílo jste převzal dokončené dílo, avšak z ceny díla dosud nebyla uhrazena částka 54 300 Kč, ' +
                'ačkoli byla splatná dne [Doplnit – datum splatnosti]. Tím jste se dostal do prodlení.\n\n' +
                'V souladu s § 142a občanského soudního řádu Vás vyzýváme k úhradě částky 54 300 Kč do 15 dnů ode dne doručení této výzvy na účet [Doplnit – číslo účtu pro platbu].\n\n' +
                'Nebude-li částka ve stanovené lhůtě uhrazena, uplatní naše klientka svůj nárok u soudu bez dalšího upozornění, včetně úroků z prodlení a náhrady nákladů řízení.\n\n' +
                'S pozdravem\n\n[Doplnit – jméno a podpis advokáta]'
        }
    ]
};

module.exports = { validateExamples, selectExamples, examplesMessages, DEFAULT_EXAMPLES, LIMITS };
