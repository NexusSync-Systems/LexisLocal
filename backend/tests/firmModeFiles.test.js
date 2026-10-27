/**
 * Firemní režim — ACL i mimo routes/spisy.js (nález 14. 10. 2026): doručená pošta,
 * lhůtník, fakturace, RAG úseky pro agenty a redakce prověrky střetu zájmů.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const ADMIN_TOKEN = 'firm-files-admin-token';
process.env.API_TOKEN = ADMIN_TOKEN;
process.env.WATCH_DIR = path.join(os.tmpdir(), `lexis_test_firmfiles_${Date.now()}`);
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_firmfiles_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_firmfiles_data_'));
delete process.env.LEXIS_FIRM_MODE;

const request = require('supertest');
const app = require('../server');
const access = require('../lib/access');
const db = require('../lib/database');
const fileAcl = require('../lib/file_acl');

const ADMIN = { 'X-API-Token': ADMIN_TOKEN };
const as = (t) => ({ 'X-API-Token': t });
let A, B, spisA;
const SPZN = '12 C 345/2026';
const pB = () => ({ kind: 'user', userId: B.user.id, name: B.user.name, scopes: ['read', 'write'] });

afterAll(() => {
    access.setFirmMode(null);
    for (const d of [process.env.WATCH_DIR, process.env.LEXIS_KEY_DIR, process.env.LEXIS_DATA_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

beforeAll(async () => {
    A = (await request(app).post('/api/users').set(ADMIN).send({ name: 'JUDr. Alena Spisová', role: 'advokat' })).body;
    B = (await request(app).post('/api/users').set(ADMIN).send({ name: 'Mgr. Bedřich Cizí', role: 'koncipient' })).body;
    expect((await request(app).post('/api/settings/firm-mode').set(ADMIN).send({ enabled: true })).statusCode).toBe(200);
    access.setFirmMode(true);
    spisA = (await request(app).post('/api/spisy').set(as(A.token)).send({ nazev: 'Důvěrná věc', spisZn: SPZN })).body.spis;
    db.set('inbox_files', [
        { id: 'tajne/zaloba.pdf', relativePath: 'tajne/zaloba.pdf', fileName: 'zaloba.pdf', caseNumber: SPZN, status: 'unread',
          deadlineDate: '2026-12-01', detectedDeadlines: [{ deadlineDate: '2026-11-20', unit: 'day', amount: 15, needsReview: true }] },
        { id: 'podatelna/nova.pdf', relativePath: 'podatelna/nova.pdf', fileName: 'nova.pdf', caseNumber: null, status: 'unread' }
    ]);
    db.insert('invoices', { id: 'inv_tajna', spisId: spisA.id, variabilniSymbol: '2026001', toPay: 1000, status: 'unpaid' });
});

test('doručená pošta: cizí kolega nevidí dokument ze spisu bez přístupu; nezařazené jen podatelna/správce/kdo nahrál (27. 10. 2026)', async () => {
    const all = (await request(app).get('/api/inbox/all').set(as(B.token))).body.inbox.map(f => f.id);
    expect(all).toEqual([]);
    const own = (await request(app).get('/api/inbox/all').set(as(A.token))).body.inbox.map(f => f.id);
    expect(own).toEqual(['tajne/zaloba.pdf']);
    expect((await request(app).get('/api/inbox/content').query({ fileName: 'tajne/zaloba.pdf' }).set(as(B.token))).statusCode).toBe(403);
    expect((await request(app).post('/api/inbox/delete').set(as(B.token)).send({ fileName: 'tajne/zaloba.pdf' })).statusCode).toBe(403);
    expect((await request(app).post('/api/inbox/mark-read').set(as(B.token)).send({ fileName: 'tajne/zaloba.pdf' })).statusCode).toBe(403);
    expect((await request(app).get(`/api/inbox/case/${encodeURIComponent(SPZN)}/timeline`).set(as(B.token))).statusCode).toBe(403);
});

test('lhůtník: lhůty cizího spisu se nezobrazí ani nepotvrdí', async () => {
    const rB = (await request(app).get('/api/lhutnik').set(as(B.token))).body;
    expect(rB.items.some(i => i.spisId === spisA.id)).toBe(false);
    expect(rB.summary.total).toBe(rB.items.length);
    const rA = (await request(app).get('/api/lhutnik').set(as(A.token))).body;
    expect(rA.items.some(i => i.spisId === spisA.id)).toBe(true);
    expect((await request(app).post('/api/lhutnik/confirm').set(as(B.token)).send({ fileId: 'tajne/zaloba.pdf', index: 0 })).statusCode).toBe(403);
});

test('fakturace: faktury cizího spisu skryté, vystavení ani úhrada bez přístupu nejde', async () => {
    expect((await request(app).get('/api/fakturace').set(as(B.token))).body.invoices.some(i => i.id === 'inv_tajna')).toBe(false);
    expect((await request(app).get('/api/fakturace').set(as(A.token))).body.invoices.some(i => i.id === 'inv_tajna')).toBe(true);
    const outB = (await request(app).get('/api/fakturace/outstanding').set(as(B.token))).body;
    expect(outB.invoices.some(i => i.id === 'inv_tajna')).toBe(false);
    expect(outB.totalDue).toBe(0);
    expect((await request(app).post('/api/fakturace/from-spis').set(as(B.token)).send({ spisId: spisA.id })).statusCode).toBe(403);
    expect((await request(app).post('/api/fakturace/inv_tajna/paid').set(as(B.token)).send({ amount: 1000 })).statusCode).toBe(403);
});

test('RAG: úseky cizího spisu a neznámého původu se odfiltrují, KB zůstává', () => {
    const chunks = [
        { fileName: 'tajne/zaloba.pdf', text: 'důvěrné' },
        { fileName: 'podatelna/nova.pdf', text: 'nezařazené' },
        { fileName: 'neznamy/soubor.pdf', text: 'bez záznamu' },
        { fileName: '0075a.txt', scope: '_kb_obcansky', text: '§ 75a' }
    ];
    expect(fileAcl.filterChunks(chunks, pB()).map(c => c.fileName)).toEqual(['0075a.txt']);
    expect(fileAcl.filterChunks(chunks, { kind: 'user', userId: 'asi', role: 'asistent', scopes: ['read', 'write'] }).map(c => c.fileName)).toEqual(['podatelna/nova.pdf', '0075a.txt']);
    const pA = { kind: 'user', userId: A.user.id, name: A.user.name, scopes: ['read', 'write'] };
    expect(fileAcl.filterChunks(chunks, pA).map(c => c.fileName)).toContain('tajne/zaloba.pdf');
    expect(fileAcl.filterChunks(chunks, { kind: 'user', userId: 'x', scopes: ['admin'] })).toHaveLength(4);
    expect(fileAcl.filterChunks(chunks, null)).toHaveLength(4); // systémový běh (watcher/cron)
    expect(fileAcl.canReadChunkFile('tajne/zaloba.pdf', pB())).toBe(false);
});

test('po sdílení ke čtení kolega dokument vidí, ale nemaže', async () => {
    expect((await request(app).post(`/api/spisy/${spisA.id}/share`).set(as(A.token)).send({ userId: B.user.id, level: 'read' })).statusCode).toBe(200);
    expect(fileAcl.filterChunks([{ fileName: 'tajne/zaloba.pdf' }], pB())).toHaveLength(1);
    const all = (await request(app).get('/api/inbox/all').set(as(B.token))).body.inbox.map(f => f.id);
    expect(all).toContain('tajne/zaloba.pdf');
    expect((await request(app).post('/api/inbox/delete').set(as(B.token)).send({ fileName: 'tajne/zaloba.pdf' })).statusCode).toBe(403);
});

test('audit čtení: otevření spisu se zapíše s aktérem, deduplikovaně (15 min)', async () => {
    const audit = require('../lib/audit');
    audit._resetReadDedup();
    const opens = () => audit.getLogsForSpis(spisA.id).filter(l => l.operation === 'Otevření spisu');
    const before = opens().length;
    expect((await request(app).get(`/api/spisy/${spisA.id}`).set(as(A.token))).statusCode).toBe(200);
    expect((await request(app).get(`/api/spisy/${spisA.id}`).set(as(A.token))).statusCode).toBe(200);
    expect(opens().length).toBe(before + 1);
    const last = opens()[opens().length - 1];
    expect(last.actor && last.actor.id).toBe(A.user.id);
    expect(last.details.access).toBe('read');
    // jiný uživatel (má sdílení ke čtení) = vlastní záznam
    expect((await request(app).get(`/api/spisy/${spisA.id}`).set(as(B.token))).statusCode).toBe(200);
    expect(opens().length).toBe(before + 2);
    // odepřený přístup se jako čtení nezapíše
    expect((await request(app).get(`/api/spisy/neexistuje`).set(as(B.token))).statusCode).toBe(404);
});

test('audit čtení: RAG výsledky → jeden záznam za spis, KB a nezařazené se nelogují', () => {
    const audit = require('../lib/audit');
    audit._resetReadDedup();
    const uses = () => audit.getLogsForSpis(spisA.id).filter(l => l.operation === 'Použití spisu agentem');
    const before = uses().length;
    fileAcl.logChunkReads([
        { fileName: 'tajne/zaloba.pdf' }, { fileName: 'tajne/zaloba.pdf' },
        { fileName: 'podatelna/nova.pdf' }, { fileName: '0075a.txt', scope: '_kb_obcansky' }
    ], 'Použití spisu agentem');
    expect(uses().length).toBe(before + 1);
    expect(uses()[uses().length - 1].details.files).toEqual(['tajne/zaloba.pdf']);
    const prev = process.env.AUDIT_READS;
    process.env.AUDIT_READS = '0';
    audit._resetReadDedup();
    expect(audit.logRead('Otevření spisu', 'x', spisA.id)).toBe(false);
    if (prev === undefined) delete process.env.AUDIT_READS; else process.env.AUDIT_READS = prev;
});

test('export auditní stopy: vlastník CSV/DOCX/JSON, čtenář ne; export se sám audituje', async () => {
    const r = await request(app).get(`/api/spisy/${spisA.id}/audit`).query({ format: 'csv' }).set(as(A.token));
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text).toContain('Otevření spisu');
    expect(r.text).toContain('JUDr. Alena Spisová');
    expect((await request(app).get(`/api/spisy/${spisA.id}/audit`).query({ format: 'csv' }).set(as(B.token))).statusCode).toBe(403);
    const j = (await request(app).get(`/api/spisy/${spisA.id}/audit`).set(ADMIN)).body;
    expect(j.rows.some(x => x.ukon === 'Export auditní stopy spisu (CSV)')).toBe(true);
    expect(j.chain.ok).toBe(true);
    const d = await request(app).get(`/api/spisy/${spisA.id}/audit`).query({ format: 'docx' }).set(as(A.token))
        .buffer(true).parse((res, cb) => { const b = []; res.on('data', c => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(d.statusCode).toBe(200);
    expect(d.body.slice(0, 2).toString()).toBe('PK');
});

describe('zbylé cesty (dočištění 14. 10. 2026)', () => {
    let spisC;
    beforeAll(async () => {
        spisC = (await request(app).post('/api/spisy').set(as(A.token)).send({ nazev: 'Další důvěrná věc', spisZn: '33 C 1/2026' })).body.spis;
    });

    test('záznam e-mailu do cizího spisu: 403, do nesvázaného OK', async () => {
        expect((await request(app).post('/api/case/email-logged').set(as(B.token)).send({ caseNumber: '33 C 1/2026', recipientEmail: 'x@example.cz' })).statusCode).toBe(403);
        expect((await request(app).post('/api/case/email-logged').set(as(B.token)).send({ caseNumber: '99 C 9/2026' })).statusCode).toBe(200);
    });

    test('AML: prověrka do cizího spisu ne; cizí prověrky nevidím, svoje ano', async () => {
        expect((await request(app).post('/api/aml/identify').set(as(B.token)).send({ typ: 'FO', jmeno: 'Karel Testovací', spisId: spisC.id })).statusCode).toBe(403);
        const own = await request(app).post('/api/aml/identify').set(as(A.token)).send({ typ: 'FO', jmeno: 'Karel Testovací', spisId: spisC.id });
        expect(own.statusCode).toBe(201);
        const mine = await request(app).post('/api/aml/identify').set(as(B.token)).send({ typ: 'FO', jmeno: 'Bez Spisu' });
        expect(mine.statusCode).toBe(201);
        const listB = (await request(app).get('/api/aml/checks').set(as(B.token))).body.checks.map(c => c.id);
        expect(listB).toContain(mine.body.check.id);
        expect(listB).not.toContain(own.body.check.id);
        expect((await request(app).get(`/api/aml/checks/${own.body.check.id}`).set(as(B.token))).statusCode).toBe(403);
        expect((await request(app).get('/api/aml/checks').set(as(A.token))).body.checks.map(c => c.id)).not.toContain(mine.body.check.id);
        expect((await request(app).get('/api/aml/checks').set(ADMIN)).body.checks.length).toBeGreaterThanOrEqual(2);
    });

    test('manažerská data a skartační protokoly jen správce; návrh skartace jen čitelné spisy', async () => {
        expect((await request(app).get('/api/managerial/profitability').set(as(A.token))).statusCode).toBe(403);
        expect((await request(app).get('/api/managerial/profitability').set(ADMIN)).statusCode).toBe(200);
        expect((await request(app).get('/api/skartace/protokoly').set(as(A.token))).statusCode).toBe(403);
        await request(app).post(`/api/spisy/${spisC.id}/stav`).set(as(A.token)).send({ stav: 'skartace' });
        const nB = (await request(app).get('/api/skartace/navrh').set(as(B.token))).body;
        expect(nB.inSkartace.some(s => s.id === spisC.id)).toBe(false);
        const nA = (await request(app).get('/api/skartace/navrh').set(as(A.token))).body;
        expect(nA.inSkartace.some(s => s.id === spisC.id)).toBe(true);
    });

    test('ověření podpisu dokumentu z cizího spisu: 403', async () => {
        expect((await request(app).post('/api/document/verify-signature').set(as(B.token)).send({ fileName: 'tajne/zaloba.pdf' })).statusCode).toBe(403);
    });
});
