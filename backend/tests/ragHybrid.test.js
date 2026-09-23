/**
 * #5: hybridní retrieval — blend sémantického a lexikálního skóre. Opt-in v
 * searchSimilar (RAG_HYBRID); tady testujeme čistou blendScore().
 */
'use strict';
const { blendScore } = require('../lib/rag');

describe('#5 blendScore', () => {
    test('alpha=1 → jen sémantika; alpha=0 → jen lexikální', () => {
        expect(blendScore(0.8, 0.2, 1)).toBeCloseTo(0.8, 6);
        expect(blendScore(0.8, 0.2, 0)).toBeCloseTo(0.2, 6);
    });
    test('default (alpha=0.7) váží sémantiku výš', () => {
        expect(blendScore(1, 0, 0.7)).toBeCloseTo(0.7, 6);
        expect(blendScore(0, 1, 0.7)).toBeCloseTo(0.3, 6);
    });
    test('lexikální složka zvedne skóre chunku s přesnou shodou (§)', () => {
        // dva chunky se stejnou sémantikou, ale jen jeden má přesnou lexikální shodu
        const a = blendScore(0.6, 0.9, 0.7); // trefil § přesně
        const b = blendScore(0.6, 0.1, 0.7); // netrefil
        expect(a).toBeGreaterThan(b);
    });
    test('neplatná alpha → fallback 0.7; nečíselné vstupy → 0', () => {
        expect(blendScore(1, 0, 5)).toBeCloseTo(0.7, 6);
        expect(blendScore(NaN, NaN, 0.5)).toBe(0);
    });
});
