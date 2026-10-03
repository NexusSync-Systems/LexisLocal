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
