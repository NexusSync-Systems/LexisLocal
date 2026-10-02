'use strict';
// Regrese nálezů ze serverového testu 2. 10. 2026 (server_suite.js).
const { anonymizeText } = require('../lib/anonymizer');
const auth = require('../lib/auth');

describe('anonymizace — účty a adresa', () => {
    test('bankovní účet, IBAN a adresa bydliště se redigují', () => {
        const out = anonymizeText('účet 123456789/0800, IBAN CZ65 0800 0000 1920 0014 5399, bytem Okružní 5, Jihlava.');
        expect(out).not.toMatch(/123456789|CZ65|Okružní/);
        expect(out).toContain('[ÚČET]');
        expect(out).toContain('[ADRESA]');
    });
    test('spisové značky a č. j. zůstávají', () => {
        const t = 'sp. zn. 12 C 45/2026 a č. j. 14 C 309/2026-9';
        expect(anonymizeText(t)).toBe(t);
    });
});

describe('fakturace — záporné položky', () => {
    test('záporná částka se odmítne', () => {
        jest.isolateModules(() => {
            const db = require('../lib/database');
            const orig = db.insert;
            db.insert = (c, o) => ({ id: 'x', ...o });
            try {
                const f = require('../lib/fakturace');
                expect(() => f.createInvoice({ items: [{ popis: 'X', amount: -500 }] })).toThrow(/nezáporné/);
            } finally { db.insert = orig; }
        });
    });
});

describe('auth — přípona statického souboru neodemyká API', () => {
    test('/api/*.js vyžaduje token', () => {
        expect(auth.checkAuth('T', { method: 'GET', path: '/api/x.js', headers: {} }).allowed).toBe(false);
    });
});
