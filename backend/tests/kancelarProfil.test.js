/**
 * Název a logo kanceláře v dashboardu + přihlášení dashboardu vlastním účtem párovacím odkazem
 * (27. 10. 2026). Logo jen rastrový obrázek do 256 KB, ověřený podle obsahu; měnit smí správce.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const ADMIN_TOKEN = 'kancelar-profil-admin-token';
process.env.API_TOKEN = ADMIN_TOKEN;
process.env.WATCH_DIR = path.join(os.tmpdir(), `lexis_test_kprof_${Date.now()}`);
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_kprof_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_kprof_data_'));

const request = require('supertest');
const app = require('../server');
const KP = require('../lib/kancelar_profil');

const ADMIN = { 'X-API-Token': ADMIN_TOKEN };
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let U;
beforeAll(async () => {
    U = (await request(app).post('/api/users').set(ADMIN).send({ name: 'Mgr. Eva Přihlášená', role: 'koncipient' })).body;
});

test('správce nastaví název a logo; každý přihlášený je čte; nesprávce měnit nesmí', async () => {
    const r = await request(app).post('/api/settings/kancelar').set(ADMIN).send({ nazev: '  Advokátní kancelář   Novák & partneři <s.r.o.> ', logo: PNG_1PX });
    expect(r.statusCode).toBe(200);
    expect(r.body.nazev).toBe('Advokátní kancelář Novák & partneři s.r.o.');
    expect(r.body.logo).toMatch(/^data:image\/png;base64,/);
    const g = await request(app).get('/api/settings/kancelar').set({ 'X-API-Token': U.token });
    expect(g.statusCode).toBe(200);
    expect(g.body.nazev).toMatch(/Novák/);
    expect((await request(app).post('/api/settings/kancelar').set({ 'X-API-Token': U.token }).send({ nazev: 'Jiná' })).statusCode).toBe(403);
    // jen název — logo zůstane; logo null — odebere se
    expect((await request(app).post('/api/settings/kancelar').set(ADMIN).send({ nazev: 'AK Novák' })).body.logo).toBeTruthy();
    expect((await request(app).post('/api/settings/kancelar').set(ADMIN).send({ logo: null })).body).toMatchObject({ nazev: 'AK Novák', logo: null });
});

test('logo: SVG, podvržený typ a příliš velký soubor se odmítnou', () => {
    expect(() => KP.checkLogo('data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64'))).toThrow(/SVG/);
    expect(() => KP.checkLogo('data:image/png;base64,' + Buffer.from('<html>nic</html>').toString('base64'))).toThrow(/neodpovídá/);
    const big = Buffer.alloc(300 * 1024); big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
    expect(() => KP.checkLogo('data:image/png;base64,' + big.toString('base64'))).toThrow(/KB/);
    expect(() => KP.set({ nazev: 'x'.repeat(121) })).toThrow(/120/);
});

test('přihlášení dashboardu: párovací odkaz /?pair= pro vlastní účet; claim vrátí token toho účtu', async () => {
    const p = await request(app).post('/api/pair/new').set({ 'X-API-Token': U.token }).send({ deviceLabel: 'Notebook doma' });
    expect(p.statusCode).toBe(200);
    expect(p.body.dashboardUrls[0]).toMatch(/\/\?pair=[A-Za-z0-9_-]+$/);
    expect(p.body.urls[0]).toMatch(/\/m\?pair=/);
    const c = await request(app).post('/api/pair/claim').send({ code: p.body.code });
    expect(c.statusCode).toBe(200);
    const me = await request(app).get('/api/me').set({ 'X-API-Token': c.body.token });
    expect(me.body).toMatchObject({ name: 'Mgr. Eva Přihlášená', device: 'Notebook doma', kind: 'user' });
    expect(me.body.deviceId).toBeTruthy();
    expect((await request(app).post('/api/pair/claim').send({ code: p.body.code })).statusCode).toBe(404); // jen jednou
});

test('založení uživatele správcem vrací i odkaz pro dashboard', async () => {
    const r = await request(app).post('/api/users').set(ADMIN).send({ name: 'Lenka Nová', role: 'asistent' });
    expect(r.body.pairing.dashboardUrls[0]).toMatch(/\/\?pair=/);
});
