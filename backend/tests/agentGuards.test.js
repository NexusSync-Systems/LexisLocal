'use strict';
const { buildDateFacts } = require('../lib/date_facts');
const { guardInventedIdentifiers, checkLawNames } = require('../lib/output_guard');
const { isEmbeddingModel } = require('../lib/agent_options');
const { validateExtraction } = require('../lib/extraction');

describe('date_facts', () => {
    test('28. 9. 2026 + 10 dní = 8. 10. 2026', () => {
        const f = buildDateFacts('Kolik je 28. 9. 2026 plus 10 dní?');
        expect(f.facts[0].end).toBe('2026-10-08');
    });
    test('konec v neděli se posouvá na pondělí a rozpor doručení se hlásí', () => {
        const f = buildDateFacts('Převzato 3. 10. 2026, doručeno 5. 10. 2026. Odpor do 15 dnů.');
        expect(f.facts[0]).toMatchObject({ base: '2026-10-03', end: '2026-10-19', shifted: true });
        expect(f.deliveryConflict).toBe(true);
    });
    test('bez data nic', () => { expect(buildDateFacts('lhůta 15 dnů')).toBeNull(); });
});

describe('output_guard', () => {
    test('vymyšlené IČO a sp. zn. nahradí, známé ponechá', () => {
        const r = guardInventedIdentifiers('IČO 12345678, IČO: 27074358, **Spisová značka:** 12 C 45/2026-58', 'IČO 27074358');
        expect(r.text).toContain('27074358');
        expect(r.text).not.toContain('12345678');
        expect(r.text).not.toContain('45/2026-58');
        expect(r.replaced).toHaveLength(2);
    });
    test('89/2012 Sb. není zákon o obchodním právu', () => {
        expect(checkLawNames('zákona č. 89/2012 Sb. (Zákon o obchodním právu)')).toHaveLength(1);
        expect(checkLawNames('zákona č. 89/2012 Sb., občanský zákoník')).toHaveLength(0);
    });
});

test('embedding model se nepovolí pro chat', () => {
    expect(isEmbeddingModel('bge-m3:latest')).toBe(true);
    expect(isEmbeddingModel('qwen2.5:7b')).toBe(false);
});

test('extraktor zahodí smyšlené účastníky, sp. zn. a lhůtu', () => {
    const r = validateExtraction({ caseNumber: '23 C 120/2026', plaintiff: 'Jana Fiktivní', defendant: 'Karel Malý', deadlineDays: 3 },
        'Smlouva: objednatel Karel Malý. Platba do 14 dnů.');
    expect(r).toMatchObject({ caseNumber: null, plaintiff: null, defendant: 'Karel Malý', deadlineDays: null });
});
