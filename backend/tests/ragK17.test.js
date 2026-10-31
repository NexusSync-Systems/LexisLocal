'use strict';
// K17: slovník hovorových pojmů, zvýhodnění zmíněného zákona, přeřazení zákonů a judikatury zvlášť.

describe('query_terms', () => {
    const qt = require('../lib/query_terms');

    test('hovorový dotaz dostane právní pojmy, odborný dotaz zůstane', () => {
        const r = qt.rozsir('Půjčil jsem kamarádovi 20 tisíc a nevrací je');
        expect(r.text).toMatch(/zápůjčka/);
        expect(r.pojmy.length).toBeGreaterThan(0);
        const o = qt.rozsir('§ 2048 OZ moderace smluvní pokuty');
        expect(o.pojmy).toEqual([]);
        expect(o.text).toBe('§ 2048 OZ moderace smluvní pokuty');
    });

    test('pojem, který dotaz už obsahuje, se nepřidává znovu', () => {
        const r = qt.rozsir('Pronajímatel mi nevrací jistotu u nájmu, i když jsem zaplatil kauci');
        expect(r.pojmy).not.toContain('jistota u nájmu');
    });

    test('výslovně zmíněný zákon → prefix souborů báze', () => {
        expect(qt.rozsir('Ručím jako společník s.r.o. za dluhy?').zakony).toEqual(['ZOK 90-2012']);
        expect(qt.rozsir('Lhůta k odvolání podle o. s. ř.').zakony).toEqual(['OSŘ 99-1963']);
        expect(qt.rozsir('Exekutor mi zabavil auto').zakony).toContain('EŘ 120-2001');
        expect(qt.rozsir('Jak dlouhá je promlčecí lhůta?').zakony).toEqual([]);
    });

    test('rozbor K17: laické situace dostanou pojem, falešné shody ne', () => {
        expect(qt.rozsir('Firma mi dluží a já dlužím jí, můžeme si to odečíst?').pojmy).toContain('započtení vzájemných pohledávek');
        expect(qt.rozsir('Šíří o mně nepravdy na internetu').pojmy).toContain('ochrana osobnosti');
        expect(qt.rozsir('Chci zakázat prodej auta, než soud rozhodne').pojmy).toContain('předběžné opatření');
        expect(qt.rozsir('Zaplatili mi o měsíc později, než měli').pojmy).toContain('úrok z prodlení');
        expect(qt.rozsir('Po rozsudku jsem našel nový důkaz').pojmy).not.toContain('nález');
    });

    test('civilní procesní dotaz → o. s. ř.; hmotné právo, správní a trestní věci ne', () => {
        expect(qt.rozsir('Lze obnovit řízení po pravomocném rozsudku?').zakony).toContain('OSŘ 99-1963');
        expect(qt.rozsir('Soudce je příbuzný protistrany').zakony).toContain('OSŘ 99-1963');
        expect(qt.rozsir('Může soud snížit smluvní pokutu?').zakony).not.toContain('OSŘ 99-1963');
        expect(qt.rozsir('Lhůta pro podání správní žaloby').zakony).not.toContain('OSŘ 99-1963');
        expect(qt.rozsir('Odvolání proti rozsudku v trestní věci').zakony).not.toContain('OSŘ 99-1963');
    });

    test('zapnutí: výchozí zapnuto, env 0 vypne, opts má přednost', () => {
        const old = process.env.RAG_QUERY_TERMS;
        delete process.env.RAG_QUERY_TERMS;
        expect(qt.zapnuto()).toBe(true);
        process.env.RAG_QUERY_TERMS = '0';
        expect(qt.zapnuto()).toBe(false);
        expect(qt.zapnuto({ queryTerms: true })).toBe(true);
        process.env.RAG_QUERY_TERMS = '1';
        expect(qt.zapnuto({ queryTerms: false })).toBe(false);
        if (old === undefined) delete process.env.RAG_QUERY_TERMS; else process.env.RAG_QUERY_TERMS = old;
    });
});

describe('přeřazení zákonů a judikatury zvlášť', () => {
    let rag, calls;
    beforeEach(() => {
        jest.resetModules();
        calls = [];
        // Falešný reranker: obrátí pořadí top k (aby bylo vidět, že přeřadil) a zapíše, co dostal.
        jest.doMock('../lib/rerank_service', () => ({
            rerankEnabled: () => true, rerankK: () => 20,
            rerankResults: async (q, res, o) => { calls.push({ n: res.length, k: (o && o.k) || 20, first: res[0].fileName }); const k = (o && o.k) || 20; return res.slice(0, k).reverse().concat(res.slice(k)); }
        }));
        rag = require('../lib/rag');
    });
    afterEach(() => jest.dontMock('../lib/rerank_service'));

    const law = n => ({ fileName: `OZ 89-2012 § ${n}.txt`, scope: '_kb_resersnik', score: 0.5 });
    const jud = n => ({ fileName: `NS_${n}_2020.txt`, scope: '_kb_resersnik', score: 0.6 });
    const spis = n => ({ fileName: `spis/${n}.pdf`, scope: null, score: 0.7 });

    test('zákon mimo top 20 společného pořadí se do přeřazení dostane', async () => {
        // 25 rozhodnutí před zákony: v dnešním společném přeřazení (top 20) by žádný zákon nebyl.
        const ranked = [...Array.from({ length: 25 }, (_, i) => jud(i)), law('2390'), law('2391'), law('2392'), law('2393')];
        const out = await rag._rerankSplitMix('dotaz', ranked, 5, 0.75);
        expect(calls).toHaveLength(2); // _rerankSplitMix volá rovnou (bez ohledu na RAG_RERANK_SPLIT)
        expect(calls.find(c => c.first.startsWith('OZ'))).toMatchObject({ n: 4 });
        expect(calls.find(c => c.first.startsWith('NS'))).toMatchObject({ k: 10 });
        const top = out.slice(0, 5).map(r => r.fileName);
        expect(top.filter(f => f.startsWith('OZ'))).toHaveLength(4); // ceil(5 × 0,75)
        expect(top.filter(f => f.startsWith('NS'))).toHaveLength(1);
        expect(top[0]).toBe('OZ 89-2012 § 2393.txt'); // zákony před judikaturou, v pořadí rerankeru
        expect(out).toHaveLength(ranked.length); // nic se neztratí
    });

    test('málo zákonů → zbytek doplní judikatura; klientské spisy jdou první', async () => {
        const ranked = [spis('a'), jud(1), jud(2), jud(3), law('629')];
        const out = await rag._rerankSplitMix('dotaz', ranked, 5, 0.75);
        const top = out.slice(0, 5).map(r => r.fileName);
        expect(top).toHaveLength(5);
        expect(top[0]).toMatch(/^spis\//);
        expect(top).toContain('OZ 89-2012 § 629.txt');
    });
});
