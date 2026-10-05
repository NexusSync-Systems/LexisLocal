/**
 * Dotaz na rozhodnutí, které nemáme (serverový test 5. 10. 2026, R3 2/3).
 */
'use strict';
const path = require('path'); const os = require('os'); const fs = require('fs');
const tmp = path.join(os.tmpdir(), `lexis_test_unkdec_${Date.now()}`); fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test'; process.env.WATCH_DIR = tmp; process.env.LEXIS_KEY_DIR = tmp + '_key';

const mockCalls = [];
jest.mock('../lib/ai_provider', () => Object.assign({}, jest.requireActual('../lib/ai_provider'), {
    chat: jest.fn(async (args) => { mockCalls.push(args); return { message: { content: 'Odpověď modelu o věci.' } }; })
}));
jest.mock('../lib/rag', () => Object.assign({}, jest.requireActual('../lib/rag'), {
    searchSimilar: jest.fn(async () => []), getEmbedding: jest.fn(async () => { throw new Error('offline'); })
}));

const U = require('../lib/unknown_decision');
const request = require('supertest');
const app = require('../server');
const H = (r) => r.set('X-API-Token', 'tok-test');
const NOW = new Date(2026, 9, 5);

describe('knihovna', () => {
    test('rok v budoucnosti → nemůže existovat; dotaz na obsah → odpoví program', () => {
        const r = U.check('Shrň závěry rozsudku Nejvyššího soudu sp. zn. 99 Cdo 9999/2031 o náhradě škody.', { kb: '', now: NOW });
        expect(r.future).toEqual(['99 Cdo 9999/2031']);
        expect(r.direct).toBe(true);
        expect(r.text).toMatch(/nemůže existovat — rok 2031 je v budoucnosti/);
        expect(r.text).not.toMatch(/dosp[eě]l|konstatoval|rozhodl,/);
    });
    test('rozhodnutí v bázi nebo v kontextu → nic se neděje', () => {
        expect(U.check('Shrň rozsudek 21 Cdo 1234/2019.', { kb: '… sp. zn. 21 Cdo 1234/2019 …', now: NOW })).toBeNull();
        expect(U.check('Shrň rozsudek 21 Cdo 1234/2019.', { context: 'Rozsudek 21 Cdo 1234/2019: …', kb: '', now: NOW })).toBeNull();
    });
    test('jen zmínka (ne dotaz na obsah) → upozornění, model odpovídá', () => {
        const r = U.check('Napiš odvolání, opři se mimo jiné o 21 Cdo 1234/2019.', { kb: '', now: NOW });
        expect(r.direct).toBe(false);
        expect(r.notice).toMatch(/nemám k dispozici/);
    });
    test('prvostupňová sp. zn. (12 C 45/2026) se nekontroluje', () => {
        expect(U.check('Shrň rozsudek 12 C 45/2026.', { kb: '', now: NOW })).toBeNull();
    });
});

describe('route', () => {
    beforeEach(() => { mockCalls.length = 0; });
    test('R3: odpoví program bez modelu', async () => {
        const r = await H(request(app).post('/api/agent/resersnik')).send({ prompt: 'Shrň závěry rozsudku Nejvyššího soudu sp. zn. 99 Cdo 9999/2031 o náhradě škody.' });
        expect(r.status).toBe(200);
        expect(mockCalls).toHaveLength(0);
        expect(r.body.response).toMatch(/budouc/);
        expect(r.body.unknownDecision.future).toEqual(['99 Cdo 9999/2031']);
    });
    test('zmínka → upozornění před odpovědí modelu', async () => {
        const r = await H(request(app).post('/api/agent/resersnik')).send({ prompt: 'Jaké argumenty pro náhradu škody? Zmiň i 21 Cdo 1234/2019.' });
        expect(r.status).toBe(200);
        expect(mockCalls.length).toBeGreaterThan(0);
        expect(r.body.response).toMatch(/^⚠️ Rozhodnutí sp\. zn\. 21 Cdo 1234\/2019 nemám k dispozici/);
    });
});
