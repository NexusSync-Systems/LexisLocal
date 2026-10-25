/**
 * Deterministická podlaha agentů 3. 10. 2026: procesní lhůty + příslušnost (R4, R5)
 * a pravidlová korektura češtiny (Y2) — včetně kontrol, že nic nepřidá tam, kam nepatří.
 */
'use strict';
const fs = require('fs'), path = require('path');
const pf = require('../lib/procedural_facts');
const cz = require('../lib/cz_proofread');
const FX = path.join(__dirname, '..', 'eval', 'server_suite', 'fixtures');

describe('procesní lhůty', () => {
    test('odvolání proti rozsudku okresního soudu → 15 dnů, § 204, krajský soud', () => {
        const r = pf.proceduralFacts({ prompt: 'Jaká je lhůta k podání odvolání proti rozsudku okresního soudu, odkdy běží a kam se odvolání podává?' });
        expect(r.items.map(i => i.key)).toEqual(['civil_appeal']);
        expect(r.text).toMatch(/15 dnů od doručení/);
        expect(r.text).toMatch(/§ 204 odst\. 1 o\. s\. ř\./);
    });
    test('trestní věc → 8 dnů (§ 248 tr. ř.), správní → § 83', () => {
        expect(pf._remedies('Do kdy se lze odvolat proti rozsudku? Klient byl odsouzen za krádež.')).toEqual(['criminal_appeal']);
        expect(pf._remedies('Do kdy podat odvolání proti rozhodnutí stavebního úřadu?')).toEqual(['admin_appeal']);
    });
    test('odpor proti platebnímu rozkazu a dovolání', () => {
        expect(pf._remedies('Do kdy musíme podat odpor proti platebnímu rozkazu?')).toEqual(['payment_order']);
        expect(pf._remedies('Jaká je lhůta k dovolání?')).toEqual(['appellate_review']);
    });
    test('bez otázky na opravný prostředek nic', () => {
        expect(pf.proceduralFacts({ prompt: 'Shrň smlouvu o dílo.', context: 'Zhotovitel se sídlem v Praze...' })).toBeNull();
        expect(pf.proceduralFacts({ prompt: 'Napiš klientce odpověď.', context: 'Rozsudek nabyl právní moci.' })).toBeNull();
    });
    test('doplněk jen když model lhůtu/§ vynechal', () => {
        const r = pf.proceduralFacts({ prompt: 'Jaká je lhůta k odvolání proti rozsudku okresního soudu?' });
        expect(pf.proceduralAppendix('Odvolání do 15 dnů od doručení (§ 204 o. s. ř.).', r)).toBe('');
        expect(pf.proceduralAppendix('Odvolání se podává k soudu.', r)).toMatch(/15 dnů/);
    });
    test('anglický dopis o dluhu dlužníka z Brna → příslušnost českých soudů', () => {
        const ctx = fs.readFileSync(path.join(FX, 'dopis_anglicky_klient.txt'), 'utf8');
        const r = pf.proceduralFacts({ prompt: 'Odpověz na jeho tři otázky.', context: ctx });
        expect(r.items.map(i => i.key)).toEqual(['jurisdiction']);
        expect(r.text).toMatch(/Brno/);
        expect(r.text).toMatch(/Czech courts have jurisdiction/);
    });
    test('příslušnost se nepřidá bez otázky na žalobu/soud', () => {
        expect(pf.jurisdictionFacts('Shrň dopis.', 'Firma ABC s.r.o. in Brno poslala nabídku.')).toBeNull();
    });
});

describe('pravidlová korektura', () => {
    const Y2 = 'Vážený pane, dovoluji si vás upozornit že lhůta k zaplacení již ubjehla a my jsme nucený přistoupit k vimáhaní dluhu soudní cestou.';
    test('opraví jisté chyby z Y2', () => {
        const r = cz.fixText(Y2);
        expect(r.text).toBe('Vážený pane, dovoluji si vás upozornit, že lhůta k zaplacení již uběhla a my jsme nuceni přistoupit k vymáhání dluhu soudní cestou.');
        expect(cz.modelNote(r.fixes)).toMatch(/vimáhaní → vymáhání/);
    });
    test('nemění správná slova', () => {
        for (const s of [
            'Objednali jsme objem zboží pro objekt, i když prší.',
            'Vjezd do areálu je volný a vjet lze kdykoli.',
            'Smlouva, kterou jsme podepsali, je platná a na kterou spoléháme.',
            'Jsme rádi, že jste přišli.',
            'Výzva k vyjádření byla doručena.'
        ]) expect(cz.fixText(s).text).toBe(s);
    });
    test('shoda podmětu s přísudkem', () => {
        expect(cz.fixText('Byli jsme povinný zaplatit a jsme připravený jednat.').text).toBe('Byli jsme povinni zaplatit a jsme připraveni jednat.');
    });
    test('výstup modelu: seznam oprav bez chybných tvarů, chybějící oprava doplněna', () => {
        const out = cz.finalize('Lhůta již uběhla a musíme se rozhodnout k vykonaní dluhu.\n- ubjehla → uběhla', Y2);
        expect(out).not.toMatch(/ubjehla|vim[aá]h|jsme nucený/);
        expect(out).toMatch(/opraveno: uběhla/);
        expect(out).toMatch(/jsme nuceni přistoupit k vymáhání/);
    });
    test('extractTarget vezme text z uvozovek', () => {
        expect(cz.extractTarget('Oprav gramatiku: "' + Y2 + '"')).toBe(Y2);
    });
});
