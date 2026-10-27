/**
 * Rutinní korespondence od podatelny (lib/korespondence.js, návrh schválený 27. 10. 2026):
 * jen typ ze seznamu, jen se zapnutou volbou, vždy „ke kontrole“, schvaluje advokát,
 * podatelna upravuje jen vlastní neschválenou korespondenci. Data smyšlená, AI se nevolá.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const ADMIN_TOKEN = 'korespondence-admin-token';
process.env.API_TOKEN = ADMIN_TOKEN;
process.env.WATCH_DIR = path.join(os.tmpdir(), `lexis_test_kor_${Date.now()}`);
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_kor_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_kor_data_'));
delete process.env.LEXIS_FIRM_MODE;
delete process.env.LEXIS_PODATELNA_KORESPONDENCE;

const request = require('supertest');
const app = require('../server');
const access = require('../lib/access');
const K = require('../lib/korespondence');

const ADMIN = { 'X-API-Token': ADMIN_TOKEN };
const as = (t) => ({ 'X-API-Token': t });
let ADV, ASI, KON, spis;
const nova = (tok, body) => request(app).post('/api/drafts').set(as(tok)).send(Object.assign({ title: 'Žádost o podklady', text: 'Vážený pane,\nprosíme o zaslání podkladů.', spisId: spis.id }, body));

afterAll(() => { access.setFirmMode(null); });

beforeAll(async () => {
    ADV = (await request(app).post('/api/users').set(ADMIN).send({ name: 'JUDr. Karel Schvalovatel', role: 'advokat' })).body;
    ASI = (await request(app).post('/api/users').set(ADMIN).send({ name: 'Jana Podatelní', role: 'asistent' })).body;
    KON = (await request(app).post('/api/users').set(ADMIN).send({ name: 'Mgr. Petr Koncipient', role: 'koncipient' })).body;
    expect((await request(app).post('/api/settings/firm-mode').set(ADMIN).send({ enabled: true })).statusCode).toBe(200);
    access.setFirmMode(true);
    spis = (await request(app).post('/api/spisy').set(as(ADV.token)).send({ nazev: 'Věc klienta', spisZn: '21 C 77/2026' })).body.spis;
    expect((await request(app).post(`/api/spisy/${spis.id}/share`).set(as(ADV.token)).send({ userId: ASI.user.id, level: 'podatelna' })).statusCode).toBe(200);
});

test('výchozí stav: vypnuto — podatelna korespondenci nezaloží; zapnout smí jen správce', async () => {
    expect((await request(app).get('/api/drafts/korespondence').set(as(ASI.token))).body).toMatchObject({ enabled: false });
    const r = await nova(ASI.token, { korespondence: 'doplneni_podkladu' });
    expect(r.statusCode).toBe(403);
    expect(r.body.code).toBe('korespondence_off');
    expect((await request(app).post('/api/settings/podatelna-korespondence').set(as(ASI.token)).send({ enabled: true })).statusCode).toBe(403);
    expect((await request(app).post('/api/settings/podatelna-korespondence').set(ADMIN).send({ enabled: true })).body.enabled).toBe(true);
});

test('zapnuto: jen typ ze seznamu; bez typu (běžný koncept) podatelna nesmí', async () => {
    expect((await nova(ASI.token, {})).statusCode).toBe(403);
    const bad = await nova(ASI.token, { korespondence: 'odvolani' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.code).toBe('korespondence_typ');
});

let d;
test('podatelna založí korespondenci → ke kontrole, štítek, deník spisu; schválit nesmí', async () => {
    const r = await nova(ASI.token, { korespondence: 'doplneni_podkladu' });
    expect(r.statusCode).toBe(201);
    d = r.body;
    expect(d.status).toBe('ke_kontrole');
    expect(d.korespondence).toMatchObject({ typ: 'doplneni_podkladu', viaPodatelna: true, preparedBy: { userId: ASI.user.id } });
    const tl = (await request(app).get(`/api/spisy/${spis.id}/timeline`).set(as(ADV.token))).body;
    expect(JSON.stringify(tl)).toMatch(/připravil\(a\) korespondenci/);
    expect((await request(app).post(`/api/drafts/${d.id}/status`).set(as(ASI.token)).send({ status: 'schvaleno' })).statusCode).toBe(403);
});

test('připomínka advokáta → podatelna zapracuje do své korespondence; po schválení už ne', async () => {
    await request(app).post(`/api/drafts/${d.id}/comments`).set(as(ADV.token)).send({ text: 'Doplňte termín 10. 11.' });
    const v2 = await request(app).put(`/api/drafts/${d.id}`).set(as(ASI.token)).send({ text: 'Vážený pane,\nprosíme o zaslání podkladů do 10. 11. 2026.', baseVersion: 1 });
    expect(v2.statusCode).toBe(200);
    expect((await request(app).post(`/api/drafts/${d.id}/status`).set(as(ADV.token)).send({ status: 'schvaleno' })).body.status).toBe('schvaleno');
    expect((await request(app).put(`/api/drafts/${d.id}`).set(as(ASI.token)).send({ text: 'změna po schválení', baseVersion: 2 })).statusCode).toBe(403);
});

test('podatelna neupraví cizí koncept ani cizí korespondenci; advokát a koncipient se zápisem ano', async () => {
    const ciz = (await nova(ADV.token, { title: 'Vyjádření', text: 'Vyjádření k žalobě — text advokáta.' })).body;
    expect((await request(app).put(`/api/drafts/${ciz.id}`).set(as(ASI.token)).send({ text: 'x', baseVersion: 1 })).statusCode).toBe(403);
    expect((await request(app).post(`/api/spisy/${spis.id}/share`).set(as(ADV.token)).send({ userId: KON.user.id, level: 'write' })).statusCode).toBe(200);
    const kk = (await nova(KON.token, { korespondence: 'termin_schuzky', text: 'Potvrzujeme schůzku dne [Doplnit].' })).body;
    expect(kk.korespondence.viaPodatelna).toBe(false);
    expect(kk.status).toBe('koncept');
    expect((await request(app).put(`/api/drafts/${kk.id}`).set(as(ASI.token)).send({ text: 'x', baseVersion: 1 })).statusCode).toBe(403);
});

test('Spisovatel: korespondence jen přes spisovatele; podatelna bez typu nemůže uložit koncept do spisu', async () => {
    const r1 = await request(app).post('/api/agent/resersnik').set(as(ASI.token)).send({ prompt: 'Dopis', korespondence: 'pruvodni_dopis', saveDraft: true, spisId: spis.id });
    expect(r1.statusCode).toBe(400);
    const r2 = await request(app).post('/api/agent/spisovatel').set(as(ASI.token)).send({ prompt: 'Napiš odvolání', saveDraft: true, spisId: spis.id });
    expect(r2.statusCode).toBe(403);
});

test('zadání pro Spisovatele a kontrola textu', () => {
    expect(K.instruction('upominka_faktury')).toMatch(/Nepiš žádné právní hodnocení/);
    expect(K.instruction('neznamy')).toBe('');
    expect(K.contentWarnings('Podle § 2051 OZ doporučujeme podat odvolání.')).toEqual(expect.arrayContaining(['odkaz na paragraf', 'doporučení procesního postupu / lhůta']));
    expect(K.contentWarnings('Prosíme o zaslání smlouvy a faktur do 10. 11. 2026.')).toEqual([]);
});
