/**
 * Ruční vyhledání jednání (InfoJednání) podle sp. zn. i podle síně a data + porovnání
 * se spisy kanceláře. Odpovědi webu jsou ve tvaru zachyceném 3. 10. 2026 (fetch je mock).
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const ADMIN_TOKEN = 'hs-admin-token';
process.env.API_TOKEN = ADMIN_TOKEN;
process.env.WATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_hs_'));
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_hs_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_hs_data_'));
delete process.env.LEXIS_FIRM_MODE;

const request = require('supertest');
const app = require('../server');
const src = require('../lib/court_hearings_source');
const ADMIN = { 'X-API-Token': ADMIN_TOKEN };

const ROOM_RESP = {
    nadrizenaOrganizace: 'Krajský soud Brno', organizace: 'Okresní soud Jihlava', jednaciSin: 'č. 04 I. podlaží', datum: '05.10.2026', typ: 'JEDNANI',
    cislo: null, bcVec: null, druh: null, rocnik: null,
    udalosti: [
        { cislo: 6, bcVec: 9207, druh: 'NC', rocnik: 2026, datum: null, cas: '12:45', resitel: 'Mgr. X', jednaniZruseno: null, neverejneJednani: null, druhJednani: 'Jednání', jednaciSin: null },
        { cislo: 6, bcVec: 53, druh: 'P A NC', rocnik: 2026, datum: null, cas: '13:15', resitel: 'Mgr. X', jednaniZruseno: null, neverejneJednani: true, druhJednani: 'Jednání', jednaciSin: null },
        { cislo: 9, bcVec: 1, druh: 'C', rocnik: 2026, datum: null, cas: '14:00', resitel: 'Mgr. Y', jednaniZruseno: true, neverejneJednani: null, druhJednani: 'Jednání', jednaciSin: null }
    ], platneK: '2026-10-03T08:16:49+02:00'
};
const SPZN_RESP = {
    nadrizenaOrganizace: 'Krajský soud Brno', organizace: 'Okresní soud Jihlava', jednaciSin: null, datum: null, typ: 'SPZN',
    cislo: 6, bcVec: 9207, druh: 'NC', rocnik: 2026,
    udalosti: [{ cislo: null, bcVec: null, druh: null, rocnik: null, datum: '05.10.2026', cas: '12:45', resitel: 'Mgr. X', jednaniZruseno: null, druhJednani: 'Jednání', jednaciSin: 'č. 04 I. podlaží' }],
    platneK: '2026-10-03T08:16:49+02:00'
};

let calls = [];
const realFetch = global.fetch;
beforeAll(() => {
    global.fetch = async (url, init) => {
        calls.push({ url, init });
        let body = null;
        if (/jednaci-sin/.test(url)) body = [{ kod: 'č. 01 I. podlaží' }, { kod: 'č. 04 I. podlaží' }];
        else {
            const b = JSON.parse(init.body);
            body = b.typHledani === 'JEDNANI' ? ROOM_RESP : SPZN_RESP;
        }
        const t = JSON.stringify(body);
        return { ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t) };
    };
});
afterAll(() => {
    global.fetch = realFetch;
    for (const d of [process.env.WATCH_DIR, process.env.LEXIS_KEY_DIR, process.env.LEXIS_DATA_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

let spisJihlava, spisJinySoud;
test('příprava spisů', async () => {
    spisJihlava = (await request(app).post('/api/spisy').set(ADMIN).send({ nazev: 'Spor Jihlava', spisZn: '6 Nc 9207/2026', soud: 'Okresní soud v Jihlavě' })).body.spis;
    spisJinySoud = (await request(app).post('/api/spisy').set(ADMIN).send({ nazev: 'Jiná věc', spisZn: '6 P a Nc 53/2026', soud: 'Okresní soud v Třebíči' })).body.spis;
    expect(spisJihlava && spisJihlava.id).toBeTruthy();
});

test('spisZnKey sjednotí zápis sp. zn.', () => {
    expect(src.spisZnKey('6 P a Nc 53/2026')).toBe(src.spisZnKey('6 P A NC 53/2026'));
    expect(src.spisZnKey('6 Nc 9207/2026')).toBe(src.spisZnKey('6 NC 9207/2026'));
    expect(src.spisZnKey('nesmysl')).toBeNull();
});

test('číselník soudů a síní', async () => {
    const c = await request(app).get('/api/calendar/hearings/courts').set(ADMIN);
    expect(c.body.courts.length).toBe(96);
    const r = await request(app).get('/api/calendar/hearings/rooms?court=OSJIMJI').set(ADMIN);
    expect(r.body.rooms).toEqual(['č. 01 I. podlaží', 'č. 04 I. podlaží']);
    expect(calls.pop().url).toMatch(/\/api\/v1\/organizace\/lovkod\/jednaci-sin\?idOrganizace=OSJIMJI$/);
});

test('podle sp. zn.: najde jednání a přiřadí spis (shoda sp. zn. + soud)', async () => {
    const r = await request(app).get('/api/calendar/hearings/search').query({ mode: 'spzn', court: 'OSJIMJI', spisZn: '6 Nc 9207/2026' }).set(ADMIN);
    expect(r.statusCode).toBe(200);
    expect(r.body.events[0]).toMatchObject({ date: '2026-10-05', time: '12:45', room: 'č. 04 I. podlaží', spisZn: '6 NC 9207/2026' });
    expect(r.body.events[0].match).toMatchObject({ spisId: spisJihlava.id, exact: true });
    const sent = JSON.parse(calls.pop().init.body);
    expect(sent).toMatchObject({ druhOrganizace: 'KSJIMBM', okresniSoud: 'OSJIMJI', typHledani: 'SPZN', cisloSenatu: '6', bcVec: '9207', rocnik: '2026' });
});

test('podle síně a data: rozpis jednání, porovnání se spisy (přesná i možná shoda), zrušené', async () => {
    const r = await request(app).get('/api/calendar/hearings/search')
        .query({ mode: 'room', court: 'OSJIMJI', room: 'č. 04 I. podlaží', date: '2026-10-05' }).set(ADMIN);
    expect(r.statusCode).toBe(200);
    const sent = JSON.parse(calls.pop().init.body);
    expect(sent).toEqual({ druhOrganizace: 'KSJIMBM', okresniSoud: 'OSJIMJI', jednaciSin: 'č. 04 I. podlaží', datumJednani: '2026-10-05', typHledani: 'JEDNANI' });
    const [a, b, c] = r.body.events;
    expect(a).toMatchObject({ date: '2026-10-05', time: '12:45', room: 'č. 04 I. podlaží', spisZn: '6 NC 9207/2026' });
    expect(a.match).toMatchObject({ spisId: spisJihlava.id, exact: true });
    expect(b.match).toMatchObject({ spisId: spisJinySoud.id, exact: false }); // stejná sp. zn., jiný soud
    expect(b.nonPublic).toBe(true);
    expect(c.match).toBeNull();
    expect(c.cancelled).toBe(true);
    expect(r.body.matches).toBe(2);
});

test('validace vstupů', async () => {
    expect((await request(app).get('/api/calendar/hearings/search').query({ mode: 'spzn', court: 'XXX', spisZn: '1 C 1/2026' }).set(ADMIN)).statusCode).toBe(400);
    expect((await request(app).get('/api/calendar/hearings/search').query({ mode: 'spzn', court: 'OSJIMJI', spisZn: 'abc' }).set(ADMIN)).statusCode).toBe(400);
    expect((await request(app).get('/api/calendar/hearings/search').query({ mode: 'room', court: 'OSJIMJI', room: 'č. 04', date: '5.10.2026' }).set(ADMIN)).statusCode).toBe(400);
});

test('přidání ke sledování: potvrzené, ke spisu, bez duplicit; v dalším hledání označeno', async () => {
    const t = await request(app).post('/api/calendar/hearings/track').set(ADMIN)
        .send({ courtCode: 'OSJIMJI', spisZn: '6 NC 9207/2026', date: '2026-10-05', time: '12:45', room: 'č. 04 I. podlaží', spisId: spisJihlava.id });
    expect(t.statusCode).toBe(201);
    expect(t.body.hearing).toMatchObject({ status: 'scheduled', spisId: spisJihlava.id, courtCode: 'OSJIMJI', courtName: 'Okresní soud Jihlava' });
    const again = await request(app).post('/api/calendar/hearings/track').set(ADMIN)
        .send({ courtCode: 'OSJIMJI', spisZn: '6 Nc 9207/2026', date: '2026-10-05', spisId: spisJihlava.id });
    expect(again.statusCode).toBe(200);
    expect(again.body.created).toBe(false);
    const r = await request(app).get('/api/calendar/hearings/search').query({ mode: 'spzn', court: 'OSJIMJI', spisZn: '6 Nc 9207/2026' }).set(ADMIN);
    expect(r.body.events[0].tracked).toMatchObject({ status: 'scheduled' });
    expect((await request(app).post('/api/calendar/hearings/track').set(ADMIN).send({ courtCode: 'OSJIMJI', spisZn: '6 Nc 9207/2026', date: '2026-10-05', spisId: 'neexistuje' })).statusCode).toBe(404);
});
