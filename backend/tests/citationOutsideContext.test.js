/**
 * K2 (29. 10. 2026): skutečný paragraf, který v podkladech k dotazu nebyl → „mimo podklady“.
 * Zátěžový den: § 2248 OZ (zvýšení nájemného) místo § 2051 OZ u moderace smluvní pokuty — verifier ho bral jako ověřený.
 */
const v = require('../lib/citation_verifier');

const kb = { '89/2012': new Set(['2048', '2050', '2051', '2052', '2248']) };
const ctx = [{ text: '§ 2051\nSmluvní pokutu nepřiměřeně vysokou může soud na návrh dlužníka snížit s přihlédnutím k hodnotě a významu zajišťované povinnosti.' }];

describe('citation_verifier — mimo podklady', () => {
    test('paragrafy z podkladů vč. výčtů a rozsahů', () => {
        const s = v._contextParagraphs('podle §§ 2048 až 2052 OZ a § 2051 odst. 1; § 1813, 1814 a 1815; § 619–621');
        for (const p of ['2048', '2049', '2050', '2051', '2052', '1813', '1814', '1815', '619', '620', '621']) expect(s.has(p)).toBe(true);
        expect(s.has('1')).toBe(false);
    });
    test('§ 2248 OZ u smluvní pokuty se označí, § 2051 ne; míra halucinací beze změny', () => {
        const r = v.verifyCitations('Soud může pokutu snížit podle § 2051 OZ, srov. § 2248 OZ.', { contextChunks: ctx, kbIndex: kb });
        const by = Object.fromEntries(r.citations.map(c => [c.paragraph, c]));
        expect(by['2051'].outsideContext).toBe(false);
        expect(by['2248'].outsideContext).toBe(true);
        expect(by['2248'].status).toBe('verified');
        expect(r.outsideContextCount).toBe(1);
        expect(r.hallucinationRate).toBe(0);
    });
    test('podklady bez paragrafů (smlouva) → bez upozornění', () => {
        const r = v.verifyCitations('Ujednání je nepřiměřené (§ 2051 OZ).', { contextChunks: [{ text: 'Článek 5. Smluvní pokuta 1 % denně.' }], kbIndex: kb });
        expect(r.outsideContextCount).toBe(0);
    });
    test('async varianta vrací totéž', async () => {
        const r = await v.verifyCitationsWithSources('Podle § 2248 OZ.', { contextChunks: ctx, kbIndex: kb });
        expect(r.outsideContextCount).toBe(1);
        expect(r.citations[0].outsideContext).toBe(true);
    });
});
