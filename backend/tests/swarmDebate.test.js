/**
 * /api/agent-swarm/debate (test 2. 10. 2026):
 *  • chybějící agentId → 400 (dřív 404),
 *  • kontext jde modelu pseudonymizovaný a odpovědi mají zpět skutečná jména,
 *  • při výpadku modelu žádný natvrdo napsaný „posudek“ se smluvní pokutou 0,05 %.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_swarm_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

const mockSeen = [];
let mockFail = false;
jest.mock('../lib/ai_provider', () => {
    const actual = jest.requireActual('../lib/ai_provider');
    return Object.assign({}, actual, {
        chat: jest.fn(async ({ messages }) => {
            if (mockFail) throw new Error('ollama down');
            mockSeen.push(JSON.stringify(messages));
            return { message: { content: 'Návrh pro [OSOBA_1].' } };
        })
    });
});
jest.mock('../lib/rag', () => Object.assign({}, jest.requireActual('../lib/rag'), {
    searchSimilar: jest.fn(async () => []),
    getEmbedding: jest.fn(async () => { throw new Error('offline'); })
}));

const request = require('supertest');
const app = require('../server');
const H = (r) => r.set('X-API-Token', 'tok-test');

test('chybějící agenti → 400', async () => {
    const r = await H(request(app).post('/api/agent-swarm/debate')).send({ prompt: 'x' });
    expect(r.status).toBe(400);
});

test('pseudonymizace kontextu v debatě', async () => {
    const r = await H(request(app).post('/api/agent-swarm/debate')).send({
        prompt: 'Navrhni plnou moc.', agentId1: 'spisovatel', agentId2: 'kontrolor',
        context: 'Klient Jan Horák, bytem Okružní 5, Jihlava.'
    });
    expect(r.status).toBe(200);
    expect(mockSeen.join(' ')).not.toMatch(/Horák|Okružní/);
    expect(r.body.agent1.response).toBe('Návrh pro Jan Horák.');
    expect(r.body.agent2.response).toBe('Návrh pro Jan Horák.');
});

test('výpadek modelu → poctivý fallback, žádný smyšlený posudek', async () => {
    mockFail = true;
    const r = await H(request(app).post('/api/agent-swarm/debate')).send({ prompt: 'Zkontroluj smlouvu.', agentId1: 'spisovatel', agentId2: 'kontrolor' });
    mockFail = false;
    expect(r.body.fallback).toBe(true);
    expect(r.body.agent2.response).not.toMatch(/0[.,]05 %/);
    expect(r.body.agent2.response).toMatch(/NEBYLO ZPRACOVÁNO/);
});

test('F2: rozhodčí doložka ve spotřebitelské smlouvě — kontrola programem jde oběma agentům a do výsledku', async () => {
    const smlouva = 'SMLOUVA O DÍLO\nObjednatel je spotřebitel.\nČl. I\n1. Zhotovitel provede rekonstrukci koupelny.\nČl. VII\n1. Veškeré spory z této smlouvy rozhodne s konečnou platností rozhodce jmenovaný zhotovitelem.\nČl. VIII\n1. Smlouva nabývá účinnosti podpisem obou stran a vyhotovuje se ve dvou stejnopisech.';
    const n0 = mockSeen.length;
    const r = await H(request(app).post('/api/agent-swarm/debate')).send({
        prompt: 'Je rozhodčí doložka v této spotřebitelské smlouvě platná? Navrhni postup pro klienta.',
        agentId1: 'resersnik', agentId2: 'kontrolor', context: smlouva
    });
    expect(r.status).toBe(200);
    const sent = mockSeen.slice(n0);
    expect(sent.length).toBe(2);
    sent.forEach(m => expect(m).toMatch(/Automatická kontrola smlouvy[^"]*Rozhodčí doložka/));
    expect(r.body.clauseCheck.findings.map(f => f.id)).toContain('rozhodci');
    expect(r.body.agent2.response).toMatch(/Rozhodčí doložka — u spotřebitele neplatná/);
});

test('F2: když se doložka v debatě probere, program ji nepřipojuje znovu', async () => {
    const ai = require('../lib/ai_provider');
    ai.chat.mockImplementationOnce(async () => ({ message: { content: 'Rozhodčí doložka v čl. VII je u spotřebitele neplatná (§ 3 odst. 6 zák. č. 216/1994 Sb.).' } }));
    const smlouva = 'SMLOUVA O DÍLO\nObjednatel je spotřebitel.\nČl. I\n1. Zhotovitel provede rekonstrukci koupelny.\nČl. VII\n1. Veškeré spory z této smlouvy rozhodne s konečnou platností rozhodce jmenovaný zhotovitelem.\nČl. VIII\n1. Smlouva nabývá účinnosti podpisem obou stran a vyhotovuje se ve dvou stejnopisech.';
    const r = await H(request(app).post('/api/agent-swarm/debate')).send({ prompt: 'Posuď smlouvu.', agentId1: 'resersnik', agentId2: 'kontrolor', context: smlouva });
    expect(r.body.clauseCheck.appended).toEqual([]);
    expect(r.body.agent2.response).not.toMatch(/Automatická kontrola smlouvy našla/);
});
