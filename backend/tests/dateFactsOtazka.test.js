'use strict';
const D = require('../lib/date_facts');
const SRC = 'Odstoupení doručeno prodávajícímu dne 22. 5. 2026. Výzva soudu: vyjádřit se do 30 dnů od doručení. Výzva byla žalovanému doručena dne 2. 10. 2026.';
test('rozpor dat doručení se nepřipojí k otázce, která se na lhůty neptá (eval 4. 11. 2026, M2)', () => {
    expect(D.dateFactsAppendix('Posudek cenu neuvádí.', D.buildDateFacts(SRC, { question: 'Kolik stála oprava vozidla po nehodě?' }))).toBe('');
});
test('u otázky na lhůtu zůstává', () => {
    expect(D.dateFactsAppendix('Do 2. 11. 2026.', D.buildDateFacts(SRC, { question: 'Do kdy se musí žalovaný vyjádřit?' }))).toMatch(/RŮZNÁ data doručení/);
    expect(D.dateFactsAppendix('x', D.buildDateFacts(SRC))).toMatch(/RŮZNÁ data doručení/);   // bez otázky jako dřív
});
