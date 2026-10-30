'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV = ['AI_CHAT_PROVIDER', 'AI_EMBED_PROVIDER', 'AI_PROVIDER', 'LEXIS_JEN_CLOUD', 'LEXIS_PILOT_LOCAL_ONLY', 'AI_LOCAL_ONLY', 'LEXIS_AI_REZIM_ZAMEK', 'LEXIS_SETTINGS_DIR'];
let saved, dir, R;

const okFetch = async () => { const m = require('../lib/model_config'); return { json: async () => ({ models: [{ name: m.CHAT_MODEL }, { name: m.EMBEDDING_MODEL + ':latest' }] }) }; };
const downFetch = async () => { throw new Error('ECONNREFUSED'); };
const bedrockOk = { region: () => 'eu-central-1', modelId: () => 'eu.anthropic.claude-sonnet-4-6', credentialsAsync: async () => ({ accessKeyId: 'AKIATEST', secretAccessKey: 'x' }), instanceMode: () => false };
const bedrockUs = Object.assign({}, bedrockOk, { region: () => 'us-east-1', modelId: () => 'us.anthropic.claude-sonnet-4-6' });
const bedrockThrows = Object.assign({}, bedrockOk, { region: () => { throw new Error('není v EU'); }, modelId: () => { throw new Error('x'); } });
const bedrockNoCreds = Object.assign({}, bedrockOk, { credentialsAsync: async () => { throw new Error('chybí přístup'); } });
const opts = (o) => Object.assign({ fetch: okFetch, bedrock: bedrockOk, resolve: () => 'ok', logEvent: jest.fn() }, o);

beforeEach(() => {
    saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
    ENV.forEach(k => delete process.env[k]);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airezim-'));
    process.env.LEXIS_SETTINGS_DIR = dir;
    jest.resetModules();
    R = require('../lib/ai_rezim');
});
afterEach(() => {
    ENV.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('ai_rezim', () => {
    test('aktuální režim podle prostředí', () => {
        expect(R.aktualni()).toBe('lokalni');
        process.env.AI_CHAT_PROVIDER = 'bedrock';
        expect(R.aktualni()).toBe('hybrid');
        process.env.AI_EMBED_PROVIDER = 'onnx'; process.env.LEXIS_JEN_CLOUD = '1';
        expect(R.aktualni()).toBe('jen-cloud');
        process.env.AI_CHAT_PROVIDER = 'openai';
        expect(R.aktualni()).toBe('jiny');
    });

    test('připravenost: Ollama dole → lokální a hybrid nepřipravené, jen cloud ano', async () => {
        const p = await R.pripravenost(opts({ fetch: downFetch }));
        expect(p.lokalni.ok).toBe(false);
        expect(p.hybrid.ok).toBe(false);
        expect(p['jen-cloud'].ok).toBe(true);
        expect(JSON.stringify(p)).not.toMatch(/AKIATEST/); // údaje o přístupu se nikdy nevrací
    });

    test('přepnutí do jen cloud nastaví prostředí, uloží volbu a zapíše audit', async () => {
        const o = opts();
        const r = await R.nastav({ rezim: 'jen-cloud', potvrzeni: true }, o);
        expect(r).toMatchObject({ success: true, z: 'lokalni', na: 'jen-cloud', restartRecommended: true });
        expect(process.env.AI_CHAT_PROVIDER).toBe('bedrock');
        expect(process.env.AI_EMBED_PROVIDER).toBe('onnx');
        expect(process.env.LEXIS_JEN_CLOUD).toBe('1');
        expect(require('../lib/config').readSettings().aiRezim).toBe('jen-cloud');
        expect(o.logEvent).toHaveBeenCalledWith('Nastavení', 'Režim AI', 'lokalni → jen-cloud', expect.objectContaining({ na: 'jen-cloud' }));
        // zpět na lokální: LEXIS_JEN_CLOUD zmizí
        await R.nastav({ rezim: 'lokalni' }, o);
        expect(process.env.LEXIS_JEN_CLOUD).toBeUndefined();
        expect(R.aktualni()).toBe('lokalni');
    });

    test('cloudový režim bez potvrzení správce → 400', async () => {
        await expect(R.nastav({ rezim: 'hybrid' }, opts())).rejects.toMatchObject({ status: 400 });
        expect(R.aktualni()).toBe('lokalni');
    });

    test('Bedrock mimo EU nebo bez přístupu → 409, nic se nezmění', async () => {
        await expect(R.nastav({ rezim: 'hybrid', potvrzeni: true }, opts({ bedrock: bedrockUs }))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/region v EU/) });
        await expect(R.nastav({ rezim: 'jen-cloud', potvrzeni: true }, opts({ bedrock: bedrockNoCreds }))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/přístup k AWS/) });
        expect(R.aktualni()).toBe('lokalni');
        expect(require('../lib/config').readSettings().aiRezim).toBeUndefined();
    });

    test('pojistka mlčenlivosti povolí jen lokální režim', async () => {
        process.env.LEXIS_PILOT_LOCAL_ONLY = '1';
        await expect(R.nastav({ rezim: 'hybrid', potvrzeni: true }, opts())).rejects.toMatchObject({ status: 409 });
        await expect(R.nastav({ rezim: 'lokalni' }, opts())).resolves.toMatchObject({ na: 'lokalni' });
    });

    test('zámek z konfigurace serveru zakáže změnu', async () => {
        process.env.LEXIS_AI_REZIM_ZAMEK = '1';
        await expect(R.nastav({ rezim: 'lokalni' }, opts())).rejects.toMatchObject({ status: 409 });
        expect((await R.stav(opts())).zamek.typ).toBe('env');
    });

    test('návrat na lokální projde i bez Ollamy (s varováním)', async () => {
        process.env.AI_CHAT_PROVIDER = 'bedrock';
        const r = await R.nastav({ rezim: 'lokalni' }, opts({ fetch: downFetch }));
        expect(r.na).toBe('lokalni');
        expect(r.varovani).toMatch(/Ollama běží/);
        expect(process.env.AI_CHAT_PROVIDER).toBe('ollama');
    });

    test('Bedrock nenastaven (region hází) → karta se načte, cloud nepřipravený', async () => {
        const p = await R.pripravenost(opts({ bedrock: bedrockThrows }));
        expect(p.hybrid.ok).toBe(false);
        expect(p.hybrid.kontroly.find(c => /region/.test(c.nazev)).detail).toBe('nenastaven');
    });

    test('neznámý režim → 400', async () => {
        await expect(R.nastav({ rezim: 'openai' }, opts())).rejects.toMatchObject({ status: 400 });
    });

    test('uložená volba se při startu použije, pokud ji nezakazuje zámek', () => {
        require('../lib/config').writeSettings({ aiRezim: 'hybrid' });
        expect(R.applyPersisted()).toBe('hybrid');
        expect(process.env.AI_CHAT_PROVIDER).toBe('bedrock');
        delete process.env.AI_CHAT_PROVIDER;
        process.env.LEXIS_PILOT_LOCAL_ONLY = '1';
        const log = jest.fn();
        expect(R.applyPersisted(log)).toBeNull();
        expect(process.env.AI_CHAT_PROVIDER).toBeUndefined();
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/nepoužije/));
    });

    test('GET /api/settings/ai-rezim je jen pro správce', () => {
        const { requiredScope } = require('../lib/authz');
        expect(requiredScope('GET', '/api/settings/ai-rezim')).toBe('admin');
        expect(requiredScope('POST', '/api/settings/ai-rezim')).toBe('admin');
        expect(requiredScope('GET', '/api/settings/ingest-dir')).toBe('read');
    });
});
