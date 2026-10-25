/**
 * Vzorové výstupy (few-shot) agentů: výběr, vložení do zpráv modelu, správa přes API,
 * hlídání údajů převzatých z ukázky; kontrola výstupu (lib/output_checks.js).
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_examples_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

const mockCalls = [];
let mockReplies = [];
jest.mock('../lib/ai_provider', () => {
    const actual = jest.requireActual('../lib/ai_provider');
    return Object.assign({}, actual, {
        chat: jest.fn(async (args) => { mockCalls.push(args); return { message: { content: mockReplies.length ? mockReplies.shift() : 'Krátká odpověď.' } }; })
    });
});
jest.mock('../lib/rag', () => Object.assign({}, jest.requireActual('../lib/rag'), {
    searchSimilar: jest.fn(async () => []),
    getEmbedding: jest.fn(async () => { throw new Error('offline'); })
}));

const E = require('../lib/agent_examples');
const C = require('../lib/output_checks');
const request = require('supertest');
const app = require('../server');
const H = (r) => r.set('X-API-Token', 'tok-test');
const W2 = 'Připrav procesní plnou moc pro klientku Evu Novotnou, kterou zastupuje naše kancelář ve sporu o náhradu škody u Okresního soudu v Jihlavě.';
const LONG = (s) => s + ' ' + 'Zmocnitel tímto zmocňuje zmocněnce ke všem úkonům v řízení včetně opravných prostředků a přijímání písemností. '.repeat(3);

describe('knihovna', () => {
    test('validace: povinná pole, limity, id', () => {
        expect(() => E.validateExamples([{ zadani: 'x' }])).toThrow(/vyplňte zadání i vzorový výstup/);
        expect(() => E.validateExamples(new Array(9).fill({ zadani: 'a', vystup: 'b' }))).toThrow(/Nejvýše 8/);
        const v = E.validateExamples([{ zadani: 'Zadání', vystup: 'Výstup', always: true }]);
        expect(v[0]).toMatchObject({ enabled: true, always: true, title: 'Zadání' });
        expect(v[0].id).toMatch(/^ex_/);
    });
    test('výběr podle podobnosti zadání + „vždy použít“, nejvýše 2', () => {
        const agent = { examples: E.DEFAULT_EXAMPLES.spisovatel.concat([{ id: 'v', title: 'Styl', zadani: 'cokoli', vystup: 'x', always: true }]) };
        const sel = E.selectExamples(agent, W2);
        expect(sel.map(e => e.id)).toEqual(['v', 'vychozi_plna_moc']);
        expect(E.selectExamples(agent, 'Kolik je hodin?').map(e => e.id)).toEqual(['v']);
        expect(E.selectExamples({ examples: [{ ...agent.examples[0], enabled: false }] }, W2)).toEqual([]);
    });
    test('údaje převzaté z ukázky se poznají (ne ty, které jsou v zadání)', () => {
        const ex = [E.DEFAULT_EXAMPLES.spisovatel[0]];
        expect(C.copiedFromExamples('Zmocnitel Jan Vzorový … u Okresního soudu v Kladně', ex, W2)).toEqual(expect.arrayContaining(['Vzorového', 'Kladně']));
        expect(C.copiedFromExamples('Zmocnitelka Eva Novotná … u Okresního soudu v Jihlavě', ex, W2)).toEqual([]);
    });
    test('kontrola dopisu: částka, lhůta, pole k doplnění; sjednocení polí', () => {
        const r = C.checkOutput({ text: 'Vážený pane, zaplaťte škodu. '.repeat(10), prompt: 'Napiš výzvu k úhradě', sourceText: 'celkem 86 000 Kč', demand: true, agentId: 'spisovatel' });
        expect(r.issues.map(i => i.code)).toEqual(['amount_missing', 'deadline_missing', 'no_placeholders']);
        expect(C.normalizePlaceholders('[doplňte: jméno] a XXX a [adresa]').text).toBe('[Doplnit – jméno] a [Doplnit] a [Doplnit – adresa]');
    });
});

describe('route + API', () => {
    beforeEach(() => { mockCalls.length = 0; mockReplies = []; });

    test('výchozí ukázky Spisovatele; plná moc → ukázka jde modelu jako user/assistant', async () => {
        mockReplies = [LONG('PLNÁ MOC\n\nZmocnitel: Eva Novotná. Okresní soud v Jihlavě. [Doplnit – adresa]')];
        const r = await H(request(app).post('/api/agent/spisovatel')).send({ prompt: W2 });
        expect(r.status).toBe(200);
        const msgs = mockCalls[0].messages;
        const i = msgs.findIndex(m => m.role === 'user' && /VZOROVÁ UKÁZKA/.test(m.content));
        expect(i).toBeGreaterThan(0);
        expect(msgs[i + 1]).toMatchObject({ role: 'assistant' });
        expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: W2 });
        expect(r.body.examplesUsed).toEqual(['Procesní plná moc']);
        expect(mockCalls).toHaveLength(1);
    });

    test('model převzal jméno z ukázky → oprava; zůstane-li, nahradí ho program', async () => {
        const bad = LONG('PLNÁ MOC\n\nZmocnitel: Jan Vzorový, bytem [Doplnit]. Okresní soud v Kladně.');
        mockReplies = [bad, bad];
        const r = await H(request(app).post('/api/agent/spisovatel')).send({ prompt: W2 });
        expect(mockCalls).toHaveLength(2);
        expect(JSON.stringify(mockCalls[1].messages)).toMatch(/Převzal jsi údaje z ukázky/);
        expect(r.body.response).not.toMatch(/Vzorov|Kladn/);
        expect(r.body.response).toMatch(/údaj z ukázky nepřebírat/);
    });

    test('správa ukázek: uložit, běžná úprava agenta je nesmaže, reset na výchozí', async () => {
        const get0 = await H(request(app).get('/api/agents/spisovatel/examples'));
        expect(get0.body.examples).toHaveLength(2);
        expect(get0.body.hasDefaults).toBe(true);
        const bad = await H(request(app).post('/api/agents/spisovatel/examples')).send({ examples: [{ zadani: '', vystup: 'x' }] });
        expect(bad.status).toBe(400);
        const ok = await H(request(app).post('/api/agents/spisovatel/examples')).send({ examples: [{ title: 'Moje', zadani: 'Napiš odvolání', vystup: 'ODVOLÁNÍ …' }] });
        expect(ok.body.examples).toHaveLength(1);
        const list = (await H(request(app).get('/api/agents'))).body.agents;
        const sp = list.find(a => a.id === 'spisovatel');
        await H(request(app).post('/api/agents/spisovatel')).send({ name: sp.name, emoji: sp.emoji, role: sp.role, systemPrompt: sp.systemPrompt, permissions: sp.permissions });
        expect((await H(request(app).get('/api/agents/spisovatel/examples'))).body.examples.map(e => e.title)).toEqual(['Moje']);
        const reset = await H(request(app).post('/api/agents/spisovatel/examples')).send({ reset: true });
        expect(reset.body.examples).toHaveLength(2);
        expect((await H(request(app).get('/api/agents/neexistuje/examples'))).status).toBe(404);
    });
});
