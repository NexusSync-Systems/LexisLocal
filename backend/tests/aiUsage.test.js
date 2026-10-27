/**
 * aiUsage.test.js — spotřeba cloudové AI (lib/ai_usage.js) a večerní porovnání s AWS
 * (lib/aws_billing.js): odhad ceny, záznam z volání Bedrocku, rozpočet a tvrdý strop,
 * Cost Explorer (podpis, filtr služeb, potvrzené dny, opravný poměr), chyba oprávnění.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = path.join(os.tmpdir(), `lexis_test_aiusage_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp; process.env.LEXIS_KEY_DIR = tmp + '_key'; process.env.LEXIS_DATA_DIR = tmp + '_data';

jest.mock('../lib/ollama_client', () => ({ chat: jest.fn(async () => ({ message: { content: 'LOKALNE' } })) }));
const db = require('../lib/database');
const spisy = require('../lib/spisy');
const P = require('../lib/cloud_policy');
const ai = require('../lib/ai_provider');
const U = require('../lib/ai_usage');
const AB = require('../lib/aws_billing');
const ADV = { userId: 'u1', name: 'JUDr. A', kind: 'user', scopes: ['read', 'write', 'approve'] };
const ENV = ['AI_CHAT_PROVIDER', 'BEDROCK_REGION', 'BEDROCK_MODEL_ID', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
const saved = {};
let spis, bedrockCalls;

beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    db.set('spisy', []); db.set('spis_events', []); db.set('ai_usage', []); db.set('ai_usage_daily', []); db.set('ai_billing_sync', []);
    U.ulozNastaveni({ mesicniRozpocetUsd: 0, tvrdyStrop: false, tolerancePct: 5, cenik: U.VYCHOZI_CENIK });
    Object.assign(process.env, { AI_CHAT_PROVIDER: 'bedrock', BEDROCK_REGION: 'eu-central-1', BEDROCK_MODEL_ID: 'eu.anthropic.claude-sonnet-5-v1:0', AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S' });
    spis = spisy.createSpis({ spisZn: '3 Cm 3/2026' });
    P.setStupen(spis.id, 'D', { principal: ADV, duvod: 'veřejné podklady' });
    bedrockCalls = 0;
    global.fetch = jest.fn(async (url) => {
        if (String(url).includes('bedrock-runtime')) { bedrockCalls++; return { ok: true, json: async () => ({ output: { message: { content: [{ text: 'CLOUD' }] } }, usage: { inputTokens: 8000, outputTokens: 1500 } }) }; }
        throw new Error('neočekávaná síť ' + url);
    });
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } delete global.fetch; });

const ask = () => P.scope({}, async () => { P.noteSpis(spis.id); const r = await ai.chat({ model: 'llama', messages: [{ role: 'user', content: 'x' }] }); return { r, sh: P.shrnuti() }; });

test('odhad ceny podle ceníku; model bez ceníku = null', () => {
    expect(U.odhadCeny('eu.anthropic.claude-sonnet-5', { inputTokens: 8000, outputTokens: 1500 })).toBe(0.05115);
    expect(U.odhadCeny('eu.anthropic.claude-fable-5', { inputTokens: 1 })).toBeNull();
});

test('volání Bedrocku se zapíše (tokeny, cena, spis, statistika) a vrátí v shrnutí', async () => {
    const { r, sh } = await ask();
    expect(r.message.content).toBe('CLOUD');
    const rec = db.get('ai_usage');
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ spisIds: [spis.id], inputTokens: 8000, outputTokens: 1500, odhadUsd: 0.05115 });
    expect(sh.naklady.odhadUsd).toBe(0.05115);
    expect(db.get('ai_usage_daily')[0].cloud).toBe(1);
});

test('souhrn: rozpočet, procenta, stav a rozpad po spisech', async () => {
    U.ulozNastaveni({ mesicniRozpocetUsd: 0.1, varovaniPct: 80 });
    await ask();
    expect(U.souhrn()).toMatchObject({ celkem: 0.0512, stav: 'ok' });
    await ask();
    const s = U.souhrn();
    expect(s.stav).toBe('prekroceno');
    expect(s.poSpisech[0].spisZn).toBe('3 Cm 3/2026');
});

test('tvrdý strop: po vyčerpání rozpočtu jde dotaz lokálně a nic neodejde', async () => {
    U.ulozNastaveni({ mesicniRozpocetUsd: 0.05, tvrdyStrop: true });
    await ask();
    expect(bedrockCalls).toBe(1);
    const { r } = await ask();
    expect(bedrockCalls).toBe(1);
    expect(r.message.content).toBe('LOKALNE');
    expect(r.lexisCloud.code).toBe('rozpocet');
});

test('porovnání s AWS: podepsaný GetCostAndUsage, jen služby Bedrock/Claude, potvrzené dny a opravný poměr', async () => {
    const now = new Date(Date.UTC(2026, 9, 27, 21, 0));
    db.set('ai_usage', [
        { id: 'a', den: '2026-10-05', model: 'm', inputTokens: 1, outputTokens: 1, odhadUsd: 10, spisIds: [] },
        { id: 'b', den: '2026-10-20', model: 'm', inputTokens: 1, outputTokens: 1, odhadUsd: 10, spisIds: [] },
        { id: 'c', den: '2026-10-27', model: 'm', inputTokens: 1, outputTokens: 1, odhadUsd: 5, spisIds: [] }]);
    let seen;
    global.fetch = jest.fn(async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return { ok: true, text: async () => JSON.stringify({ ResultsByTime: [
        { TimePeriod: { Start: '2026-10-05' }, Groups: [{ Keys: ['Claude Sonnet 5 (Amazon Bedrock Edition)'], Metrics: { UnblendedCost: { Amount: '11' } } }, { Keys: ['Amazon Simple Storage Service'], Metrics: { UnblendedCost: { Amount: '3' } } }] },
        { TimePeriod: { Start: '2026-10-20' }, Groups: [{ Keys: ['Amazon Bedrock'], Metrics: { UnblendedCost: { Amount: '11' } } }] }] }) }; });
    const z = await AB.synchronizuj({ now });
    expect(seen.url).toBe('https://ce.us-east-1.amazonaws.com/');
    expect(seen.init.headers['x-amz-target']).toBe('AWSInsightsIndexService.GetCostAndUsage');
    expect(seen.init.headers.authorization).toMatch(/\/us-east-1\/ce\/aws4_request/);
    expect(seen.body.TimePeriod).toEqual({ Start: '2026-10-01', End: '2026-10-27' });
    expect(z).toMatchObject({ awsUsd: 22, odhadUsd: 20, rozdilPct: 10, stav: 'rozdil' });
    const s = U.souhrn('2026-10', now);
    expect(s).toMatchObject({ potvrzenoAws: 22, korekce: 1.1, celkem: 27.5 });
    expect(s.rada.find(r => r.den === '2026-10-05').zdroj).toBe('aws');
    expect(s.rada.find(r => r.den === '2026-10-27').zdroj).toBe('odhad');
});

test('porovnání: chybějící oprávnění se uloží se srozumitelnou chybou', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ __type: 'com.amazon#AccessDeniedException', message: 'not authorized' }) }));
    const now = new Date(Date.UTC(2026, 9, 27, 21));
    const z = await AB.synchronizuj({ now });
    expect(z.stav).toBe('chyba');
    expect(z.chyba).toMatch(/ce:GetCostAndUsage/);
    expect(U.souhrn('2026-10', now).posledniPokus.stav).toBe('chyba');
});

test('1. den v měsíci se porovná celý minulý měsíc', () => {
    expect(AB.obdobi(new Date(Date.UTC(2026, 10, 1, 21)))).toEqual({ od: '2026-10-01', do: '2026-11-01', mesic: '2026-10' });
});

test('nastavení: validace a jen pro správce (authz)', () => {
    expect(() => U.ulozNastaveni({ mesicniRozpocetUsd: -1 })).toThrow(/nezáporné/);
    expect(() => U.ulozNastaveni({ cenik: [{ vzor: '', vstup: 1, vystup: 1 }] })).toThrow(/Neplatný/);
    const authz = require('../lib/authz');
    expect(authz.authorize({ kind: 'user', scopes: ['read', 'write', 'approve'] }, 'GET', '/api/ai-usage/summary').allowed).toBe(false);
});
