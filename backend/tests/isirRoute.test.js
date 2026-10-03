/**
 * GET /api/registries/isir/case — insolvenční řízení podle sp. zn. + porovnání se spisy.
 * Dotaz na ISIR je mock (fetchInsCase), žádná síť.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const ADMIN_TOKEN = 'isir-admin-token';
process.env.API_TOKEN = ADMIN_TOKEN;
process.env.WATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_isir_'));
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_isir_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_isir_data_'));
delete process.env.LEXIS_FIRM_MODE;

const request = require('supertest');
const app = require('../server');
const isir = require('../lib/isir_cases');
const ADMIN = { 'X-API-Token': ADMIN_TOKEN };

let spy;
beforeEach(() => {
    spy = jest.spyOn(isir, 'fetchInsCase').mockResolvedValue({
        ok: true, empty: false, query: 'KSBR 56 INS 1000/2026', syncedAt: '2026-10-03T15:00:00',
        cases: [{ spisZn: '56 INS 1000/2026', cisloSenatu: '56', dluznik: 'Test s.r.o.', stav: 'ODDLUŽENÍ', url: 'https://isir.justice.cz/isir/ueu/evidence_upadcu_detail.do?id=abc' }]
    });
});
afterEach(() => spy.mockRestore());

test('neplatná sp. zn. → 400 bez dotazu', async () => {
    const r = await request(app).get('/api/registries/isir/case').query({ spisZn: '12 C 5/2026' }).set(ADMIN);
    expect(r.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
});

test('nalezené řízení + shoda se spisem kanceláře', async () => {
    await request(app).post('/api/spisy').set(ADMIN).send({ nazev: 'Insolvence Test', spisZn: 'INS 1000/2026', klient: 'Klient' });
    const r = await request(app).get('/api/registries/isir/case').query({ spisZn: 'KSBR 56 INS 1000/2026' }).set(ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.cases[0]).toMatchObject({ stav: 'ODDLUŽENÍ' });
    expect(r.body.spisy.map(s => s.nazev)).toContain('Insolvence Test');
});

test('výpadek ISIR → 502 s vysvětlením', async () => {
    spy.mockResolvedValue({ ok: false, kind: 'unavailable', reason: 'ISIR nedostupný (timeout).' });
    const r = await request(app).get('/api/registries/isir/case').query({ spisZn: 'INS 1/2026' }).set(ADMIN);
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/nedostupný/);
});

test('POST /isir/check-now spustí hlídač', async () => {
    const spy2 = jest.spyOn(isir, 'checkInsolvencySpisy').mockResolvedValue({ checked: 2, changed: 0, failed: 0 });
    const r = await request(app).post('/api/registries/isir/check-now').set(ADMIN).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, checked: 2 });
    spy2.mockRestore();
});

test('insZn u spisu: jiné řízení vynuluje uložený stav ISIR, stejné řízení jinak zapsané ne', async () => {
    const db = require('../lib/database');
    const c = await request(app).post('/api/spisy').set(ADMIN).send({ nazev: 'Přihláška pohledávky', insZn: 'KSBR 56 INS 1000/2026' });
    const id = c.body.spis.id;
    expect(c.body.spis.insZn).toBe('KSBR 56 INS 1000/2026');
    db.update('spisy', id, { isirStav: 'KONKURS' });
    let p = await request(app).patch(`/api/spisy/${id}`).set(ADMIN).send({ insZn: '56 INS 1000 / 2026' });
    expect(p.body.spis.isirStav).toBe('KONKURS');
    p = await request(app).patch(`/api/spisy/${id}`).set(ADMIN).send({ insZn: 'INS 2000/2026' });
    expect(p.body.spis.isirStav).toBeNull();
});
