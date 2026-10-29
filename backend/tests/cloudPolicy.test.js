/**
 * cloudPolicy.test.js — pravidla cloudu podle spisu (lib/cloud_policy.js) a jejich vynucení
 * v ai_provider.chat: stupeň citlivosti A–D, souhlas klienta, dotaz nad více spisy,
 * text neznámého původu, přímé API zakázané pro klientská data, odepřený cloud → lokální model.
 * Bez sítě: ollama_client i global.fetch jsou mockované.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = path.join(os.tmpdir(), `lexis_test_cloudpolicy_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

jest.mock('../lib/ollama_client', () => ({
    chat: jest.fn(async () => ({ message: { content: 'LOKALNE' } })),
    embeddings: jest.fn(async () => ({ embedding: [0.1] }))
}));
const ollamaMock = require('../lib/ollama_client');
const db = require('../lib/database');
const spisy = require('../lib/spisy');
const P = require('../lib/cloud_policy');
const ai = require('../lib/ai_provider');

const ENV = ['AI_PROVIDER', 'AI_CHAT_PROVIDER', 'AI_EMBED_PROVIDER', 'LEXIS_PILOT_LOCAL_ONLY', 'AI_LOCAL_ONLY', 'BEDROCK_REGION', 'BEDROCK_MODEL_ID',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'LEXIS_POVOLIT_PRIME_API', 'LEXIS_CLOUD_ODEPRENI', 'LEXIS_CLOUD_BEZ_KONTEXTU', 'LEXIS_CLOUD_FALLBACK_MODEL'];
const saved = {};
const ADVOKAT = { userId: 'u1', name: 'JUDr. Test', kind: 'user', scopes: ['read', 'write', 'approve'] };
const KONCIPIENT = { userId: 'u2', name: 'Mgr. Koncipient', kind: 'user', scopes: ['read', 'write'] };
const AGENT = { userId: 'agent:x', name: 'Agent', kind: 'agent', scopes: ['read', 'write'] };

let sA, sB, sC, sD;
beforeEach(() => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    db.set('spisy', []); db.set('spis_events', []);
    db.set('inbox_files', [
        { id: 'f1', fileName: 'smlouva_b.pdf', relativePath: 'smlouva_b.pdf', caseNumber: '12 C 2/2026' },
        { id: 'f2', fileName: 'nezarazeny.pdf', relativePath: 'nezarazeny.pdf' }
    ]);
    sA = spisy.createSpis({ spisZn: '1 T 1/2026', nazev: 'Trestní věc' });
    sB = spisy.createSpis({ spisZn: '12 C 2/2026', nazev: 'Spor FO' });
    sC = spisy.createSpis({ spisZn: '3 Cm 3/2026', nazev: 'Obchodní věc' });
    sD = spisy.createSpis({ spisZn: '4 C 4/2026', nazev: 'Rešerše' });
    P.setStupen(sA.id, 'A', { principal: ADVOKAT });
    P.setStupen(sC.id, 'C', { principal: ADVOKAT, duvod: 'obchodní věc PO' });
    P.setStupen(sD.id, 'D', { principal: ADVOKAT, duvod: 'jen veřejné podklady' });
    ollamaMock.chat.mockClear();
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } delete global.fetch; });

const bedrockEnv = () => Object.assign(process.env, { AI_CHAT_PROVIDER: 'bedrock', BEDROCK_REGION: 'eu-central-1', BEDROCK_MODEL_ID: 'eu.anthropic.claude-sonnet-x-v1:0', AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S' });
const bedrockFetch = () => { global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ output: { message: { content: [{ text: 'CLOUD' }] } } }) })); };
const ask = (opts, notes) => P.scope(opts, async () => { if (notes) notes(); return ai.chat({ model: 'llama-lokal', messages: [{ role: 'user', content: 'Dotaz' }] }); });

describe('stupeň a souhlas na spisu', () => {
    test('výchozí stupeň je B a bez souhlasu cloud nesmí', () => {
        expect(P.stupenSpisu(sB)).toBe('B');
        expect(P.vyhodnotSpis(spisy.getSpis(sB.id))).toMatchObject({ ok: false, code: 'chybi_souhlas' });
    });
    test('B potřebuje souhlas pro spis, rámcový nestačí', () => {
        P.udelSouhlas(sB.id, { typ: 'ramcovy', principal: ADVOKAT });
        expect(P.vyhodnotSpis(spisy.getSpis(sB.id)).ok).toBe(false);
        P.udelSouhlas(sB.id, { typ: 'spis', principal: ADVOKAT, poznamka: 'písemně 27. 10. 2026' });
        expect(P.vyhodnotSpis(spisy.getSpis(sB.id)).ok).toBe(true);
    });
    test('C stačí rámcový souhlas, D bez souhlasu, A nikdy', () => {
        P.udelSouhlas(sC.id, { typ: 'ramcovy', principal: ADVOKAT });
        expect(P.vyhodnotSpis(spisy.getSpis(sC.id)).ok).toBe(true);
        expect(P.vyhodnotSpis(spisy.getSpis(sD.id)).ok).toBe(true);
        expect(() => P.udelSouhlas(sA.id, { typ: 'spis', principal: ADVOKAT })).toThrow(/stupeň A/);
    });
    test('snížení stupně jen advokát a s důvodem; zvýšení smí koncipient; agent nic', () => {
        expect(() => P.setStupen(sB.id, 'C', { principal: KONCIPIENT, duvod: 'proč ne' })).toThrow(/advokát/);
        expect(() => P.setStupen(sB.id, 'C', { principal: ADVOKAT })).toThrow(/odůvodnění/);
        expect(P.setStupen(sB.id, 'A', { principal: KONCIPIENT }).cloudStupen).toBe('A');
        expect(() => P.setStupen(sC.id, 'A', { principal: AGENT })).toThrow(/agent/);
        expect(() => P.udelSouhlas(sC.id, { typ: 'ramcovy', principal: KONCIPIENT })).toThrow(/advokát/);
        const ev = spisy.getEvents(sB.id).map(e => e.type);
        expect(ev).toContain('cloud_stupen');
    });
    test('odvolání souhlasu platí okamžitě a smí ho i koncipient', () => {
        P.udelSouhlas(sB.id, { typ: 'spis', principal: ADVOKAT });
        P.odvolejSouhlas(sB.id, { principal: KONCIPIENT, duvod: 'klient odvolal' });
        expect(P.vyhodnotSpis(spisy.getSpis(sB.id)).ok).toBe(false);
        expect(spisy.getSpis(sB.id).cloudSouhlas.stav).toBe('odvolan');
    });
});

describe('rozhodnutí podle poskytovatele a kontextu', () => {
    test('Ollama a OpenAI-kompatibilní server v síti kanceláře jsou lokální', () => {
        expect(P.druhPoskytovatele('ollama')).toBe('lokalni');
        process.env.OPENAI_BASE_URL = 'http://192.168.1.20:8000/v1';
        expect(P.druhPoskytovatele('openai')).toBe('lokalni');
        process.env.OPENAI_BASE_URL = 'http://localhost:1234/v1';
        expect(P.druhPoskytovatele('openai')).toBe('lokalni');
        delete process.env.OPENAI_BASE_URL;
        expect(P.druhPoskytovatele('openai')).toBe('prime_api');
        expect(P.druhPoskytovatele('anthropic')).toBe('prime_api');
        expect(P.druhPoskytovatele('bedrock')).toBe('cloud_eu');
    });
    test('Bedrock bez kontextu (úloha mimo asistenta) neprojde', () => {
        expect(P.rozhodni('bedrock')).toMatchObject({ allowed: false, code: 'bez_kontextu' });
    });
    test('veřejný dotaz bez spisu projde, nezařazený ne', async () => {
        await P.scope({ dataClass: 'verejne' }, async () => expect(P.rozhodni('bedrock')).toMatchObject({ allowed: true, code: 'verejne' }));
        await P.scope({}, async () => expect(P.rozhodni('bedrock')).toMatchObject({ allowed: false, code: 'nezarazeno' }));
    });
    test('dotaz nad více spisy: musí projít každý (nejcitlivější vyhrává)', async () => {
        P.udelSouhlas(sC.id, { typ: 'ramcovy', principal: ADVOKAT });
        await P.scope({}, async () => {
            P.noteSpis(sC.id); P.noteSpis(sD.id);
            expect(P.rozhodni('bedrock').allowed).toBe(true);
            P.noteSpis(sA.id);
            const d = P.rozhodni('bedrock');
            expect(d).toMatchObject({ allowed: false, code: 'spis' });
            expect(d.duvody.join(' ')).toMatch(/stupeň A/);
        });
    });
    test('veřejný dotaz, do kterého RAG přidal klientský úsek, se řídí spisem úseku', async () => {
        await P.scope({ dataClass: 'verejne' }, async () => {
            P.noteRagMatches([{ fileName: 'zakon.txt', scope: '_kb_resersnik' }]);
            expect(P.rozhodni('bedrock').allowed).toBe(true);
            P.noteRagMatches([{ fileName: 'smlouva_b.pdf', scope: null }]);
            expect(P.rozhodni('bedrock')).toMatchObject({ allowed: false, code: 'spis' });
        });
    });
    test('dokument mimo spis = neznámý původ → cloud ne', async () => {
        await P.scope({ dataClass: 'verejne' }, async () => {
            P.noteFile('nezarazeny.pdf');
            expect(P.rozhodni('bedrock')).toMatchObject({ allowed: false, code: 'neznamy_puvod' });
        });
    });
    test('přímé API: klientská data nikdy; veřejný dotaz jen s LEXIS_POVOLIT_PRIME_API=1', async () => {
        P.udelSouhlas(sC.id, { typ: 'spis', principal: ADVOKAT });
        await P.scope({}, async () => { P.noteSpis(sC.id); expect(P.rozhodni('anthropic')).toMatchObject({ allowed: false, code: 'prime_api' }); });
        await P.scope({ dataClass: 'verejne' }, async () => expect(P.rozhodni('anthropic').allowed).toBe(false));
        process.env.LEXIS_POVOLIT_PRIME_API = '1';
        await P.scope({ dataClass: 'verejne' }, async () => expect(P.rozhodni('anthropic').allowed).toBe(true));
        await P.scope({}, async () => { P.noteSpis(sC.id); expect(P.rozhodni('anthropic').allowed).toBe(false); });
    });
});

describe('vynucení v ai_provider.chat', () => {
    test('povolený spis → Bedrock; zapíše se do deníku spisu', async () => {
        bedrockEnv(); bedrockFetch();
        P.udelSouhlas(sB.id, { typ: 'spis', principal: ADVOKAT });
        const r = await ask({}, () => P.noteSpis(sB.id));
        expect(r.message.content).toBe('CLOUD');
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(ollamaMock.chat).not.toHaveBeenCalled();
        expect(spisy.getEvents(sB.id).map(e => e.type)).toContain('cloud_ai');
    });
    test('odepřený cloud → lokální model, nic neodejde, důvod v odpovědi', async () => {
        bedrockEnv(); bedrockFetch();
        const r = await ask({}, () => P.noteSpis(sA.id));
        expect(global.fetch).not.toHaveBeenCalled();
        expect(r.message.content).toBe('LOKALNE');
        expect(r.lexisCloud).toMatchObject({ odepreno: true, code: 'spis' });
        expect(ollamaMock.chat.mock.calls[0][0].model).toBe('llama-lokal');
    });
    test('cloud nedostupný (chyba Bedrocku) → odpoví lokální model s důvodem, ne simulace', async () => {
        bedrockEnv();
        global.fetch = jest.fn(async () => ({ ok: false, status: 403, text: async () => 'AccessDeniedException: model is not available for this account' }));
        const r = await ask({ dataClass: 'verejne' });
        expect(global.fetch).toHaveBeenCalled();
        expect(r.message.content).toBe('LOKALNE');
        expect(r.lexisCloud).toMatchObject({ cloud: false, odepreno: true, code: 'chyba_cloudu' });
        expect(r.lexisCloud.duvody[0]).toMatch(/nedostupný/);
    });
    test('LEXIS_CLOUD_ODEPRENI=chyba → chyba CLOUD_POLICY místo lokálního modelu', async () => {
        bedrockEnv(); bedrockFetch(); process.env.LEXIS_CLOUD_ODEPRENI = 'chyba';
        await expect(ask({}, () => P.noteSpis(sB.id))).rejects.toMatchObject({ code: 'CLOUD_POLICY' });
        expect(global.fetch).not.toHaveBeenCalled();
        expect(ollamaMock.chat).not.toHaveBeenCalled();
    });
    test('přímé Anthropic API se spisem → lokálně, k api.anthropic.com nic neodejde', async () => {
        Object.assign(process.env, { AI_CHAT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'ak' });
        global.fetch = jest.fn();
        P.udelSouhlas(sC.id, { typ: 'spis', principal: ADVOKAT });
        const r = await ask({}, () => P.noteSpis(sC.id));
        expect(global.fetch).not.toHaveBeenCalled();
        expect(r.message.content).toBe('LOKALNE');
    });
    test('embeddingy přes veřejné OpenAI API jsou zakázané, v síti kanceláře povolené', async () => {
        process.env.AI_EMBED_PROVIDER = 'openai';
        await expect(ai.embeddings({ prompt: 'text spisu' })).rejects.toThrow(/zakázané/);
        process.env.OPENAI_BASE_URL = 'http://10.0.0.5:8000/v1';
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1] }] }) }));
        await expect(ai.embeddings({ prompt: 'text' })).resolves.toEqual({ embedding: [1] });
    });
});

describe('podklady pro kartu spisu (UI)', () => {
    test('opravneni: advokát vše, koncipient jen zvýšit/odvolat, agent nic', () => {
        expect(P.opravneni(ADVOKAT)).toEqual({ zvysitStupen: true, snizitStupen: true, udelitSouhlas: true, odvolatSouhlas: true });
        expect(P.opravneni(KONCIPIENT)).toEqual({ zvysitStupen: true, snizitStupen: false, udelitSouhlas: false, odvolatSouhlas: true });
        expect(P.opravneni(AGENT)).toEqual({ zvysitStupen: false, snizitStupen: false, udelitSouhlas: false, odvolatSouhlas: false });
    });
    test('stavKancelare: lokálně / jen lokálně / Bedrock EU / přímé API', () => {
        expect(P.stavKancelare()).toMatchObject({ druh: 'lokalni', cloudAktivni: false });
        bedrockEnv();
        expect(P.stavKancelare()).toMatchObject({ provider: 'bedrock', druh: 'cloud_eu', cloudAktivni: true, jenLokalne: false });
        process.env.LEXIS_PILOT_LOCAL_ONLY = '1';
        expect(P.stavKancelare()).toMatchObject({ jenLokalne: true, cloudAktivni: false });
        delete process.env.LEXIS_PILOT_LOCAL_ONLY;
        process.env.AI_CHAT_PROVIDER = 'anthropic';
        expect(P.stavKancelare()).toMatchObject({ druh: 'prime_api', cloudAktivni: true });
        expect(JSON.stringify(P.stavKancelare())).not.toMatch(/AKIA|S"|ak"/); // žádná tajemství
    });
    test('pomocné funkce UI: stav kanceláře a text souhlasu (escapování)', () => {
        global.escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const ui = require('../public/app-spis-cloud.js');
        expect(ui.spisCloudKancelar({ jenLokalne: true }).text).toMatch(/jen lokálně/);
        expect(ui.spisCloudKancelar({ cloudAktivni: true, druh: 'cloud_eu' }).text).toMatch(/Bedrock/);
        expect(ui.spisCloudKancelar({ cloudAktivni: true, druh: 'prime_api' }).text).toMatch(/zablokované/);
        expect(ui.spisCloudSouhlasText(null)).toMatch(/nezaznamenán/);
        const t = ui.spisCloudSouhlasText({ stav: 'udelen', typ: 'spis', udelenoAt: '2026-10-27T10:00:00Z', udelil: { name: 'JUDr. <b>X</b>' }, poznamka: '<img src=x>' }, { spis: 'Výslovný souhlas pro tento spis' });
        expect(t).toMatch(/udělen/);
        expect(t).not.toMatch(/<img|<b>X/);
        expect(ui.spisCloudSouhlasText({ stav: 'odvolan', odvolanoAt: '2026-10-27T10:00:00Z', odvolal: { name: 'A' } })).toMatch(/odvolán/);
        delete global.escapeHtml;
    });
});
