/**
 * Testy citation_verifier — slouží zároveň jako spec chování.
 */
const {
    verifyCitations,
    extractCitations,
    buildEmptyReferenceIndex
} = require('../lib/citation_verifier');

describe('extractCitations', () => {
    test('vytáhne zákon, paragraf i spisovou značku', () => {
        const t = 'Podle § 2048 zákona č. 89/2012 Sb. a rozhodnutí 26 Cdo 1230/2021 platí…';
        const c = extractCitations(t);
        const types = c.map(x => x.type).sort();
        expect(types).toEqual(['judikat', 'paragraf', 'zakon']);
        const par = c.find(x => x.type === 'paragraf');
        expect(par.paragraph).toBe('2048');
        expect(par.law).toBe('89/2012'); // navázáno na nejbližší zákon
    });
});

describe('ověření proti kontextu (bez referenčního indexu)', () => {
    const context = [{
        text: 'Smluvní pokuta se řídí § 2048 zákona č. 89/2012 Sb.',
        sourceId: 'chk_1', fileName: 'oz.txt'
    }];

    test('citace doložená v podkladech → verified + sourceId', () => {
        const r = verifyCitations('Uplatní se § 2048 zákona č. 89/2012 Sb.', { contextChunks: context });
        const par = r.citations.find(c => c.type === 'paragraf');
        expect(par.verified).toBe(true);
        expect(par.sourceId).toBe('chk_1');
        expect(r.hallucinationRate).toBe(0);
    });

    test('paragraf mimo podklady → neověřený, promítne se do hallucinationRate', () => {
        const r = verifyCitations('Dále viz § 9999 zákona č. 89/2012 Sb.', {
            contextChunks: context, strict: true
        });
        const par = r.citations.find(c => c.paragraph === '9999');
        expect(par.verified).toBe(false);
        expect(r.ok).toBe(false); // strict blokuje
        expect(r.hallucinationRate).toBeGreaterThan(0);
        expect(r.annotatedText).toContain('⚠ NEOVĚŘENO');
    });

    test('vymyšlená spisová značka bez indexu i kontextu → unverified_case', () => {
        const r = verifyCitations('Srov. 99 Cdo 1234/2099.', { contextChunks: context });
        const jud = r.citations.find(c => c.type === 'judikat');
        expect(jud.status).toBe('unverified_case');
        expect(jud.verified).toBe(false);
    });

    test('prázdný kontext → vše neověřené', () => {
        const r = verifyCitations('§ 2048 zákona č. 89/2012 Sb.', { contextChunks: [] });
        expect(r.unverifiedCount).toBe(r.total);
    });
});

describe('ověření proti referenčnímu indexu', () => {
    const ref = buildEmptyReferenceIndex();
    ref.laws['89/2012'] = new Set(['2048', '2079']);
    ref.caseNumbers.add('26 cdo 1230/2021');

    test('existující § v indexovaném zákoně → verified i bez kontextu', () => {
        const r = verifyCitations('§ 2079 zákona č. 89/2012 Sb.', { contextChunks: [], referenceIndex: ref });
        expect(r.citations.find(c => c.type === 'paragraf').verified).toBe(true);
    });

    test('neexistující § v indexovaném zákoně → not_in_reference', () => {
        const r = verifyCitations('§ 5000 zákona č. 89/2012 Sb.', { contextChunks: [], referenceIndex: ref });
        expect(r.citations.find(c => c.type === 'paragraf').status).toBe('not_in_reference');
    });

    test('známá sp. zn. v indexu → verified', () => {
        const r = verifyCitations('Viz 26 Cdo 1230/2021.', { contextChunks: [], referenceIndex: ref });
        expect(r.citations.find(c => c.type === 'judikat').verified).toBe(true);
    });
});

describe('přiřazení zákona k paragrafu (pořadí "§ X zákona Y")', () => {
    const { extractCitations, verifyCitations, buildEmptyReferenceIndex } = require('../lib/citation_verifier');

    test('více zákonů: každý § dostane SVŮJ následující zákon', () => {
        const c = extractCitations('Podle § 5 zákona č. 40/2009 Sb. a dále podle § 10 zákona č. 89/2012 Sb. platí.')
            .filter(x => x.type === 'paragraf');
        expect(c.find(x => x.paragraph === '5').law).toBe('40/2009');
        expect(c.find(x => x.paragraph === '10').law).toBe('89/2012'); // dřív chybně 40/2009
    });

    test('jeden zákon za více paragrafy → všechny k němu', () => {
        const c = extractCitations('Dle § 2048 a § 2079 zákona č. 89/2012 Sb.').filter(x => x.type === 'paragraf');
        expect(c.every(x => x.law === '89/2012')).toBe(true);
    });

    test('opačné pořadí (zákon před §) stále funguje', () => {
        const c = extractCitations('Podle zákona č. 89/2012 Sb. v § 2048 platí.').filter(x => x.type === 'paragraf');
        expect(c[0].law).toBe('89/2012');
    });

    test('dopad na ověření: § se kontroluje proti SPRÁVNÉMU zákonu', () => {
        const idx = buildEmptyReferenceIndex();
        idx.laws['89/2012'] = new Set(['10']);
        idx.laws['40/2009'] = new Set(['5']);
        const r = verifyCitations('Podle § 5 zákona č. 40/2009 Sb. a § 10 zákona č. 89/2012 Sb.', { referenceIndex: idx });
        expect(r.citations.find(x => x.paragraph === '10').status).toBe('verified');
        expect(r.citations.find(x => x.paragraph === '5').status).toBe('verified');
    });
});

// Server test 13. 10. 2026: všech 29 neověřených citací byl „holý“ § bez zákona
// (§ 2248, § 629 …) → do báze zákonů se nehledalo. Zákon se teď odvodí z báze.
describe('holý § bez zákona — odvození zákona z báze', () => {
    const { indexFromTexts } = require('../lib/kb_law_index');
    const kb = indexFromTexts([
        'Citace: § 2248 zákona č. 89/2012 Sb.; § 629 zákona č. 89/2012 Sb.; § 84 zákona č. 89/2012 Sb.',
        'Citace: § 629 zákona č. 90/2012 Sb.; § 84 zákona č. 99/1963 Sb.; § 84 zákona č. 90/2012 Sb.'
    ]);
    test('§ jen v jednom zákoně báze → ověřeno s odvozeným zákonem', () => {
        const r = verifyCitations('Nájemce může podle § 2248 požadovat slevu.', { kbIndex: kb });
        expect(r.citations[0]).toMatchObject({ status: 'verified', law: '89/2012', lawInferred: true });
        expect(r.unverifiedCount).toBe(0);
    });
    test('§ ve více zákonech → ambiguous_law (neověřeno), bez kontextu', () => {
        const r = verifyCitations('Promlčecí lhůta podle § 629 činí deset let.', { kbIndex: kb });
        expect(r.citations[0].status).toBe('ambiguous_law');
        expect(r.citations[0].verified).toBe(false);
        expect(r.citations[0].reason).toMatch(/89\/2012.*90\/2012|90\/2012.*89\/2012/);
    });
    test('§ ve více zákonech, ale odpověď jinde jmenuje OZ → zákon odvozen z odpovědi', () => {
        const txt = 'Podle § 2248 OZ nájemce … ' + 'x '.repeat(200) + 'Promlčení se řídí § 629.';
        const r = verifyCitations(txt, { kbIndex: kb });
        const c = r.citations.find(x => x.paragraph === '629');
        expect(c).toMatchObject({ status: 'verified', law: '89/2012', lawInferred: true });
    });
    test('§, který v bázi vůbec není, zůstává neověřený', () => {
        const r = verifyCitations('Podle § 9999 je to jinak.', { kbIndex: kb });
        expect(r.citations[0].status).toBe('unsupported_by_context');
    });
    test('bez kbIndex se chování nemění', () => {
        const r = verifyCitations('Podle § 2248 je to jinak.');
        expect(r.citations[0].status).toBe('unsupported_by_context');
        expect(r.citations[0].lawInferred).toBe(false);
    });
});
