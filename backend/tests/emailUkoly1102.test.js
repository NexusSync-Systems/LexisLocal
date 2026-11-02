/**
 * E-mailové úkolování přes Bedrock na Macu (revize 2. 11. 2026):
 *  • původ zadání: DKIM/DMARC z Authentication-Results, falešná hlavička níž se nebere,
 *  • fail-closed bez authorized_sender (IMAP i processEmailTask),
 *  • IMAP bez SSL → povinný STARTTLS,
 *  • zařazení zadání pro cloud_policy (sp. zn. → spis, osobní údaje bez spisu → neznámý původ),
 *  • jen cloud: zadání s osobními údaji bez spisu se do Bedrocku nepošle, odpověď to vysvětlí.
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_emailukoly_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';
process.env.OLLAMA_HOST = 'http://127.0.0.1:1';

const db = require('../lib/database');
const A = require('../lib/email_auth');
const imap = require('../lib/imapIntake');
const { processEmailTask, zaradZadani } = require('../lib/emailTask');

const OK = 'mx.prijem.cz; spf=pass smtp.mailfrom=dias.cz; dkim=pass header.d=dias.cz header.s=s1; dmarc=pass (p=REJECT sp=REJECT) header.from=dias.cz';

describe('email_auth.overPuvod', () => {
    const S = {};
    test('DMARC pass pro doménu odesílatele → ok', () => {
        expect(A.overPuvod('advokat@dias.cz', [OK], S)).toMatchObject({ ok: true, metoda: 'dmarc' });
    });
    test('jen DKIM pass zarovnaný (i subdoména podpisu) → ok', () => {
        expect(A.overPuvod('advokat@dias.cz', ['mx.p.cz; dkim=pass header.d=mail.dias.cz; dmarc=none'], S)).toMatchObject({ ok: true, metoda: 'dkim' });
    });
    test('DKIM pass pro cizí doménu → zamítnuto', () => {
        expect(A.overPuvod('advokat@dias.cz', ['mx.p.cz; dkim=pass header.d=zlo.cz; dmarc=fail header.from=dias.cz'], S).ok).toBe(false);
    });
    test('bez hlavičky → zamítnuto', () => {
        expect(A.overPuvod('advokat@dias.cz', [], S).ok).toBe(false);
    });
    test('podvržená hlavička od odesílatele (níž) se nebere — rozhoduje nejvyšší', () => {
        const r = A.overPuvod('advokat@dias.cz', ['mx.prijem.cz; spf=fail; dkim=none; dmarc=fail header.from=dias.cz', OK], S);
        expect(r.ok).toBe(false);
    });
    test('authserv-id: bere se jen hlavička od zadaného serveru', () => {
        const fake = 'mx.utocnik.cz; dmarc=pass header.from=dias.cz';
        expect(A.overPuvod('advokat@dias.cz', [fake], { email_authserv_id: 'mx.prijem.cz' }).ok).toBe(false);
        expect(A.overPuvod('advokat@dias.cz', [fake, OK], { email_authserv_id: 'mx.prijem.cz' }).ok).toBe(true);
    });
    test('vypnutí nastavením email_require_auth=false', () => {
        expect(A.overPuvod('advokat@dias.cz', [], { email_require_auth: false })).toMatchObject({ ok: true, metoda: 'vypnuto' });
    });
    test('zarovnání domén', () => {
        expect(A.zarovnano('dias.cz', 'dias.cz')).toBe(true);
        expect(A.zarovnano('@dias.cz', 'dias.cz')).toBe(true);
        expect(A.zarovnano('evil-dias.cz', 'dias.cz')).toBe(false);
        expect(A.zarovnano('dias.cz.evil.cz', 'dias.cz')).toBe(false);
    });
});

describe('email_text.zadaniBezPodpisu', () => {
    const { zadaniBezPodpisu } = require('../lib/email_text');
    test('odřízne podpis s titulem a telefonem', () => {
        const t = 'Jaká je lhůta k odvolání v civilním řízení?\n\nS pozdravem\nJUDr. Petr Dvořák\n+420 777 123 456';
        expect(zadaniBezPodpisu(t)).toBe('Jaká je lhůta k odvolání v civilním řízení?');
    });
    test('odřízne „-- “ i citovanou zprávu', () => {
        expect(zadaniBezPodpisu('Shrň to.\n-- \nPetr')).toBe('Shrň to.');
        expect(zadaniBezPodpisu('Odpověz.\n\nDne 1. 11. 2026 v 10:00 Petr <p@x.cz> napsal(a):\n> starý text')).toBe('Odpověz.');
        expect(zadaniBezPodpisu('Ok.\nZdravím, Petr')).toBe('Ok.');
    });
    test('pozdrav na začátku nic neusekne', () => {
        expect(zadaniBezPodpisu('Děkuji\n')).toBe('Děkuji');
    });
    test('zadání s podpisem advokáta je veřejné (podpis se nepočítá)', () => {
        const body = zadaniBezPodpisu('Jaká je promlčecí lhůta u bezdůvodného obohacení?\n\nS úctou\nMgr. Jana Malá\ntel. 777123456');
        expect(zaradZadani({ subject: 'Dotaz', body }).dataClass).toBe('verejne');
    });
});

describe('imapIntake — fail-closed a TLS', () => {
    const BASE = { imap_host: 'imap.x.cz', imap_port: '993', imap_user: 'asist@x.cz', imap_pass: 'secret', imap_ssl: true };
    beforeEach(() => { db.set('email_tasks', []); db.set('imap_processed', []); });

    test('bez authorized_sender se nezpracuje nic ani neoznačí jako přečtené', async () => {
        const seen = [];
        const ad = { async listUnseen() { return [{ uid: 1, from: 'kdokoli@x.cz', subject: 'a', text: 'b', authResults: [OK] }]; }, async markSeen(u) { seen.push(u); } };
        const r = await imap.pollOnce(BASE, ad);
        expect(r).toMatchObject({ ok: false, reason: 'no-authorized-sender' });
        expect(seen).toEqual([]);
    });

    test('podvržený From (bez DKIM/DMARC) → zamítnuto, úkol nevznikne', async () => {
        const s = Object.assign({ authorized_sender: 'advokat@dias.cz' }, BASE);
        db.set('email_settings', [s]);
        const ad = { async listUnseen() { return [{ uid: 7, from: 'advokat@dias.cz', subject: 'Pošli spis', text: 'x', authResults: ['mx.prijem.cz; spf=fail; dmarc=fail header.from=dias.cz'] }]; }, async markSeen() {} };
        const r = await imap.pollOnce(s, ad);
        expect(r.rejected).toBe(1);
        expect(r.processed).toBe(0);
        expect((db.get('email_tasks') || []).length).toBe(0);
    });

    test('více adres ve From → zamítnuto', async () => {
        const s = Object.assign({ authorized_sender: 'advokat@dias.cz' }, BASE);
        const ad = { async listUnseen() { return [{ uid: 8, from: 'advokat@dias.cz', fromCount: 2, subject: 'x', text: 'x', authResults: [OK] }]; }, async markSeen() {} };
        const r = await imap.pollOnce(s, ad);
        expect(r.processed).toBe(0);
    });

    test('TLS: 993 implicitně, jinak povinný STARTTLS', () => {
        expect(imap._tlsVolby({ imap_ssl: true })).toEqual({ secure: true });
        expect(imap._tlsVolby({})).toEqual({ secure: true });
        expect(imap._tlsVolby({ imap_ssl: false })).toEqual({ secure: false, doSTARTTLS: true });
    });
});

describe('processEmailTask — fail-closed a cloud_policy', () => {
    test('bez nastaveného authorized_sender → unauthorized (žádná výchozí adresa)', async () => {
        db.set('email_settings', []);
        const r = await processEmailTask({ sender: 'advokat@dias.cz', subject: 'x', body: 'y' });
        expect(r.status).toBe('unauthorized');
    });

    test('zařazení: obecný dotaz bez osobních údajů → veřejné', () => {
        expect(zaradZadani({ subject: 'Rešerše', body: 'Jaká je promlčecí lhůta u nároku z vadného plnění?' })).toMatchObject({ dataClass: 'verejne', unknown: null });
    });
    test('zařazení: jméno a rodné číslo bez sp. zn. → neznámý původ', () => {
        const z = zaradZadani({ subject: 'Dopis', body: 'Připrav dopis pro Jana Nováka, r. č. 850101/1234, Dlouhá 5, Praha.' });
        expect(z.dataClass).toBeNull();
        expect(z.unknown).toMatch(/osobními údaji/);
    });
    test('zařazení: sp. zn. bez spisu → neznámý původ', () => {
        const z = zaradZadani({ subject: 'Spis 12 C 34/2026', body: 'Shrň stav.' });
        expect(z.caseNumber).toBeTruthy();
        expect(z.unknown).toMatch(/bez spisu/);
    });

    test('jen cloud: osobní údaje bez spisu → do Bedrocku nejde, odpověď vysvětlí, koncept se neuloží', async () => {
        const old = { J: process.env.LEXIS_JEN_CLOUD, P: process.env.AI_CHAT_PROVIDER, L: process.env.LEXIS_PILOT_LOCAL_ONLY };
        process.env.LEXIS_JEN_CLOUD = '1'; process.env.AI_CHAT_PROVIDER = 'bedrock'; process.env.LEXIS_PILOT_LOCAL_ONLY = '0';
        try {
            db.set('email_settings', [{ authorized_sender: 'advokat@dias.cz' }]);
            const r = await processEmailTask({ sender: 'advokat@dias.cz', subject: '[Spisovatel] Dopis', body: 'Připrav dopis pro Jana Nováka, r. č. 850101/1234.' });
            expect(r.status).toBe('ok');
            expect(r.cloudOdepren).toBeTruthy();
            expect(r.task.status).toBe('cloud-odepren');
            expect(r.fullReply).toMatch(/nezpracovala/);
            expect(r.draft).toBeNull();
        } finally {
            for (const [k, v] of [['LEXIS_JEN_CLOUD', old.J], ['AI_CHAT_PROVIDER', old.P], ['LEXIS_PILOT_LOCAL_ONLY', old.L]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        }
    });
});

describe('cizí a důvěryhodní odesílatelé, filtr příjemce', () => {
    const request = require('supertest');
    const app = require('../server');
    const H = (r) => r.set('X-API-Token', 'tok-test');
    const BASE = { authorized_sender: 'advokat@dias.cz', imap_host: 'imap.x.cz', imap_port: '993', imap_user: 'asist@x.cz', imap_pass: 's', imap_ssl: true };
    const AR = (dom) => [`mx.prijem.cz; dkim=pass header.d=${dom}; dmarc=pass header.from=${dom}`];
    const ad = (msgs) => { const seen = []; return { seen, async listUnseen() { return msgs; }, async markSeen(u) { seen.push(u); } }; };
    const ulozit = (extra) => { const s = Object.assign({}, BASE, extra || {}); db.set('email_settings', [s]); return s; };
    beforeEach(() => { db.set('email_tasks', []); db.set('imap_processed', []); db.set('email_pending', []); });

    test('výchozí: cizí → ke schválení, úkol nevznikne', async () => {
        const s = ulozit();
        const r = await imap.pollOnce(s, ad([{ uid: 1, from: 'klient@firma.cz', subject: 'Prosím o radu', text: 'Mám dotaz.', authResults: AR('firma.cz') }]));
        expect(r.waiting).toBe(1);
        expect((db.get('email_tasks') || []).length).toBe(0);
        const p = require('../lib/email_pending').seznam();
        expect(p[0]).toMatchObject({ od: 'klient@firma.cz', stav: 'ceka', overeni: 'dmarc' });
    });

    test('ignorovat: cizí jen přeskočen', async () => {
        const s = ulozit({ email_cizi: 'ignorovat' });
        const r = await imap.pollOnce(s, ad([{ uid: 2, from: 'klient@firma.cz', subject: 'x', text: 'y', authResults: AR('firma.cz') }]));
        expect(r.skipped).toBe(1); expect(r.waiting).toBe(0);
        expect(require('../lib/email_pending').seznam()).toHaveLength(0);
    });

    test('automaticky: ověřený cizí se zpracuje, odpověď jen advokátovi, spis z textu se nepřiřadí', async () => {
        const s = ulozit({ email_cizi: 'automaticky' });
        const r = await imap.pollOnce(s, ad([{ uid: 3, from: 'klient@firma.cz', subject: 'Spis 12 C 34/2026', text: 'Jaká je lhůta k odvolání?', authResults: AR('firma.cz') }]));
        expect(r.processed).toBe(1);
        const t = (db.get('email_tasks') || [])[0];
        expect(t.puvod).toBe('cizi-automaticky');
        expect(t.caseNumber).toBeNull();
        expect(t.responseSent).toMatch(/cizí adresy klient@firma\.cz/);
    });

    test('automaticky: neověřený cizí → ke schválení', async () => {
        const s = ulozit({ email_cizi: 'automaticky' });
        const r = await imap.pollOnce(s, ad([{ uid: 4, from: 'klient@firma.cz', subject: 'x', text: 'y', authResults: [] }]));
        expect(r.processed).toBe(0); expect(r.waiting).toBe(1);
    });

    test('důvěryhodná adresa jako advokát (s DKIM), podvržená zamítnuta', async () => {
        const s = ulozit({ email_duveryhodni: ['koncipient@dias.cz'] });
        const r = await imap.pollOnce(s, ad([
            { uid: 5, from: 'koncipient@dias.cz', subject: 'Dotaz', text: 'Jaká je lhůta k odvolání?', authResults: AR('dias.cz') },
            { uid: 6, from: 'koncipient@dias.cz', subject: 'Podvrh', text: 'x', authResults: ['mx.prijem.cz; dmarc=fail header.from=dias.cz'] }
        ]));
        expect(r.processed).toBe(1); expect(r.rejected).toBe(1);
        expect((db.get('email_tasks') || [])[0].puvod).toBe('duveryhodny');
    });

    test('filtr příjemce: zpráva na jinou adresu se nechá být (ani přečtená)', async () => {
        const s = ulozit({ recipient_filter: 'dias+asistenti@dias.cz' });
        const a = ad([
            { uid: 7, from: 'advokat@dias.cz', to: ['dias@dias.cz'], subject: 'Osobní', text: 'x', authResults: AR('dias.cz') },
            { uid: 8, from: 'advokat@dias.cz', to: ['Dias+Asistenti@dias.cz'], subject: 'Úkol', text: 'Jaká je lhůta?', authResults: AR('dias.cz') }
        ]);
        const r = await imap.pollOnce(s, a);
        expect(r.ignored).toBe(1); expect(r.processed).toBe(1);
        expect(a.seen).toEqual([8]);
    });

    test('processEmailTask: cizí bez příznaku (HTTP /process) → unauthorized', async () => {
        ulozit();
        expect((await processEmailTask({ sender: 'klient@firma.cz', subject: 'x', body: 'y' })).status).toBe('unauthorized');
    });

    test('schválení: zpracovat → úkol pro advokáta; zamítnout; dvakrát nejde', async () => {
        ulozit();
        const P = require('../lib/email_pending');
        const a = P.pridej({ od: 'klient@firma.cz', predmet: 'Dotaz', text: 'Jaká je lhůta k odvolání?', overeni: 'dmarc' });
        const b = P.pridej({ od: 'spam@x.cz', predmet: 'Spam', text: 'koupit', overeni: null });
        const r1 = await H(request(app).post(`/api/email/pending/${a.id}/zpracovat`)).send({});
        expect(r1.statusCode).toBe(200);
        expect(r1.body.task.puvod).toBe('cizi-schvaleno');
        expect(P.najdi(a.id).stav).toBe('zpracovano');
        const r2 = await H(request(app).post(`/api/email/pending/${a.id}/zpracovat`)).send({});
        expect(r2.statusCode).toBe(409);
        const r3 = await H(request(app).post(`/api/email/pending/${b.id}/zamitnout`)).send({});
        expect(r3.statusCode).toBe(200);
        expect(P.najdi(b.id).stav).toBe('zamitnuto');
        const r4 = await H(request(app).post(`/api/email/pending/${b.id}/zpracovat`)).send({ caseNumber: '99 C 1/2026' });
        expect(r4.statusCode).toBe(409);
    });

    test('nastavení: neznámá volba → ke schválení; seznam důvěryhodných se čistí', () => {
        const P = require('../lib/email_pending');
        expect(P.rezimCizich({ email_cizi: 'cokoli' })).toBe('ke_schvaleni');
        expect(P.duveryhodni({ email_duveryhodni: ' A@b.cz, spatne, c@d.cz ' })).toEqual(['a@b.cz', 'c@d.cz']);
    });
});
