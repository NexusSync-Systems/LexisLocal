const { extractDeliveryDates, calculateDeadlineDate } = require('../lib/extraction');

describe('extractDeliveryDates — lhůta běží od doručení', () => {
    test('rozsudek doručený 15. 9. 2026 → odvolání do 30. 9. 2026', () => {
        const d = extractDeliveryDates('Doručeno do datové schránky advokáta dne 15. 9. 2026');
        expect(d.date).toBe('2026-09-15');
        expect(calculateDeadlineDate(15, d.date)).toBe('2026-09-30');
    });
    test('výzva doručená 22. 9. 2026, lhůta 10 dnů → 2. 10. 2026', () => {
        expect(calculateDeadlineDate(10, extractDeliveryDates('Doručeno: 22. 9. 2026').date)).toBe('2026-10-02');
    });
    test('rozporná data → nejdřívější + příznak rozporu; konec v neděli se posune', () => {
        const d = extractDeliveryDates('Doručeno do datové schránky: 5. 10. 2026\nPlatební rozkaz jsme převzali 3. 10. 2026');
        expect(d).toEqual({ date: '2026-10-03', all: ['2026-10-03', '2026-10-05'], conflict: true });
        expect(calculateDeadlineDate(15, d.date)).toBe('2026-10-19');
    });
    test('bez data doručení → null', () => {
        expect(extractDeliveryDates('Smlouva o dílo ze dne 10. 9. 2026').date).toBeNull();
    });
});
