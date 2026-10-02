/**
 * Uživatelé kanceláře: per-user identita, zařízení (tokeny), role a oprávnění,
 * párování bez povýšení práv, skutečná jména v konceptech a auditu.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_TOKEN = 'test-admin-token-users';
process.env.API_TOKEN = TEST_TOKEN;
process.env.WATCH_DIR = path.join(os.tmpdir(), `lexis_test_users_${Date.now()}`);
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_users_key_'));

const request = require('supertest');
const app = require('../server');
const users = require('../lib/users');
const authz = require('../lib/authz');
const pairing = require('../lib/pairing');

const ADMIN = { 'X-API-Token': TEST_TOKEN };
const as = (t) => ({ 'X-API-Token': t });

afterAll(() => {
    for (const d of [process.env.WATCH_DIR, process.env.LEXIS_KEY_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

describe('lib/users', () => {
    test('token se ukládá jen jako hash a ověří se na správného uživatele', () => {
        const r = users.createUser({ name: 'Lib Test', role: 'koncipient' }, 'test');
        expect(r.token).toMatch(/^llu_[0-9a-f]{64}$/);
        const raw = fs.readFileSync(path.join(process.env.LEXIS_KEY_DIR, 'users.json'), 'utf8');
        expect(raw).not.toContain(r.token);
        const v = users.verifyToken(r.token);
        expect(v.user.id).toBe(r.user.id);
        expect(users.verifyToken('llu_' + '0'.repeat(64))).toBeNull();
        expect(users.verifyToken(TEST_TOKEN)).toBeNull();
    });

    test('jméno musí být jedinečné (bez ohledu na diakritiku a velikost)', () => {
        users.createUser({ name: 'Jana Dvořáková', role: 'asistent' });
        expect(() => users.createUser({ name: 'jana dvorakova', role: 'asistent' })).toThrow(/už existuje/);
    });

    test('neznámá role je odmítnuta', () => {
        expect(() => users.createUser({ name: 'X Y', role: 'bůh' })).toThrow(/Neznámá role/);
    });

    test('deaktivace okamžitě zneplatní všechna zařízení', () => {
        const r = users.createUser({ name: 'Odcházející Kolega', role: 'koncipient' });
        const d2 = users.addDevice(r.user.id, 'Telefon');
        users.updateUser(r.user.id, { disabled: true });
        expect(users.verifyToken(r.token)).toBeNull();
        expect(users.verifyToken(d2.token)).toBeNull();
        expect(() => users.addDevice(r.user.id, 'x')).toThrow(/deaktivovaný/);
    });

    test('zrušení jednoho zařízení nechá ostatní funkční', () => {
        const r = users.createUser({ name: 'Dvě Zařízení', role: 'advokat' });
        const tel = users.addDevice(r.user.id, 'Telefon');
        users.revokeDevice(r.user.id, tel.device.id);
        expect(users.verifyToken(tel.token)).toBeNull();
        expect(users.verifyToken(r.token)).not.toBeNull();
    });

    test('poslední aktivní správce nejde degradovat ani deaktivovat', () => {
        const r = users.createUser({ name: 'Jediný Správce', role: 'spravce' });
        expect(() => users.updateUser(r.user.id, { role: 'advokat' })).toThrow(/poslední aktivní správce/);
        expect(() => users.updateUser(r.user.id, { disabled: true })).toThrow(/poslední aktivní správce/);
    });
});

describe('lib/authz', () => {
    test('rozlišení read / write / admin podle cesty a metody', () => {
        expect(authz.requiredScope('GET', '/api/drafts')).toBe('read');
        expect(authz.requiredScope('POST', '/api/drafts')).toBe('write');
        expect(authz.requiredScope('GET', '/api/users')).toBe('admin');
        expect(authz.requiredScope('GET', '/api/system/export')).toBe('admin');
        expect(authz.requiredScope('POST', '/api/audit/clear')).toBe('admin');
        expect(authz.requiredScope('GET', '/api/email/settings')).toBe('admin');
        expect(authz.requiredScope('GET', '/index.html')).toBeNull();
    });
    test('omezuje jen uživatele kanceláře; hlavní token má vše', () => {
        expect(authz.authorize({ kind: 'local-token', scopes: ['admin'] }, 'POST', '/api/audit/clear').allowed).toBe(true);
        expect(authz.authorize({ kind: 'user', scopes: ['read', 'write'] }, 'POST', '/api/audit/clear').allowed).toBe(false);
        expect(authz.authorize({ kind: 'user', scopes: ['read'] }, 'POST', '/api/drafts').allowed).toBe(false);
        expect(authz.authorize({ kind: 'user', scopes: ['read'] }, 'GET', '/api/me').allowed).toBe(true);
    });
});

describe('HTTP: identita, role, párování', () => {
    let advokat, koncipient, ctenar;

    beforeAll(async () => {
        const mk = async (name, role) => {
            const r = await request(app).post('/api/users').set(ADMIN).send({ name, role, deviceLabel: 'LexisEditor' });
            expect(r.statusCode).toBe(201);
            expect(r.body.token).toMatch(/^llu_/);
            expect(r.body.pairing.code).toBeTruthy();
            return r.body;
        };
        advokat = await mk('JUDr. Petra Advokátní', 'advokat');
        koncipient = await mk('Mgr. Karel Koncipient', 'koncipient');
        ctenar = await mk('Stážistka Čtenářová', 'ctenar');
    });

    test('uživatelský token projde bránou a /api/me vrátí skutečné jméno a roli', async () => {
        const r = await request(app).get('/api/me').set(as(koncipient.token));
        expect(r.statusCode).toBe(200);
        expect(r.body).toMatchObject({ name: 'Mgr. Karel Koncipient', role: 'koncipient', kind: 'user', device: 'LexisEditor', sharedIdentity: false });
        const adm = await request(app).get('/api/me').set(ADMIN);
        expect(adm.body.sharedIdentity).toBe(true);
    });

    test('neplatný llu_ token → 401', async () => {
        const r = await request(app).get('/api/drafts').set(as('llu_' + 'a'.repeat(64)));
        expect(r.statusCode).toBe(401);
    });

    test('ne-správce nesmí spravovat uživatele ani mazat audit', async () => {
        expect((await request(app).get('/api/users').set(as(advokat.token))).statusCode).toBe(403);
        expect((await request(app).post('/api/users').set(as(koncipient.token)).send({ name: 'Hacker', role: 'spravce' })).statusCode).toBe(403);
        const clr = await request(app).post('/api/audit/clear').set(as(advokat.token));
        expect(clr.statusCode).toBe(403);
        expect(clr.body.code).toBe('forbidden_role');
    });

    test('role „jen čtení“ může číst, ale ne zapisovat', async () => {
        expect((await request(app).get('/api/drafts').set(as(ctenar.token))).statusCode).toBe(200);
        expect((await request(app).post('/api/drafts').set(as(ctenar.token)).send({ title: 'X', text: 'y' })).statusCode).toBe(403);
    });

    test('párování uživatelem vydá NOVÉ zařízení na jeho účet — nikdy hlavní token', async () => {
        const r = await request(app).post('/api/pair/new').set(as(koncipient.token)).send({ deviceLabel: 'Telefon' });
        expect(r.statusCode).toBe(200);
        const claimed = pairing.claim(r.body.code);
        expect(claimed).not.toBe(TEST_TOKEN);
        expect(claimed).toMatch(/^llu_/);
        const me = await request(app).get('/api/me').set(as(claimed));
        expect(me.body).toMatchObject({ name: 'Mgr. Karel Koncipient', device: 'Telefon' });
    });

    test('koncept nese skutečné autory; koncipient neschválí, advokát ano', async () => {
        const c = await request(app).post('/api/drafts').set(as(koncipient.token)).send({ title: 'Žaloba ID test', text: 'Text žaloby.' });
        expect(c.statusCode).toBe(201);
        expect(c.body.lastAuthor.name).toBe('Mgr. Karel Koncipient');
        const id = c.body.id;
        const up = await request(app).put('/api/drafts/' + id).set(as(advokat.token)).send({ text: 'Text žaloby upravený.', baseVersion: c.body.version, note: 'Revize' });
        expect(up.statusCode).toBe(200);
        expect(up.body.lastAuthor.name).toBe('JUDr. Petra Advokátní');

        await request(app).post('/api/drafts/' + id + '/status').set(as(koncipient.token)).send({ status: 'ke_kontrole' }).expect(200);
        const deny = await request(app).post('/api/drafts/' + id + '/status').set(as(koncipient.token)).send({ status: 'schvaleno' });
        expect(deny.statusCode).toBe(403);
        const ok = await request(app).post('/api/drafts/' + id + '/status').set(as(advokat.token)).send({ status: 'schvaleno' });
        expect(ok.statusCode).toBe(200);
        expect(ok.body.approvedBy.name).toBe('JUDr. Petra Advokátní');
    });

    test('audit zaznamená skutečného aktéra a řetězec zůstane platný', async () => {
        await request(app).post('/api/drafts').set(as(advokat.token)).send({ title: 'Audit aktér', text: 'x' }).expect(201);
        const logs = (await request(app).get('/api/audit/logs').set(ADMIN)).body.logs;
        const e = logs.find(l => l.target === 'Audit aktér');
        expect(e.actor).toMatchObject({ name: 'JUDr. Petra Advokátní', kind: 'user', device: 'LexisEditor' });
        const v = require('../lib/audit').verifyAuditChain();
        expect(v.ok).toBe(true);
        expect(v.checked).toBeGreaterThan(3);
    });

    test('deaktivace přes API: uživatel je okamžitě odhlášen', async () => {
        const r = await request(app).patch('/api/users/' + ctenar.user.id).set(ADMIN).send({ disabled: true });
        expect(r.statusCode).toBe(200);
        expect((await request(app).get('/api/me').set(as(ctenar.token))).statusCode).toBe(401);
    });

    test('vlastní zařízení si uživatel zruší sám', async () => {
        const add = await request(app).post('/api/users/' + advokat.user.id + '/devices').set(ADMIN).send({ label: 'Starý notebook' });
        expect(add.statusCode).toBe(201);
        const del = await request(app).delete('/api/me/devices/' + add.body.device.id).set(as(advokat.token));
        expect(del.statusCode).toBe(200);
        expect((await request(app).get('/api/me').set(as(add.body.token))).statusCode).toBe(401);
    });
});
