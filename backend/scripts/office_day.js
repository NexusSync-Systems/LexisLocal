#!/usr/bin/env node
/**
 * office_day.js — simulace zavedení LexisLocalu v kanceláři a jednoho celého pracovního dne.
 *
 * Co se děje (vše přes HTTP API jako skutečné klienty, každý uživatel svým tokenem):
 *   0  ZAVEDENÍ   správce založí účty (3 advokáti, koncipient, asistentka), zapne firemní režim,
 *                 advokáti naimportují své spisy z CSV, správce nastaví sdílení, nahraje interní
 *                 postupy do báze rešeršníka, asistentka digitalizuje stávající dokumenty
 *                 (PDF, DOCX, skeny, e-maily) → kontrola zařazení do spisů, lhůt a doručení.
 *   1  DEN        8:00–16:30 v reálném čase (--hours 8; zhuštěně --hours 3): podatelna přijímá
 *                 datové zprávy (.zfo) a další písemnosti, asistentka zakládá nové věci (po
 *                 kontrole střetu zájmů), rezervuje schůzky, fakturuje, hlídá lhůtník; advokáti
 *                 a koncipient dělají rešerše (i nad spisem), kontroly smluv, koncepty podání,
 *                 schvalují koncepty, odpovídají klientům; prohlížeče se dotazují na novinky.
 *                 Každý člověk čeká na odpověď, než udělá další krok (fronta na uživatele).
 *                 Volitelně v poledne restart serveru (--restart-cmd) — výpadek a obnova dat.
 *   2  KONEC DNE  úplnost dat (dokumenty, spisy, koncepty), oprávnění (kdo co vidí, únik přes
 *                 doručenou poštu a vyhledávání), auditní řetězec, chybovost a odezvy po hodinách,
 *                 deaktivace účtu (odchod zaměstnance).
 *
 *   node backend/scripts/office_day.js --base https://127.0.0.1 --token <správce> --insecure \
 *     [--hours 8] [--dataset backend/eval/office_day/dataset-v1.tar.gz] [--out <dir>] [--label kancelar]
 *     [--restart-cmd "systemctl restart lexislocal" --restart-at 4.5] [--model qwen2.5:7b]
 *     [--smoke]   (rychlá zkouška: 20 min den, 30 + 30 dokumentů)
 *
 * Výstup: <out>/office_day_<čas>_<label>.json (vše vč. odpovědí agentů) + .md (souhrn česky).
 * Tokeny uživatelů jen v paměti procesu, nikam se nezapisují. Data jsou SYNTETICKÁ
 * (backend/eval/office_day/generate_dataset.py), jen pro vlastní testovací server.
 * Bez závislostí kromě node-forge (sestavení .zfo; je v závislostech aplikace). Node ≥ 18.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEF_DATASET = path.join(ROOT, 'eval', 'office_day', 'dataset-v1.tar.gz');

// ─── argumenty ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const o = { base: null, token: process.env.LEXIS_API_TOKEN || '', insecure: false, hours: 8, dataset: DEF_DATASET,
        out: path.join(ROOT, '..', 'bench-results'), label: 'kancelar', restartCmd: '', restartAt: 4.5, model: '', seed: 20261103,
        smoke: false, uploadConcurrency: 2, pollS: 60, agentTimeoutMs: 15 * 60 * 1000, maxOnboarding: 0, maxDen: 0, firm: true, intenzita: 1 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], n = () => argv[++i];
        if (a === '--base') o.base = String(n()).replace(/\/+$/, '');
        else if (a === '--token') o.token = n();
        else if (a === '--insecure') o.insecure = true;
        else if (a === '--hours') o.hours = parseFloat(n());
        else if (a === '--dataset') o.dataset = n();
        else if (a === '--out') o.out = n();
        else if (a === '--label') o.label = n();
        else if (a === '--restart-cmd') o.restartCmd = n();
        else if (a === '--restart-at') o.restartAt = parseFloat(n());
        else if (a === '--model') o.model = n();
        else if (a === '--seed') o.seed = parseInt(n(), 10);
        else if (a === '--upload-concurrency') o.uploadConcurrency = Math.max(1, parseInt(n(), 10));
        else if (a === '--poll-s') o.pollS = parseInt(n(), 10);
        else if (a === '--max-onboarding') o.maxOnboarding = parseInt(n(), 10);
        else if (a === '--max-den') o.maxDen = parseInt(n(), 10);
        else if (a === '--no-firm') o.firm = false;
        else if (a === '--intenzita') o.intenzita = Math.min(5, Math.max(0.2, parseFloat(n()) || 1)); // násobek tempa práce lidí
        else if (a === '--smoke') o.smoke = true;
        else if (a === '--cloud') o.cloud = true; // server s cloudovým modelem (Bedrock EU): souhlasy klientů, obecné dotazy jako veřejné
        else if (a === '-h' || a === '--help') o.help = true;
    }
    if (o.smoke) { o.hours = o.hours === 8 ? 1 / 3 : o.hours; o.maxOnboarding = o.maxOnboarding || 30; o.maxDen = o.maxDen || 30; o.pollS = Math.min(o.pollS, 20); }
    return o;
}

// ─── deterministický generátor ───────────────────────────────────────────────
function rng(seed) {
    let s = seed >>> 0;
    const f = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    f.int = (a, b) => a + Math.floor(f() * (b - a + 1));
    f.pick = arr => arr[Math.floor(f() * arr.length)];
    f.chance = p => f() < p;
    return f;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
let O = null;
// Přerušené spojení (ECONNRESET apod.) u čtení (GET) zopakujeme jednou — jako prohlížeč; počítá se zvlášť (K17b).
const TRANSIENT = /ECONNRESET|EPIPE|socket hang up/i;
async function request(method, urlPath, opts = {}) {
    const r = await request1(method, urlPath, opts);
    if (r.status === 0 && method === 'GET' && TRANSIENT.test(r.error || '')) {
        const r2 = await request1(method, urlPath, opts);
        r2.retried = r.error; r2.ms += r.ms;
        return r2;
    }
    return r;
}
function request1(method, urlPath, { body, token, timeout = 120000 } = {}) {
    return new Promise((resolve) => {
        const u = new URL(O.base + urlPath);
        const lib = u.protocol === 'https:' ? https : http;
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const h = {};
        if (token) h['X-API-Token'] = token;
        if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
        const t0 = Date.now();
        const req = lib.request({ method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search, rejectUnauthorized: !O.insecure, timeout, headers: h }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null; try { json = JSON.parse(text); } catch (e) { /* ne-JSON */ }
                resolve({ status: res.statusCode, ms: Date.now() - t0, text, json });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', e => resolve({ status: 0, ms: Date.now() - t0, error: e.message, text: '', json: null }));
        if (data) req.write(data);
        req.end();
    });
}

// ─── evidence ────────────────────────────────────────────────────────────────
const T0 = Date.now();
let dayStart = null, dayMs = 1;
const ops = [];        // každý požadavek: { phase, at, clock, user, action, status, ms, ok, note }
const checks = [];     // { phase, id, name, ok, severity, detail }
const agentRuns = [];  // výstupy agentů + hodnocení
const telemetry = [];  // vzorky /api/system/telemetry
let restartWindow = null; // { from, to }
let phase = '0';

const ok2 = s => s >= 200 && s < 300;
const short = (s, n = 200) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);
function clock(ts = Date.now()) {
    if (!dayStart || ts < dayStart) return '';
    const vm = Math.round((ts - dayStart) / dayMs * 510);
    return `${String(8 + Math.floor(vm / 60)).padStart(2, '0')}:${String(vm % 60).padStart(2, '0')}`;
}
function check(id, name, ok, { severity = 'medium', detail = '' } = {}) {
    checks.push({ phase, id, name, ok: !!ok, severity, detail: String(detail) });
    console.log(`  ${ok ? '✓' : '✗'} [${phase}/${id}] ${name}${detail ? ' — ' + short(detail, 180) : ''}`);
}

// Uživatelé (tokeny jen v paměti)
const U = {};        // key → { key, name, role, id, token }
let ASIST = [], KONC = []; // klíče asistentek (podatelna) a koncipientů — v sadě jich může být víc (velká kancelář)
const pickAsist = () => ASIST[Math.floor(Math.random() * ASIST.length)];
let ADMIN = null;

async function call(user, action, method, p, body, opt = {}) {
    const tok = user === 'admin' ? O.token : (U[user] && U[user].token);
    const r = await request(method, p, { body, token: tok, timeout: opt.timeout || (action.startsWith('agent') ? O.agentTimeoutMs : 300000) });
    const at = Date.now();
    // požadavek zasažený restartem: jeho průběh [start, konec] se překrývá s oknem restartu
    const inRestart = !!restartWindow && at >= restartWindow.from && (at - r.ms) <= (restartWindow.to || at);
    const expected = opt.expect ? opt.expect.includes(r.status) : ok2(r.status);
    ops.push({ phase, at: at - T0, clock: clock(at), user, action, status: r.status, ms: r.ms, ok: expected, restart: !!inRestart,
        note: expected ? undefined : short(r.error || (r.json && r.json.error) || r.text, 160), retried: r.retried || undefined });
    r.restart = !!inRestart;
    return r;
}
const get = (u, a, p, opt) => call(u, a, 'GET', p, undefined, opt);
const post = (u, a, p, b, opt) => call(u, a, 'POST', p, b, opt);

// ─── data ────────────────────────────────────────────────────────────────────
function loadDataset(src) {
    let dir = src;
    if (/\.t(ar\.)?gz$/.test(src)) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-officeday-'));
        execSync(`tar -xzf ${JSON.stringify(path.resolve(src))} -C ${JSON.stringify(dir)}`);
    }
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    m.dir = dir;
    return m;
}
function zfoFor(doc, text, dmID) {
    const forge = require('node-forge');
    const z = doc.zfo;
    const xml = '<?xml version="1.0" encoding="UTF-8"?><p:MessageDownloadResponse xmlns:p="http://isds.czechpoint.cz/v20"><p:dmReturnedMessage><p:dmDm>' +
        `<p:dmID>${dmID}</p:dmID><p:dmSender>${z.sender}</p:dmSender><p:dmAnnotation>${z.annotation}</p:dmAnnotation><p:dmFiles>` +
        `<p:dmFile dmMimeType="text/plain" dmFileMetaType="main" dmFileDescr="${z.attachment}"><p:dmEncodedContent>${Buffer.from(text).toString('base64')}</p:dmEncodedContent></p:dmFile>` +
        `</p:dmFiles></p:dmDm><p:dmDeliveryTime>${z.deliveryTime}</p:dmDeliveryTime><p:dmAcceptanceTime>${z.acceptanceTime}</p:dmAcceptanceTime>` +
        '<p:dmMessageStatus>6</p:dmMessageStatus></p:dmReturnedMessage><p:dmStatus><p:dmStatusCode>0000</p:dmStatusCode></p:dmStatus></p:MessageDownloadResponse>';
    const keys = zfoFor._keys || (zfoFor._keys = forge.pki.rsa.generateKeyPair(1024));
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey; cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 864e5); cert.validity.notAfter = new Date(Date.now() + 864e5);
    const a = [{ name: 'commonName', value: 'SIMULACE ISDS' }]; cert.setSubject(a); cert.setIssuer(a); cert.sign(keys.privateKey);
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(forge.util.encodeUtf8(xml));
    p7.addCertificate(cert);
    p7.addSigner({ key: keys.privateKey, certificate: cert, digestAlgorithm: forge.pki.oids.sha256 });
    p7.sign();
    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

// Stav simulace
const S = {
    spisByZn: {},       // spisZn → { id, ownerKey, data }
    shared: {},         // spisZn → { krejci: 'write'|'read', simkova: 'write', <adv>: 'read' }
    uploaded: {},       // manifest file → { storedName, status, dmID, ms, processed }
    drafts: [],         // { id, spisZn, author, status }
    nove: [],           // výsledky nových věcí
    cases: [],          // sada cases.json (rešerše bez spisu)
    souhlas: {},        // spisZn → true: klient souhlasí s cloudem (jen --cloud)
    odvolano: {},       // spisZn → čas (ms) odvolání souhlasu během dne
    stupenA: {},        // spisZn → true: přísně důvěrné (nikdy cloud)
    strop: null,        // { od, do } okno tvrdého stropu rozpočtu (ms)
    cloudEvents: [],    // průběh cloudových zásahů během dne
    preRestart: null
};

function spisOwnerKey(spisRow) { return spisRow.advokatKey; }
const keyOfName = name => (Object.values(U).find(u => u.name === name) || {}).key;
function readable(userKey, spisZn) {
    const s = S.spisByZn[spisZn]; if (!s) return false;
    if (s.ownerKey === userKey) return true;
    return !!(S.shared[spisZn] && S.shared[spisZn][userKey]);
}
function writable(userKey, spisZn) {
    const s = S.spisByZn[spisZn]; if (!s) return false;
    if (s.ownerKey === userKey) return true;
    return S.shared[spisZn] && S.shared[spisZn][userKey] === 'write';
}

// ─── 0: zavedení ─────────────────────────────────────────────────────────────
async function onboarding(M, R) {
    phase = '0';
    console.log('\n0 — ZAVEDENÍ V KANCELÁŘI');
    const t0 = Date.now();
    const st = await get('admin', 'status', '/api/status');
    check('Z1', 'Server odpovídá, token správce platí', ok2(st.status), { severity: 'critical', detail: `${st.status} ${short(st.json && st.json.version)}` });
    if (!ok2(st.status)) throw new Error('Server nedostupný nebo neplatný token správce.');
    if (!O.model) O.model = '';

    // účty
    const lu = await get('admin', 'users_list', '/api/users');
    const existing = ((lu.json && lu.json.users) || []).map(u => u.name);
    const clash = M.kancelar.uzivatele.filter(u => existing.includes(u.name));
    if (clash.length) throw new Error(`Účty simulace už existují (${clash.map(u => u.name).join(', ')}) — spusť na čisté instalaci.`);
    for (const u of M.kancelar.uzivatele) {
        const r = await post('admin', 'users_create', '/api/users', { name: u.name, role: u.role, deviceLabel: 'Simulace – prohlížeč' });
        if (ok2(r.status) && r.json && r.json.token) U[u.key] = { key: u.key, name: u.name, role: u.role, id: r.json.user.id, token: r.json.token };
    }
    check('Z2', `Založení ${M.kancelar.uzivatele.length} účtů (role advokát / koncipient / asistent)`, Object.keys(U).length === M.kancelar.uzivatele.length,
        { severity: 'critical', detail: Object.values(U).map(u => `${u.name} (${u.role})`).join(', ') });
    if (Object.keys(U).length !== M.kancelar.uzivatele.length) throw new Error('Nepodařilo se založit účty.');
    ASIST = Object.values(U).filter(u => u.role === 'asistent').map(u => u.key);
    KONC = Object.values(U).filter(u => u.role === 'koncipient').map(u => u.key);
    const me = await get(KONC[0] || ASIST[0], 'me', '/api/me');
    check('Z3', 'Nový uživatel se přihlásí svým tokenem (/api/me)', ok2(me.status) && me.json && /Krej/.test(JSON.stringify(me.json)), { severity: 'high', detail: me.status });

    if (O.firm) {
        const fm = await post('admin', 'firm_mode', '/api/settings/firm-mode', { enabled: true });
        const fs2 = await get('admin', 'firm_mode', '/api/settings/firm-mode');
        check('Z4', 'Firemní režim zapnut (spisy jen vlastník + sdílení)', fs2.json && fs2.json.enabled === true, { severity: 'critical', detail: `${fm.status} ${short(fs2.text, 160)}` });
    }

    // import spisů: každý advokát svůj seznam
    let imported = 0; const impMs = [];
    for (const adv of M.kancelar.uzivatele.filter(u => u.role === 'advokat')) {
        const csv = fs.readFileSync(path.join(M.dir, `spisy_${adv.key}.csv`), 'utf8');
        const rows = csv.trim().split(/\r?\n/).length - 1;
        const dry = await post(adv.key, 'spisy_import', '/api/spisy/import', { csv, dryRun: true });
        const imp = await post(adv.key, 'spisy_import', '/api/spisy/import', { csv });
        impMs.push(imp.ms);
        const nove = imp.json && imp.json.summary ? imp.json.summary.nove : 0;
        imported += nove;
        check('Z5-' + adv.key, `Import spisů z CSV: ${adv.name} (${rows} spisů)`, dry.json && dry.json.summary && dry.json.summary.nove === rows && nove === rows,
            { severity: 'high', detail: `náhled ${short(JSON.stringify(dry.json && dry.json.summary), 100)} · import ${imp.status} za ${imp.ms} ms` });
    }
    const all = await get('admin', 'spisy_list', '/api/spisy');
    const list = (all.json && all.json.spisy) || [];
    for (const row of M.spisy) {
        const s = list.find(x => x.spisZn === row.spisZn);
        if (s) S.spisByZn[row.spisZn] = { id: s.id, ownerKey: spisOwnerKey(row), row };
    }
    check('Z6', 'Všechny spisy z CSV jsou v evidenci', Object.keys(S.spisByZn).length === M.spisy.length, { severity: 'high', detail: `${Object.keys(S.spisByZn).length}/${M.spisy.length}` });

    // sdílení: asistentka = podatelna u všech (došlá pošta, lhůty, fakturace; spis ani dokumenty nemění),
    // koncipient zapisuje do ~40 %, advokáti si občas půjčí spis kolegy ke čtení
    let shareFail = 0; const advKeys = M.kancelar.uzivatele.filter(u => u.role === 'advokat').map(u => u.key);
    for (const zn of Object.keys(S.spisByZn)) {
        const s = S.spisByZn[zn]; S.shared[zn] = {};
        const grants = ASIST.map(k => [k, 'podatelna']);
        KONC.forEach(k => { if (R.chance(0.4)) grants.push([k, 'write']); });
        if (R.chance(0.1)) grants.push([R.pick(advKeys.filter(k => k !== s.ownerKey)), 'read']);
        for (const [k, level] of grants) {
            // sdílí vlastník spisu (advokát), ne správce — jak to bude v praxi
            const r = await post(s.ownerKey, 'spis_share', `/api/spisy/${s.id}/share`, { userId: U[k].id, level });
            if (ok2(r.status)) S.shared[zn][k] = level; else shareFail++;
        }
    }
    check('Z7', 'Sdílení spisů vlastníkem (asistentka podatelna u všech, koncipient ~40 %, kolegové občas)', shareFail === 0,
        { severity: 'high', detail: `chyb ${shareFail}; koncipient má ${Object.values(S.shared).filter(x => x[KONC[0]]).length} spisů` });

    // Cloud (--cloud): u ~třetiny spisů advokát zaznamená souhlas klienta s cloudovým modelem (ostatní zůstávají
    // stupeň B bez souhlasu = jen lokálně). Kontroly K21 pak ověří, že do cloudu šlo jen, co smí.
    if (O.cloud) {
        let sFail = 0;
        for (const zn of Object.keys(S.spisByZn)) {
            if (!R.chance(1 / 3)) continue;
            const s = S.spisByZn[zn];
            const r = await post(s.ownerKey, 'cloud_souhlas', `/api/spisy/${s.id}/cloud/souhlas`, { typ: 'spis', poznamka: 'Simulace: písemný souhlas klienta s cloudovým modelem (EU)' });
            if (ok2(r.status)) S.souhlas[zn] = true; else sFail++;
        }
        // ~5 spisů je přísně důvěrných (stupeň A): ani se souhlasem nesmí do cloudu
        let aFail = 0, aSouhlas = [];
        for (const zn of Object.keys(S.spisByZn).filter(z => !S.souhlas[z]).slice(0, 5)) {
            const sp = S.spisByZn[zn];
            const r = await post(sp.ownerKey, 'cloud_stupen', `/api/spisy/${sp.id}/cloud/stupen`, { stupen: 'A', duvod: 'Simulace: trestní obhajoba / zdravotní údaje' });
            if (ok2(r.status)) S.stupenA[zn] = true; else aFail++;
            const so = await post(sp.ownerKey, 'cloud_souhlas_A', `/api/spisy/${sp.id}/cloud/souhlas`, { typ: 'spis', poznamka: 'Simulace: souhlas u stupně A' }, { expect: [200, 400, 403, 409, 422] });
            aSouhlas.push(so.status);
            if (ok2(so.status)) S.souhlas[zn] = 'A'; // souhlas zaznamenán, ale stupeň A ho musí přebít
        }
        S.cloudA = { aFail, aSouhlas };
        // rozpočet kanceláře na cloud (bez tvrdého stropu; strop se zkusí odpoledne)
        const bs = await post('admin', 'ai_rozpocet', '/api/ai-usage/settings', { mesicniRozpocetUsd: 50, varovaniPct: 80, tvrdyStrop: false });
        S.cloudEvents.push({ t: Date.now(), co: 'rozpočet 50 USD', status: bs.status });
        const st = await get('admin', 'cloud_stav', '/api/agent/cloud-stav');
        check('Z13', 'Cloudový model zapnutý a souhlas klienta zaznamenán u ~1/3 spisů', sFail === 0 && !!(st.json && st.json.aktivni),
            { severity: 'high', detail: `souhlas ${Object.keys(S.souhlas).length} spisů, chyb ${sFail}; model ${(st.json && st.json.model && st.json.model.nazev) || '—'}` });
    }

    // interní postupy → báze rešeršníka
    let kbOk = 0; const kbFiles = fs.readdirSync(path.join(M.dir, 'knowhow'));
    for (const f of kbFiles) {
        const r = await post('admin', 'kb_upload', '/api/agent-knowledge/resersnik', { fileName: 'SIMULACE_' + f, text: fs.readFileSync(path.join(M.dir, 'knowhow', f), 'utf8') });
        if (ok2(r.status)) kbOk++;
    }
    check('Z8', 'Interní postupy kanceláře v bázi rešeršníka', kbOk === kbFiles.length, { severity: 'medium', detail: `${kbOk}/${kbFiles.length}` });
    // dashboard: název a logo kanceláře (správce), každý uživatel je vidí; stránka má hlavičku s účtem
    const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const kp = await post('admin', 'nastaveni', '/api/settings/kancelar', { nazev: M.kancelar.nazev, logo: LOGO }, { expect: [200, 404] });
    if (kp.status === 200) {
        const seen = [];
        for (const u of Object.values(U)) { const r = await get(u.key, 'kancelar_znacka', '/api/settings/kancelar'); seen.push(r.json && r.json.nazev === M.kancelar.nazev && !!r.json.logo); }
        const html = await request('GET', '/', {});
        check('Z12', 'Dashboard: název a logo kanceláře nastavené správcem vidí všichni; stránka má značku a menu účtu', seen.every(Boolean) && /id="brand-name"/.test(html.text) && /id="me-chip"/.test(html.text),
            { severity: 'medium', detail: `${seen.filter(Boolean).length}/${seen.length} uživatelů · stránka ${html.status}` });
    }
    // kancelář povolí podatelně rutinní korespondenci (lib/korespondence.js; výchozí vypnuto)
    const ko = await post('admin', 'nastaveni', '/api/settings/podatelna-korespondence', { enabled: true }, { expect: [200, 404] });
    S.korespondence = ko.status === 200;
    if (S.korespondence) { const t = await get(ASIST[0], 'korespondence_typy', '/api/drafts/korespondence'); S.korTypy = ((t.json && t.json.typy) || []).map(x => x.id); }

    // digitalizace stávajících dokumentů (asistentka)
    let docs = M.dokumenty.filter(d => d.phase === 'onboarding');
    if (O.maxOnboarding) docs = docs.slice(0, O.maxOnboarding);
    const tUp = Date.now();
    await pool(docs, O.uploadConcurrency, d => uploadDoc(pickAsist(), d, M));
    const upMin = (Date.now() - tUp) / 60000;
    const fails = docs.filter(d => !S.uploaded[d.file] || !ok2(S.uploaded[d.file].status));
    const unprocessed = docs.filter(d => S.uploaded[d.file] && S.uploaded[d.file].status === 202);
    check('Z9', `Digitalizace: nahráno ${docs.length} dokumentů`, fails.length === 0,
        { severity: 'high', detail: `${upMin.toFixed(1)} min (${(docs.length / Math.max(upMin, 0.01)).toFixed(1)} dok./min), chyb ${fails.length}, nezpracováno (202) ${unprocessed.length}` });
    await verifyDocs(docs, 'Z10', 'po digitalizaci');
    const after = await get('admin', 'spisy_list', '/api/spisy');
    const nAfter = ((after.json && after.json.spisy) || []).length;
    check('Z11', 'Digitalizace nezaložila duplicitní spisy', nAfter === M.spisy.length, { severity: 'medium', detail: `spisů ${nAfter} (čekáno ${M.spisy.length})` });
    S.onboardingMin = (Date.now() - t0) / 60000;
    console.log(`  zavedení trvalo ${S.onboardingMin.toFixed(1)} min`);
}

async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

let dmCounter = 0;
async function uploadDoc(user, d, M) {
    const fp = path.join(M.dir, d.file);
    let fileName = path.basename(d.file), buf;
    let dmID = null;
    if (d.zfo) {
        dmID = String(7100000 + (++dmCounter) + (O.seed % 1000) * 1000);
        buf = zfoFor(d, fs.readFileSync(fp, 'utf8'), dmID);
        fileName = `DZ_${dmID}.zfo`;
    } else buf = fs.readFileSync(fp);
    const r = await post(user, d.zfo ? 'prijem_zfo' : (d.phase === 'den' ? 'prijem_dokument' : 'digitalizace'), '/api/inbox/upload',
        { fileName, base64: buf.toString('base64') }, { timeout: 600000 });
    S.uploaded[d.file] = { storedName: (r.json && r.json.fileName) || fileName, status: r.status, dmID, ms: r.ms,
        attachments: r.json && r.json.files ? r.json.files.map(f => f.file || f.relativePath || f.name).filter(Boolean) : null };
    // Smlouva od klienta nemá sp. zn. → asistentka ji ručně zařadí do spisu (Nezařazené → Zařadit).
    // Do té doby je to „podatelna“ a v doručené poště / vyhledávání ji vidí všichni.
    if (d.kind === 'smlouva' && d.spisZn && ok2(r.status) && S.spisByZn[d.spisZn]) {
        const un = await get(user, 'nezarazene', '/api/spisy/unfiled');
        const f = ((un.json && un.json.files) || []).find(x => x.fileName === S.uploaded[d.file].storedName || x.id === S.uploaded[d.file].storedName || x.relativePath === S.uploaded[d.file].storedName);
        const as = f ? await post(user, 'zarazeni_do_spisu', `/api/spisy/${S.spisByZn[d.spisZn].id}/assign-file`, { fileId: f.id }) : null;
        S.uploaded[d.file].assigned = !!(as && ok2(as.status));
        S.assign = S.assign || { ok: 0, fail: [] };
        if (S.uploaded[d.file].assigned) S.assign.ok++; else S.assign.fail.push(`${d.file}: ${f ? as.status + ' ' + short(as.text, 80) : 'není mezi nezařazenými'}`);
    }
    return r;
}

// Ověření zpracování: zařazení do spisu, lhůta, doručení — vůči očekávání z manifestu
async function verifyDocs(docs, id, label) {
    const inbox = await get('admin', 'inbox_all', '/api/inbox/all', { timeout: 300000 });
    const items = (inbox.json && (inbox.json.inbox || inbox.json.files)) || [];
    const find = d => {
        const u = S.uploaded[d.file]; if (!u) return null;
        if (u.dmID) return items.find(it => it.isds && String(it.isds.dmID) === u.dmID);
        return items.find(it => it.fileName === u.storedName || it.relativePath === u.storedName);
    };
    const st = { n: 0, nalezeno: 0, spzn: [0, 0], lhutaDni: [0, 0], doruceni: [0, 0], konecLhuty: [0, 0], ocr: [0, 0], chyby: [] };
    for (const d of docs) {
        if (!S.uploaded[d.file]) continue;
        st.n++;
        const it = find(d);
        if (!it) { st.chyby.push(`${d.file}: v doručené poště chybí`); continue; }
        st.nalezeno++;
        d._item = it;
        const e = d.expect || {};
        const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (e.caseNumber) { st.spzn[1]++; if (norm(it.caseNumber) === norm(e.caseNumber)) st.spzn[0]++; else st.chyby.push(`${d.file}: sp. zn. „${it.caseNumber}“ ≠ „${e.caseNumber}“`); }
        if (e.deadlineDays) { st.lhutaDni[1]++; if (Number(it.deadlineDays) === e.deadlineDays) st.lhutaDni[0]++; else st.chyby.push(`${d.file}: lhůta ${it.deadlineDays} ≠ ${e.deadlineDays} dnů`); }
        if (e.deliveryDate) { st.doruceni[1]++; if (it.deliveryDate === e.deliveryDate) st.doruceni[0]++; else st.chyby.push(`${d.file}: doručeno ${it.deliveryDate} ≠ ${e.deliveryDate}`); }
        if (e.deadlineDate) { st.konecLhuty[1]++; if (it.deadlineDate === e.deadlineDate) st.konecLhuty[0]++; else st.chyby.push(`${d.file}: konec lhůty ${it.deadlineDate} ≠ ${e.deadlineDate}`); }
        if (e.ocr) { st.ocr[1]++; if (e.caseNumber && norm(it.caseNumber) === norm(e.caseNumber)) st.ocr[0]++; }
    }
    const pct = ([a, b]) => b ? `${a}/${b} (${Math.round(a / b * 100)} %)` : '—';
    const rate = ([a, b]) => b ? a / b : 1;
    check(id + 'a', `Dokumenty ${label} jsou v doručené poště`, st.nalezeno === st.n, { severity: 'high', detail: `${st.nalezeno}/${st.n}` });
    check(id + 'b', `Zařazení do spisu podle sp. zn. ${label}`, rate(st.spzn) >= 0.95, { severity: 'high', detail: pct(st.spzn) });
    check(id + 'c', `Délka lhůty rozpoznána ${label}`, rate(st.lhutaDni) >= 0.9, { severity: 'high', detail: pct(st.lhutaDni) });
    check(id + 'd', `Datum doručení ${label}`, rate(st.doruceni) >= 0.9, { severity: 'high', detail: pct(st.doruceni) });
    if (st.konecLhuty[1]) check(id + 'e', `Konec lhůty (pracovní den) ${label}`, rate(st.konecLhuty) >= 0.9, { severity: 'high', detail: pct(st.konecLhuty) });
    if (st.ocr[1]) check(id + 'f', `Skeny (OCR) — sp. zn. přečtena ${label}`, rate(st.ocr) >= 0.8, { severity: 'medium', detail: pct(st.ocr) });
    (S.docErrors = S.docErrors || []).push(...st.chyby.map(c => `${label}: ${c}`));
    return st;
}

// ─── hodnocení agentů ────────────────────────────────────────────────────────
// Vzory rizik ze starších datových sad rozšířené o rovnocenné formulace (běh 28. 10. 2026: kontrolor
// správně napsal „vzdání se práv z vadného plnění“, vzor chtěl jen „vyloučení / odpovědnost za vady“).
const RX_ALIAS = { 'vylu[čc]|odpov[eě]dnost za vad': 'vylu[čc]|odpov[eě]dnost za vad|pr[áa]v\\S* z vadn\\S* pln[ěe]n' };
const rx = s => new RegExp(RX_ALIAS[s] || s, 'iu');
function scoreCase(c, resp) {
    const miss = [], hit = [];
    for (const p of c.must || []) if (!rx(p).test(resp)) miss.push(p);
    if (c.anyOf && !c.anyOf.some(p => rx(p).test(resp))) miss.push('anyOf(' + c.anyOf.join(' | ') + ')');
    for (const p of c.mustNot || []) if (p !== '__TOKEN__' && rx(p).test(resp)) hit.push(p);
    const total = (c.must || []).length + (c.anyOf ? 1 : 0) + (c.mustNot || []).filter(p => p !== '__TOKEN__').length;
    return { miss, hit, score: total ? (total - miss.length - hit.length) / total : 1, pass: !miss.length && !hit.length };
}
const simulated = (r, resp) => /Simulovan/i.test((r.json && r.json.model) || '') || /ZAD[AÁ]N[IÍ] NEBYLO ZPRACOV/i.test(resp);

async function runAgent(user, kind, agent, body, grade) {
    const r = await post(user, 'agent_' + kind, `/api/agent/${agent}`, Object.assign({}, body, O.model ? { model: O.model } : {}));
    const resp = (r.json && r.json.response) || '';
    const g = grade ? grade(resp, r) : { pass: ok2(r.status) && resp.length > 80, score: resp.length > 80 ? 1 : 0 };
    const run = Object.assign({ id: body._caseId || `OD-${kind}-${agentRuns.length + 1}`, attempt: 1, at: clock(), user, role: U[user].role, kind, agent,
        status: r.status, ms: r.ms, simulated: simulated(r, resp), prompt: body.prompt, response: resp,
        draftId: r.json && r.json.draft && r.json.draft.id, citations: r.json && r.json.citationCheck ? summarizeCit(r.json.citationCheck) : null }, g);
    run.pass = run.pass && ok2(r.status) && !run.simulated;
    // Dotaz přerušený plánovaným restartem v poledne (běh 29. 10.: 2× „socket hang up“) není chyba modelu —
    // do kvality AI se nepočítá, v souhrnu je zvlášť.
    if (r.restart && !ok2(r.status)) run.restart = true;
    // Kde se dotaz zpracoval (K7b): cloud / lokálně, důvod odepření, odhad ceny.
    const cp = r.json && r.json.cloudPolicy;
    run.cloud = !!(r.json && r.json.modelUsed && r.json.modelUsed.cloud);
    run.t0 = Date.now() - r.ms; run.t1 = Date.now();
    run.verejne = body.dataClass === 'verejne';
    if (cp && !cp.cloud && cp.code) run.cloudOdepreno = cp.code;
    if (cp && cp.naklady && typeof cp.naklady.odhadUsd === 'number') run.cloudUsd = cp.naklady.odhadUsd;
    delete run._caseId;
    agentRuns.push(run);
    return { r, run };
}
function summarizeCit(cc) {
    const items = cc.items || cc.citations || [];
    // Verifier značí ověření polem `verified` (stavy verified / verified_by_source); dřív se tu hledaly
    // neexistující stavy „unverified/missing“ → neověřené citace se v souhrnu nepočítaly.
    const bad = items.filter(i => i && (typeof i.verified === 'boolean' ? !i.verified : (i.status === 'unverified' || i.status === 'missing' || i.ok === false)));
    const mimo = items.filter(i => i && i.outsideContext);
    return { celkem: items.length, neovereno: bad.length, mimoPodklady: mimo.length, mimo: [...new Set(mimo.map(i => i.raw))].slice(0, 5) };
}

// ─── 1: den ──────────────────────────────────────────────────────────────────
const HOUR_W = [1.5, 1.4, 1.2, 1.0, 0.45, 0.9, 1.1, 1.0, 0.6]; // 8–9 … 16–16:30
function schedule(rate, R, fromMin = 0, toMin = 510) {
    // Poissonovský proces s denním profilem: rate = akcí za hodinu v průměrné hodině
    const out = [];
    for (let m = fromMin; m < toMin; m++) {
        const w = HOUR_W[Math.min(8, Math.floor(m / 60))];
        if (R() < rate * w / 60) out.push(m + R());
    }
    return out;
}

function buildPlan(M, R) {
    const ev = []; // { min, user, kind, arg }
    let denDocs = M.dokumenty.filter(d => d.phase === 'den');
    if (O.maxDen) denDocs = denDocs.slice(0, O.maxDen);
    for (const d of denDocs) ev.push({ min: d.t, user: 'podatelna', kind: 'prijem', arg: d });
    M.noveSpisy.forEach((s, i) => ev.push({ min: s.t != null ? s.t : 60 + Math.round((i + 0.5) * 360 / M.noveSpisy.length), user: ASIST[i % ASIST.length], kind: 'nova_vec', arg: s }));
    const roles = {
        advokat: [['resersnik_spis', 1.2], ['resersnik_obecne', 0.7], ['kontrola_smlouvy', 0.5], ['koncept', 0.4], ['otevrit_spis', 4], ['lhutnik', 1],
            ['koncepty_schvalit', 0.6], ['hledani', 0.6], ['kalendar', 1], ['odpoved_klientovi', 0.4], ['cizi_spis', 0.25]],
        koncipient: [['resersnik_spis', 1.2], ['resersnik_obecne', 1], ['koncept', 1], ['anonymizace', 0.4], ['citace', 0.4], ['otevrit_spis', 3], ['vysvetleni_klientovi', 0.3]],
        asistent: [['kalendar_rezervace', 1], ['fakturace', 0.4], ['lhutnik', 1.2], ['otevrit_spis', 2], ['schuzka_dotaz', 0.3], ['korespondence', 0.6]]
    };
    for (const u of Object.values(U)) {
        for (const [kind, rate] of roles[u.role] || []) for (const m of schedule(rate * O.intenzita, R)) ev.push({ min: m, user: u.key, kind });
    }
    if (KONC.length) ev.push({ min: 300, user: KONC[0], kind: 'schvalit_bez_opravneni' });
    ev.push({ min: 120, user: 'admin', kind: 'readiness' });
    if (O.cloud) {
        ev.push({ min: 300, user: 'admin', kind: 'cloud_odvolani' });   // 13:00 klienti odvolají souhlas
        ev.push({ min: 420, user: 'admin', kind: 'cloud_strop_on' });   // 15:00 vyčerpaný rozpočet s tvrdým stropem
        ev.push({ min: 450, user: 'admin', kind: 'cloud_strop_off' });  // 15:30 rozpočet navýšen
    }
    return ev.sort((a, b) => a.min - b.min);
}

function pickSpis(user, R, needWrite) {
    const zns = Object.keys(S.spisByZn).filter(zn => needWrite ? writable(user, zn) : readable(user, zn));
    return zns.length ? R.pick(zns) : null;
}

async function act(ev, M, R) {
    const u = ev.user;
    switch (ev.kind) {
        case 'prijem': {
            const d = ev.arg;
            await uploadDoc(pickAsist(), d, M);
            return;
        }
        case 'nova_vec': {
            const s = ev.arg;
            const cf = await post(u, 'stret_zajmu', '/api/conflicts/check', { clientName: s.klient, counterpartyName: s.protistrana });
            const rep = (cf.json && cf.json.report) || {};
            // high/medium = střet hlášen; unknown = prověření se nezdařilo (nelze vyloučit) → asistentka nezakládá
            const level = String(rep.riskLevel || '');
            const flagged = level === 'high' || level === 'medium';
            const rec = { spisZn: s.spisZn, expectConflict: !!s.expectConflict, flagged, riskLevel: level || null, ms: cf.ms };
            if (level === 'none' || level === 'low') {
                const cr = await post(u, 'spis_novy', '/api/spisy', { spisZn: s.spisZn, nazev: s.nazev, klient: s.klient, protistrana: s.protistrana, soud: s.soud, odpovednyAdvokat: s.advokat, agenda: s.agenda });
                rec.created = cr.status;
                if (cr.json && cr.json.spis) {
                    S.spisByZn[s.spisZn] = { id: cr.json.spis.id, ownerKey: keyOfName(s.advokat) || u, row: s, novy: true };
                    S.shared[s.spisZn] = {};
                    // zakladatelka (asistentka) dostane automaticky úroveň podatelna: spis vidí, nemění ho
                    const vis = await get(u, 'otevrit_spis', `/api/spisy/${cr.json.spis.id}`, { expect: [200, 403] });
                    rec.asistentkaVidi = vis.status;
                    const upr = await call(u, 'spis_uprava_podatelna', 'PATCH', `/api/spisy/${cr.json.spis.id}`, { poznamka: 'pokus o úpravu' }, { expect: [403] });
                    rec.asistentkaUpravi = upr.status;
                    if (vis.status === 200) S.shared[s.spisZn][u] = 'podatelna';
                }
            }
            S.nove.push(rec);
            return;
        }
        case 'resersnik_spis': {
            const zn = pickSpis(u, R); if (!zn) return;
            const row = S.spisByZn[zn].row;
            const q = R.pick([
                `Shrň stav věci ${zn} a navrhni další procesní postup.`,
                `Jaké lhůty běží ve věci ${zn} a co z nich plyne pro klienta ${row.klient}?`,
                `Na co se zaměřit v odvolání ve věci ${zn} (${row.predmet})? Uveď relevantní ustanovení.`,
                `Připrav podklady pro poradu ke spisu ${zn}: strany, předmět, poslední písemnosti.`]);
            await runAgent(u, 'resersnik_spis', 'resersnik', Object.assign({ prompt: q, ragFilters: { caseNumber: zn } }, O.cloud ? { caseNumber: zn } : {}),
                (resp, r) => ({ pass: ok2(r.status) && resp.length > 150, score: resp.length > 150 ? 1 : 0, spisZn: zn,
                    zminkaSpisu: resp.includes(zn) || resp.includes(row.klient) }));
            return;
        }
        case 'resersnik_obecne': {
            const pool2 = S.cases.filter(c => c.agent === 'resersnik' && !c.doc);
            if (!pool2.length) return;
            const c = R.pick(pool2);
            await runAgent(u, 'resersnik_obecne', 'resersnik', Object.assign({ prompt: c.prompt, _caseId: c.id }, O.cloud ? { dataClass: 'verejne' } : {}), resp => scoreCase(c, resp));
            return;
        }
        case 'kontrola_smlouvy': {
            const cands = M.dokumenty.filter(d => d.kind === 'smlouva' && S.uploaded[d.file] && (!d.spisZn || readable(u, d.spisZn)));
            if (!cands.length) return;
            const d = R.pick(cands);
            const c = await get(u, 'dokument_obsah', '/api/inbox/content?fileName=' + encodeURIComponent(S.uploaded[d.file].storedName));
            const text = (c.json && (c.json.content || c.json.text)) || '';
            if (!text) return;
            const rizika = (d.expect && d.expect.rizika) || [];
            await runAgent(u, 'kontrola_smlouvy', 'kontrolor', { prompt: 'Zkontroluj přiloženou smlouvu pro našeho klienta (objednatele). Vypiš rizika a nevyvážená ustanovení s odkazem na článek a zákon.', context: text },
                resp => { const found = rizika.filter(p => rx(p).test(resp)); return { pass: found.length >= Math.ceil(rizika.length * 0.67), score: rizika.length ? found.length / rizika.length : 1, rizika: `${found.length}/${rizika.length}`, chybi: rizika.filter(p => !found.includes(p)), doc: d.file }; });
            return;
        }
        case 'koncept': {
            const zn = pickSpis(u, R, true); if (!zn) return;
            const row = S.spisByZn[zn].row;
            const typ = R.pick(['předžalobní výzvu k zaplacení', 'vyjádření k žalobě', 'žádost o odročení jednání', 'odvolání proti rozsudku (blanketní)']);
            const { r } = await runAgent(u, 'koncept', 'spisovatel', { prompt: `Sepiš ${typ} ve věci ${zn} (${row.predmet}). Klient: ${row.klient}, protistrana: ${row.protistrana}, soud: ${row.soud}. Chybějící údaje označ [Doplnit].`,
                saveDraft: true, spisId: S.spisByZn[zn].id, draftTitle: `${typ} – ${zn}` },
                (resp, rr) => ({ pass: ok2(rr.status) && !!(rr.json && rr.json.draft && rr.json.draft.id), score: rr.json && rr.json.draft ? 1 : 0, spisZn: zn }));
            if (r.json && r.json.draft && r.json.draft.id) S.drafts.push({ id: r.json.draft.id, spisZn: zn, author: u, status: r.json.draft.status || 'ke_kontrole' });
            return;
        }
        case 'koncepty_schvalit': {
            const mine = S.drafts.filter(d => d.status !== 'schvaleno' && S.spisByZn[d.spisZn] && S.spisByZn[d.spisZn].ownerKey === u);
            if (!mine.length) { await get(u, 'koncepty', '/api/drafts'); return; }
            const d = mine[0];
            const dd = await get(u, 'koncept_otevrit', '/api/drafts/' + d.id);
            await post(u, 'koncept_pripominka', `/api/drafts/${d.id}/comments`, { text: 'Doplnit přesné vyčíslení příslušenství.' });
            const ap = await post(u, 'koncept_schvalit', `/api/drafts/${d.id}/status`, { status: 'schvaleno' });
            if (ok2(ap.status)) d.status = 'schvaleno'; else d.approveError = `${ap.status} ${short(ap.text, 80)}`;
            d.openStatus = dd.status;
            return;
        }
        case 'schvalit_bez_opravneni': {
            let d = S.drafts.find(x => x.status !== 'schvaleno' && writable(u, x.spisZn));
            if (!d) {
                // koncipient si koncept napíše sám (bez AI) a zkusí ho schválit
                const zn = pickSpis(u, R, true);
                const c = zn ? await post(u, 'koncept_rucne', '/api/drafts', { title: `Vyjádření – ${zn}`, text: 'VYJÁDŘENÍ ŽALOVANÉHO\nNávrh koncipienta ke kontrole.', spisId: S.spisByZn[zn].id }) : null;
                if (!c || !ok2(c.status) || !c.json || !c.json.id) { S.koncipientApprove = 'koncept nešlo založit'; return; }
                d = { id: c.json.id, spisZn: zn, author: u, status: c.json.status || 'koncept' }; S.drafts.push(d);
            }
            const ap = await post(u, 'koncept_schvalit_koncipient', `/api/drafts/${d.id}/status`, { status: 'schvaleno' }, { expect: [403] });
            S.koncipientApprove = ap.status;
            return;
        }
        case 'otevrit_spis': {
            const zn = pickSpis(u, R); if (!zn) { await get(u, 'spisy_list', '/api/spisy'); return; }
            const id = S.spisByZn[zn].id;
            await get(u, 'otevrit_spis', `/api/spisy/${id}`);
            if (R.chance(0.5)) await get(u, 'spis_timeline', `/api/spisy/${id}/timeline`);
            return;
        }
        case 'cizi_spis': {
            // advokát zkusí otevřít spis kolegy, který mu NENÍ sdílen → 403; sdílený ke čtení → 200
            const foreign = Object.keys(S.spisByZn).filter(zn => S.spisByZn[zn].ownerKey !== u && !S.spisByZn[zn].novy);
            const zn = R.pick(foreign); if (!zn) return;
            const exp = readable(u, zn) ? [200] : [403];
            const r = await get(u, 'cizi_spis', `/api/spisy/${S.spisByZn[zn].id}`, { expect: exp });
            (S.aclProbes = S.aclProbes || []).push({ user: u, spisZn: zn, expected: exp[0], got: r.status });
            return;
        }
        case 'korespondence': {
            // asistentka (podatelna) připraví se Spisovatelem rutinní dopis → ke schválení advokátovi
            if (!S.korespondence || !(S.korTypy || []).length) return;
            const zn = pickSpis(u, R); if (!zn) return;
            const row = S.spisByZn[zn].row;
            const typ = R.pick(S.korTypy);
            const zad = { doplneni_podkladu: 'Potřebujeme kopii smlouvy, faktury a veškerou korespondenci s protistranou do 14 dnů.', pruvodni_dopis: `Zasíláme kopii písemnosti od soudu (${row.soud}).`,
                termin_schuzky: 'Potvrzení schůzky ve čtvrtek ve 14:00 v kanceláři, přinést občanský průkaz.', upominka_faktury: 'Faktura č. 2026-118 na 12 100 Kč, splatná před 14 dny.',
                informace_dosla_pisemnost: `Došla písemnost od ${row.soud}.` }[typ] || '';
            const { r, run } = await runAgent(u, 'korespondence', 'spisovatel', { prompt: `${zad} Klient: ${row.klient}, věc ${zn}.`, korespondence: typ, saveDraft: true, spisId: S.spisByZn[zn].id },
                (resp, rr) => { const dr = rr.json && rr.json.draft; return { pass: ok2(rr.status) && !!(dr && dr.id) && dr.status === 'ke_kontrole', score: dr && dr.id ? 1 : 0, typ, spisZn: zn,
                    pravniObsah: /§\s*\d|doporučuj(?:eme|i)\s+podat/i.test(resp) }; });
            if (r.json && r.json.draft && r.json.draft.id) S.drafts.push({ id: r.json.draft.id, spisZn: zn, author: u, status: r.json.draft.status || 'ke_kontrole', korespondence: typ });
            return;
        }
        case 'lhutnik': await get(u, 'lhutnik', '/api/lhutnik'); return;
        case 'kalendar': await get(u, 'kalendar', '/api/calendar/events'); return;
        case 'hledani': {
            const zn = pickSpis(u, R); if (!zn) return;
            await get(u, 'hledani', '/api/rag/search?query=' + encodeURIComponent(S.spisByZn[zn].row.predmet) + '&caseNumber=' + encodeURIComponent(zn));
            return;
        }
        case 'odpoved_klientovi': case 'schuzka_dotaz': {
            const cands = M.dokumenty.filter(d => d.kind === 'email' && S.uploaded[d.file] && d.spisZn && readable(u, d.spisZn));
            if (!cands.length) return;
            const d = R.pick(cands);
            const c = await get(u, 'dokument_obsah', '/api/inbox/content?fileName=' + encodeURIComponent(S.uploaded[d.file].storedName));
            const text = (c.json && (c.json.content || c.json.text)) || '';
            await runAgent(u, 'odpoved_klientovi', 'sekretarka', { prompt: 'Navrhni krátkou odpověď klientovi na tento e-mail (k odeslání až po schválení advokátem).', context: text, ragFilters: { caseNumber: d.spisZn } });
            return;
        }
        case 'vysvetleni_klientovi': {
            const zn = pickSpis(u, R); if (!zn) return;
            await runAgent(u, 'vysvetleni', 'stylista', { prompt: `Vysvětli klientovi srozumitelně (2 odstavce, bez právnického žargonu), co znamená doručený rozsudek a lhůta k odvolání ve věci ${zn}.`, ragFilters: { caseNumber: zn } });
            return;
        }
        case 'anonymizace': {
            const zn = pickSpis(u, R); if (!zn) return;
            const row = S.spisByZn[zn].row;
            const r = await post(u, 'anonymizace', '/api/document/anonymize', { text: `Žalobce ${row.klient}, bytem ${'Masarykova 12, Jihlava'}, tel. 603 123 456, e-mail klient@example.cz, proti ${row.protistrana}.` });
            (S.anon = S.anon || []).push({ ok: ok2(r.status) && r.json && !String(JSON.stringify(r.json)).includes('603 123 456') });
            return;
        }
        case 'citace': await post(u, 'citace', '/api/citations/verify', { text: 'Podle § 2051 zákona č. 89/2012 Sb. a § 204 o. s. ř. a § 9999 zákona č. 89/2012 Sb.' }); return;
        case 'kalendar_rezervace': {
            const day = new Date(Date.parse(M.den) + R.int(1, 10) * 864e5).toISOString().slice(0, 10);
            const zn = pickSpis(u, R);
            await post(u, 'kalendar_rezervace', '/api/calendar/book', { title: `Porada s klientem ${zn || ''}`.trim(), date: day, time: `${R.int(9, 15)}:${R.pick(['00', '30'])}`, durationMin: 60, spisId: zn ? S.spisByZn[zn].id : undefined }, { expect: [201, 409] });
            return;
        }
        case 'fakturace': {
            const zn = pickSpis(u, R); if (!zn) return;
            const row = S.spisByZn[zn].row;
            await post(u, 'fakturace', '/api/fakturace', { klient: row.klient, spisId: S.spisByZn[zn].id, items: [{ popis: `Právní služby ve věci ${zn}`, amount: R.int(2, 30) * 1000 }] });
            return;
        }
        case 'readiness': await get('admin', 'readiness', '/api/readiness'); return;
        case 'cloud_odvolani': {
            // čtvrtina spisů se souhlasem: klient souhlas odvolá (odvolat smí kdokoli se zápisem, platí okamžitě)
            const zns = Object.keys(S.souhlas).filter(z => S.souhlas[z] === true);
            let n = 0;
            for (const zn of zns.filter((z, i) => i % 4 === 0)) {
                const sp = S.spisByZn[zn];
                const r = await post(sp.ownerKey, 'cloud_odvolani', `/api/spisy/${sp.id}/cloud/souhlas/odvolat`, { duvod: 'Simulace: klient odvolal souhlas' });
                if (ok2(r.status)) { S.odvolano[zn] = Date.now(); n++; }
            }
            S.cloudEvents.push({ t: Date.now(), co: `odvolán souhlas u ${n} spisů` });
            return;
        }
        case 'cloud_strop_on': {
            const r = await post('admin', 'ai_strop', '/api/ai-usage/settings', { mesicniRozpocetUsd: 0.01, tvrdyStrop: true });
            if (ok2(r.status)) S.strop = { od: Date.now(), do: null };
            S.cloudEvents.push({ t: Date.now(), co: 'tvrdý strop: rozpočet 0,01 USD', status: r.status });
            return;
        }
        case 'cloud_strop_off': {
            const r = await post('admin', 'ai_strop', '/api/ai-usage/settings', { mesicniRozpocetUsd: 50, tvrdyStrop: false });
            if (S.strop) S.strop.do = Date.now();
            S.cloudEvents.push({ t: Date.now(), co: 'rozpočet zpět 50 USD', status: r.status });
            return;
        }
        default: return;
    }
}

// Prohlížeče uživatelů: periodické dotazy na novinky (jako otevřená aplikace)
function startPolling(stopAt) {
    const timers = [];
    for (const u of Object.values(U)) {
        const tick = async () => {
            if (Date.now() >= stopAt) return;
            await get(u.key, 'poll', '/api/alerts', { timeout: 60000 });
            await get(u.key, 'poll', '/api/activity/today', { timeout: 60000 });
            if (u.role === 'asistent') await get(u.key, 'poll', '/api/inbox', { timeout: 60000 });
        };
        timers.push(setInterval(tick, O.pollS * 1000 * (0.8 + Math.random() * 0.4)));
    }
    // telemetrie serveru každých 10 min (zkráceně úměrně délce dne)
    const telInt = Math.max(30000, dayMs / 51);
    const tel = async () => { const r = await get('admin', 'telemetrie', '/api/system/telemetry', { timeout: 60000 }); telemetry.push({ clock: clock(), data: r.json }); };
    tel(); timers.push(setInterval(tel, telInt));
    return () => timers.forEach(clearInterval);
}

async function snapshot() {
    const sp = await get('admin', 'snapshot', '/api/spisy');
    const ib = await get('admin', 'snapshot', '/api/inbox/all', { timeout: 300000 });
    const dr = await get('admin', 'snapshot', '/api/drafts');
    const arr = j => Array.isArray(j) ? j : (j && (j.drafts || j.items)) || [];
    return { spisy: ((sp.json && sp.json.spisy) || []).length, dokumenty: ((ib.json && (ib.json.inbox || ib.json.files)) || []).length, koncepty: arr(dr.json).length };
}

async function doRestart() {
    console.log(`  ↻ ${clock()} restart serveru: ${O.restartCmd}`);
    S.preRestart = await snapshot();
    const t = Date.now();
    restartWindow = { from: t, to: null };
    try { execSync(O.restartCmd, { stdio: 'ignore', timeout: 300000 }); } catch (e) { S.restartError = e.message; }
    let up = false;
    while (Date.now() - t < 10 * 60000) {
        const r = await request('GET', '/api/status', { token: O.token, timeout: 5000 });
        if (r.status === 200) { up = true; break; }
        await sleep(1000);
    }
    restartWindow.to = Date.now();
    S.restartS = (restartWindow.to - t) / 1000;
    const post2 = await snapshot();
    check('D1', 'Restart serveru v poledne: API zpět a data zachována', up && post2.spisy === S.preRestart.spisy && post2.dokumenty >= S.preRestart.dokumenty && post2.koncepty >= S.preRestart.koncepty,
        { severity: 'critical', detail: `API po ${S.restartS.toFixed(0)} s; před ${JSON.stringify(S.preRestart)} po ${JSON.stringify(post2)}${S.restartError ? ' · ' + S.restartError : ''}` });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function day(M, R) {
    phase = '1';
    console.log(`\n1 — PRACOVNÍ DEN (${O.hours} h reálného času = 8:00–16:30)`);
    dayMs = O.hours * 3600e3;
    dayStart = Date.now();
    const plan = buildPlan(M, R);
    console.log(`  plán: ${plan.length} akcí (${plan.filter(e => e.kind === 'prijem').length} příchozích písemností)`);
    const stopPoll = startPolling(dayStart + dayMs);
    const queues = {}; // uživatel → řetěz slibů (člověk dělá jednu věc po druhé)
    const enqueue = (ev) => {
        const key = ev.user;
        const run = async () => { try { await act(ev, M, R); } catch (e) { ops.push({ phase, at: Date.now() - T0, clock: clock(), user: key, action: 'vyjimka_' + ev.kind, status: 0, ms: 0, ok: false, note: short(e.stack || e.message, 200) }); } };
        queues[key] = (queues[key] || Promise.resolve()).then(run);
    };
    let restartDone = !O.restartCmd;
    let lastLog = 0;
    for (const ev of plan) {
        const due = dayStart + ev.min / 510 * dayMs;
        if (!restartDone && due >= dayStart + (O.restartAt / 8.5) * dayMs) {
            await sleep(Math.max(0, dayStart + (O.restartAt / 8.5) * dayMs - Date.now()));
            await doRestart(); restartDone = true;
        }
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
        enqueue(ev);
        if (Date.now() - lastLog > Math.max(60000, dayMs / 34)) {
            lastLog = Date.now();
            const busy = Object.keys(queues).length;
            const done = ops.filter(o => o.phase === '1');
            console.log(`  ${clock()}  požadavků ${done.length}, chyb ${done.filter(o => !o.ok && !o.restart).length}, agentů ${agentRuns.length}, front ${busy}`);
        }
    }
    if (!restartDone) { await doRestart(); }
    const remaining = dayStart + dayMs - Date.now();
    if (remaining > 0) await sleep(remaining);
    console.log(`  ${clock()} konec pracovní doby — čekám na rozdělanou práci`);
    const tEnd = Date.now();
    await Promise.all(Object.values(queues));
    S.overtimeMin = (Date.now() - tEnd) / 60000;
    stopPoll();
    // nedodělky: kolik akcí skončilo po konci dne (fronta lidí čekajících na AI)
    check('D2', 'Práce dne stihnutá v pracovní době (fronta nepřetekla)', S.overtimeMin < 15, { severity: 'medium', detail: `dobíhání po 16:30: ${S.overtimeMin.toFixed(1)} min` });
}

// ─── 2: konec dne ────────────────────────────────────────────────────────────
async function endOfDay(M) {
    phase = '2';
    console.log('\n2 — KONEC DNE: kontrola dat, oprávnění, chyb');
    let denDocs = M.dokumenty.filter(d => d.phase === 'den');
    if (O.maxDen) denDocs = denDocs.slice(0, O.maxDen);
    await verifyDocs(denDocs, 'K1', 'přijaté během dne');

    // spisy: nové věci, střet zájmů, automaticky vzniklé spisy
    const conflictsOk = S.nove.filter(n => n.expectConflict === n.flagged && n.riskLevel !== 'unknown').length;
    check('K2', 'Kontrola střetu zájmů u nových věcí (střet odhalen, bez falešných poplachů a „nelze prověřit“)', conflictsOk === S.nove.length,
        { severity: 'high', detail: S.nove.map(n => `${n.spisZn}: čekáno ${n.expectConflict ? 'STŘET' : 'ok'}, hlášeno ${n.flagged ? 'STŘET' : 'ok'} (${n.riskLevel})`).join('; ') });
    const created = S.nove.filter(n => n.created && ok2(n.created));
    check('K3', 'Asistentka založila nové spisy (bez střetu)', created.length === S.nove.filter(n => n.riskLevel === 'none' || n.riskLevel === 'low').length, { severity: 'medium', detail: `${created.length} založeno` });
    const asVis = S.nove.filter(n => n.asistentkaVidi);
    if (asVis.length) check('K4', 'Asistentka vidí spis, který založila pro advokáta (podatelna), ale nemění ho', asVis.every(n => n.asistentkaVidi === 200 && n.asistentkaUpravi === 403),
        { severity: 'medium', detail: asVis.map(n => `${n.spisZn}: otevřít ${n.asistentkaVidi}, upravit ${n.asistentkaUpravi}`).join(', ') });
    const sp = await get('admin', 'spisy_list', '/api/spisy');
    const all = (sp.json && sp.json.spisy) || [];
    const unknownZn = new Set(denDocs.filter(d => d.kind === 'neznama' && S.uploaded[d.file]).map(d => d.spisZn));
    const auto = all.filter(s => unknownZn.has(s.spisZn));
    check('K5', 'Písemnost k neznámé věci → automaticky vzniklý spis k zařazení', auto.length === unknownZn.size, { severity: 'low', detail: `${auto.length}/${unknownZn.size}` });
    const keyZn = z => String(z || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const counts = {}; all.forEach(s => { const k = keyZn(s.spisZn); if (k) counts[k] = (counts[k] || 0) + 1; });
    const dup = Object.entries(counts).filter(([, n]) => n > 1).map(([k]) => k);
    const expected = new Set([...M.spisy.map(s => s.spisZn), ...created.map(n => n.spisZn), ...unknownZn].map(keyZn));
    const missingZn = [...expected].filter(k => !counts[k]);
    const extraZn = Object.keys(counts).filter(k => !expected.has(k));
    check('K6', 'Spisy na konci dne: žádné duplicity, nic nechybí, nic navíc', !dup.length && !missingZn.length && !extraZn.length,
        { severity: 'medium', detail: `${all.length} spisů · duplicit ${dup.length} · chybí ${missingZn.length} · navíc ${extraZn.length}${extraZn.length ? ' (' + extraZn.slice(0, 5).join(', ') + ')' : ''}` });
    if (S.assign) check('K6b', 'Smlouvy bez sp. zn. ručně zařazeny do spisu', !S.assign.fail.length, { severity: 'medium', detail: `${S.assign.ok} zařazeno${S.assign.fail.length ? ' · ' + S.assign.fail.slice(0, 3).join('; ') : ''}` });

    // oprávnění: kdo co vidí
    if (O.firm) {
        const leaks = [];
        for (const u of Object.values(U)) {
            const r = await get(u.key, 'spisy_list', '/api/spisy');
            const seen = ((r.json && r.json.spisy) || []).map(s => s.spisZn);
            const expected = Object.keys(S.spisByZn).filter(zn => readable(u.key, zn));
            const extra = seen.filter(zn => S.spisByZn[zn] && !readable(u.key, zn));
            const missing = expected.filter(zn => !seen.includes(zn));
            if (extra.length || missing.length) leaks.push(`${u.name}: navíc ${extra.length}, chybí ${missing.length}`);
            u.seen = seen.length;
        }
        check('K7', 'Seznam spisů každého uživatele = vlastní + sdílené', !leaks.length,
            { severity: 'critical', detail: leaks.join('; ') || Object.values(U).map(u => `${u.name.split(' ').pop()} ${u.seen}`).join(', ') });
        // doručená pošta koncipienta nesmí obsahovat dokumenty nesdílených spisů
        const ib = await get(KONC[0], 'inbox_all', '/api/inbox/all', { timeout: 300000 });
        const items = (ib.json && (ib.json.inbox || ib.json.files)) || [];
        const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const foreign = items.filter(it => { const zn = Object.keys(S.spisByZn).find(z => norm(z) === norm(it.caseNumber)); return zn && !readable(KONC[0], zn); });
        check('K8', 'Doručená pošta koncipienta bez dokumentů cizích spisů', foreign.length === 0, { severity: 'critical', detail: `${items.length} viditelných, cizích ${foreign.length}` });
        // vyhledávání: dotaz na klienta nesdíleného spisu nevrátí jeho dokumenty
        const notShared = Object.keys(S.spisByZn).filter(zn => !readable(KONC[0], zn) && !S.spisByZn[zn].novy);
        let ragLeak = 0, ragTried = 0;
        // jen spisy, ke kterým už je nahraný dokument (jinak není co uniknout)
        const withDocs = notShared.filter(zn => M.dokumenty.some(d => d.spisZn === zn && S.uploaded[d.file]));
        for (const zn of withDocs.slice(0, 8)) {
            const row = S.spisByZn[zn].row;
            const names = M.dokumenty.filter(d => d.spisZn === zn && S.uploaded[d.file]).map(d => S.uploaded[d.file].storedName);
            const r = await get(KONC[0], 'hledani', '/api/rag/search?limit=10&query=' + encodeURIComponent(`${row.klient} ${row.predmet}`));
            ragTried++;
            const matches = (r.json && r.json.matches) || [];
            if (matches.some(m => { const t = JSON.stringify(m); return names.some(n => t.includes(n)) || t.includes(zn); })) ragLeak++;
        }
        check('K9', 'Vyhledávání koncipienta nevrací úryvky z nesdílených spisů', ragLeak === 0, { severity: 'critical', detail: `${ragLeak}/${ragTried} dotazů s únikem` });
        const probes = S.aclProbes || [];
        const badP = probes.filter(p => p.got !== p.expected);
        check('K10', 'Advokát nevidí nesdílený spis kolegy (přímý odkaz)', badP.length === 0, { severity: 'critical', detail: `${probes.length} pokusů, odchylek ${badP.length}${badP.length ? ': ' + badP.slice(0, 3).map(p => `${p.user} ${p.spisZn} ${p.got}`).join(', ') : ''}` });
    }
    // koncepty
    const appr = S.drafts.filter(d => d.status === 'schvaleno');
    check('K11', 'Koncepty od AI vznikly ve spisech a advokáti je schvalují', S.drafts.length > 0 && S.drafts.every(d => !d.approveError),
        { severity: 'high', detail: `vzniklo ${S.drafts.length}, schváleno ${appr.length}${S.drafts.filter(d => d.approveError).map(d => ' · ' + d.approveError).join('')}` });
    if (S.koncipientApprove !== undefined) check('K12', 'Koncipient nesmí schválit koncept (403)', S.koncipientApprove === 403, { severity: 'high', detail: String(S.koncipientApprove) });
    const kor = agentRuns.filter(a => a.kind === 'korespondence');
    if (kor.length) {
        const korDr = S.drafts.filter(d => d.korespondence);
        check('K12b', 'Podatelna připravila korespondenci přes Spisovatele (ke kontrole), advokáti ji schvalují', kor.every(a => a.pass) && korDr.every(d => !d.approveError),
            { severity: 'medium', detail: `${kor.filter(a => a.pass).length}/${kor.length} konceptů, schváleno ${korDr.filter(d => d.status === 'schvaleno').length}, s právním obsahem ${kor.filter(a => a.pravniObsah).length}` });
    }
    if (S.anon && S.anon.length) check('K13', 'Anonymizace odstraní telefon klienta', S.anon.every(a => a.ok), { severity: 'medium', detail: `${S.anon.filter(a => a.ok).length}/${S.anon.length}` });
    // audit
    const vc = await get('admin', 'audit', '/api/audit/verify-chain', { timeout: 300000 });
    check('K14', 'Auditní řetězec po celém dni neporušen', ok2(vc.status) && vc.json && (vc.json.valid === true || vc.json.ok === true), { severity: 'critical', detail: short(vc.text, 160) });
    const tv = await get('admin', 'audit', '/api/audit/transparency/verify', { timeout: 300000 });
    check('K15', 'Záznamy transparentnosti AI neporušeny', ok2(tv.status) && tv.json && (tv.json.valid === true || tv.json.ok === true), { severity: 'high', detail: short(tv.text, 160) });
    // kdo je přihlášen: /api/me každého účtu = jeho jméno a role (hlavička dashboardu)
    const meOk = [];
    for (const u of Object.values(U)) { const r = await get(u.key, 'me', '/api/me'); meOk.push(!!(r.json && r.json.name === u.name && r.json.role === u.role && r.json.kind === 'user')); }
    if (O.cloud) {
        // K21: do cloudu jen veřejné dotazy a spisy se souhlasem klienta — nic jiného (mlčenlivost).
        const done = agentRuns.filter(r => ok2(r.status));
        // smí do cloudu: veřejný dotaz, nebo spis se souhlasem, který není stupně A a nebyl před dotazem odvolán
        const smi = r => r.verejne || (r.spisZn && S.souhlas[r.spisZn] === true && !S.stupenA[r.spisZn]
            && !(S.odvolano[r.spisZn] && S.odvolano[r.spisZn] <= r.t0));
        const poruseni = done.filter(r => r.cloud && !smi(r));
        check('K21a', 'Do cloudu nic bez souhlasu klienta, nic ze spisu stupně A ani po odvolání souhlasu, nic neznámého původu', poruseni.length === 0,
            { severity: 'critical', detail: `${poruseni.length} porušení z ${done.length}${poruseni.length ? ': ' + poruseni.slice(0, 5).map(r => `${r.kind} ${r.spisZn || ''}`).join(', ') : ''}` });
        const ver = done.filter(r => r.verejne);
        check('K21b', 'Obecné dotazy (bez klientských dat) odpověděl cloudový model', !ver.length || ver.filter(r => r.cloud).length / ver.length >= 0.8,
            { severity: 'medium', detail: `${ver.filter(r => r.cloud).length}/${ver.length} v cloudu; odepřeno: ${[...new Set(ver.filter(r => !r.cloud).map(r => r.cloudOdepreno).filter(Boolean))].join(', ') || '—'}` });
        const sou = done.filter(r => r.spisZn && S.souhlas[r.spisZn]);
        const usd = done.reduce((a, r) => a + (r.cloudUsd || 0), 0);
        const vA = done.filter(r => r.spisZn && S.stupenA[r.spisZn]);
        check('K21d', 'Spisy stupně A nikdy v cloudu (ani se zaznamenaným souhlasem)', !vA.some(r => r.cloud) && S.cloudA && S.cloudA.aFail === 0,
            { severity: 'critical', detail: `${vA.length} dotazů na spisy A, v cloudu ${vA.filter(r => r.cloud).length}; nastavení A chyb ${S.cloudA ? S.cloudA.aFail : '?'}; pokus o souhlas u A → ${S.cloudA ? S.cloudA.aSouhlas.join(',') : '?'}` });
        const poOdv = done.filter(r => r.spisZn && S.odvolano[r.spisZn] && r.t0 >= S.odvolano[r.spisZn]);
        check('K21e', 'Po odvolání souhlasu klientem už nic do cloudu', !poOdv.some(r => r.cloud),
            { severity: 'critical', detail: `odvoláno ${Object.keys(S.odvolano).length} spisů; dotazů po odvolání ${poOdv.length}, v cloudu ${poOdv.filter(r => r.cloud).length}` });
        if (S.strop) {
            const vOkne = done.filter(r => r.t0 >= S.strop.od && (!S.strop.do || r.t1 <= S.strop.do));
            check('K21f', 'Tvrdý strop rozpočtu: v okně nic do cloudu, po navýšení zase ano', !vOkne.some(r => r.cloud),
                { severity: 'high', detail: `v okně ${vOkne.length} dotazů, v cloudu ${vOkne.filter(r => r.cloud).length}, odepřeno kvůli rozpočtu ${vOkne.filter(r => r.cloudOdepreno === 'rozpocet').length}; po navýšení v cloudu ${done.filter(r => S.strop.do && r.t0 > S.strop.do && r.cloud).length}` });
        }
        const sumR = await get('admin', 'ai_souhrn', '/api/ai-usage/summary');
        const logs = await get('admin', 'audit_logs', '/api/audit/logs');
        const vCloudu = done.filter(r => r.cloud).length;
        const auditOdeslano = ((logs.json && logs.json.logs) || []).filter(l => l.operation === 'Dotaz odeslán do cloudu').length;
        const evid = sumR.json || {};
        const evidDotazu = (evid.poModelech || evid.modely || []).reduce ? (evid.poModelech || evid.modely || []).reduce((a, x) => a + (x.dotazu || 0), 0) : null;
        check('K21g', 'Každý dotaz v cloudu je v auditu a v evidenci spotřeby', auditOdeslano >= vCloudu && (evidDotazu == null || evidDotazu >= vCloudu),
            { severity: 'high', detail: `odpovědí z cloudu ${vCloudu}; audit „Dotaz odeslán do cloudu“ ${auditOdeslano}; evidence spotřeby ${evidDotazu == null ? '?' : evidDotazu} dotazů, odhad ${evid.celkem != null ? evid.celkem + ' USD' : '?'}` });
        check('K21c', 'Spisy se souhlasem klienta mohou do cloudu (informativně)', true,
            { severity: 'low', detail: `${sou.filter(r => r.cloud).length}/${sou.length} v cloudu (ostatní odepřeno kvůli podkladům z jiných spisů); celkem v cloudu ${done.filter(r => r.cloud).length}/${done.length}, odhad ${usd.toFixed(2)} USD` });
    }
    check('K19', 'Hlavička dashboardu: každý účet vidí sebe (jméno, role)', meOk.every(Boolean), { severity: 'high', detail: `${meOk.filter(Boolean).length}/${meOk.length}` });
    // další zařízení: párovací odkaz pro dashboard → přihlášení tímto účtem → zrušení zařízení
    const adv = Object.values(U).find(u => u.role === 'advokat');
    const pr = await post(adv.key, 'pripojit_zarizeni', '/api/pair/new', { deviceLabel: 'Notebook doma (simulace)' });
    let devOk = false, devDetail = String(pr.status);
    if (ok2(pr.status) && pr.json && pr.json.code && (pr.json.dashboardUrls || [])[0]) {
        const cl = await request('POST', '/api/pair/claim', { body: { code: pr.json.code } });
        const tok2 = cl.json && cl.json.token;
        const me2 = tok2 ? await request('GET', '/api/me', { token: tok2 }) : { json: null };
        const again = await request('POST', '/api/pair/claim', { body: { code: pr.json.code } });
        const devId = me2.json && me2.json.deviceId;
        const rv = devId ? await call(adv.key, 'zrusit_zarizeni', 'DELETE', `/api/me/devices/${encodeURIComponent(devId)}`) : { status: 0 };
        const after2 = tok2 ? await request('GET', '/api/me', { token: tok2 }) : { status: 0 };
        devOk = !!(me2.json && me2.json.name === adv.name && me2.json.device === 'Notebook doma (simulace)') && again.status === 404 && ok2(rv.status) && after2.status === 401;
        devDetail = `odkaz ${/\?pair=/.test(pr.json.dashboardUrls[0]) ? 'ok' : '?'} · přihlášen ${me2.json && me2.json.name} (${me2.json && me2.json.device}) · podruhé ${again.status} · zrušení ${rv.status} → ${after2.status}`;
    }
    check('K20', 'Připojení dalšího zařízení odkazem (dashboard), přihlášení vlastním účtem, zrušení zařízení', devOk, { severity: 'high', detail: devDetail });
    // odchod zaměstnance: deaktivace účtu → token přestane platit
    const da = await call('admin', 'users_disable', 'PATCH', `/api/users/${U[KONC[0]].id}`, { disabled: true });
    const after = await get(KONC[0], 'spisy_list', '/api/spisy', { expect: [401, 403] });
    check('K16', 'Deaktivovaný uživatel se už nepřihlásí', ok2(da.status) && (after.status === 401 || after.status === 403), { severity: 'critical', detail: `${da.status} → ${after.status}` });
    // chyby a odezvy
    const dayOps = ops.filter(o => o.phase === '1' && !o.restart);
    const e5 = dayOps.filter(o => o.status >= 500 || o.status === 0);
    check('K17', 'Během dne žádné chyby serveru (5xx / spadlé spojení)', e5.length === 0,
        { severity: e5.length > 5 ? 'high' : 'medium', detail: `${e5.length} z ${dayOps.length}${e5.length ? ': ' + summarizeErrors(e5) : ''}` });
    const rt = dayOps.filter(o => o.retried);
    check('K17b', 'Žádná přerušená spojení (čtení opakováno klientem)', rt.length === 0,
        { severity: 'low', detail: `${rt.length} z ${dayOps.length}${rt.length ? ': ' + summarizeErrors(rt.map(o => Object.assign({}, o, { status: 0, note: o.retried }))) : ''}` });
    const e4 = dayOps.filter(o => !o.ok && o.status >= 400 && o.status < 500);
    check('K18', 'Během dne žádné neočekávané odmítnutí (4xx)', e4.length === 0, { severity: 'medium', detail: `${e4.length}${e4.length ? ': ' + summarizeErrors(e4) : ''}` });
}
function summarizeErrors(list) {
    const by = {};
    list.forEach(o => { const k = `${o.action} ${o.status}`; by[k] = by[k] || { n: 0, note: o.note }; by[k].n++; });
    return Object.entries(by).sort((a, b) => b[1].n - a[1].n).slice(0, 6).map(([k, v]) => `${k} ×${v.n} (${short(v.note, 60)})`).join('; ');
}

// ─── report ──────────────────────────────────────────────────────────────────
const pctl = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const fmtS = ms => ms == null ? '—' : (ms >= 10000 ? (ms / 1000).toFixed(0) : (ms / 1000).toFixed(1)) + ' s';

function writeReport(meta) {
    fs.mkdirSync(O.out, { recursive: true });
    const stamp = new Date(T0).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = path.join(O.out, `office_day_${stamp}_${O.label}`);
    const dayOps = ops.filter(o => o.phase === '1');
    const byAction = {};
    dayOps.forEach(o => { (byAction[o.action] = byAction[o.action] || []).push(o); });
    const actRows = Object.entries(byAction).sort((a, b) => b[1].length - a[1].length).map(([a, l]) => {
        const ms = l.filter(o => o.ok).map(o => o.ms);
        return { action: a, n: l.length, chyby: l.filter(o => !o.ok && !o.restart).length, p50: pctl(ms, 50), p95: pctl(ms, 95), max: ms.length ? Math.max(...ms) : null };
    });
    const hours = [];
    for (let h = 8; h <= 16; h++) {
        const l = dayOps.filter(o => o.clock && parseInt(o.clock, 10) === h);
        const ag = l.filter(o => o.action.startsWith('agent_') && o.ok).map(o => o.ms);
        hours.push({ hodina: `${h}:00`, pozadavku: l.length, chyb: l.filter(o => !o.ok && !o.restart).length, agentu: ag.length, agentP50: pctl(ag, 50), agentP95: pctl(ag, 95),
            prijem: l.filter(o => /^prijem/.test(o.action)).length });
    }
    const byKind = {};
    agentRuns.forEach(r => { const k = r.kind; byKind[k] = byKind[k] || { n: 0, pass: 0, ms: [], sim: 0, restart: 0 }; if (r.restart) { byKind[k].restart++; return; } byKind[k].n++; if (r.pass) byKind[k].pass++; if (r.simulated) byKind[k].sim++; byKind[k].ms.push(r.ms); });
    const failed = checks.filter(c => !c.ok);
    const SEV = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    failed.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
    const json = { meta, checks, hours, actions: actRows, agentKinds: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { n: v.n, pass: v.pass, simulated: v.sim, restart: v.restart, p50: pctl(v.ms, 50), p95: pctl(v.ms, 95) }])),
        nove: S.nove, drafts: S.drafts, docErrors: S.docErrors || [], aclProbes: S.aclProbes || [], telemetry, agentRuns, ops };
    fs.writeFileSync(base + '.json', JSON.stringify(json, null, 1));

    const L = [];
    L.push(`# Simulace dne v kanceláři — ${meta.label}`, '');
    L.push(`Server ${meta.base} · verze ${meta.version || '?'} · model ${meta.model || 'výchozí'} · den ${meta.hours} h reálného času · data: ${meta.dataset}`);
    L.push(`Start ${meta.start} · konec ${meta.end} · zavedení ${S.onboardingMin ? S.onboardingMin.toFixed(1) : '?'} min · restart ${S.restartS != null ? S.restartS.toFixed(0) + ' s' : 'ne'} · dobíhání po 16:30 ${S.overtimeMin != null ? S.overtimeMin.toFixed(1) + ' min' : '?'}`, '');
    L.push(`**Kontroly: ${checks.filter(c => c.ok).length}/${checks.length} v pořádku.** Požadavků během dne ${dayOps.length}, z toho agentů ${agentRuns.length}.`, '');
    if (failed.length) {
        L.push('## Nálezy', '', '| Závažnost | Kontrola | Detail |', '|---|---|---|');
        failed.forEach(c => L.push(`| ${c.severity} | ${c.id} ${c.name} | ${String(c.detail).replace(/\|/g, '/').slice(0, 400)} |`));
        L.push('');
    }
    L.push('## Všechny kontroly', '', '| | Fáze | Kontrola | Detail |', '|---|---|---|---|');
    checks.forEach(c => L.push(`| ${c.ok ? '✓' : '✗'} | ${c.phase} | ${c.id} ${c.name} | ${String(c.detail).replace(/\|/g, '/').slice(0, 300)} |`));
    L.push('', '## Den po hodinách', '', '| Hodina | Požadavků | Chyb | Přijato písemností | Odpovědí AI | AI p50 | AI p95 |', '|---|---|---|---|---|---|---|');
    hours.forEach(h => L.push(`| ${h.hodina} | ${h.pozadavku} | ${h.chyb} | ${h.prijem} | ${h.agentu} | ${fmtS(h.agentP50)} | ${fmtS(h.agentP95)} |`));
    L.push('', '## Asistenti AI', '', '| Úloha | Počet | Prošlo kontrolou | p50 | p95 |', '|---|---|---|---|---|');
    Object.entries(json.agentKinds).forEach(([k, v]) => L.push(`| ${k} | ${v.n} | ${v.pass} (${Math.round(v.pass / Math.max(1, v.n) * 100)} %)${v.simulated ? ` · simulováno ${v.simulated}` : ''}${v.restart ? ` · přerušeno restartem ${v.restart}` : ''} | ${fmtS(v.p50)} | ${fmtS(v.p95)} |`));
    {
        const cr = agentRuns.filter(r => r.citations);
        const sum = k => cr.reduce((n, r) => n + (r.citations[k] || 0), 0);
        const mimo = {}; cr.forEach(r => (r.citations.mimo || []).forEach(m => { mimo[m] = (mimo[m] || 0) + 1; }));
        const top = Object.entries(mimo).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([m, n]) => `${m} ×${n}`).join(', ');
        if (S.cloudEvents.length) L.push('', 'Cloud během dne: ' + S.cloudEvents.map(e => `${clock(e.t)} ${e.co}`).join(' · ') + '.');
        L.push('', `Citace v odpovědích: ${sum('celkem')}, neověřeno ${sum('neovereno')}, mimo podklady ${sum('mimoPodklady')}${top ? ` (nejčastěji ${top})` : ''}.`);
    }
    L.push('', '## Akce (odezva)', '', '| Akce | Počet | Chyb | p50 | p95 | max |', '|---|---|---|---|---|---|');
    actRows.forEach(a => L.push(`| ${a.action} | ${a.n} | ${a.chyby} | ${fmtS(a.p50)} | ${fmtS(a.p95)} | ${fmtS(a.max)} |`));
    if ((S.docErrors || []).length) { L.push('', '## Odchylky ve zpracování dokumentů (prvních 40)', ''); S.docErrors.slice(0, 40).forEach(e => L.push('- ' + e)); }
    L.push('', '_Všechna data jsou syntetická (generate_dataset.py). Úplné odpovědi agentů a každý požadavek jsou v .json._');
    fs.writeFileSync(base + '.md', L.join('\n') + '\n');
    return base;
}

async function main() {
    O = parseArgs(process.argv.slice(2));
    if (O.help || !O.base || !O.token) {
        console.log('Použití: node backend/scripts/office_day.js --base https://127.0.0.1 --token <token správce> [--insecure] [--hours 8] [--smoke] [--restart-cmd "…"]');
        process.exit(O.help ? 0 : 2);
    }
    const R = rng(O.seed);
    const M = loadDataset(O.dataset);
    try { S.cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'server_suite', 'cases.json'), 'utf8')).cases; } catch (e) { S.cases = []; }
    console.log(`office_day: ${M.spisy.length} spisů, ${M.dokumenty.length} dokumentů, ${M.kancelar.uzivatele.length} uživatelů · den ${O.hours} h${O.smoke ? ' (SMOKE)' : ''}`);
    const meta = { label: O.label, base: O.base, model: O.model, hours: O.hours, dataset: path.basename(O.dataset), seed: O.seed, smoke: O.smoke,
        start: new Date(T0).toISOString(), restartCmd: O.restartCmd ? 'ano' : 'ne', firm: O.firm };
    let fatal = null;
    try {
        const st = await request('GET', '/api/status', { token: O.token });
        meta.version = st.json && st.json.version;
        await onboarding(M, R);
        await day(M, R);
        await endOfDay(M);
    } catch (e) {
        fatal = e; phase = 'X';
        check('X', 'Simulace doběhla', false, { severity: 'critical', detail: e.message });
    }
    meta.end = new Date().toISOString();
    const base = writeReport(meta);
    console.log(`\nReport: ${base}.md (+ .json)`);
    console.log(`Kontroly: ${checks.filter(c => c.ok).length}/${checks.length} v pořádku`);
    if (/^lexis-officeday-/.test(path.basename(M.dir))) try { fs.rmSync(M.dir, { recursive: true, force: true }); } catch (e) { /* tmp */ }
    process.exit(fatal ? 1 : 0);
}

if (require.main === module) main();
module.exports = { parseArgs, rng, schedule, scoreCase, pctl, request, _setOptions: o => { O = o; } };
