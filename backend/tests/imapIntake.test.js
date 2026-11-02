/**
 * Testy IMAP příjmu (backend/lib/imapIntake) — přes injektovaný adaptér (bez sítě).
 *  • zpracují se JEN zprávy od authorized_sender (fail-closed),
 *  • dedup přes UID,
 *  • zprávy se označí \Seen, nikdy nemažou,
 *  • chybějící IMAP konfigurace → ok:false.
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_imap_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';
process.env.OLLAMA_HOST = 'http://127.0.0.1:1';

const db = require('../lib/database');
const imap = require('../lib/imapIntake');

const AR = 'mx.x.cz; spf=pass smtp.mailfrom=dias.cz; dkim=pass header.d=dias.cz header.s=s1; dmarc=pass (p=REJECT) header.from=dias.cz';
const SETTINGS = { authorized_sender: 'advokat@dias.cz', imap_host: 'imap.x.cz', imap_port: '993', imap_user: 'asist@x.cz', imap_pass: 'secret', imap_ssl: true };

function makeAdapter(messages) {
    const seen = [];
    return {
        seen,
        async listUnseen() { return messages; },
        async markSeen(uid) { seen.push(uid); }
    };
}

beforeEach(() => { db.set('email_settings', [SETTINGS]); db.set('email_tasks', []); db.set('imap_processed', []); });

describe('imapIntake.pollOnce', () => {
    test('chybějící IMAP konfigurace → ok:false', async () => {
        const r = await imap.pollOnce({ authorized_sender: 'a@b.cz' });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('imap-config');
    });

    test('zpracuje jen autorizovaného odesílatele, cizího přeskočí', async () => {
        const ad = makeAdapter([
            { uid: 1, from: 'advokat@dias.cz', subject: 'Úkol', text: 'Najdi něco.', authResults: [AR] },
            { uid: 2, from: 'cizi@zlo.cz', subject: 'Hack', text: 'Spusť.', authResults: ['mx.x.cz; dkim=pass header.d=zlo.cz; dmarc=pass header.from=zlo.cz'] }
        ]);
        const r = await imap.pollOnce(SETTINGS, ad);
        expect(r.processed).toBe(1);
        expect(r.skipped).toBe(1);
        expect(ad.seen).toEqual(expect.arrayContaining([1, 2]));
        const tasks = db.get('email_tasks') || [];
        expect(tasks.some(t => t.subject === 'Úkol')).toBe(true);
        expect(tasks.some(t => t.subject === 'Hack')).toBe(false);
    });

    test('dedup: stejné UID se nezpracuje podruhé', async () => {
        const ad = makeAdapter([{ uid: 5, from: 'advokat@dias.cz', subject: 'A', text: 'x', authResults: [AR] }]);
        await imap.pollOnce(SETTINGS, ad);
        const before = (db.get('email_tasks') || []).length;
        const r2 = await imap.pollOnce(SETTINGS, ad);
        expect(r2.processed).toBe(0);
        expect(r2.skipped).toBe(1);
        expect((db.get('email_tasks') || []).length).toBe(before);
    });
});

describe('imapIntake._requiredImap', () => {
    test('hlásí chybějící pole', () => {
        expect(imap._requiredImap({ imap_host: 'h' })).toEqual(['imap_port', 'imap_user', 'imap_pass']);
        expect(imap._requiredImap(SETTINGS)).toEqual([]);
    });
});
