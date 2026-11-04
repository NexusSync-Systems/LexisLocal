/**
 * Eval sada nad syntetickými spisy (backend/eval/spis_eval): data jsou smyšlená, zlaté odpovědi projdou
 * a každý typ chyby z katalogu kontrola opravdu zachytí.
 */
'use strict';
const path = require('path');
const C = require('../eval/spis_eval/checks');
const S = C.nactiSpisy(path.join(__dirname, '..', 'eval', 'spis_eval', 'spisy'));
const SADA = require('../eval/spis_eval/cases.json');
const P = id => SADA.pripady.find(p => p.id === id);
const typy = (id, odp) => C.vyhodnot(P(id), odp, S).chyby.map(c => c.typ);

describe('syntetická data', () => {
    test('8 typů × 6 případů, každý případ má zlatou odpověď', () => {
        const poc = {};
        for (const p of SADA.pripady) { poc[p.typ] = (poc[p.typ] || 0) + 1; expect(p.reference).toBeTruthy(); expect(S[p.spis]).toBeTruthy(); }
        expect(Object.keys(poc)).toHaveLength(8);
        for (const n of Object.values(poc)) expect(n).toBe(6);
    });
    test('žádné platné identifikátory: IČO s chybným kontrolním součtem, r. č. s neplatným měsícem, kód banky 0000', () => {
        const vse = Object.values(S).flatMap(s => Object.values(s.docs).map(d => d.text)).join('\n');
        for (const m of vse.matchAll(/IČO:? ?(\d{8})/g)) {
            const d = m[1].split('').map(Number);
            const sum = d.slice(0, 7).reduce((a, x, i) => a + x * (8 - i), 0) % 11;
            const ok = sum === 0 ? 1 : sum === 1 ? 0 : 11 - sum;
            expect(d[7]).not.toBe(ok % 10);
        }
        for (const m of vse.matchAll(/r\. ?č\. ?(\d{6})\/\d{3,4}/g)) { const mes = +m[1].slice(2, 4); expect(mes > 12 && mes < 51 || mes > 62).toBe(true); }
        for (const m of vse.matchAll(/(?<!r\. ?č\. ?)\b\d{6,10}\/(\d{4})/g)) expect(m[1]).toBe('0000');
        for (const m of vse.matchAll(/\b\d{1,2}\. \d{1,2}\. (\d{4})/g)) expect(['1970', '2025', '2026', '2028']).toContain(m[1]);
    });
    test('všechny zlaté odpovědi projdou bez chyb', () => {
        for (const p of SADA.pripady) { const r = C.vyhodnot(p, p.reference, S); expect([p.id, r.chyby]).toEqual([p.id, []]); }
    });
});

describe('katalog chyb — každá kontrola zabere', () => {
    test('halucinovaný fakt a citace, která ho nepodporuje', () => {
        expect(typy('R1', 'Cena díla činí 1 750 000 Kč (Dodatek č. 1, čl. 2 odst. 1) a termín je 31. 8. 2026 (Dodatek, čl. 1 odst. 1).')).toEqual(expect.arrayContaining(['halucinace', 'chybejici_fakt']));
        expect(typy('R2', 'Vady: prasklá dlažba a netěsnící okno (protokol, bod 3), odstranit do 30 dnů (protokol, bod 4). Převzal Mgr. Karel Neexistující.')).toContain('halucinace');
    });
    test('citace na neexistující místo i na dokument, který ve spisu není', () => {
        expect(typy('C2', 'Záruka je 24 měsíců (smlouva o dílo, čl. 12 odst. 4).')).toContain('neexistujici_misto');
        expect(typy('C2', 'Záruka je 24 měsíců (rozsudek, bod 2).')).toContain('neexistujici_misto');
    });
    test('správný fakt s chybnou citací', () => {
        expect(typy('C2', 'Záruka je 24 měsíců (smlouva o dílo, čl. 4 odst. 1).')).toEqual(expect.arrayContaining(['chybna_citace']));
    });
    test('vynechaný klíčový dokument a past', () => {
        expect(typy('R1', 'Cena díla je 1 480 000 Kč (smlouva o dílo, čl. 4 odst. 1), dokončení do 30. 6. 2026 (čl. 3 odst. 1).')).toEqual(expect.arrayContaining(['vynechany_dokument', 'past', 'chybejici_fakt']));
    });
    test('odpověď mimo spis', () => {
        expect(typy('M1', 'Číslo účtu zhotovitele je 2400123456/2010 (smlouva o dílo, čl. 4 odst. 2).')).toContain('mimo_spis');
        expect(typy('M4', 'Soud žalobu zamítl rozsudkem ze dne 3. 9. 2026.')).toContain('mimo_spis');
    });
    test('nepřiznaný rozpor', () => {
        expect(typy('P2', 'Mezi dokumenty není rozpor v nehodovosti; vše odpovídá kupní smlouvě (čl. 3 odst. 2).')).toContain('nepriznany_rozpor');
    });
    test('chybná lhůta (bez posunu z neděle)', () => {
        expect(typy('L1', 'Výzva doručena 2. 10. 2026 (výzva soudu, bod 3), lhůta 30 dnů — vyjádření do 1. 11. 2026.')).toEqual(expect.arrayContaining(['chybna_lhuta', 'past']));
    });
    test('únik osobních údajů do dopisu', () => {
        expect(typy('D1', 'Vážení, nájemce Ota Modelový (r. č. 801399/0001) byl po operaci páteře v pracovní neschopnosti, nájemné 18 500 Kč (čl. 3 odst. 1).')).toContain('unik_udaju');
    });
    test('neexistující § a doporučení bez opory', () => {
        expect(typy('K1', 'Rozhodčí doložka (čl. 8 odst. 3) je neplatná podle § 9999 OZ. Pokuty 0,5 % (čl. 6 odst. 2) jsou nevyvážené.\nDoporučuji smlouvu v tomto znění nepodepisovat a vyjednat změny.')).toEqual(expect.arrayContaining(['vymysleny_paragraf', 'bez_opory']));
    });
    test('neúplné shrnutí', () => {
        expect(typy('H1', 'Smlouva o dílo na rekonstrukci (čl. 2 odst. 1), cena 1 480 000 Kč (čl. 4 odst. 1).')).toContain('neuplne_shrnuti');
    });
    test('chyba běhu a prázdná odpověď', () => {
        expect(C.vyhodnot(P('R1'), '', S).chyby.map(c => c.typ)).toEqual(['chyba_behu']);
        expect(C.vyhodnot(P('R1'), 'x', S, { chyba: 'HTTP 502' }).prosel).toBe(false);
    });
    test('doplňky programu se do textu modelu nepočítají', () => {
        const t = 'Záruka 24 měsíců (smlouva o dílo, čl. 7 odst. 1).\n\n---\n🔎 Automatická kontrola smlouvy:\n• Čl. 8 – Rozhodčí doložka';
        expect(C.textModelu(t)).toBe('Záruka 24 měsíců (smlouva o dílo, čl. 7 odst. 1).');
        expect(typy('C2', t)).toEqual([]);
    });
});

describe('porovnání běhů', () => {
    const { souhrnBehu } = require('../scripts/spis_eval');
    const { regrese, tabulka } = require('../scripts/spis_eval_compare');
    const beh = (label, odp) => {
        const vys = SADA.pripady.map(p => Object.assign({ opakovani: 1 }, C.vyhodnot(p, odp(p), S)));
        return { meta: { label, sada: { hash: 'x' } }, souhrn: souhrnBehu(vys), vysledky: vys };
    };
    test('zhoršení typu se ukáže jako regrese a heat mapa má řádek za typ', () => {
        const a = beh('A', p => p.reference);
        const b = beh('B', p => p.typ === 'lhuty' ? 'Nevím.' : p.reference);
        const r = regrese(a, b);
        expect(r.some(x => /lhůty a výpočty: skóre 100 →/.test(x))).toBe(true);
        expect(tabulka([a, b]).split('\n').filter(l => /^\| (rešerše|shrnutí|rozpory|odpověď|kontrola|lhůty|mimo|dopis)/.test(l))).toHaveLength(8);
    });
});

describe('LLM-judge: dvojice a kalibrace', () => {
    const J = require('../eval/spis_eval/judge');
    const PARY = require('../eval/spis_eval/judge/pary.json').pary;
    const { metriky, nactiOznaceni } = require('../scripts/spis_eval_judge');
    test('každá dvojice míří na existující místo; vývoj = S1–S4, kontrola = S5–S6; obě odpovědi zastoupené', () => {
        for (const p of PARY) expect([p.id, !!J.textMista(S[p.spis], p.kotva)]).toEqual([p.id, true]);
        expect(PARY.filter(p => p.sada === 'kontrola').every(p => ['S5', 'S6'].includes(p.spis))).toBe(true);
        for (const sada of ['vyvoj', 'kontrola']) for (const k of ['ANO', 'NE']) expect(PARY.some(p => p.sada === sada && p.klic === k)).toBe(true);
    });
    test('příklady pro judge jen ze sady vývoj', () => {
        const pr = J.vyberPriklady(PARY, 8);
        expect(pr).toHaveLength(8);
        expect(pr.every(p => p.sada === 'vyvoj')).toBe(true);
        expect(new Set(pr.map(p => p.klic)).size).toBe(2);
        const m = J.zpravy('místo', 'tvrzení', pr.map(p => Object.assign({ misto: 'x' }, p)));
        expect(m[0].content).toMatch(/PODPORUJE/);
        expect(m).toHaveLength(1 + 16 + 1);
    });
    test('rozbor odpovědi judge a metriky (κ, FP, FN)', () => {
        expect(J.rozeber('ANO\nMísto to uvádí.')).toEqual({ verdikt: 'ANO', duvod: 'Místo to uvádí.' });
        expect(J.rozeber('**NE** — jiná hodnota').verdikt).toBe('NE');
        expect(J.rozeber('nevím').verdikt).toBeNull();
        const m = metriky([{ ocek: 'ANO', vysl: 'ANO' }, { ocek: 'NE', vysl: 'ANO' }, { ocek: 'NE', vysl: 'NE' }, { ocek: 'ANO', vysl: null }]);
        expect(m).toMatchObject({ n: 3, shoda: 2, fp: 1, fn: 0, bez: 1 });
    });
    test('pracovní list neobsahuje klíč ani druh dvojice; ruční označení se načte', () => {
        const fs = require('fs'), os = require('os');
        const f = path.join(__dirname, '..', 'eval', 'spis_eval', 'judge', 'kalibrace_k_oznaceni.csv');
        const t = fs.readFileSync(f, 'utf8');
        expect(t.split('\n')[0]).toMatch(/^\ufeff?id;citované místo;text citovaného místa;tvrzení;hodnocení/);
        expect(t).not.toMatch(/parafraze|jina_hodnota|jine_misto|"vyvoj"|"kontrola"/);
        const tmp = path.join(os.tmpdir(), 'oznaceni_' + Date.now() + '.csv');
        fs.writeFileSync(tmp, 'id;a;b;c;hodnocení;p\n"J01";"x";"y";"z";"ano";""\n"J02";"x";"y; s středníkem";"z";"NE";""\n"J03";"";"";"";"";""\n');
        expect(nactiOznaceni(tmp)).toEqual({ J01: 'ANO', J02: 'NE' });
    });
});

describe('opravy z prvního běhu na Claudovi (4. 11. 2026)', () => {
    test('dopis protistraně: číslo smlouvy a sp. zn. nejsou účet, skutečný účet ano', () => {
        const { redactForOpponent } = require('../lib/agent_outlines');
        const src = 'NÁJEMNÍ SMLOUVA č. EV-NS-03/2026, účet pronajímatele č. 1234567890/0000, sp. zn. 12 C 101/2026.';
        const r = redactForOpponent('Smlouva č. EV-NS-03/2026, sp. zn. 12 C 101/2026, platba na 1234567890/0000.', src);
        expect(r.text).toMatch(/EV-NS-03\/2026/);
        expect(r.text).toMatch(/12 C 101\/2026/);
        expect(r.text).not.toMatch(/1234567890/);
    });
    test('kontrola opory: nadpis, popis ustanovení a „údaj ve spisu není“ nejsou doporučení', () => {
        const LB = require('../lib/legal_basis');
        const t = 'Doporučení pro klienta\n**Co ustanovení říká:** Nájemce je povinen složit jistotu 55 500 Kč.\nČíslo účtu ve spisu uvedeno není, je třeba si ho vyžádat.';
        expect(LB.kontrolaOpory(t).bezOpory).toEqual([]);
    });
    test('citace v tabulce, zkratky dokumentů, zápis čl. 2/2 a „viz bod 7“', () => {
        const t = '| | Dokument A | Dokument B |\n|---|---|---|\n| km | KS čl. 2/2 | PP bod 2 |\nRozdíl viz bod 7.';
        const c = C.citace(t, S.S2, null);
        expect(c.map(x => [x.doc, x.cl, x.odst, x.bod])).toEqual([['KS', 2, 2, null], ['PREDAVACI', null, null, 2]]);
    });
});

describe('osnovy z evalu: rozpory a návrhy úprav', () => {
    const { taskProfile } = require('../lib/agent_outlines');
    test('„najdi rozpory“ dostane vlastní osnovu s citací u každé hodnoty', () => {
        const p = taskProfile({ agentId: 'kontrolor', prompt: 'Najdi všechny rozpory mezi dokumenty ve spisu.' });
        expect(p.kind).toBe('contradictions');
        expect(p.outline).toMatch(/VLASTNÍ citaci s celým názvem dokumentu/);
        expect(p.outline).toMatch(/Sjednaná změna \(dodatek\) není rozpor/);
    });
    test('kontrola smlouvy chce oporu i u návrhu úpravy; dopis protistraně zůstává dopisem', () => {
        expect(taskProfile({ agentId: 'kontrolor', prompt: 'Zkontroluj smlouvu a vypiš rizika.', context: 'smlouva' }).outline).toMatch(/Návrh úpravy[^\n]*i návrh má oporu/);
        expect(taskProfile({ agentId: 'spisovatel', prompt: 'Napiš dopis protistraně, že ve výpočtu dluhu je rozpor.' }).kind).toBe('opponent_letter');
    });
    test('pravidlo zdůvodnění chce u citace spisu název dokumentu', () => {
        expect(require('../lib/legal_basis').PRAVIDLO).toMatch(/s názvem dokumentu i místem/);
    });
});
