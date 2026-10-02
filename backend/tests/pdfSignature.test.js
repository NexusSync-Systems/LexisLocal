/**
 * Ověření elektronických podpisů v PDF (lib/signature_check.js, /api/document/verify-signature,
 * štítek v doručené poště). Fixture = syntetické PDF podepsané testovacím certifikátem
 * („Testovaci Advokat“, QcStatements) s razítkem testovací TSA — žádná reálná data.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_sig_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

const request = require('supertest');
const app = require('../server');
const SC = require('../lib/signature_check');
const H = (r) => r.set('X-API-Token', 'tok-test');

const signed = fs.readFileSync(path.join(__dirname, 'fixtures', 'signed_synthetic.pdf'));
const tampered = Buffer.from(signed); tampered[20] ^= 0x01;

test('podepsané PDF: platný podpis, podepisující, razítko, kvalifikovaný certifikát', () => {
    const r = SC.checkPdfBuffer(signed);
    expect(r).toMatchObject({ signed: true, count: 1, allValid: true, anyInvalid: false, trustChecked: false });
    const s = r.signatures[0];
    expect(s.signer).toBe('Testovaci Advokat');
    expect(s.qualifiedCertificate).toBe(true);
    expect(s.timestamp).toMatchObject({ valid: true });
    expect(SC.summaryNote(r)).toMatch(/Elektronicky podepsáno: Testovaci Advokat/);
});

test('změněné PDF → neplatný podpis a varování ve shrnutí', () => {
    const r = SC.checkPdfBuffer(tampered);
    expect(r.signed).toBe(true);
    expect(r.anyInvalid).toBe(true);
    expect(r.signatures[0].integrity).toBe(false);
    expect(SC.summaryNote(r)).toMatch(/NEPLATNÝ ELEKTRONICKÝ PODPIS/);
});

test('nepodepsané PDF a ne-PDF', () => {
    const plain = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    expect(SC.checkPdfBuffer(plain)).toMatchObject({ signed: false, count: 0 });
    expect(SC.summaryNote(SC.checkPdfBuffer(plain))).toBe('');
    expect(SC.checkPdfBuffer(Buffer.from('hello world'))).toBeNull();
    expect(SC.checkPdfFile(path.join(tmp, 'neexistuje.pdf'))).toBeNull();
    expect(SC.checkPdfFile(path.join(tmp, 'x.txt'))).toBeNull();
});

test('API: ověření PDF poslaného v base64', async () => {
    const ok = await H(request(app).post('/api/document/verify-signature')).send({ fileBase64: signed.toString('base64') });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ signed: true, allValid: true });
    const bad = await H(request(app).post('/api/document/verify-signature')).send({ fileBase64: tampered.toString('base64') });
    expect(bad.body.anyInvalid).toBe(true);
    const notPdf = await H(request(app).post('/api/document/verify-signature')).send({ fileBase64: Buffer.from('abc').toString('base64') });
    expect(notPdf.status).toBe(400);
    const none = await H(request(app).post('/api/document/verify-signature')).send({});
    expect(none.status).toBe(400);
});

test('API: bez tokenu nepustí; fileName mimo doručenou poštu → 404 (žádné libovolné cesty)', async () => {
    const r = await request(app).post('/api/document/verify-signature').send({ fileBase64: signed.toString('base64') });
    expect([401, 403]).toContain(r.status);
    const p = await H(request(app).post('/api/document/verify-signature')).send({ fileName: '../../etc/passwd' });
    expect(p.status).toBe(404);
});

test('štítek v doručené poště escapuje jméno podepisujícího', () => {
    global.escapeHtml = require('../public/app-helpers').escapeHtml;
    const src = fs.readFileSync(path.join(__dirname, '../public/app-inbox.js'), 'utf8');
    const m = src.match(/function _lexSignatureBadge[\s\S]*?\n}\n/);
    // eslint-disable-next-line no-new-func
    const badge = new Function('escapeHtml', m[0] + '; return _lexSignatureBadge;')(global.escapeHtml);
    expect(badge(null)).toBe('');
    expect(badge({ signed: false })).toBe('');
    const html = badge({ signed: true, anyInvalid: false, signatures: [{ valid: true, signer: '"><img src=x onerror=alert(1)>', level: 'zaručený', timestamp: null }] });
    expect(html).toContain('🔏 podepsáno');
    expect(html).not.toMatch(/<img/);
    expect(badge({ signed: true, anyInvalid: true, signatures: [{ valid: false, signer: 'X' }] })).toContain('podpis neplatný');
});

test('nahraný podepsaný PDF dokument má v doručené poště podpis i poznámku ve shrnutí', async () => {
    const up = await H(request(app).post('/api/inbox/upload')).send({ fileName: 'usneseni_podepsane.pdf', base64: signed.toString('base64') });
    expect([200, 202]).toContain(up.status);
    const { loadInbox } = require('../lib/watcher');
    const inbox = await loadInbox();
    const item = Object.values(inbox.files).find(f => f.fileName === 'usneseni_podepsane.pdf');
    expect(item).toBeTruthy();
    expect(item.signatures).toMatchObject({ signed: true, allValid: true });
    expect(item.summary).toMatch(/Elektronicky podepsáno/);
    // ověření podle názvu z doručené pošty
    const key = Object.keys(inbox.files).find(k => inbox.files[k].fileName === 'usneseni_podepsane.pdf');
    const v = await H(request(app).post('/api/document/verify-signature')).send({ fileName: key });
    expect(v.status).toBe(200);
    expect(v.body.signed).toBe(true);
}, 60000);
