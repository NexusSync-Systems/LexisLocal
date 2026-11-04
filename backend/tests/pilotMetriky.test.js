/**
 * Měření pilotu (lib/pilot_metriky.js): z dotazu agenta se ukládají jen počty a kódy — žádný text,
 * sp. zn. ani jméno. Přehled a export jen správce, hodnocení odpovědi z pevného výčtu.
 */
'use strict';
const path = require('path'), os = require('os'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `lexis_test_pilotmet_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';
process.env.LEXIS_DATA_DIR = tmp + '_data';

const TAJNE = 'Jan Tajemný, r. č. 801231/1234, sp. zn. 12 C 34/2026';
jest.mock('../lib/ai_provider', () => {
    const actual = jest.requireActual('../lib/ai_provider');
    return Object.assign({}, actual, {
        providerInfo: jest.fn(() => ({ chat: 'ollama', embed: 'ollama', localOnly: false, compliant: true })),
        chat: jest.fn(async () => {
            if (process.env.TEST_FAIL === 'down') throw Object.assign(new Error('Cloudový model je teď nedostupný'), { code: 'CLOUD_DOWN', status: 503 });
            return { message: { content: 'Doporučuji podat odvolání, klient Jan Tajemný má nárok na náhradu škody.' } };
        })
    });
});
jest.mock('../lib/rag', () => Object.assign({}, jest.requireActual('../lib/rag'), {
    searchSimilar: jest.fn(async () => []), getEmbedding: jest.fn(async () => { throw new Error('offline'); })
}));

const request = require('supertest');
const app = require('../server');
const db = require('../lib/database');
const M = require('../lib/pilot_metriky');
const H = (r) => r.set('X-API-Token', 'tok-test');

afterEach(() => { delete process.env.TEST_FAIL; });

test('dotaz agenta → počty po typu úlohy, bez textu a údajů klienta', async () => {
    db.set(M.TABULKA, []);
    const r = await H(request(app).post('/api/agent/resersnik')).send({ prompt: 'Co doporučíš? ' + TAJNE, context: TAJNE });
    expect(r.status).toBe(200);
    const rows = db.get(M.TABULKA);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ agentId: 'resersnik', dotazu: 1, ok: 1 });
    expect(rows[0].taskKind).toMatch(/^[a-z_]+$/);
    expect(JSON.stringify(rows)).not.toMatch(/Tajemn|801231|12 C 34|odvolání/);
    const s = (await H(request(app).get('/api/pilot-metriky'))).body;
    expect(s.typy[0].dotazu).toBe(1);
    const csv = (await H(request(app).get('/api/pilot-metriky/export.csv'))).text;
    expect(csv).toMatch(/^﻿taskKind;dotazu;/);
    expect(csv).not.toMatch(/Tajemn/);
});

test('výpadek cloudu se počítá zvlášť', async () => {
    db.set(M.TABULKA, []);
    process.env.TEST_FAIL = 'down';
    await H(request(app).post('/api/agent/resersnik')).send({ prompt: 'Otázka' });
    expect(db.get(M.TABULKA)[0]).toMatchObject({ dotazu: 1, cloud_nedostupny: 1, ok: 0 });
});

test('hodnocení: jen pevný výčet; souhrn a podíly', () => {
    db.set(M.TABULKA, []);
    const den = new Date('2026-11-10T10:00:00Z');
    M.zaznamenej({ agentId: 'kontrolor', taskKind: 'contract_review', vysledek: 'ok', ms: 2000,
        citationCheck: { total: 10, unverifiedCount: 2 }, opora: { doporuceni: 4, bezOpory: ['x'], vyslovneBez: [] },
        selfCheck: { found: ['bez_opory', 'Jan Tajemný'], retried: true, remaining: [] } }, den);
    M.ohodnot({ agentId: 'kontrolor', taskKind: 'contract_review', hodnoceni: 'spatne', duvod: 'chybi_opora' }, den);
    expect(() => M.ohodnot({ hodnoceni: 'spatne', duvod: 'klient Novák nespokojen' })).toThrow(/Neznámý důvod/);
    const t = M.souhrn('2026-11-10', '2026-11-10').typy[0];
    expect(t).toMatchObject({ taskKind: 'contract_review', pctNeovereneCitace: 20, pctBezOpory: 25, pctOpravaPomohla: 100, pctSpatneHodnoceni: 100 });
    expect(t.kody).toEqual({ bez_opory: 1, jine: 1 });   // kód, který není kód, se neuloží jako text
    expect(t.duvody).toEqual({ chybi_opora: 1 });
});

test('LEXIS_PILOT_METRIKY=0 nic neukládá', () => {
    db.set(M.TABULKA, []);
    process.env.LEXIS_PILOT_METRIKY = '0';
    M.zaznamenej({ agentId: 'x', vysledek: 'ok' });
    delete process.env.LEXIS_PILOT_METRIKY;
    expect(db.get(M.TABULKA)).toEqual([]);
});
