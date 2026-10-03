/**
 * Datová schránka — příjem zpráv (lib/isds_inbox.js), import .zfo a lhůta od doručení.
 * Síť je vždy mock; odpovědi mají tvar podle WS ISDS v20, .zfo se staví přes node-forge
 * (PKCS#7 SignedData s XML zprávy uvnitř, jako skutečná zpráva). Údaje jsou smyšlené.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_isds_'));
process.env.API_TOKEN = 'tok-isds';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_isds_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_isds_data_'));
delete process.env.LEXIS_FIRM_MODE;

const request = require('supertest');
const forge = require('node-forge');
const app = require('../server');
const ib = require('../lib/isds_inbox');
const H = (r) => r.set('X-API-Token', 'tok-isds');

const ROZSUDEK = 'Okresní soud v Jihlavě\nSp. zn. 12 C 45/2026\nROZSUDEK\nŽalobce: Alfa Test s.r.o.\nŽalovaný: Beta Test s.r.o.\n' +
    'Poučení: Proti tomuto rozsudku lze podat odvolání do 15 dnů ode dne doručení písemného vyhotovení.\n';
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

function messageXml({ dmID = '1234567', files = [{ name: 'rozsudek.txt', meta: 'main', content: ROZSUDEK }], acceptance = '2026-10-01T06:15:00.000+02:00', status = 6 } = {}) {
    return '<?xml version="1.0" encoding="UTF-8"?><p:MessageDownloadResponse xmlns:p="http://isds.czechpoint.cz/v20"><p:dmReturnedMessage>' +
        `<p:dmDm><p:dmID>${dmID}</p:dmID><p:dbIDSender>abc1234</p:dbIDSender><p:dmSender>Okresní soud v Jihlavě</p:dmSender>` +
        '<p:dmAnnotation>Rozsudek 12 C 45/2026</p:dmAnnotation><p:dmSenderRefNumber>12 C 45/2026-30</p:dmSenderRefNumber>' +
        '<p:dmFiles>' + files.map(f => `<p:dmFile dmMimeType="text/plain" dmFileMetaType="${f.meta}" dmFileDescr="${f.name}"><p:dmEncodedContent>${b64(f.content)}</p:dmEncodedContent></p:dmFile>`).join('') +
        `</p:dmFiles></p:dmDm><p:dmHash algorithm="SHA-256">AAAA</p:dmHash><p:dmDeliveryTime>2026-09-30T14:00:00.000+02:00</p:dmDeliveryTime>` +
        (acceptance ? `<p:dmAcceptanceTime>${acceptance}</p:dmAcceptanceTime>` : '') + `<p:dmMessageStatus>${status}</p:dmMessageStatus>` +
        '</p:dmReturnedMessage><p:dmStatus><p:dmStatusCode>0000</p:dmStatusCode><p:dmStatusMessage>Provedeno úspěšně.</p:dmStatusMessage></p:dmStatus></p:MessageDownloadResponse>';
}

function zfoOf(xml) {
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey; cert.serialNumber = '01';
    cert.validity.notBefore = new Date('2026-01-01'); cert.validity.notAfter = new Date('2027-01-01');
    const attrs = [{ name: 'commonName', value: 'ISDS test' }];
    cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(keys.privateKey);
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(forge.util.encodeUtf8(xml));
    p7.addCertificate(cert);
    p7.addSigner({ key: keys.privateKey, certificate: cert, digestAlgorithm: forge.pki.oids.sha256 });
    p7.sign();
    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

const soapList = (records) => '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
    '<p:GetListOfReceivedMessagesResponse xmlns:p="http://isds.czechpoint.cz/v20"><p:dmRecords>' +
    records.map(r => `<p:dmRecord dmType="V"><p:dmOrdinal>1</p:dmOrdinal><p:dmID>${r.id}</p:dmID><p:dmSender>Okresní soud v Jihlavě</p:dmSender>` +
        `<p:dmAnnotation>Rozsudek</p:dmAnnotation><p:dmMessageStatus>${r.status || 4}</p:dmMessageStatus><p:dmDeliveryTime>2026-09-30T14:00:00.000+02:00</p:dmDeliveryTime>` +
        (r.acceptance ? `<p:dmAcceptanceTime>${r.acceptance}</p:dmAcceptanceTime>` : '') + '</p:dmRecord>').join('') +
    '</p:dmRecords><p:dmStatus><p:dmStatusCode>0000</p:dmStatusCode></p:dmStatus></p:GetListOfReceivedMessagesResponse></soap:Body></soap:Envelope>';
const soapWrap = inner => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;

describe('datum doručení', () => {
    test('přihlášením: datum v kalendáři ČR (ne UTC)', () => {
        // 23:30 UTC = 01:30 dalšího dne v Praze
        expect(ib.deliveryOf({ acceptanceTime: '2026-10-01T23:30:00Z', status: '6' })).toMatchObject({ date: '2026-10-02', how: 'přihlášením', exact: true });
    });
    test('fikcí', () => {
        expect(ib.deliveryOf({ acceptanceTime: '2026-10-10T00:00:00+02:00', status: '5' })).toMatchObject({ date: '2026-10-10', how: 'fikcí' });
    });
    test('jen dodáno → odhad fikce +10 dní, k ověření', () => {
        const d = ib.deliveryOf({ deliveryTime: '2026-09-30T14:00:00+02:00', status: '4' });
        expect(d).toMatchObject({ date: '2026-10-10', exact: false });
        expect(d.how).toMatch(/odhad fikce/);
    });
});

describe('SOAP', () => {
    test('požadavek na seznam a stažení', () => {
        expect(ib.buildListRequest({ from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' })).toMatch(/<GetListOfReceivedMessages xmlns="http:\/\/isds.czechpoint.cz\/v20"><dmFromTime>2026-09-01/);
        expect(ib.buildDownloadRequest('12<34', true)).toMatch(/<SignedMessageDownload [^>]*><dmID>1234<\/dmID>/);
    });
    test('rozbor seznamu a chybového stavu', () => {
        expect(ib.parseList(soapList([{ id: '11' }, { id: '12', acceptance: '2026-10-01T08:00:00Z', status: 6 }])).records.map(r => r.dmID)).toEqual(['11', '12']);
        const bad = soapWrap('<p:GetListOfReceivedMessagesResponse xmlns:p="http://isds.czechpoint.cz/v20"><p:dmStatus><p:dmStatusCode>1214</p:dmStatusCode><p:dmStatusMessage>Chyba</p:dmStatusMessage></p:dmStatus></p:GetListOfReceivedMessagesResponse>');
        expect(ib.parseList(bad)).toMatchObject({ ok: false });
    });
    test('rozbor zprávy: přílohy, odesílatel, čas doručení', () => {
        const m = ib.parseMessage(messageXml());
        expect(m.ok).toBe(true);
        expect(m.files).toHaveLength(1);
        expect(m.files[0]).toMatchObject({ name: 'rozsudek.txt', metaType: 'main' });
        expect(m.record).toMatchObject({ dmID: '1234567', sender: 'Okresní soud v Jihlavě', senderRefNumber: '12 C 45/2026-30' });
    });
});

describe('.zfo', () => {
    test('rozbalí XML z PKCS#7 obálky', () => {
        const xml = ib.extractZfoXml(zfoOf(messageXml()));
        expect(xml).toMatch(/MessageDownloadResponse/);
        expect(ib.parseMessage(xml).files[0].name).toBe('rozsudek.txt');
    });
    test('nesmysl → null', () => {
        expect(ib.extractZfoXml(Buffer.from('ahoj'))).toBeNull();
    });
});

describe('nahrání .zfo → doručená pošta, lhůta od doručení do schránky', () => {
    test('odvolání 15 dnů běží od 1. 10. (ISDS), ne od data zpracování', async () => {
        const zfo = zfoOf(messageXml({ dmID: '7001' }));
        const r = await H(request(app).post('/api/inbox/upload')).send({ fileName: 'DZ_7001.zfo', base64: zfo.toString('base64') });
        expect([200, 202]).toContain(r.status);
        expect(r.body).toMatchObject({ success: true, dmID: '7001' });
        expect(r.body.delivery).toMatchObject({ date: '2026-10-01', how: 'přihlášením' });
        const { loadInbox } = require('../lib/watcher');
        const inbox = await loadInbox();
        const item = Object.values(inbox.files).find(f => f.isds && f.isds.dmID === '7001');
        expect(item).toBeTruthy();
        expect(item.deliveryDate).toBe('2026-10-01');
        expect(item.deadlineDays).toBe(15);
        expect(item.deadlineDate).toBe('2026-10-16');
        expect(item.deadlineBase).toMatch(/datové schránky přihlášením/);
        expect(item.summary).toMatch(/📨 Datová schránka: doručeno 2026-10-01/);
        expect(item.action).toBe('Zvážit odvolání do 16. 10. 2026 (15 dnů od doručení)');
        // strany sporu i s právní formou („s.r.o.“), „Žalovaný:“ s ý
        expect(item.plaintiff).toBe('Alfa Test s.r.o.');
        expect(item.defendant).toBe('Beta Test s.r.o.');
        expect(item.relativePath).toMatch(/^datova-schranka[\\/]2026-10-01_7001[\\/]rozsudek\.txt$/);
        expect(fs.existsSync(path.join(tmp, '.isds-zfo', '7001.zfo'))).toBe(true);
    });
    test('stejná zpráva podruhé → duplicita, nic se nepřepíše', async () => {
        const zfo = zfoOf(messageXml({ dmID: '7001' }));
        const r = await H(request(app).post('/api/inbox/upload')).send({ fileName: 'znovu.zfo', base64: zfo.toString('base64') });
        expect(r.body).toMatchObject({ duplicate: true });
    });
    test('datum doručení v textu se liší → rozhoduje ISDS, v shrnutí poznámka', async () => {
        const text = ROZSUDEK + 'Doručeno dne 20. 9. 2026.\n';
        const zfo = zfoOf(messageXml({ dmID: '7002', files: [{ name: 'usneseni.txt', meta: 'main', content: text }] }));
        await H(request(app).post('/api/inbox/upload')).send({ fileName: 'DZ_7002.zfo', base64: zfo.toString('base64') });
        const inbox = await require('../lib/watcher').loadInbox();
        const item = Object.values(inbox.files).find(f => f.isds && f.isds.dmID === '7002');
        expect(item.deliveryDate).toBe('2026-10-01');
        expect(item.deliveryConflict).toBe(false);
        expect(item.summary).toMatch(/jiné datum doručení \(2026-09-20\)/);
    });
    test('neplatné .zfo → 400 s vysvětlením', async () => {
        const r = await H(request(app).post('/api/inbox/upload')).send({ fileName: 'x.zfo', base64: b64('není to zpráva') });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/\.zfo/);
    });
});

describe('vyzvednutí schránky (pollOnce)', () => {
    test('vypnuté stahování nic nestáhne', async () => {
        const soap = jest.fn();
        const r = await ib.pollOnce({ config: { login: 'u', password: 'p', enabled: false, base: 'https://x' }, soap });
        expect(r).toMatchObject({ ok: false, kind: 'disabled' });
        expect(soap).not.toHaveBeenCalled();
    });
    test('stáhne nové zprávy, uloží .zfo a přílohy, podruhé je přeskočí', async () => {
        const processed = [];
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_isds_poll_'));
        const soap = jest.fn(async (svc, xml) => {
            if (/GetListOfReceivedMessages/.test(xml)) return soapList([{ id: '8001', status: 4 }]);
            if (/SignedMessageDownload/.test(xml)) return soapWrap(`<p:SignedMessageDownloadResponse xmlns:p="http://isds.czechpoint.cz/v20"><p:dmSignature>${zfoOf(messageXml({ dmID: '8001' })).toString('base64')}</p:dmSignature><p:dmStatus><p:dmStatusCode>0000</p:dmStatusCode></p:dmStatus></p:SignedMessageDownloadResponse>`);
            return soapWrap(messageXml({ dmID: '8001' }));
        });
        const opts = { config: { login: 'u', password: 'p', enabled: true, base: 'https://x' }, soap, dir, process: async (f, o) => { processed.push({ f, o }); return { ok: true }; } };
        const r1 = await ib.pollOnce(opts);
        expect(r1).toMatchObject({ ok: true, checked: 1, downloaded: 1 });
        // seznam hlásil „jen dodáno“, stažení už vrátilo čas doručení přihlášením → bere se ten
        expect(r1.messages[0]).toMatchObject({ dmID: '8001', delivery: '2026-10-01', how: 'přihlášením' });
        expect(processed[0].o.isds).toMatchObject({ dmID: '8001', deliveryDate: '2026-10-01' });
        expect(fs.existsSync(path.join(dir, '.isds-zfo', '8001.zfo'))).toBe(true);
        expect(soap.mock.calls.map(c => c[0])).toEqual(['dz', 'dx', 'dx']);
        const r2 = await ib.pollOnce(opts);
        expect(r2).toMatchObject({ ok: true, checked: 1, downloaded: 0, skipped: 1 });
    });
    test('odmítnuté přihlášení → chyba uložená ve stavu', async () => {
        const r = await ib.pollOnce({ config: { login: 'u', password: 'p', enabled: true, base: 'https://x' }, soap: async () => { throw new Error('ISDS odmítl přihlášení (HTTP 401)'); } });
        expect(r).toMatchObject({ ok: false, kind: 'unavailable' });
        expect(ib.status().lastError).toMatch(/401/);
    });
});

describe('nastavení přístupu', () => {
    test('config vrací stav příjmu, heslo nikdy', async () => {
        await H(request(app).post('/api/registries/config')).send({ isds: { url: 'https://ws1.czebox.cz/DS/dx', login: 'testuser', password: 'tajne-heslo', inbox: true } });
        const r = await H(request(app).get('/api/registries/config'));
        expect(r.status).toBe(200);
        expect(r.body.config.isds).toMatchObject({ login: 'testuser', hasPassword: true });
        expect(r.body.config.isds.inbox).toMatchObject({ configured: true, enabled: true, base: 'https://ws1.czebox.cz' });
        expect(JSON.stringify(r.body)).not.toMatch(/tajne-heslo/);
    });
});

// Watcher (chokidar) hlásí nové soubory v podsložkách se zpožděním — počkat, ať nelogují po konci testu.
afterAll(() => new Promise(r => setTimeout(r, 1500)));
