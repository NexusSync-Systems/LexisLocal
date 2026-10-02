/**
 * lib/tls_identity.js — TLS identita serveru pro párování s LexisEditorem.
 *
 * Server v kanceláři nemá doménu → self-signed certifikát. Editor mu nesmí věřit
 * „naslepo“ (vypnutá kontrola = kdokoli v síti se vydá za server). Místo toho se
 * při párování přenese OTISK VEŘEJNÉHO KLÍČE (SPKI SHA-256) mimo síťové spojení
 * (odkaz/QR z dashboardu) a editor pak přijme jen server s tímto klíčem.
 *
 *  • spkiPin(certPem) — „sha256/<base64url>“ z veřejného klíče (přežije obnovu
 *    certifikátu se stejným klíčem).
 *  • ensureCertificate() — chybí-li certifikát a je zapnuté HTTPS, vytvoří
 *    dlouhodobý (825 dní) self-signed certifikát přes openssl, s IP adresami
 *    stroje v SAN. Klíč leží v adresáři klíčů (mimo data), práva 0600.
 *  • buildConnectUrl() — lexis://host:port/?fp=<pin>&code=<jednorázový kód>
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CERT_DAYS = 825; // max. doba, kterou akceptují běžné klienty pro TLS certifikáty

/** SPKI SHA-256 otisk certifikátu (PEM nebo DER) → „sha256/<base64url>“. */
function spkiPin(cert) {
    const x = new crypto.X509Certificate(cert);
    const der = x.publicKey.export({ type: 'spki', format: 'der' });
    const b64 = crypto.createHash('sha256').update(der).digest('base64');
    return 'sha256/' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Krátká lidsky porovnatelná podoba otisku (pro kontrolu očima). */
function shortPin(pin) {
    const s = String(pin || '').replace(/^sha256\//, '');
    return (s.slice(0, 16).match(/.{1,4}/g) || []).join(' ');
}

function _lanIPs() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
    return out;
}

function defaultPaths() {
    let dir;
    try { dir = path.join(require('./secure_crypto').resolveKeyDir(), 'tls'); }
    catch (e) { dir = path.join(os.homedir(), '.lexislocal', 'tls'); }
    return { dir, key: path.join(dir, 'key.pem'), cert: path.join(dir, 'cert.pem') };
}

/**
 * Zajistí certifikát. Vrací { keyPath, certPath, created, pin } nebo { error }.
 * opts.run = injektovatelný execFileSync (testy).
 */
function ensureCertificate({ keyPath, certPath, hosts, run } = {}) {
    const d = defaultPaths();
    keyPath = keyPath || d.key; certPath = certPath || d.cert;
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        try { return { keyPath, certPath, created: false, pin: spkiPin(fs.readFileSync(certPath)) }; }
        catch (e) { return { error: 'Certifikát nejde přečíst: ' + e.message }; }
    }
    const exec = run || require('child_process').execFileSync;
    const ips = Array.from(new Set(['127.0.0.1'].concat(hosts || _lanIPs())));
    const san = ['DNS:localhost'].concat(ips.map(ip => 'IP:' + ip)).join(',');
    try {
        fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
        exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(CERT_DAYS),
            '-subj', '/CN=LexisLocal', '-addext', 'subjectAltName=' + san,
            '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
        try { fs.chmodSync(keyPath, 0o600); } catch (e) { /* Windows */ }
        return { keyPath, certPath, created: true, pin: spkiPin(fs.readFileSync(certPath)) };
    } catch (e) {
        return { error: 'Certifikát se nepodařilo vytvořit (je nainstalované openssl?): ' + e.message };
    }
}

/** Odkaz pro spárování editoru. host = adresa, přes kterou je dashboard otevřený. */
function buildConnectUrl({ host, pin, code }) {
    if (!host || !pin) return null;
    if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) return null; // podezřelý Host header
    const q = new URLSearchParams({ fp: pin });
    if (code) q.set('code', code);
    return `lexis://${host}/?${q.toString()}`;
}

module.exports = { spkiPin, shortPin, ensureCertificate, buildConnectUrl, defaultPaths, CERT_DAYS };
