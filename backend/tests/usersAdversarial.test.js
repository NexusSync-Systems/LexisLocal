/**
 * Útočné testy identit: obcházení rolí přes varianty cest, token v URL, eskalace
 * přes párování, firemní režim (ACL spisů) mezi dvěma uživateli, zámky konceptu,
 * schválení výstupu AI.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const ADMIN_TOKEN = 'adv-admin-token-xyz';
process.env.API_TOKEN = ADMIN_TOKEN;
process.env.WATCH_DIR = path.join(os.tmpdir(), `lexis_test_usradv_${Date.now()}`);
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_usradv_key_'));

const request = require('supertest');
const app = require('../server');
const access = require('../lib/access');
const pairing = require('../lib/pairing');
const db = require('../lib/database');

const ADMIN = { 'X-API-Token': ADMIN_TOKEN };
const as = (t) => ({ 'X-API-Token': t });
let A, B, R; // advokát A, koncipient B, čtenář R

beforeAll(async () => {
    const mk = async (name, role) => (await request(app).post('/api/users').set(ADMIN).send({ name, role })).body;
    A = await mk('JUDr. Alena Advokátní', 'advokat');
    B = await mk('Mgr. Bohdan Koncipient', 'koncipient');
    R = await mk('Radka Čtenářová', 'ctenar');
});
afterAll(() => {
    access.setFirmMode(null);
    for (const d of [process.env.WATCH_DIR, process.env.LEXIS_KEY_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

describe('obcházení rolí', () => {
    test.each([
        ['GET', '/api/users'], ['GET', '/API/USERS'], ['GET', '/api/users/'], ['GET', '/api/Users?x=1'],
        ['POST', '/api/audit/clear'], ['POST', '/api/Audit/Clear/'], ['GET', '/api/system/export'],
        ['POST', '/api/system/rotate-key'], ['GET', '/api/email/settings'], ['POST', '/api/skartace/protokol']
    ])('koncipient: %s %s → zamítnuto', async (m, p) => {
        const r = await request(app)[m.toLowerCase()](p).set(as(B.token)).send({});
        expect([401, 403, 404]).toContain(r.statusCode);
        expect(r.statusCode).not.toBe(200);
    });

    test('URL-kódovaná cesta neobejde správcovskou kontrolu', async () => {
        const r = await request(app).get('/api/%75sers').set(as(B.token));
        expect(r.statusCode).not.toBe(200);
    });

    test('koncipient si nezmění roli ani nezaloží správce', async () => {
        expect((await request(app).patch('/api/users/' + B.user.id).set(as(B.token)).send({ role: 'spravce' })).statusCode).toBe(403);
        expect((await request(app).post('/api/users').set(as(B.token)).send({ name: 'Nový Šéf', role: 'spravce' })).statusCode).toBe(403);
    });

    test('token v URL se nepřijímá', async () => {
        const r = await request(app).get('/api/me?token=' + B.token);
        expect(r.statusCode).toBe(401);
    });

    test('pozměněný token / jiný prefix neprojde', async () => {
        expect((await request(app).get('/api/me').set(as(B.token + 'a'))).statusCode).toBe(401);
        expect((await request(app).get('/api/me').set(as(B.token.slice(0, -1)))).statusCode).toBe(401);
        expect((await request(app).get('/api/me').set(as(B.token.replace('llu_', 'llx_')))).statusCode).toBe(401);
    });
});

describe('párování', () => {
    test('„jen čtení“ si smí spárovat VLASTNÍ zařízení a dostane jen svá práva', async () => {
        const r = await request(app).post('/api/pair/new').set(as(R.token)).send({ deviceLabel: 'Tablet' });
        expect(r.statusCode).toBe(200);
        const t = pairing.claim(r.body.code);
        expect(t).not.toBe(ADMIN_TOKEN);
        const me = (await request(app).get('/api/me').set(as(t))).body;
        expect(me).toMatchObject({ name: 'Radka Čtenářová', role: 'ctenar' });
        expect((await request(app).post('/api/drafts').set(as(t)).send({ title: 'x', text: 'y' })).statusCode).toBe(403);
    });

    test('kód je jednorázový', async () => {
        const r = await request(app).post('/api/pair/new').set(as(B.token)).send({});
        expect(pairing.claim(r.body.code)).toBeTruthy();
        expect(pairing.claim(r.body.code)).toBeNull();
    });
});

describe('koncepty mezi lidmi', () => {
    test('zámek drží konkrétní člověk — kolega dostane 423', async () => {
        const c = (await request(app).post('/api/drafts').set(as(B.token)).send({ title: 'Zámek test', text: 'a' })).body;
        await request(app).post('/api/drafts/' + c.id + '/lock').set(as(B.token)).expect(200);
        const r = await request(app).put('/api/drafts/' + c.id).set(as(A.token)).send({ text: 'b', baseVersion: c.version });
        expect(r.statusCode).toBe(423);
        expect(r.body.lock.name).toBe('Mgr. Bohdan Koncipient');
        await request(app).delete('/api/drafts/' + c.id + '/lock').set(as(B.token)).expect(200);
        expect((await request(app).put('/api/drafts/' + c.id).set(as(A.token)).send({ text: 'b', baseVersion: c.version })).statusCode).toBe(200);
    });

    test('výstup AI v transparentním logu schválí advokát, ne koncipient; řetězec zůstane platný', async () => {
        const rec = db.insert('transparency_logs', { agentId: 'test', prompt: 'p', response: 'r' });
        expect((await request(app).post('/api/audit/transparency/' + rec.id + '/approve').set(as(B.token))).statusCode).toBe(403);
        const ok = await request(app).post('/api/audit/transparency/' + rec.id + '/approve').set(as(A.token));
        expect(ok.statusCode).toBe(200);
        expect(ok.body.record.approvedBy.name).toBe('JUDr. Alena Advokátní');
        expect(db.verifyLedger().valid).toBe(true);
    });
});

describe('firemní režim (ACL spisů) s účty', () => {
    beforeAll(() => access.setFirmMode(true));
    afterAll(() => access.setFirmMode(null));

    test('kdo spis založí, je vlastník; kolega ho nevidí ani v seznamu, ani v detailu', async () => {
        const s = (await request(app).post('/api/spisy').set(as(B.token)).send({ nazev: 'Firemní spis B' })).body.spis;
        expect(s.access.owner).toBe(B.user.id);
        const listB = (await request(app).get('/api/spisy').set(as(B.token))).body.spisy;
        const listA = (await request(app).get('/api/spisy').set(as(A.token))).body.spisy;
        expect(listB.some(x => x.id === s.id)).toBe(true);
        expect(listA.some(x => x.id === s.id)).toBe(false);
        expect((await request(app).get('/api/spisy/' + s.id + '/access').set(as(A.token))).statusCode).toBe(403);
    });

    test('ACL se nedá podstrčit při založení', async () => {
        const s = (await request(app).post('/api/spisy').set(as(B.token)).send({ nazev: 'Podstrčené ACL', access: { owner: 'x', readers: [A.user.id] } })).body.spis;
        expect(s.access.owner).toBe(B.user.id);
        expect(s.access.readers).toEqual([]);
    });

    test('odpovědný advokát zadaný jménem → vlastníkem je jeho účet', async () => {
        const s = (await request(app).post('/api/spisy').set(as(B.token)).send({ nazev: 'Spis pro advokátku', odpovednyAdvokat: 'judr. alena advokatni' })).body.spis;
        expect(s.access.owner).toBe(A.user.id);
        expect((await request(app).get('/api/spisy').set(as(A.token))).body.spisy.some(x => x.id === s.id)).toBe(true);
    });

    test('vlastník spis nasdílí kolegovi → ten ho uvidí', async () => {
        const s = (await request(app).post('/api/spisy').set(as(B.token)).send({ nazev: 'Sdílený spis' })).body.spis;
        await request(app).post('/api/spisy/' + s.id + '/share').set(as(B.token)).send({ userId: A.user.id, level: 'read' }).expect(200);
        expect((await request(app).get('/api/spisy').set(as(A.token))).body.spisy.some(x => x.id === s.id)).toBe(true);
    });

    test('správce (hlavní token) vidí vše', async () => {
        const all = (await request(app).get('/api/spisy').set(ADMIN)).body.spisy;
        expect(all.length).toBeGreaterThanOrEqual(4);
    });
});
