/**
 * Cloudový model (AI_CHAT_PROVIDER≠ollama): pasáže z klientských spisů, které RAG přidá
 * k dotazu agenta, jdou k modelu anonymizované; báze zákonů beze změny.
 */
'use strict';
const path = require('path'), os = require('os'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `lexis_test_cloudred_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

const seen = [];
jest.mock('../lib/ai_provider', () => {
    const actual = jest.requireActual('../lib/ai_provider');
    return Object.assign({}, actual, {
        providerInfo: jest.fn(() => ({ chat: process.env.TEST_CHAT || 'ollama', embed: 'ollama', localOnly: false, compliant: true })),
        chat: jest.fn(async ({ messages }) => { seen.push(messages); return { message: { content: 'Odpověď.' } }; })
    });
});
jest.mock('../lib/rag', () => Object.assign({}, jest.requireActual('../lib/rag'), {
    searchSimilar: jest.fn(async () => [
        { fileName: 'spis_12/smlouva.txt', scope: null, score: 0.9, text: 'Kupující Jan Horák, r. č. 801231/1234, účet 123456789/0800.' },
        { fileName: 'OZ 89-2012 § 2051.txt', scope: '_kb_resersnik', score: 0.8, text: '§ 2051 Dlužník může navrhnout snížení smluvní pokuty.' }
    ]),
    getEmbedding: jest.fn(async () => { throw new Error('offline'); })
}));

const request = require('supertest');
const app = require('../server');
const H = (r) => r.set('X-API-Token', 'tok-test');
const sent = () => seen[seen.length - 1].map(m => m.content).join('\n');

afterEach(() => { delete process.env.TEST_CHAT; });

test('lokální model: pasáž spisu beze změny', async () => {
    const r = await H(request(app).post('/api/agent/resersnik')).send({ prompt: 'Lze snížit smluvní pokutu?' });
    expect(r.status).toBe(200);
    expect(sent()).toMatch(/801231\/1234/);
});

test('cloudový model: rodné číslo a účet ze spisu k modelu nejdou, § ze zákona ano', async () => {
    process.env.TEST_CHAT = 'bedrock';
    const r = await H(request(app).post('/api/agent/resersnik')).send({ prompt: 'Lze snížit smluvní pokutu?' });
    expect(r.status).toBe(200);
    const s = sent();
    expect(s).not.toMatch(/801231\/1234/);
    expect(s).not.toMatch(/123456789\/0800/);
    expect(s).toMatch(/§ 2051 Dlužník může navrhnout/);
});
