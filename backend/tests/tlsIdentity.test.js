/**
 * Párování LexisEditor ↔ LexisLocal přes otisk klíče serveru (SPKI pin).
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const tmp = path.join(os.tmpdir(), `lexis_test_tls_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

const tls = require('../lib/tls_identity');
let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch (e) { hasOpenssl = false; }
const t = hasOpenssl ? test : test.skip;

t('ensureCertificate vytvoří dlouhodobý certifikát a otisk sedí s openssl', () => {
    const keyPath = path.join(tmp, 'tls', 'key.pem'), certPath = path.join(tmp, 'tls', 'cert.pem');
    const r = tls.ensureCertificate({ keyPath, certPath, hosts: ['192.168.1.20'] });
    expect(r.created).toBe(true);
    expect(r.pin).toMatch(/^sha256\/[A-Za-z0-9_-]{43}$/);
    // nezávislý výpočet: openssl pkey -pubout -outform der | sha256
    const der = execFileSync('openssl', ['x509', '-in', certPath, '-pubkey', '-noout']);
    const spki = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: der });
    const exp = require('crypto').createHash('sha256').update(spki).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(r.pin).toBe('sha256/' + exp);
    const info = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-text']).toString();
    expect(info).toMatch(/IP Address:192\.168\.1\.20/);
    const end = new Date(execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-enddate']).toString().split('=')[1]);
    expect((end - Date.now()) / 86400000).toBeGreaterThan(800);
    if (process.platform !== 'win32') expect(fs.statSync(keyPath).mode & 0o077).toBe(0);
    // druhé volání certifikát nepřepíše (otisk zůstává)
    expect(tls.ensureCertificate({ keyPath, certPath })).toMatchObject({ created: false, pin: r.pin });
});

test('buildConnectUrl: otisk + kód, podezřelý host odmítne', () => {
    const u = tls.buildConnectUrl({ host: '192.168.1.20:443', pin: 'sha256/abc_-', code: 'Xy-1' });
    expect(u).toBe('lexis://192.168.1.20:443/?fp=sha256%2Fabc_-&code=Xy-1');
    expect(tls.buildConnectUrl({ host: 'evil.com/<x>', pin: 'sha256/a' })).toBeNull();
    expect(tls.shortPin('sha256/ABCDEFGHIJKLMNOPQRS')).toBe('ABCD EFGH IJKL MNOP');
});

test('/api/pair/new vrací pro HTTPS i odkaz pro editor s otiskem', async () => {
    process.env.USE_HTTPS = 'true';
    const request = require('supertest');
    const app = require('../server');
    app.locals.tlsPin = 'sha256/TESTPIN';
    const r = await request(app).post('/api/pair/new').set('X-API-Token', 'tok-test').set('Host', '127.0.0.1:4443');
    expect(r.status).toBe(200);
    expect(r.body.editor.pin).toBe('sha256/TESTPIN');
    expect(r.body.editor.connectUrl).toBe(`lexis://127.0.0.1:4443/?fp=sha256%2FTESTPIN&code=${encodeURIComponent(r.body.code)}`);
    delete process.env.USE_HTTPS;
});
