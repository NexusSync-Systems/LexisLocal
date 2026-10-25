'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const ADMIN_TOKEN = 'cx-admin-token';
process.env.API_TOKEN = ADMIN_TOKEN;
process.env.WATCH_DIR = path.join(os.tmpdir(), `lexis_test_cx_${Date.now()}`);
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_cx_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_cx_data_'));
delete process.env.CODEXIS_API_KEY;
delete process.env.LEXIS_PILOT_LOCAL_ONLY;
delete process.env.AI_LOCAL_ONLY;

const request = require('supertest');
const app = require('../server');
const cx = require('../lib/codexis');
const audit = require('../lib/audit');
const ADMIN = { 'X-API-Token': ADMIN_TOKEN };
const KEY = 'cdx_test_0123456789abcdef';

afterAll(() => {
    for (const d of [process.env.WATCH_DIR, process.env.LEXIS_KEY_DIR, process.env.LEXIS_DATA_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

function fakeApi(script) {
    const calls = [];
    const fetch = jest.fn(async (url, init) => {
        calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
        const r = script(url, init, calls.length);
        return { ok: r.status < 400, status: r.status, json: async () => r.body };
    });
    cx._setForTests({ fetch, sleep: async () => {} });
    return calls;
}

test('výchozí stav: vypnuto, nic neodchází', async () => {
    const calls = fakeApi(() => ({ status: 200, body: {} }));
    expect(cx.status()).toMatchObject({ configured: false, enabled: false });
    const r = await cx.ask('Jaká je promlčecí lhůta?');
    expect(r.error).toMatch(/není zapnuté/);
    expect(calls).toHaveLength(0);
});

test('nastavení přes API: klíč se uloží s právy 0600 a nikdy se nevrací', async () => {
    const r = await request(app).post('/api/settings/codexis').set(ADMIN).send({ apiKey: KEY, enabled: true });
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect(r.body).toMatchObject({ configured: true, switchOn: true, enabled: true });
    const file = path.join(process.env.LEXIS_KEY_DIR, 'codexis_api_key');
    expect(fs.readFileSync(file, 'utf8')).toBe(KEY);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const g = await request(app).get('/api/settings/codexis').set(ADMIN);
    expect(JSON.stringify(g.body)).not.toContain(KEY);
    expect((await request(app).post('/api/settings/codexis').set(ADMIN).send({ apiKey: 'kratky' })).statusCode).toBe(400);
});

test('dotaz: spustí VM, počká na odpověď, osobní údaje neodejdou, zapíše se audit', async () => {
    let vmPolls = 0, msgPolls = 0;
    const calls = fakeApi((url, init) => {
        if (url.endsWith('/api/v1/vm') && init.method === 'GET') return { status: 200, body: { status: (vmPolls++ === 0) ? 'STOPPED' : 'RUNNING' } };
        if (url.endsWith('/api/v1/vm/start')) return { status: 202, body: { status: 'STARTING' } };
        if (url.endsWith('/api/v1/chats')) return { status: 202, body: { id: 'm1', chatId: 'c1', status: 'in_progress', text: '' } };
        if (url.includes('/api/v1/chats/c1/messages/m1')) return { status: 200, body: (msgPolls++ === 0)
            ? { id: 'm1', chatId: 'c1', status: 'in_progress', text: 'Pracuji…' }
            : { id: 'm1', chatId: 'c1', status: 'completed', text: 'Subjektivní lhůta je tři roky (§ 629 OZ).', parts: [{ type: 'citation', title: '§ 629 zákona č. 89/2012 Sb.' }] } };
        return { status: 404, body: {} };
    });
    const r = await cx.ask('Klient jan.novak@example.cz, RČ 800101/1234: jaká je promlčecí lhůta u náhrady škody?');
    expect(r).toMatchObject({ source: 'codexis', chatId: 'c1', citations: ['§ 629 zákona č. 89/2012 Sb.'] });
    expect(r.text).toContain('tři roky');
    expect(calls.every(c => c.headers['X-Api-Key'] === KEY)).toBe(true);
    const post = calls.find(c => c.url.endsWith('/api/v1/chats'));
    expect(post.body.input).not.toMatch(/jan\.novak|800101/);
    expect(post.body.input).toContain('[email]');
    expect(post.body.attachmentIds).toBeUndefined();
    expect(calls.some(c => c.url.endsWith('/vm/start'))).toBe(true);
    const log = audit.loadAuditLogs().filter(l => l.operation === 'Externí rešeršní dotaz (CODEXIS AI)').pop();
    expect(log.details.zacatek).not.toMatch(/800101/);
});

test('neplatný klíč → srozumitelná chyba; lokální režim → zakázáno', async () => {
    fakeApi(() => ({ status: 401, body: {} }));
    expect((await cx.ask('Otázka?')).error).toMatch(/neplatný klíč/);
    process.env.LEXIS_PILOT_LOCAL_ONLY = '1';
    try {
        expect(cx.status()).toMatchObject({ localOnly: true, enabled: false });
        expect((await cx.ask('Otázka?')).error).toMatch(/Lokální režim/);
        const r = await request(app).post('/api/codexis/ask').set(ADMIN).send({ question: 'x' });
        expect(r.statusCode).toBe(409);
    } finally { delete process.env.LEXIS_PILOT_LOCAL_ONLY; }
});

test('nástroj agenta se nabízí jen když je CODEXIS zapnuté', async () => {
    const tools = require('../lib/agent_tools');
    const agent = { permissions: { read_files: true } };
    expect(tools.toolsForAgent(agent).map(t => t.function.name)).toContain('search_codexis');
    await request(app).post('/api/settings/codexis').set(ADMIN).send({ enabled: false });
    expect(tools.toolsForAgent(agent).map(t => t.function.name)).not.toContain('search_codexis');
});
