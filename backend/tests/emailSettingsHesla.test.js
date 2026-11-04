/**
 * Hesla schránek se do prohlížeče neposílají (revize 4. 11. 2026); prázdné heslo při uložení nic nepřepíše;
 * test připojení s libovolným serverem smí jen správce.
 */
'use strict';
const path = require('path'), os = require('os'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `lexis_test_emhesla_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';
const request = require('supertest');
const app = require('../server');
const db = require('../lib/database');
const H = (r) => r.set('X-API-Token', 'tok-test');

describe('nastavení e-mailu — hesla', () => {
    beforeEach(() => db.set('email_settings', []));
    test('GET nevrací hesla, jen příznak uloženo', async () => {
        await H(request(app).post('/api/email/settings')).send({ authorized_sender: 'a@b.cz', imap_pass: 'tajne-imap', smtp_pass: 'tajne-smtp' });
        const r = await H(request(app).get('/api/email/settings'));
        expect(r.statusCode).toBe(200);
        expect(JSON.stringify(r.body)).not.toMatch(/tajne-/);
        expect(r.body.settings).toMatchObject({ has_imap_pass: true, has_smtp_pass: true, authorized_sender: 'a@b.cz' });
    });
    test('uložení s prázdným heslem ponechá uložené', async () => {
        await H(request(app).post('/api/email/settings')).send({ authorized_sender: 'a@b.cz', imap_pass: 'tajne-imap' });
        await H(request(app).post('/api/email/settings')).send({ authorized_sender: 'c@d.cz', imap_pass: '', smtp_pass: '', has_imap_pass: true });
        const s = (db.get('email_settings') || [])[0];
        expect(s.imap_pass).toBe('tajne-imap');
        expect(s.authorized_sender).toBe('c@d.cz');
        expect(s.has_imap_pass).toBeUndefined();
    });
    test('test připojení je jen pro správce', () => {
        expect(require('../lib/authz').requiredScope('POST', '/api/email/test')).toBe('admin');
    });
});
