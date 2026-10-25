/**
 * fixFilingCourt: „odvolání se podává u krajského soudu“ → u soudu, který rozhodnutí vydal
 * (serverový test 7. 10. 2026, run 8, R4).
 */
'use strict';
const P = require('../lib/procedural_facts');

const civil = P.proceduralFacts({ prompt: 'Jaká je lhůta k podání odvolání proti rozsudku okresního soudu a kam se odvolání podává?' });

describe('fixFilingCourt', () => {
    test('opraví podání odvolání u krajského soudu', () => {
        const r = P.fixFilingCourt('Odvolání se podává u krajského soudu.\n- Podat odvolání ke krajskému soudu včas.', civil);
        expect(r.fixed).toBe(2);
        expect(r.text).not.toMatch(/(podává|podat)[^.\n]{0,50}(u|ke?) krajsk/i);
        expect(r.text).toMatch(/u soudu, který rozhodnutí vydal/);
    });

    test('správné věty nechá být (rozhoduje krajský soud, dovolání)', () => {
        const ok = 'O odvolání rozhoduje krajský soud. Dovolání se podává do dvou měsíců u soudu prvního stupně.';
        expect(P.fixFilingCourt(ok, civil)).toEqual({ text: ok, fixed: 0 });
    });

    test('bez civilního odvolání v zadání nic nemění', () => {
        const t = 'Odvolání se podává u krajského soudu.';
        expect(P.fixFilingCourt(t, null)).toEqual({ text: t, fixed: 0 });
        const crim = P.proceduralFacts({ prompt: 'Jaká je lhůta k odvolání v trestním řízení?' });
        expect(P.fixFilingCourt(t, crim).fixed).toBe(0);
    });
});
