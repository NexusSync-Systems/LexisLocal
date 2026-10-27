/**
 * Úroveň přístupu PODATELNA (simulace dne v kanceláři 26.–27. 10. 2026, pravidlo dle Zdeňka):
 * asistentka do spisu zařazuje DOŠLÉ dokumenty, potvrzuje lhůty a fakturuje, ale neopravuje
 * dokumenty ve spisu ani spis samotný — i když spis sama založila pro advokáta.
 * Dále OCR oprava sp. zn. podle existujícího spisu a nová pravidla kontroly smluv. Data smyšlená.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const ADMIN_TOKEN = 'podatelna-admin-token';
process.env.API_TOKEN = ADMIN_TOKEN;
process.env.WATCH_DIR = path.join(os.tmpdir(), `lexis_test_podatelna_${Date.now()}`);
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_podatelna_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_podatelna_data_'));
delete process.env.LEXIS_FIRM_MODE;

const request = require('supertest');
const app = require('../server');
const access = require('../lib/access');
const db = require('../lib/database');

const ADMIN = { 'X-API-Token': ADMIN_TOKEN };
const as = (t) => ({ 'X-API-Token': t });
let ADV, ASI, spis;

afterAll(() => { access.setFirmMode(null); });

beforeAll(async () => {
    ADV = (await request(app).post('/api/users').set(ADMIN).send({ name: 'JUDr. Petra Zkušební', role: 'advokat' })).body;
    ASI = (await request(app).post('/api/users').set(ADMIN).send({ name: 'Lenka Testovací', role: 'asistent' })).body;
    expect((await request(app).post('/api/settings/firm-mode').set(ADMIN).send({ enabled: true })).statusCode).toBe(200);
    access.setFirmMode(true);
});

test('asistentka založí spis pro advokáta → vlastník advokát, ona podatelna (vidí, nemění)', async () => {
    const r = await request(app).post('/api/spisy').set(as(ASI.token)).send({ nazev: 'Nová věc', spisZn: '14 P a Nc 830/2026', odpovednyAdvokat: 'JUDr. Petra Zkušební' });
    expect(r.statusCode).toBe(201);
    spis = r.body.spis;
    const acc = (await request(app).get(`/api/spisy/${spis.id}/access`).set(ADMIN)).body.access;
    expect(acc.owner).toBe(ADV.user.id);
    expect(acc.filers).toEqual([ASI.user.id]);
    expect(acc.writers).toEqual([]);
    expect((await request(app).get(`/api/spisy/${spis.id}`).set(as(ASI.token))).statusCode).toBe(200);
    expect((await request(app).patch(`/api/spisy/${spis.id}`).set(as(ASI.token)).send({ nazev: 'přejmenováno' })).statusCode).toBe(403);
    expect((await request(app).get('/api/spisy').set(as(ASI.token))).body.spisy.map(s => s.id)).toContain(spis.id);
});

test('podatelna: zařadí došlý dokument, označí vyřízené, potvrdí lhůtu; nemaže a nepíše koncepty', async () => {
    db.set('inbox_files', [
        { id: 'dosla/smlouva.docx', relativePath: 'dosla/smlouva.docx', fileName: 'smlouva.docx', caseNumber: null, status: 'unread' },
        { id: 'dosla/vyzva.pdf', relativePath: 'dosla/vyzva.pdf', fileName: 'vyzva.pdf', caseNumber: '14 P a Nc 830/2026', status: 'unread',
          detectedDeadlines: [{ deadlineDate: '2026-11-20', unit: 'day', amount: 10, needsReview: true }] }
    ]);
    const asg = await request(app).post(`/api/spisy/${spis.id}/assign-file`).set(as(ASI.token)).send({ fileId: 'dosla/smlouva.docx' });
    expect(asg.statusCode).toBe(200);
    expect(asg.body.file.caseNumber).toBe('14 P a Nc 830/2026');
    expect((await request(app).post('/api/inbox/mark-read').set(as(ASI.token)).send({ fileName: 'dosla/vyzva.pdf' })).statusCode).not.toBe(403);
    expect((await request(app).post('/api/lhutnik/confirm').set(as(ASI.token)).send({ fileId: 'dosla/vyzva.pdf', index: 0 })).statusCode).not.toBe(403);
    expect((await request(app).post('/api/inbox/delete').set(as(ASI.token)).send({ fileName: 'dosla/vyzva.pdf' })).statusCode).toBe(403);
    expect((await request(app).post('/api/drafts').set(as(ASI.token)).send({ title: 'Návrh', text: 'x', spisId: spis.id })).statusCode).toBe(403);
    // advokát (vlastník) koncept založí; asistentka ho nesmí upravit
    const d = (await request(app).post('/api/drafts').set(as(ADV.token)).send({ title: 'Vyjádření', text: 'Text advokáta', spisId: spis.id })).body;
    expect(d.id).toBeTruthy();
    expect((await request(app).put(`/api/drafts/${d.id}`).set(as(ASI.token)).send({ text: 'oprava asistentky', baseVersion: 1 })).statusCode).toBe(403);
});

test('fakturace ke spisu: podatelna ano, kolega bez přístupu ne', async () => {
    const ok = await request(app).post('/api/fakturace').set(as(ASI.token)).send({ klient: 'Klient', spisId: spis.id, items: [{ popis: 'Služby', amount: 1000 }] });
    expect(ok.statusCode).toBe(201);
    const X = (await request(app).post('/api/users').set(ADMIN).send({ name: 'Mgr. Cizí Kolega', role: 'koncipient' })).body;
    const no = await request(app).post('/api/fakturace').set(as(X.token)).send({ klient: 'Klient', spisId: spis.id, items: [{ popis: 'Služby', amount: 1000 }] });
    expect(no.statusCode).toBe(403);
});

test('sdílení: úroveň se nastaví (ne sčítá), revoke odebere i podatelnu', () => {
    let s = { access: { owner: 'adv', readers: [], writers: ['u1'], filers: [] } };
    s.access = access.grant(s, 'u1', 'podatelna');
    expect(s.access).toMatchObject({ writers: [], filers: ['u1'], readers: [] });
    expect(access.canAccess(s, { kind: 'user', userId: 'u1', scopes: ['read', 'write'] }, 'file')).toBe(true);
    expect(access.canAccess(s, { kind: 'user', userId: 'u1', scopes: ['read', 'write'] }, 'write')).toBe(false);
    s.access = access.revoke(s, 'u1');
    expect(access.canAccess(s, { kind: 'user', userId: 'u1', scopes: ['read'] }, 'read')).toBe(false);
});

test('OCR: „35 P a Ne 336/2026“ → existující spis „35 P a Nc 336/2026“; víc kandidátů = bez opravy', () => {
    const sp = require('../lib/spisy');
    sp.createSpis({ nazev: 'OCR test', spisZn: '35 P a Nc 336/2026' });
    expect(sp.findByCase('35 P a Ne 336/2026')).toBeNull();
    expect(sp.findByCaseOcr('35 P a Ne 336/2026').spisZn).toBe('35 P a Nc 336/2026');
    expect(sp.findByCaseOcr('35 P a Nc 336/2O26').spisZn).toBe('35 P a Nc 336/2026');
    sp.createSpis({ nazev: 'OCR test 2', spisZn: '8 C 10/2026' });
    sp.createSpis({ nazev: 'OCR test 3', spisZn: '8 E 10/2026' });
    expect(sp.findByCaseOcr('8 C 1O/2026')).toBeNull(); // pasuje na „8 C“ i „8 E“ — nejednoznačné, neopravuje se
    expect(sp.findByCaseOcr('99 C 1/2026')).toBeNull();
});

test('kontrola smluv: klauzule ze simulace kanceláře (i bez zmínky o spotřebiteli)', () => {
    const cs = require('../lib/clause_scan');
    const t = 'Smlouva o dílo\nČlánek 1\nObjednatel uhradí zálohu ve výši 100 % ceny díla do 3 dnů od podpisu smlouvy.\n' +
        'Článek 2\nZáruční doba činí 3 měsíce a vady je nutné oznámit do 2 dnů od jejich vzniku.\n' +
        'Článek 3\nOdpovědnost zhotovitele za vady díla se vylučuje v plném rozsahu.\n' +
        'Článek 4\nObjednatel se vzdává práva odstoupit od smlouvy z jakéhokoli důvodu.\n' +
        'Článek 5\nZa prodlení objednatele s úhradou náleží zhotoviteli smluvní pokuta 1 % denně z dlužné částky bez omezení.\n';
    const ids = cs.scanContract(t).map(f => f.id);
    expect(ids).toEqual(expect.arrayContaining(['zaloha_100', 'zaruka_kratka', 'vady_lhuta', 'vzdani_vad', 'bez_odstoupeni', 'pokuta_denni']));
    const z = cs.scanContract(t).find(f => f.id === 'zaloha_100');
    expect(z.law).toMatch(/jinak obchodní riziko/);
    const benign = 'Smlouva o dílo\nČlánek 1\nZáruční doba činí 24 měsíců.\nČlánek 2\nVady lze oznámit do 30 dnů.\nČlánek 3\nSmluvní pokuta činí 0,05 % denně z dlužné částky a strany smlouvu podepsaly.\n';
    expect(cs.scanContract(benign).map(f => f.id)).toEqual([]);
});

test('nezařazený dokument: vidí ho kdo ho nahrál, podatelna a správce — ne ostatní kolegové', async () => {
    const up = await request(app).post('/api/inbox/upload').set(as(ADV.token)).send({ fileName: 'smlouva_klienta_bez_spzn.txt',
        base64: Buffer.from('SMLOUVA O DÍLO\nObjednatel: Klient Testovací\nCena 100 000 Kč.\n').toString('base64') });
    expect([200, 202]).toContain(up.statusCode);
    const X = (await request(app).post('/api/users').set(ADMIN).send({ name: 'Mgr. Jiný Advokát', role: 'advokat' })).body;
    const ids = async (tok) => ((await request(app).get('/api/inbox/all').set(as(tok))).body.inbox || []).map(f => f.fileName);
    expect(await ids(ADV.token)).toContain('smlouva_klienta_bez_spzn.txt');   // nahrál
    expect(await ids(ASI.token)).toContain('smlouva_klienta_bez_spzn.txt');   // podatelna
    expect(await ids(X.token)).not.toContain('smlouva_klienta_bez_spzn.txt'); // kolega bez vztahu
    const un = (tok) => request(app).get('/api/spisy/unfiled').set(as(tok));
    expect((await un(X.token)).body.files.map(f => f.fileName)).not.toContain('smlouva_klienta_bez_spzn.txt');
    expect((await un(ASI.token)).body.files.map(f => f.fileName)).toContain('smlouva_klienta_bez_spzn.txt');
}, 30000);

test('nečitelný dokument zůstane v doručené poště se štítkem (dřív zmizel)', async () => {
    const up = await request(app).post('/api/inbox/upload').set(as(ASI.token)).send({ fileName: 'prazdny_sken.txt', base64: Buffer.from('   \n  ').toString('base64') });
    expect(up.statusCode).toBe(202);
    expect(up.body.warning).toMatch(/nečitelný/);
    const it = ((await request(app).get('/api/inbox/all').set(as(ASI.token))).body.inbox || []).find(f => f.fileName === 'prazdny_sken.txt');
    expect(it).toBeTruthy();
    expect(it.unreadable).toBe(true);
    expect(it.summary).toMatch(/Nečitelný dokument/);
}, 30000);

test('kontrola smluv: vyloučení odpovědnosti za vady — zmínka „vad“ jinde nestačí, doplněk se připojí (server 27. 10. 2026)', () => {
    const cs = require('../lib/clause_scan');
    const t = 'Smlouva o dílo uzavřená mezi objednatelem a zhotovitelem podle občanského zákoníku.\nČlánek 1\nOdpovědnost zhotovitele za vady díla se vylučuje v plném rozsahu.\n' +
        'Článek 2\nStrany smlouvu podepsaly a přečetly si ji pečlivě, souhlasí s jejím obsahem a na důkaz připojují podpisy.\n';
    const f = cs.scanContract(t);
    expect(cs.missingAppendix('Rizika: záruka za vady je krátká (§ 1814).', f).missing).toEqual(['vzdani_vad']);
    expect(cs.missingAppendix('Čl. 1 vylučuje odpovědnost za vady — neplatné, § 1814 písm. b) OZ.', f).missing).toEqual([]);
});
