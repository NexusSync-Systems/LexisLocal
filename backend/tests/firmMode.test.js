/**
 * Firemní režim z dashboardu: přepínač (jen správce, uloží se, přežije restart),
 * změna vlastníka spisu, sdílení jen s uživateli kanceláře, seznam kolegů.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const ADMIN_TOKEN = 'firm-admin-token';
process.env.API_TOKEN = ADMIN_TOKEN;
process.env.WATCH_DIR = path.join(os.tmpdir(), `lexis_test_firm_${Date.now()}`);
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_firm_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_firm_data_'));
delete process.env.LEXIS_FIRM_MODE;

const request = require('supertest');
const app = require('../server');
const access = require('../lib/access');
const config = require('../lib/config');

const ADMIN = { 'X-API-Token': ADMIN_TOKEN };
const as = (t) => ({ 'X-API-Token': t });
let A, B;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

afterAll(() => {
    access.setFirmMode(null);
    for (const d of [process.env.WATCH_DIR, process.env.LEXIS_KEY_DIR, process.env.LEXIS_DATA_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

test('bez uživatelů firemní režim zapnout nejde', async () => {
    const r = await request(app).post('/api/settings/firm-mode').set(ADMIN).send({ enabled: true });
    expect(r.statusCode).toBe(409);
});

test('po založení uživatelů: koncipient přepnout nesmí, správce ano; volba se uloží', async () => {
    A = (await request(app).post('/api/users').set(ADMIN).send({ name: 'JUDr. Anna Firemní', role: 'advokat' })).body;
    B = (await request(app).post('/api/users').set(ADMIN).send({ name: 'Mgr. Bořek Firemní', role: 'koncipient' })).body;
    expect((await request(app).post('/api/settings/firm-mode').set(as(B.token)).send({ enabled: true })).statusCode).toBe(403);
    const r = await request(app).post('/api/settings/firm-mode').set(ADMIN).send({ enabled: true });
    expect(r.statusCode).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(config.readSettings().firmMode).toBe(true);
    await wait(2100); // cache 2 s
    expect(access.isFirmMode()).toBe(true);
    const st = (await request(app).get('/api/settings/firm-mode').set(as(B.token))).body;
    expect(st).toMatchObject({ enabled: true, source: 'setting', users: 2 });
});

test('správce předá spis jinému vlastníkovi; původní vlastník (bez sdílení) ho přestane vidět', async () => {
    const s = (await request(app).post('/api/spisy').set(as(B.token)).send({ nazev: 'Předávaný spis' })).body.spis;
    expect(s.access.owner).toBe(B.user.id);
    const r = await request(app).post(`/api/spisy/${s.id}/owner`).set(as(B.token)).send({ userId: A.user.id });
    expect(r.statusCode).toBe(200);
    expect(r.body.access.owner).toBe(A.user.id);
    expect((await request(app).get('/api/spisy').set(as(B.token))).body.spisy.some(x => x.id === s.id)).toBe(false);
    expect((await request(app).get('/api/spisy').set(as(A.token))).body.spisy.some(x => x.id === s.id)).toBe(true);
});

test('cizí uživatel vlastníka nezmění; vlastníkem nemůže být neexistující účet', async () => {
    const s = (await request(app).post('/api/spisy').set(as(A.token)).send({ nazev: 'Spis Anny' })).body.spis;
    expect((await request(app).post(`/api/spisy/${s.id}/owner`).set(as(B.token)).send({ userId: B.user.id })).statusCode).toBe(403);
    expect((await request(app).post(`/api/spisy/${s.id}/owner`).set(as(A.token)).send({ userId: 'u_neexistuje' })).statusCode).toBe(400);
});

test('sdílet lze jen s uživatelem kanceláře', async () => {
    const s = (await request(app).post('/api/spisy').set(as(A.token)).send({ nazev: 'Sdílení test' })).body.spis;
    expect((await request(app).post(`/api/spisy/${s.id}/share`).set(as(A.token)).send({ userId: 'nekdo-cizi', level: 'read' })).statusCode).toBe(400);
    expect((await request(app).post(`/api/spisy/${s.id}/share`).set(as(A.token)).send({ userId: B.user.id, level: 'write' })).statusCode).toBe(200);
});

test('ACL i u detailu, úprav, deníku a smazání spisu (nález 14. 10. 2026)', async () => {
    const s = (await request(app).post('/api/spisy').set(as(A.token)).send({ nazev: 'Důvěrný spis' })).body.spis;
    const id = s.id;
    expect((await request(app).get(`/api/spisy/${id}`).set(as(B.token))).statusCode).toBe(403);
    expect((await request(app).patch(`/api/spisy/${id}`).set(as(B.token)).send({ nazev: 'X' })).statusCode).toBe(403);
    expect((await request(app).post(`/api/spisy/${id}/stav`).set(as(B.token)).send({ stav: 'archiv' })).statusCode).toBe(403);
    expect((await request(app).post(`/api/spisy/${id}/event`).set(as(B.token)).send({ type: 'poznamka', note: 'x' })).statusCode).toBe(403);
    expect((await request(app).delete(`/api/spisy/${id}`).set(as(B.token))).statusCode).toBe(403);
    expect((await request(app).get(`/api/spisy/${id}`).set(as(A.token))).statusCode).toBe(200);
    // sdílení jen pro čtení: číst smí, měnit ne
    expect((await request(app).post(`/api/spisy/${id}/share`).set(as(A.token)).send({ userId: B.user.id, level: 'read' })).statusCode).toBe(200);
    expect((await request(app).get(`/api/spisy/${id}`).set(as(B.token))).statusCode).toBe(200);
    expect((await request(app).patch(`/api/spisy/${id}`).set(as(B.token)).send({ nazev: 'X' })).statusCode).toBe(403);
});

test('seznam kolegů: jméno a role bez zařízení a tokenů, dostupný i koncipientovi', async () => {
    const r = await request(app).get('/api/me/colleagues').set(as(B.token));
    expect(r.statusCode).toBe(200);
    expect(r.body.users.map(u => u.name).sort()).toEqual(['JUDr. Anna Firemní', 'Mgr. Bořek Firemní']);
    expect(JSON.stringify(r.body)).not.toMatch(/devices|hash|llu_/);
});

test('vypnutí: všichni zase vidí vše', async () => {
    await request(app).post('/api/settings/firm-mode').set(ADMIN).send({ enabled: false }).expect(200);
    await wait(2100);
    expect(access.isFirmMode()).toBe(false);
    const all = (await request(app).get('/api/spisy').set(as(B.token))).body.spisy;
    expect(all.length).toBeGreaterThanOrEqual(3);
});

describe('review 2 / skupina 2: sp. zn. a přeřazení dokumentu', () => {
    beforeAll(() => access.setFirmMode(true));
    afterAll(() => access.setFirmMode(null));
    test('založení spisu s cizí sp. zn. → 409 bez údajů; vlastník dostane existující spis', async () => {
        const s = (await request(app).post('/api/spisy').set(as(A.token)).send({ spisZn: '21 C 77/2026', nazev: 'Tajný spis Anny', klient: 'Klient X' })).body.spis;
        const r = await request(app).post('/api/spisy').set(as(B.token)).send({ spisZn: '21 C 77/2026', nazev: 'Pokus' });
        expect(r.statusCode).toBe(409);
        expect(JSON.stringify(r.body)).not.toMatch(/Tajný|Klient X/);
        const r2 = await request(app).post('/api/spisy').set(as(A.token)).send({ spisZn: '21 C 77/2026' });
        expect(r2.statusCode).toBe(200);
        expect(r2.body.spis.id).toBe(s.id);
    });
    test('sp. zn. jiného spisu nelze převzít úpravou', async () => {
        const vlastni = (await request(app).post('/api/spisy').set(as(B.token)).send({ nazev: 'Spis Bořka' })).body.spis;
        const r = await request(app).patch(`/api/spisy/${vlastni.id}`).set(as(B.token)).send({ spisZn: '21 C 77/2026' });
        expect(r.statusCode).toBe(400);
        expect(r.body.error).toMatch(/jiný spis/);
    });
    test('dokument z cizího spisu si nikdo nepřeřadí do svého', async () => {
        const db = require('../lib/database');
        db.set('inbox_files', (db.get('inbox_files') || []).concat([{ id: 'fx1', fileName: 'tajne.pdf', caseNumber: '21 C 77/2026' }]));
        const vlastni = (await request(app).post('/api/spisy').set(as(B.token)).send({ spisZn: '5 C 5/2026', nazev: 'Bořek 2' })).body.spis;
        const r = await request(app).post(`/api/spisy/${vlastni.id}/assign-file`).set(as(B.token)).send({ fileId: 'fx1' });
        expect(r.statusCode).toBe(403);
        expect(db.get('inbox_files').find(f => f.id === 'fx1').caseNumber).toBe('21 C 77/2026');
    });
});

describe('review 2 / skupina 2: souhrnné přehledy a role', () => {
    beforeAll(() => access.setFirmMode(true));
    afterAll(() => access.setFirmMode(null));
    test('kalendář: lhůta cizího spisu se kolegovi bez přístupu nezobrazí', async () => {
        const db = require('../lib/database');
        await request(app).post('/api/spisy').set(as(A.token)).send({ spisZn: '30 C 3/2026', nazev: 'Anna kalendář' });
        db.set('calendar_events', [
            { id: 'ev_cizi', type: 'deadline', title: 'Lhůta Anny', date: '2026-12-01', spisZn: '30 C 3/2026' },
            { id: 'ev_obecna', type: 'deadline', title: 'Porada kanceláře', date: '2026-12-02' }
        ]);
        const b = (await request(app).get('/api/calendar/events').set(as(B.token))).body.events.map(e => e.id);
        expect(b).toContain('ev_obecna');
        expect(b).not.toContain('ev_cizi');
        const a = (await request(app).get('/api/calendar/events').set(as(A.token))).body.events;
        expect(a.map(e => e.id)).toContain('ev_cizi');
        expect(a[0]._vazby).toBeUndefined();
    });
    test('koncipient nestáhne datovou schránku ani neodešle kampaň', async () => {
        expect((await request(app).post('/api/registries/isds/inbox/poll').set(as(B.token))).statusCode).toBe(403);
        const r = await request(app).post('/api/campaigns/send').set(as(B.token)).send({ recipients: [{ ico: '1' }], confirmedByLawyer: true });
        expect(r.statusCode).toBe(403);
        expect(r.body.error).toMatch(/advokát/);
    });
});

