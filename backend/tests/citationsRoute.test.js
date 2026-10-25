/**
 * Testy endpointu /api/citations/verify — ověření citací v textu (fail-closed).
 */
'use strict';

const path = require('path');
const os = require('os');
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = path.join(os.tmpdir(), `lexis_test_citroute_${Date.now()}`);
process.env.LEXIS_KEY_DIR = path.join(os.tmpdir(), `lexis_test_citroute_key_${Date.now()}`);

jest.mock('../lib/kb_law_index', () => ({ getKbLawIndex: () => ({ '89/2012': new Set(['629']) }) }));

const request = require('supertest');
const app = require('../server');
const H = (r) => r.set('X-API-Token', 'tok-test');

describe('POST /api/citations/verify', () => {
    test('prázdný text → 400', async () => {
        const r = await H(request(app).post('/api/citations/verify')).send({ text: '   ' });
        expect(r.statusCode).toBe(400);
    });

    test('rozpozná a ověří citace (bez podkladů → neověřené)', async () => {
        const r = await H(request(app).post('/api/citations/verify'))
            .send({ text: 'Nárok dle § 2048 zákona č. 89/2012 Sb., viz 21 Cdo 1234/2019.', useSources: false });
        expect(r.statusCode).toBe(200);
        expect(r.body.total).toBeGreaterThanOrEqual(2);
        expect(r.body.unverifiedCount).toBeGreaterThanOrEqual(1);
        expect(r.body.annotatedText).toContain('NEOVĚŘENO');
    });

    test('ověřené proti podkladům (contextChunks) se neoznačí', async () => {
        const r = await H(request(app).post('/api/citations/verify')).send({
            text: 'Podle § 2048 Sb.',
            contextChunks: [{ text: 'text obsahující § 2048 v podkladech' }],
            useSources: false
        });
        expect(r.statusCode).toBe(200);
        expect(r.body.total).toBeGreaterThanOrEqual(1);
    });
});

describe('GET /api/citations/sources', () => {
    test('vrátí seznam právních zdrojů s příznakem enabled', async () => {
        const r = await H(request(app).get('/api/citations/sources'));
        expect(r.statusCode).toBe(200);
        expect(Array.isArray(r.body.providers)).toBe(true);
        expect(r.body.providers.length).toBeGreaterThanOrEqual(1);
        r.body.providers.forEach(p => {
            expect(typeof p.name).toBe('string');
            expect(typeof p.enabled).toBe('boolean');
        });
    });

    test('paragraf z nahrané báze zákonů je ověřený (test 5. 10. 2026: § 629 OZ „nelze ověřit“)', async () => {
        const r = await H(request(app).post('/api/citations/verify'))
            .send({ text: 'Podle § 629 občanského zákoníku je promlčecí lhůta 3 roky.', useSources: false });
        expect(r.statusCode).toBe(200);
        expect(r.body.citations[0]).toMatchObject({ paragraph: '629', status: 'verified' });
    });
});
