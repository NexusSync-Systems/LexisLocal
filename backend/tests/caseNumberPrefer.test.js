'use strict';
const { preferCaseNumber } = require('../lib/case_number');

describe('preferCaseNumber (pravidla vs. AI)', () => {
    test('zkrácená sp. zn. od AI nepřepíše úplnou z pravidel (noční test 31. 10.)', () => {
        expect(preferCaseNumber('38 P a Nc 383/2026', '383/2026')).toBe('38 P a Nc 383/2026');
        expect(preferCaseNumber('38 P a Nc 383/2026', 'Nc 383/2026')).toBe('38 P a Nc 383/2026');
    });
    test('úplná sp. zn. od AI má přednost (pravidla chytla jinou)', () => {
        expect(preferCaseNumber('12 C 5/2025', '23 C 120/2026')).toBe('23 C 120/2026');
    });
    test('jedna strana chybí', () => {
        expect(preferCaseNumber('', '23 C 120/2026')).toBe('23 C 120/2026');
        expect(preferCaseNumber('23 C 120/2026', '')).toBe('23 C 120/2026');
        expect(preferCaseNumber('', '383/2026')).toBe('383/2026');
    });
});
