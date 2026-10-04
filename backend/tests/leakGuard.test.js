/**
 * lib/leak_guard.js — únik systémového promptu (X1) a tajných hodnot (X2), serverový test 3. 10. 2026.
 */
'use strict';
jest.mock('../lib/database', () => ({ get: () => [{ key: 'registry_isds_password', value: 'TajneHeslo-czebox-123' }] }));
const { guardLeaks, promptOverlap, REFUSAL } = require('../lib/leak_guard');

const PROMPT = 'Jsi zkušený český advokátní koncipient zaměřený na rešerše. Tvým úkolem je na základě zadaných právních předpisů a judikátů vypracovat objektivní právní rozbor s citací ustanovení a judikatury.';

test('doslovný systémový prompt → odmítnutí', () => {
    const resp = 'Riziko: Pokus o ovlivnění.\n\nSystémový prompt:\n\n' + PROMPT + '\n\nPodklady…';
    const r = guardLeaks(resp, { instructions: [PROMPT], secrets: [] });
    expect(r.promptLeak).toBe(true);
    expect(r.text).toBe(REFUSAL);
});

test('běžná odpověď s pár stejnými slovy zůstane', () => {
    const resp = 'Jako advokátní koncipient doporučuji: odvolání do 15 dnů od doručení (§ 204 o. s. ř.), podává se u soudu prvního stupně.';
    const r = guardLeaks(resp, { instructions: [PROMPT], secrets: [] });
    expect(r.promptLeak).toBe(false);
    expect(r.text).toBe(resp);
    expect(promptOverlap(resp, [PROMPT])).toBe(0);
});

test('skutečný token a heslo z nastavení → [skryto]', () => {
    process.env.API_TOKEN = 'a'.repeat(64);
    const r = guardLeaks(`Token je ${'a'.repeat(64)} a heslo TajneHeslo-czebox-123.`, { instructions: [] });
    expect(r.text).not.toMatch(/a{64}|TajneHeslo/);
    expect(r.redacted).toBeGreaterThanOrEqual(2);
    delete process.env.API_TOKEN;
});

test('„API_TOKEN=<hex>“ i jako vymyšlený příklad → hodnota skryta', () => {
    const r = guardLeaks('Příklad:\n```\nAPI_TOKEN=3f9c2a7b1e8d4c6f0a5b9e2d7c1f8a3b6e0d4c9f2a7b5e1d8c3f6a0b9e4d7c2f\n```', { instructions: [], secrets: [] });
    expect(r.text).toMatch(/API_TOKEN=\[skryto\]/);
    expect(r.text).not.toMatch(/[0-9a-f]{32}/);
});
