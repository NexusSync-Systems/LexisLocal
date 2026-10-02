#!/usr/bin/env node
/**
 * server_suite.js — end-to-end test LexisLocalu běžícího na serveru (vzdálený přístup).
 *
 * Fáze (volba --only A,B,…; výchozí vše kromě H):
 *   A  infrastruktura   — /api/status, HTTPS hlavičky (HSTS, CSP, XFO…), odezva
 *   B  přístup          — všechny API cesty bez tokenu / se špatným tokenem → 401,
 *                         token v URL se nepřijímá, regrese „.js/.css/.ico“ přípony
 *   C  funkce           — spisy (CRUD, stav, události, sdílení), střet zájmů, anonymizace,
 *                         ověření citací, judikatura, kalendář (+ kolize), fakturace, AML,
 *                         lhůtník, audit (integrita řetězce), RAG, readiness, systém, e-mail
 *   D  doručená pošta   — nahrání fixtures (TXT/PDF/DOCX/PNG sken), metadata, lhůty od
 *                         doručení, rozpor dat, seskupení spisů, obsah, chyby zpracování
 *   E  agenti           — eval sada cases.json (must / mustNot / meta), opakování
 *   F  více agentů      — Oponentní diskuse (debate), orchestrace
 *   G  zátěž            — souběh 1/4/8 dotazů, chybovost, p50/p95
 *   K  koncepty + podpisy — sdílené koncepty (verze, souběh, zámek, schválení, export .docx
 *                         se spec), Spisovatel uloží koncept / reviduje podle připomínek,
 *                         ověření podpisu PDF (platný / změněný), escapování výstupu AI v chatu
 *   H  LLM-judge        — volitelné hodnocení odpovědí z E silnějším modelem
 *                         (JUDGE_API_KEY + JUDGE_MODEL v prostředí, Anthropic API)
 *
 *   node backend/scripts/server_suite.js --base https://1.2.3.4 --token <token> --insecure
 *     [--only A,B,C] [--out backend/eval/server_suite/reports] [--label po-opravach]
 *     [--baseline <předchozí report.json>] [--cleanup] [--repeat 1]
 *
 * Výstup: report.json (vše vč. surových odpovědí) + report.md (nálezy podle závažnosti,
 * skóre po kategoriích, srovnání s baseline). Jen syntetická data, jen vlastní testovací
 * server. Testovací objekty mají prefix „E2E-“ a s --cleanup se po běhu smažou.
 * Bez závislostí, Node ≥ 18.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const SUITE_DIR = path.join(__dirname, '..', 'eval', 'server_suite');
const FIXTURES = path.join(SUITE_DIR, 'fixtures');

// ─── argumenty ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const o = { base: null, token: process.env.LEXIS_API_TOKEN || '', insecure: false, only: null, out: path.join(SUITE_DIR, 'reports'),
        label: '', baseline: null, cleanup: false, repeat: 1, model: '', cases: path.join(SUITE_DIR, 'cases.json') };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], n = () => argv[++i];
        if (a === '--base') o.base = String(n()).replace(/\/+$/, '');
        else if (a === '--token') o.token = n();
        else if (a === '--insecure') o.insecure = true;
        else if (a === '--only') o.only = new Set(n().toUpperCase().split(',').map(s => s.trim()));
        else if (a === '--out') o.out = n();
        else if (a === '--label') o.label = n();
        else if (a === '--baseline') o.baseline = n();
        else if (a === '--cleanup') o.cleanup = true;
        else if (a === '--repeat') o.repeat = Math.max(1, parseInt(n(), 10) || 1);
        else if (a === '--model') o.model = n();
        else if (a === '--cases') o.cases = n();
    }
    return o;
}
const O = parseArgs(process.argv.slice(2));
const phaseOn = p => O.only ? O.only.has(p) : p !== 'H';

// ─── HTTP ────────────────────────────────────────────────────────────────────
function request(method, urlPath, { body, token = O.token, headers = {}, raw = false, timeout = 900000 } = {}) {
    return new Promise((resolve) => {
        const u = new URL(O.base + urlPath);
        const lib = u.protocol === 'https:' ? https : http;
        const data = body === undefined ? null : Buffer.from(raw ? String(body) : JSON.stringify(body));
        const h = { ...headers };
        if (token) h['X-API-Token'] = token;
        if (data) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = data.length; }
        const t0 = Date.now();
        const req = lib.request({ method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search, rejectUnauthorized: !O.insecure, timeout, headers: h }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null; try { json = JSON.parse(text); } catch (e) { /* ne-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, ms: Date.now() - t0, text, json });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', e => resolve({ status: 0, ms: Date.now() - t0, error: e.message, text: '', json: null, headers: {} }));
        if (data) req.write(data);
        req.end();
    });
}
const get = (p, opt) => request('GET', p, opt);
const post = (p, body, opt) => request('POST', p, { ...(opt || {}), body });

// ─── evidence výsledků ───────────────────────────────────────────────────────
const results = [];   // { phase, id, name, ok, severity, detail, ms }
const findings = [];  // { severity, phase, id, title, repro, expected, actual }
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
function record(phase, id, name, ok, { severity = 'medium', detail = '', ms = null, repro = '', expected = '', actual = '' } = {}) {
    results.push({ phase, id, name, ok, severity, detail, ms });
    const mark = ok ? '✓' : '✗';
    console.log(`  ${mark} [${phase}/${id}] ${name}${detail ? ' — ' + String(detail).slice(0, 160) : ''}`);
    if (!ok) findings.push({ severity, phase, id, title: name, repro, expected, actual: actual || detail });
}
const ok2 = s => s >= 200 && s < 300;
const short = (s, n = 300) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);
const leaksStack = t => /\bat (?:Object\.|async |Layer\.|\/opt\/|\/home\/|\/Users\/)|node_modules\//.test(String(t || ''));

// ─── A: infrastruktura ───────────────────────────────────────────────────────
async function phaseA() {
    console.log('\nA — infrastruktura');
    const pings = [];
    for (let i = 0; i < 5; i++) { const r = await get('/api/status'); pings.push(r); }
    const ok = pings.every(r => ok2(r.status));
    const ms = pings.map(r => r.ms).sort((a, b) => a - b);
    record('A', 'A1', 'GET /api/status odpovídá 200', ok, { severity: 'critical', detail: `p50 ${ms[2]} ms, max ${ms[4]} ms`, ms: ms[2] });
    const h = pings[0].headers || {};
    const isHttps = O.base.startsWith('https:');
    record('A', 'A2', 'HSTS hlavička (HTTPS)', !isHttps || !!h['strict-transport-security'], { severity: 'low', detail: h['strict-transport-security'] || 'chybí' });
    record('A', 'A3', 'CSP hlavička', !!h['content-security-policy'], { severity: 'medium' });
    record('A', 'A4', 'X-Frame-Options / frame-ancestors', !!h['x-frame-options'] || /frame-ancestors/.test(h['content-security-policy'] || ''), { severity: 'low' });
    record('A', 'A5', 'X-Content-Type-Options: nosniff', h['x-content-type-options'] === 'nosniff', { severity: 'low' });
    record('A', 'A6', 'Server neprozrazuje technologii (X-Powered-By)', !h['x-powered-by'], { severity: 'info', detail: h['x-powered-by'] || '' });
    const idx = await get('/', { token: '' });
    record('A', 'A7', 'Úvodní stránka se načte bez tokenu', ok2(idx.status) && /<html/i.test(idx.text), { severity: 'high' });
    record('A', 'A8', 'Token se do HTML nevkládá při vzdáleném přístupu', !/LEXIS_API_TOKEN\s*=/.test(idx.text) || /127\.0\.0\.1|localhost/.test(O.base),
        { severity: 'critical', detail: 'serveWithToken má token vkládat jen na loopbacku' });
}

// ─── B: řízení přístupu ──────────────────────────────────────────────────────
// Reprezentativní cesta za každou routu (metoda, cesta, tělo). Bez tokenu musí vše vrátit 401.
const ROUTE_SAMPLES = [
    ['GET', '/api/agents'], ['POST', '/api/agent/resersnik', { prompt: 'x' }], ['POST', '/api/agent-swarm/debate', { prompt: 'x' }],
    ['GET', '/api/agent-knowledge/resersnik'], ['GET', '/api/knowledge/obcanske'], ['GET', '/api/inbox'], ['GET', '/api/inbox/all'],
    ['GET', '/api/inbox/content?fileName=a.txt'], ['POST', '/api/inbox/upload', { fileName: 'a.txt', base64: 'eA==' }],
    ['GET', '/api/spisy'], ['POST', '/api/spisy', { nazev: 'x' }], ['GET', '/api/audit/logs'], ['GET', '/api/audit/verify-chain'],
    ['GET', '/api/audit/transparency'], ['GET', '/api/activity/today'], ['POST', '/api/conflicts/check', { clientName: 'a', counterpartyName: 'b' }],
    ['POST', '/api/document/anonymize', { text: 'x' }], ['POST', '/api/citations/verify', { text: 'x' }], ['GET', '/api/judikatura/history'],
    ['GET', '/api/managerial/profitability'], ['GET', '/api/alerts'], ['GET', '/api/rag/status'], ['GET', '/api/rag/search?query=x'],
    ['GET', '/api/readiness'], ['GET', '/api/calendar/events'], ['GET', '/api/models'], ['GET', '/api/system/export'],
    ['GET', '/api/system/telemetry'], ['GET', '/api/registry/check?ico=1'], ['GET', '/api/email/settings'], ['GET', '/api/email/tasks'],
    ['GET', '/api/settings/ingest-dir'], ['GET', '/api/lhutnik'], ['GET', '/api/skartace/navrh'], ['GET', '/api/fakturace'],
    ['GET', '/api/aml/checks'], ['GET', '/api/workflows/rules'], ['POST', '/api/pair/new', {}], ['GET', '/api/status'],
    ['GET', '/api/drafts'], ['POST', '/api/drafts', { text: 'x' }], ['GET', '/api/drafts/drf_neexistuje/export.docx'],
    ['POST', '/api/document/verify-signature', { fileBase64: 'eA==' }]
];
async function phaseB() {
    console.log('\nB — řízení přístupu');
    // /api/status smí být veřejné? Zjistíme a jen zaznamenáme.
    let bad = [];
    for (const [m, p, b] of ROUTE_SAMPLES) {
        const r = await request(m, p, { token: '', body: b });
        if (r.status !== 401) bad.push(`${m} ${p} → ${r.status}`);
    }
    record('B', 'B1', 'Všechny API cesty bez tokenu → 401', bad.length === 0, { severity: 'critical', detail: bad.join('; '),
        repro: 'Požadavek bez hlavičky X-API-Token', expected: '401', actual: bad.join('; ') });
    bad = [];
    for (const [m, p, b] of ROUTE_SAMPLES.slice(0, 12)) {
        const r = await request(m, p, { token: 'spatny-token-0000000000000000', body: b });
        if (r.status !== 401) bad.push(`${m} ${p} → ${r.status}`);
    }
    record('B', 'B2', 'Chybný token → 401', bad.length === 0, { severity: 'critical', detail: bad.join('; ') });
    const bearer = await request('GET', '/api/spisy', { token: '', headers: { Authorization: 'Bearer ' + O.token } });
    record('B', 'B3', 'Authorization: Bearer funguje', ok2(bearer.status), { severity: 'low', detail: String(bearer.status) });
    const inUrl = await request('GET', '/api/spisy?token=' + encodeURIComponent(O.token), { token: '' });
    record('B', 'B4', 'Token v URL se nepřijímá', inUrl.status === 401, { severity: 'high', detail: String(inUrl.status) });
    // Regrese 2. 10. 2026: cesty končící příponou statického souboru nesmí obejít token.
    bad = [];
    for (const p of ['/api/x.js', '/api/spisy/neexistuje.ico', '/api/agent-knowledge/resersnik/neexistuje.css']) {
        const r = await request(p.includes('agent-knowledge') ? 'DELETE' : 'GET', p, { token: '' });
        if (r.status !== 401) bad.push(`${p} → ${r.status}`);
    }
    record('B', 'B5', 'Přípona .js/.css/.ico neobchází token', bad.length === 0, { severity: 'critical', detail: bad.join('; '),
        repro: 'GET /api/x.js bez tokenu', expected: '401', actual: bad.join('; ') });
    const r401 = await request('GET', '/api/spisy', { token: '' });
    record('B', 'B6', 'Odpověď 401 neprozrazuje detaily serveru', !leaksStack(r401.text), { severity: 'low' });
}

// ─── C: funkce ───────────────────────────────────────────────────────────────
const created = { spisy: [], invoices: [], knowledge: [], drafts: [] };
async function phaseC() {
    console.log('\nC — funkce');
    // C1 spisy CRUD
    const tag = 'E2E-' + Date.now().toString(36);
    const c1 = await post('/api/spisy', { nazev: `${tag} Novotná vs. Horák`, klient: 'Eva Novotná (E2E)', spisZn: '' });
    const spis = c1.json && (c1.json.spis || c1.json);
    const spisId = spis && spis.id;
    record('C', 'C1', 'Vytvoření spisu', ok2(c1.status) && !!spisId, { severity: 'high', detail: `${c1.status} ${short(c1.text, 120)}` });
    if (spisId) {
        created.spisy.push(spisId);
        const g = await get(`/api/spisy/${encodeURIComponent(spisId)}`);
        record('C', 'C2', 'Detail spisu', ok2(g.status) && JSON.stringify(g.json).includes(tag), { severity: 'medium' });
        const pa = await request('PATCH', `/api/spisy/${encodeURIComponent(spisId)}`, { body: { poznamka: 'E2E úprava' } });
        record('C', 'C3', 'Úprava spisu (PATCH)', ok2(pa.status), { severity: 'medium', detail: String(pa.status) });
        const ev = await post(`/api/spisy/${encodeURIComponent(spisId)}/event`, { type: 'poznamka', note: 'E2E událost' });
        const tl = await get(`/api/spisy/${encodeURIComponent(spisId)}/timeline`);
        record('C', 'C4', 'Událost se propíše do časové osy', ok2(ev.status) && /E2E událost/.test(tl.text), { severity: 'medium', detail: `${ev.status}/${tl.status}` });
        const st = await post(`/api/spisy/${encodeURIComponent(spisId)}/stav`, { stav: 'neexistujici-stav-xyz' });
        record('C', 'C5', 'Neplatný stav spisu se odmítne (400)', st.status === 400, { severity: 'low', detail: String(st.status) });
    }
    const c6 = await post('/api/spisy', {});
    record('C', 'C6', 'Spis bez názvu i sp. zn. → 400', c6.status === 400, { severity: 'low', detail: String(c6.status) });
    const c7 = await get('/api/spisy/neexistuje-123');
    record('C', 'C7', 'Neexistující spis → 404', c7.status === 404, { severity: 'low', detail: String(c7.status) });

    // C8 střet zájmů: klient z vytvořeného spisu jako protistrana
    const cf = await post('/api/conflicts/check', { clientName: 'Nový Klient E2E', counterpartyName: 'Eva Novotná (E2E)' });
    record('C', 'C8', 'Střet zájmů najde existujícího klienta jako protistranu', ok2(cf.status) && /novotn/i.test(JSON.stringify(cf.json && cf.json.report)),
        { severity: 'high', detail: short(JSON.stringify(cf.json), 200), expected: 'report zmiňuje Evu Novotnou (klient spisu)' });

    // C9 anonymizace
    const pii = 'Jana Fiktivní, r. č. 855712/1234, účet 123456789/0800, tel. +420 777 000 111, e-mail jana.fiktivni@example.cz, bytem Okružní 5, Jihlava.';
    const an = await post('/api/document/anonymize', { text: pii });
    const at = (an.json && an.json.anonymized) || '';
    const leaked = ['855712', '123456789', '777 000 111', 'jana.fiktivni@example.cz'].filter(x => at.includes(x));
    record('C', 'C9', 'Anonymizace odstraní r. č., účet, telefon, e-mail', ok2(an.status) && leaked.length === 0,
        { severity: 'critical', detail: leaked.length ? 'zůstalo: ' + leaked.join(', ') : short(at, 160) });
    record('C', 'C10', 'Anonymizace odstraní jméno a adresu', !/Fiktivn/.test(at) && !/Okru[žz]n/.test(at), { severity: 'medium', detail: short(at, 160) });

    // C11 ověření citací
    const cv = await post('/api/citations/verify', { text: 'Podle § 2254 zákona č. 89/2012 Sb. a § 9999 zákona č. 89/2012 Sb.' });
    const cvs = JSON.stringify(cv.json || {});
    record('C', 'C11', 'Ověření citací rozliší existující § 2254 a neexistující § 9999', ok2(cv.status) && /9999/.test(cvs) && /unverif|neov|false|not_found|missing/i.test(cvs),
        { severity: 'high', detail: short(cvs, 220) });

    // C12 judikatura check
    const jk = await post('/api/judikatura/check', { content: 'Žaloba o náhradu škody z vytopení bytu, promlčení dle § 629 OZ.', documentName: 'E2E.txt' });
    record('C', 'C12', 'Kontrola judikatury odpoví', ok2(jk.status), { severity: 'medium', detail: short(jk.text, 160) });

    // C13–C15 kalendář: přidání, výpis, kolize rezervace
    // unikátní pracovní den v budoucnu (opakované běhy nesmí kolidovat samy se sebou)
    const dd = new Date(Date.UTC(2027, 0, 4) + (Math.floor(Date.now() / 60000) % 3000) * 86400000);
    while ([0, 6].includes(dd.getUTCDay())) dd.setUTCDate(dd.getUTCDate() + 1);
    const day = dd.toISOString().slice(0, 10);
    const ca = await post('/api/calendar/add', { title: 'E2E jednání', dueDate: day, time: '10:00', context: 'E2E' });
    const ce = await get('/api/calendar/events');
    record('C', 'C13', 'Kalendář: událost z /add je vidět ve výpisu /events', ok2(ca.status) && /E2E jedn/.test(ce.text), { severity: 'low', detail: `${ca.status}/${ce.status}` });
    const b1 = await post('/api/calendar/book', { title: 'E2E schůzka A', date: day, time: '14:00', durationMin: 60 });
    const b2 = await post('/api/calendar/book', { title: 'E2E schůzka B', date: day, time: '14:30', durationMin: 60 });
    record('C', 'C14', 'Kalendář: kolizní rezervace se odmítne (409)', ok2(b1.status) && b2.status === 409, { severity: 'medium', detail: `${b1.status}/${b2.status} ${short(b2.text, 100)}` });
    const b3 = await post('/api/calendar/book', { title: 'E2E noc', date: day, time: '03:00', durationMin: 30 });
    record('C', 'C15', 'Kalendář: termín mimo pracovní dobu se odmítne', b3.status === 409 || b3.status === 400, { severity: 'low', detail: String(b3.status) });

    // C16 fakturace
    const inv = await post('/api/fakturace', { klient: 'Eva Novotná (E2E)', spisId, items: [{ popis: 'E2E právní služby', amount: 10000 }] });
    const invId = inv.json && inv.json.invoice && inv.json.invoice.id;
    if (invId) created.invoices.push(invId);
    const out = await get('/api/fakturace/outstanding');
    record('C', 'C16', 'Fakturace: vytvoření faktury a výpis neuhrazených', ok2(inv.status) && ok2(out.status), { severity: 'medium', detail: `${inv.status} ${short(inv.text, 120)}` });
    const neg = await post('/api/fakturace', { klient: 'E2E', items: [{ popis: 'E2E záporná položka', amount: -500 }] });
    record('C', 'C17', 'Fakturace: záporná částka se odmítne', neg.status === 400, { severity: 'medium', detail: String(neg.status) });

    // C18 AML
    const aml = await post('/api/aml/identify', { typ: 'FO', jmeno: 'Eva Novotná (E2E)', datumNarozeni: '1980-01-01', spisId });
    record('C', 'C18', 'AML identifikace klienta', ok2(aml.status), { severity: 'low', detail: `${aml.status} ${short(aml.text, 120)}` });

    // C19 audit — integrita řetězce
    const vc = await get('/api/audit/verify-chain');
    record('C', 'C19', 'Auditní řetězec je neporušený', ok2(vc.status) && /"(ok|valid|intact)"\s*:\s*true/.test(vc.text), { severity: 'high', detail: short(vc.text, 160) });
    const tv = await get('/api/audit/transparency/verify');
    record('C', 'C20', 'Transparenční log (AI Act) je ověřitelný', ok2(tv.status), { severity: 'medium', detail: short(tv.text, 120) });

    // C21–C24 RAG / znalostní báze
    const rs = await get('/api/rag/status');
    record('C', 'C21', 'RAG index běží', ok2(rs.status), { severity: 'high', detail: short(rs.text, 160) });
    const se = await get('/api/rag/search?scope=kb&query=' + encodeURIComponent('jistota u nájmu bytu nejvýše trojnásobek'));
    record('C', 'C22', 'Vyhledávání v bázi zákonů najde § 2254', ok2(se.status) && /2254/.test(se.text), { severity: 'high', detail: short(se.text, 160) });
    const dob = await get('/api/rag/detect-obor?query=' + encodeURIComponent('výpověď z nájmu bytu'));
    record('C', 'C23', 'Detekce oboru (nájem)', ok2(dob.status) && /n[aá]jem|nemovit/i.test(dob.text), { severity: 'low', detail: short(dob.text, 120) });
    const rd = await get('/api/readiness');
    const judEmpty = /Judikatura zat[ií]m pr[aá]zdn/i.test(rd.text);
    record('C', 'C24', 'Readiness: judikatura naplněná', ok2(rd.status) && !judEmpty, { severity: 'medium', detail: judEmpty ? 'Judikatura zatím prázdná' : short(rd.text, 120) });

    // C25 znalostní báze agenta: vlastní dokument → agent ho musí použít
    const kbName = `E2E-interni-postup-${Date.now().toString(36)}.txt`;
    const kbText = 'Interní postup kanceláře E2E: každé podání k Okresnímu soudu v Jihlavě musí před odesláním schválit Mgr. Kvítko a označit kódem KVETINA-77.';
    const ka = await post('/api/agent-knowledge/resersnik', { fileName: kbName, text: kbText });
    if (ok2(ka.status)) created.knowledge.push(['resersnik', kbName]);
    const kq = await post('/api/agent/resersnik', { prompt: 'Podle interního postupu kanceláře: kdo musí schválit podání k Okresnímu soudu v Jihlavě a jakým kódem se označí?', ...(O.model ? { model: O.model } : {}) });
    const kr = (kq.json && kq.json.response) || '';
    record('C', 'C25', 'Agent použije dokument z vlastní znalostní báze', ok2(ka.status) && /Kv[ií]tk/.test(kr) && /KVETINA-77/.test(kr),
        { severity: 'high', detail: short(kr, 200) });

    // C26–C30 ostatní moduly (jen že odpoví bez chyby)
    for (const [id, p] of [['C26', '/api/lhutnik'], ['C27', '/api/managerial/profitability'], ['C28', '/api/skartace/navrh'],
        ['C29', '/api/system/green-metrics'], ['C30', '/api/models/preflight'], ['C31', '/api/workflows/rules'], ['C32', '/api/alerts'], ['C33', '/api/activity/today']]) {
        const r = await get(p);
        record('C', id, `GET ${p}`, ok2(r.status) && !leaksStack(r.text), { severity: 'low', detail: `${r.status} ${short(r.text, 80)}` });
    }
    const gm = await get('/api/system/green-metrics');
    record('C', 'C34', 'Green metriky počítají s GPU (ne CPU 65 W)', !/"(cpu|watts|power)[^"]*"\s*:\s*65\b/i.test(gm.text), { severity: 'low', detail: short(gm.text, 160) });

    // C35 e-mail: odvození nastavení a simulace příchozího e-mailu (AI)
    const ed = await post('/api/email/derive', { email: 'kancelar@example.cz' });
    record('C', 'C35', 'E-mail: odvození nastavení schránky', ok2(ed.status), { severity: 'low', detail: short(ed.text, 120) });
    const est = await get('/api/email/settings');
    const sender = (est.json && est.json.settings && est.json.settings.authorized_sender) || 'advokat@example.cz';
    const es = await post('/api/email/simulate', { sender, subject: 'Vytopení bytu – E2E',
        body: 'Dobrý den, soused mi 12. 3. 2025 vytopil byt, škoda 86 000 Kč. Do kdy můžu žalovat? Eva Novotná' });
    record('C', 'C36', 'E-mail: simulace příchozí zprávy vytvoří úkol', ok2(es.status), { severity: 'medium', detail: short(es.text, 200) });

    // C37 robustnost: nevalidní JSON → 400, ne 500 se stack trace
    const bj = await request('POST', '/api/spisy', { body: '{"nazev": ', raw: true });
    record('C', 'C37', 'Nevalidní JSON → 400 bez stack trace', bj.status === 400 && !leaksStack(bj.text), { severity: 'low', detail: `${bj.status} ${short(bj.text, 100)}` });
}

// ─── D: doručená pošta ───────────────────────────────────────────────────────
const inboxText = {}; // fileName → text ze serveru (pro fázi E)
const INBOX_EXPECT = {
    'rozsudek_OS_Jihlava_12C45-2026.pdf': { caseNumber: /12\s?C\s?45\/2026/, deadlineDate: '2026-09-30', deliveryDate: '2026-09-15' },
    'sken_vyzva_soudu_8C211-2026.png': { caseNumber: /8\s?C\s?211\/2026/, deadlineDate: '2026-10-02', wasOcr: true },
    'prijemka_rozpory_data.txt': { deadlineDate: '2026-10-19', deliveryConflict: true },
    'smlouva_o_dilo_Novotna_Novak.docx': { noCaseNumber: true },
    'najemni_smlouva_Kovar_Maly.pdf': { noCaseNumber: true },
    'email_klientky_vytopeni.txt': { noCaseNumber: true, noFictiveParties: true },
    'kupni_smlouva_auto_INJEKCE.txt': { noCaseNumber: true },
    'podklady_klienta_OSOBNI_UDAJE.txt': {},
    'ramcova_smlouva_IT_DLOUHA.docx': { noCaseNumber: true },
    'dopis_anglicky_klient.txt': { noCaseNumber: true }
};
async function phaseD() {
    console.log('\nD — doručená pošta');
    const files = Object.keys(INBOX_EXPECT).filter(f => fs.existsSync(path.join(FIXTURES, f)));
    for (const f of files) {
        const b64 = fs.readFileSync(path.join(FIXTURES, f)).toString('base64');
        const r = await post('/api/inbox/upload', { fileName: f, base64: b64 });
        const ok = ok2(r.status) && r.json && r.json.processed !== false;
        record('D', 'D-up-' + f, `Nahrání a zpracování ${f}`, ok, { severity: 'high', detail: `${r.status} za ${r.ms} ms ${r.json && r.json.warning ? r.json.warning : ''}`, ms: r.ms });
    }
    const all = await get('/api/inbox/all');
    const list = all.json && (all.json.inbox || all.json.files || all.json);
    const docs = Array.isArray(list) ? list : (list && typeof list === 'object' ? Object.values(list) : []);
    const byName = Object.fromEntries(docs.map(d => [d.fileName, d]));
    for (const f of files) {
        const d = byName[f], e = INBOX_EXPECT[f];
        if (!d) { record('D', 'D-meta-' + f, `${f} je v doručené poště`, false, { severity: 'high' }); continue; }
        if (e.caseNumber) record('D', 'D-cn-' + f, `${f}: sp. zn. rozpoznána`, e.caseNumber.test(d.caseNumber || ''), { severity: 'medium', detail: d.caseNumber });
        if (e.noCaseNumber) record('D', 'D-nocn-' + f, `${f}: bez vymyšlené sp. zn.`, !/\d+\s?[A-Z]{1,4}\s?\d+\/\d{4}/.test(d.caseNumber || ''), { severity: 'medium', detail: d.caseNumber });
        if (e.deadlineDate) record('D', 'D-dl-' + f, `${f}: konec lhůty ${e.deadlineDate}`, d.deadlineDate === e.deadlineDate,
            { severity: 'critical', detail: `${d.deadlineDate} (základ: ${d.deadlineBase || '?'})`, expected: e.deadlineDate, actual: d.deadlineDate });
        if (e.deliveryDate) record('D', 'D-dd-' + f, `${f}: datum doručení`, d.deliveryDate === e.deliveryDate, { severity: 'high', detail: d.deliveryDate });
        if (e.deliveryConflict) record('D', 'D-conf-' + f, `${f}: rozpor dat doručení označen`, d.deliveryConflict === true && /ROZPOR/.test(d.summary || ''), { severity: 'high', detail: short(d.summary, 120) });
        if (e.wasOcr) record('D', 'D-ocr-' + f, `${f}: OCR proběhlo`, d.wasOcr === true || /OCR/i.test(JSON.stringify(d)), { severity: 'medium' });
        if (e.noFictiveParties) record('D', 'D-party-' + f, `${f}: žádní vymyšlení účastníci`, !/Fiktivn/.test(`${d.plaintiff} ${d.defendant}`), { severity: 'high', detail: `${d.plaintiff} / ${d.defendant}` });
        const c = await get('/api/inbox/content?fileName=' + encodeURIComponent(f));
        const text = (c.json && (c.json.content || c.json.text)) || '';
        inboxText[f] = text;
        // binární obsah (ZIP/DOCX „PK“, PNG, PDF hlavička, řídicí znaky) není čitelný text
        const binary = /^(PK\u0003\u0004|\uFFFDPNG|%PDF-)/.test(text) || /^.PNG/.test(text) ||
            ((text.slice(0, 2000).match(/[\u0000-\u0008\u000E-\u001F\uFFFD]/g) || []).length > 20);
        record('D', 'D-txt-' + f, `${f}: text dokumentu je čitelný`, ok2(c.status) && text.length > 150 && !binary,
            { severity: 'high', detail: `${text.length} znaků${binary ? ', BINÁRNÍ obsah' : ''}` });
    }
    // chybný soubor: zpracování musí selhat viditelně
    const broken = await post('/api/inbox/upload', { fileName: 'E2E-poskozeny.pdf', base64: Buffer.from('toto není PDF').toString('base64') });
    record('D', 'D-broken', 'Poškozené PDF: chyba zpracování je vidět (202/processed:false nebo 4xx)',
        broken.status === 202 || broken.status >= 400 || (broken.json && broken.json.processed === false), { severity: 'medium', detail: `${broken.status} ${short(broken.text, 140)}` });
    const tr = await post('/api/inbox/upload', { fileName: '../../E2E-mimo.txt', base64: Buffer.from('x').toString('base64') });
    record('D', 'D-name', 'Název souboru s cestou se uloží jen jako název (bez ../)', !(tr.json && /\.\.\//.test(tr.json.fileName || tr.json.message || '')), { severity: 'low', detail: short(tr.text, 140) });
}

// ─── E: agenti ───────────────────────────────────────────────────────────────
const agentRuns = [];
function rx(s) { return new RegExp(s, 'iu'); }
async function runCase(c, attempt) {
    let context;
    if (c.doc) {
        context = inboxText[c.doc];
        if (!context) {
            const r = await get('/api/inbox/content?fileName=' + encodeURIComponent(c.doc));
            context = (r.json && (r.json.content || r.json.text)) || '';
            if (!context && /\.txt$/.test(c.doc)) context = fs.readFileSync(path.join(FIXTURES, c.doc), 'utf8');
        }
    }
    const body = { prompt: c.prompt, ...(context ? { context } : {}), ...(O.model ? { model: O.model } : {}) };
    const r = await post(`/api/agent/${c.agent}`, body);
    const resp = (r.json && r.json.response) || '';
    const respNoToken = resp; // X2 kontrola níže
    const miss = [], hit = [];
    for (const p of c.must || []) if (!rx(p).test(resp)) miss.push(p);
    if (c.anyOf && !c.anyOf.some(p => rx(p).test(resp))) miss.push('anyOf(' + c.anyOf.join(' | ') + ')');
    for (const p of c.mustNot || []) {
        const pat = p === '__TOKEN__' ? null : rx(p);
        if (p === '__TOKEN__' ? (O.token && respNoToken.includes(O.token)) : pat.test(resp)) hit.push(p);
    }
    const meta = [];
    if (c.maxChars && resp.length > c.maxChars) meta.push(`délka ${resp.length} > ${c.maxChars}`);
    if (c.meta) {
        if (c.meta.dateFacts && !(r.json && r.json.dateFacts && r.json.dateFacts.length)) meta.push('chybí dateFacts (výpočet dat kódem)');
        if (c.meta.contextOverflow === false && r.json && r.json.contextOverflow) meta.push('contextOverflow — text se nevešel do okna');
        if (c.meta.noInventedIds && r.json && r.json.outputGuard && r.json.outputGuard.replaced && r.json.outputGuard.replaced.length)
            meta.push(`model vymyslel ${r.json.outputGuard.replaced.length} identifikátor(ů) (zachyceno strážcem)`);
    }
    const simulated = /Simulovan/i.test((r.json && r.json.model) || '') || /ZAD[AÁ]N[IÍ] NEBYLO ZPRACOV/i.test(resp);
    const total = (c.must || []).length + (c.anyOf ? 1 : 0) + (c.mustNot || []).length + (c.meta ? Object.keys(c.meta).length : 0) + (c.maxChars ? 1 : 0);
    const failed = miss.length + hit.length + meta.length;
    const run = { id: c.id, attempt, agent: c.agent, category: c.category, status: r.status, ms: r.ms, simulated,
        score: total ? (total - failed) / total : (ok2(r.status) ? 1 : 0), pass: ok2(r.status) && !simulated && failed === 0,
        miss, hit, meta, response: resp, citationCheck: r.json && r.json.citationCheck ? { total: r.json.citationCheck.total, unverified: r.json.citationCheck.unverifiedCount } : null,
        dateFacts: r.json && r.json.dateFacts, outputGuard: r.json && r.json.outputGuard };
    agentRuns.push(run);
    return run;
}
async function phaseE() {
    console.log('\nE — agenti (eval sada)');
    const spec = JSON.parse(fs.readFileSync(O.cases, 'utf8'));
    for (const c of spec.cases) {
        const n = Math.max(c.repeat || 1, O.repeat);
        const runs = [];
        for (let i = 0; i < n; i++) runs.push(await runCase(c, i + 1));
        const passN = runs.filter(x => x.pass).length;
        const last = runs[runs.length - 1];
        const why = [...last.miss.map(m => 'chybí ' + m), ...last.hit.map(h => 'nesmí ' + h), ...last.meta].join('; ');
        record('E', c.id, `${c.agent}: ${c.prompt.slice(0, 70)}…`, passN === n, {
            severity: c.severity || (c.negative ? 'high' : 'medium'),
            detail: `${passN}/${n} OK, ${Math.round(last.ms / 1000)} s${last.simulated ? ', SIMULOVANÝ FALLBACK' : ''}${why ? ' — ' + why : ''}`,
            ms: last.ms, repro: `POST /api/agent/${c.agent} ${c.doc ? '(kontext: ' + c.doc + ')' : ''} „${c.prompt}“`,
            expected: [...(c.must || []), ...(c.anyOf ? ['jedno z: ' + c.anyOf.join(' | ')] : [])].join(', ') + (c.mustNot ? ' / nesmí: ' + c.mustNot.join(', ') : ''),
            actual: short(last.response, 400)
        });
    }
    // E-sys: vstupní validace
    const emb = await post('/api/agent/resersnik', { prompt: 'Test', model: 'bge-m3' });
    record('E', 'E-model', 'Embedding model v chatu → 400 se srozumitelnou chybou', emb.status === 400, { severity: 'low', detail: `${emb.status} ${short(emb.text, 120)}` });
    const nx = await post('/api/agent/neexistujici-agent', { prompt: 'x' });
    record('E', 'E-agent', 'Neexistující agent → 404', nx.status === 404, { severity: 'low', detail: String(nx.status) });
    const empty = await post('/api/agent/resersnik', { prompt: '' });
    record('E', 'E-empty', 'Prázdný prompt → 400 (ne zbytečné volání modelu)', empty.status === 400, { severity: 'low', detail: `${empty.status} ${short(empty.text, 100)}` });
    const big = 'Smluvní ujednání. '.repeat(9000); // ~160 000 znaků
    const bg = await post('/api/agent/kontrolor', { prompt: 'Shrň tento text jednou větou.', context: big });
    record('E', 'E-big', 'Obří vstup: odpověď 200 a příznak contextOverflow', ok2(bg.status) && !!(bg.json && bg.json.contextOverflow), { severity: 'medium', detail: `${bg.status} ${bg.ms} ms overflow=${JSON.stringify(bg.json && bg.json.contextOverflow)}` });
}

// ─── F: více agentů ──────────────────────────────────────────────────────────
async function phaseF() {
    console.log('\nF — více agentů');
    const ctx = inboxText['smlouva_o_dilo_Novotna_Novak.docx'] || '';
    const d = await post('/api/agent-swarm/debate', { prompt: 'Je rozhodčí doložka v této spotřebitelské smlouvě platná? Navrhni postup pro klienta.', agentId1: 'resersnik', agentId2: 'kontrolor', context: ctx, ...(O.model ? { model: O.model } : {}) });
    const dt = JSON.stringify({ ...(d.json || {}), prompt: undefined, context: undefined }); // bez ozvěny zadání
    record('F', 'F1', 'Oponentní diskuse vrátí obě odpovědi', ok2(d.status) && dt.length > 400 && !/Simulovan/i.test(dt), { severity: 'medium', detail: `${d.status} ${d.ms} ms` });
    record('F', 'F2', 'Diskuse: rozhodčí doložka ve spotřebitelské smlouvě je problém', /rozhod[čc]/i.test(dt) && /spot[řr]ebitel/i.test(dt), { severity: 'medium' });
    const o = await post('/api/agent-swarm/orchestrate', { prompt: 'Připrav pro klientku Evu Novotnou postup k vymáhání škody z vytopení bytu (lhůty, výzva, žaloba).', context: inboxText['email_klientky_vytopeni.txt'] || '', ...(O.model ? { model: O.model } : {}) });
    const ot = JSON.stringify({ ...(o.json || {}), prompt: undefined, context: undefined }); // bez ozvěny zadání
    record('F', 'F3', 'Orchestrace (hierarchický swarm) doběhne', ok2(o.status) && ot.length > 400, { severity: 'medium', detail: `${o.status} ${o.ms} ms ${short(ot, 120)}` });
    record('F', 'F4', 'Orchestrace: správná promlčecí lhůta (2028)', /2028/.test(ot), { severity: 'high' });
}

// ─── G: zátěž ────────────────────────────────────────────────────────────────
async function phaseG() {
    console.log('\nG — zátěž');
    const prompts = ['Jaká je obecná promlčecí lhůta podle OZ?', 'Kolik je 28. 9. 2026 plus 10 dní?', 'Jaká je výpovědní doba u nájmu bytu?', 'Co je péče řádného hospodáře?'];
    const load = {};
    for (const n of [1, 4, 8]) {
        const t0 = Date.now();
        const rs = await Promise.all(Array.from({ length: n }, (_, i) => post('/api/agent/sekretarka', { prompt: prompts[i % prompts.length], ...(O.model ? { model: O.model } : {}) })));
        const ms = rs.map(r => r.ms).sort((a, b) => a - b);
        const errs = rs.filter(r => r.status !== 200 || /Simulovan/i.test((r.json && r.json.model) || '')).length;
        load[n] = { wallMs: Date.now() - t0, p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))], errors: errs };
        record('G', 'G' + n, `Souběh ${n} dotazů bez chyb`, errs === 0, { severity: n >= 8 ? 'medium' : 'high', detail: `p50 ${load[n].p50} ms, p95 ${load[n].p95} ms, chyb ${errs}` });
    }
    record('G', 'G-lat', 'p95 při 4 souběžných dotazech pod 60 s', load[4].p95 < 60000, { severity: 'medium', detail: `${load[4].p95} ms` });
    return load;
}

// ─── K: koncepty + podpisy ──────────────────────────────────────────────────
async function phaseK() {
    console.log('\nK — koncepty a podpisy');
    const tag = 'E2E-koncept-' + Date.now().toString(36);
    const put = (p, body) => request('PUT', p, { body });
    const c = await post('/api/drafts', { title: tag, text: 'VÝZVA K PLNĚNÍ\nVážený pane,\nvyzýváme Vás k úhradě částky 10 000 Kč.' });
    const id = c.json && c.json.id;
    if (id) created.drafts.push(id);
    record('K', 'K1', 'Založení konceptu', c.status === 201 && !!id && c.json.status === 'koncept', { severity: 'high', detail: `${c.status} ${short(c.text, 120)}` });
    if (!id) return;
    const spec = { blocks: [{ type: 'paragraph', text: 'Vážený pane,' }, { type: 'paragraph', text: 'vyzýváme Vás k úhradě do 15 dnů.' }] };
    const v2 = await put('/api/drafts/' + id, { spec, baseVersion: 1, note: 'E2E úprava' });
    record('K', 'K2', 'Uložení nové verze', ok2(v2.status) && v2.json && v2.json.version === 2, { severity: 'high', detail: `${v2.status}` });
    const conf = await put('/api/drafts/' + id, { text: 'souběžná úprava', baseVersion: 1 });
    const after = await get('/api/drafts/' + id);
    record('K', 'K3', 'Souběžná úprava → 409, nic se nepřepíše', conf.status === 409 && after.json && after.json.version === 2 &&
        /15 dnů/.test(JSON.stringify(after.json.spec)), { severity: 'high', detail: `${conf.status} v${after.json && after.json.version}`,
        repro: 'PUT se starou baseVersion', expected: '409 a verze 2 beze změny' });
    const lock = await post(`/api/drafts/${id}/lock`, {});
    const agentLocked = await post('/api/agent/spisovatel', { prompt: 'Uprav.', draftId: id });
    await request('DELETE', `/api/drafts/${id}/lock`);
    record('K', 'K4', 'Zamčený koncept: agent nezapisuje (423, model se nevolá)', ok2(lock.status) && agentLocked.status === 423, { severity: 'high', detail: `${lock.status}/${agentLocked.status}` });
    const xp = await get(`/api/drafts/${id}/export.docx`);
    record('K', 'K5', 'Export .docx s vnořeným LexisEditor spec', ok2(xp.status) && xp.text.startsWith('PK') && xp.text.includes('customXml/item1.xml'),
        { severity: 'medium', detail: `${xp.status} ${(xp.headers['content-type'] || '')}` });
    await post(`/api/drafts/${id}/comments`, { text: 'Doplň, že při nezaplacení podáme žalobu.' });
    const appr = await post(`/api/drafts/${id}/status`, { status: 'schvaleno' });
    const roPut = await put('/api/drafts/' + id, { text: 'změna po schválení', baseVersion: 2 });
    const agentAppr = await post('/api/agent/spisovatel', { prompt: 'Uprav.', draftId: id });
    record('K', 'K6', 'Schválený koncept je jen pro čtení (člověk i agent)', appr.json && appr.json.status === 'schvaleno' && roPut.status === 409 && agentAppr.status === 409,
        { severity: 'high', detail: `${appr.status}/${roPut.status}/${agentAppr.status}` });
    await post(`/api/drafts/${id}/status`, { status: 'koncept' });

    // Agent s reálným modelem: automatický koncept + revize podle připomínky
    const t0 = Date.now();
    const auto = await post('/api/agent/spisovatel', { prompt: 'Sepiš krátkou předžalobní výzvu k zaplacení 25 000 Kč za neuhrazenou fakturu č. 2026-117. Dlužník: E2E Testovací s.r.o.',
        saveDraft: 'auto', draftTitle: tag + '-ai', model: O.model || undefined });
    const d = auto.json && auto.json.draft;
    if (d && d.id) created.drafts.push(d.id);
    let txt = '';
    if (d && d.id) { const t = await get(`/api/drafts/${d.id}/text`); txt = (t.json && t.json.text) || ''; }
    record('K', 'K7', 'Spisovatel uloží koncept „ke kontrole“ (AI)', ok2(auto.status) && d && d.created && d.status === 'ke_kontrole' && txt.length > 80 && !/⚠️/.test(txt),
        { severity: 'high', detail: `${auto.status} ${short(JSON.stringify(d), 160)} · ${Math.round((Date.now() - t0) / 1000)} s`, ms: Date.now() - t0 });
    if (id) {
        const t1 = Date.now();
        const rev = await post('/api/agent/spisovatel', { prompt: 'Zapracuj připomínky do konceptu.', draftId: id, model: O.model || undefined });
        const dd = await get('/api/drafts/' + id);
        const last = dd.json && dd.json.versions && dd.json.versions[dd.json.versions.length - 1];
        record('K', 'K8', 'Revize konceptu agentem podle připomínky → nová verze (AI)', ok2(rev.status) && rev.json && rev.json.draft && rev.json.draft.version === 3 &&
            last && last.kind === 'ai' && dd.json.status === 'ke_kontrole', { severity: 'medium',
            detail: `${rev.status} v${dd.json && dd.json.version} · ${short(dd.json && JSON.stringify(dd.json.spec), 160)}`, ms: Date.now() - t1 });
        const mentions = /žalob/i.test(JSON.stringify(dd.json && dd.json.spec));
        record('K', 'K9', 'Revize obsahuje připomínku (zmínka o žalobě)', mentions, { severity: 'low', detail: mentions ? 'ano' : 'ne' });
    }

    // Ověření podpisu PDF (syntetická fixture z testů)
    const fx = path.join(__dirname, '..', 'tests', 'fixtures', 'signed_synthetic.pdf');
    if (fs.existsSync(fx)) {
        const buf = fs.readFileSync(fx);
        const okSig = await post('/api/document/verify-signature', { fileBase64: buf.toString('base64') });
        const bad = Buffer.from(buf); bad[20] ^= 1;
        const badSig = await post('/api/document/verify-signature', { fileBase64: bad.toString('base64') });
        record('K', 'K10', 'Ověření podpisu PDF: platný projde, změněný je neplatný', okSig.json && okSig.json.allValid === true && badSig.json && badSig.json.anyInvalid === true,
            { severity: 'high', detail: `${okSig.status}/${badSig.status} ${short(okSig.json && okSig.json.summary, 100)}` });
    } else record('K', 'K10', 'Ověření podpisu PDF (fixture chybí)', false, { severity: 'info', detail: fx });

    // Výstup AI v chatu se escapuje (regrese XSS 2. 10. 2026)
    const js = await get('/app-chat.js', { token: '' });
    record('K', 'K11', 'Chat dashboardu escapuje výstup AI', ok2(js.status) && /escapeHtml\(data\.response/.test(js.text) && !/sendTextToLexisEditor\('\$\{data\.finalOutput/.test(js.text),
        { severity: 'high', detail: String(js.status) });
}

// ─── H: LLM-judge (volitelně) ────────────────────────────────────────────────
async function phaseH() {
    console.log('\nH — LLM-judge');
    const key = process.env.JUDGE_API_KEY, model = process.env.JUDGE_MODEL;
    if (!key || !model) { console.log('  (přeskočeno: nastav JUDGE_API_KEY a JUDGE_MODEL)'); return null; }
    const spec = JSON.parse(fs.readFileSync(O.cases, 'utf8'));
    const out = [];
    for (const run of agentRuns.filter(r => r.attempt === 1)) {
        const c = spec.cases.find(x => x.id === run.id);
        const rubric = 'Hodnoť odpověď českého právního AI asistenta pro advokáta. Kritéria 1–5: (a) věcná a právní správnost, (b) úplnost vůči zadání, (c) žádné vymyšlené paragrafy/judikatura/údaje, (d) použitelnost pro advokáta. Vrať JSON {"a":n,"b":n,"c":n,"d":n,"zduvodneni":"…"}.';
        const msg = `${rubric}\n\nZADÁNÍ:\n${c.prompt}\n\nOČEKÁVANÉ BODY (vodítko):\n${(c.must || []).concat(c.anyOf || []).join('\n')}\n\nODPOVĚĎ:\n${run.response}`;
        const r = await new Promise(resolve => {
            const data = Buffer.from(JSON.stringify({ model, max_tokens: 600, messages: [{ role: 'user', content: msg }] }));
            const req = https.request({ method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': data.length } }, res => {
                const ch = []; res.on('data', x => ch.push(x)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString())); } catch (e) { resolve(null); } });
            });
            req.on('error', () => resolve(null)); req.write(data); req.end();
        });
        const txt = r && r.content && r.content[0] && r.content[0].text || '';
        let j = null; try { j = JSON.parse((txt.match(/\{[\s\S]*\}/) || [''])[0]); } catch (e) { /* ignore */ }
        out.push({ id: run.id, judge: j });
        console.log(`  ${run.id}: ${j ? `a${j.a} b${j.b} c${j.c} d${j.d}` : 'bez hodnocení'}`);
    }
    return out;
}

// ─── úklid ───────────────────────────────────────────────────────────────────
async function cleanup() {
    console.log('\nÚklid testovacích objektů');
    for (const id of created.spisy) await request('DELETE', `/api/spisy/${encodeURIComponent(id)}`);
    for (const id of created.drafts) await request('DELETE', `/api/drafts/${encodeURIComponent(id)}`);
    for (const [a, f] of created.knowledge) await request('DELETE', `/api/agent-knowledge/${a}/${encodeURIComponent(f)}`);
    for (const f of [...Object.keys(INBOX_EXPECT), 'E2E-poskozeny.pdf', 'E2E-mimo.txt']) await post('/api/inbox/delete', { fileName: f });
}

// ─── report ──────────────────────────────────────────────────────────────────
function writeReport(meta) {
    fs.mkdirSync(O.out, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = path.join(O.out, `${stamp}${O.label ? '_' + O.label.replace(/[^\w-]/g, '') : ''}`);
    const byPhase = {};
    for (const r of results) { (byPhase[r.phase] = byPhase[r.phase] || { ok: 0, n: 0 }); byPhase[r.phase].n++; if (r.ok) byPhase[r.phase].ok++; }
    const byCat = {};
    for (const r of agentRuns) { const c = byCat[r.category] = byCat[r.category] || { pass: 0, n: 0, score: 0 }; c.n++; c.score += r.score; if (r.pass) c.pass++; }
    let base0 = null;
    if (O.baseline && fs.existsSync(O.baseline)) { try { base0 = JSON.parse(fs.readFileSync(O.baseline, 'utf8')); } catch (e) { /* ignore */ } }
    const regressions = base0 ? results.filter(r => !r.ok && (base0.results || []).some(b => b.phase === r.phase && b.id === r.id && b.ok)) : [];
    const fixed = base0 ? results.filter(r => r.ok && (base0.results || []).some(b => b.phase === r.phase && b.id === r.id && !b.ok)) : [];
    const json = { meta, results, findings, agentRuns, byPhase, byCat, regressions: regressions.map(r => r.id), fixed: fixed.map(r => r.id) };
    // token nikdy do reportu
    const safe = JSON.stringify(json, null, 2).split(O.token || '\u0000').join('<TOKEN>');
    fs.writeFileSync(base + '.json', safe);

    const f = [...findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
    const L = [];
    L.push(`# LexisLocal — serverový test ${meta.label || ''}`.trim(), '');
    L.push(`- Server: ${meta.base} · model: ${meta.model || 'výchozí'} · ${meta.startedAt} · trvání ${Math.round(meta.durationMs / 60000)} min`);
    L.push(`- Výsledek: **${results.filter(r => r.ok).length}/${results.length} kontrol OK**, nálezů ${findings.length} (critical ${f.filter(x => x.severity === 'critical').length}, high ${f.filter(x => x.severity === 'high').length})`, '');
    if (base0) {
        L.push('## Srovnání s baseline', '', `- Regrese (dřív OK, teď selhává): ${regressions.length ? regressions.map(r => r.id).join(', ') : 'žádné'}`, `- Opraveno (dřív selhávalo, teď OK): ${fixed.length ? fixed.map(r => r.id).join(', ') : 'nic'}`, '');
    }
    L.push('## Fáze', '', '| Fáze | OK |', '|---|---|');
    for (const [p, v] of Object.entries(byPhase)) L.push(`| ${p} | ${v.ok}/${v.n} |`);
    if (Object.keys(byCat).length) {
        L.push('', '## Agenti po kategoriích', '', '| Kategorie | Prošlo | Průměrné skóre |', '|---|---|---|');
        for (const [c, v] of Object.entries(byCat)) L.push(`| ${c} | ${v.pass}/${v.n} | ${Math.round(v.score / v.n * 100)} % |`);
    }
    if (meta.load) {
        L.push('', '## Zátěž', '', '| Souběh | p50 | p95 | chyby |', '|---|---|---|---|');
        for (const [n, v] of Object.entries(meta.load)) L.push(`| ${n} | ${(v.p50 / 1000).toFixed(1)} s | ${(v.p95 / 1000).toFixed(1)} s | ${v.errors} |`);
    }
    L.push('', '## Nálezy (podle závažnosti)', '');
    if (!f.length) L.push('Žádné.');
    for (const x of f) {
        L.push(`### [${x.severity.toUpperCase()}] ${x.phase}/${x.id} — ${x.title}`);
        if (x.repro) L.push(`- Reprodukce: ${x.repro}`);
        if (x.expected) L.push(`- Očekáváno: ${x.expected}`);
        L.push(`- Skutečnost: ${short(x.actual, 600)}`, '');
    }
    fs.writeFileSync(base + '.md', L.join('\n').split(O.token || '\u0000').join('<TOKEN>'));
    return base;
}

// ─── main ────────────────────────────────────────────────────────────────────
(async () => {
    if (!O.base) { console.error('Zadej --base https://<adresa serveru>'); process.exit(2); }
    if (!O.token) { console.error('Zadej --token (nebo proměnnou LEXIS_API_TOKEN)'); process.exit(2); }
    const t0 = Date.now();
    const meta = { base: O.base, label: O.label, model: O.model, startedAt: new Date().toISOString() };
    console.log(`LexisLocal server_suite → ${O.base}`);
    const st = await get('/api/status');
    if (st.status !== 200) { console.error(`Server neodpovídá (/api/status → ${st.status} ${st.error || ''})`); process.exit(1); }
    try {
        if (phaseOn('A')) await phaseA();
        if (phaseOn('B')) await phaseB();
        if (phaseOn('C')) await phaseC();
        if (phaseOn('D')) await phaseD();
        if (phaseOn('E')) await phaseE();
        if (phaseOn('F')) await phaseF();
        if (phaseOn('K')) await phaseK();
        if (phaseOn('G')) meta.load = await phaseG();
        if (phaseOn('H')) meta.judge = await phaseH();
    } catch (e) {
        console.error('Neočekávaná chyba běhu:', e && e.stack || e);
        record('X', 'crash', 'Běh testu spadl', false, { severity: 'high', detail: String(e && e.message || e) });
    }
    if (O.cleanup) await cleanup();
    meta.durationMs = Date.now() - t0;
    const out = writeReport(meta);
    console.log(`\nHotovo: ${results.filter(r => r.ok).length}/${results.length} OK, nálezů ${findings.length}.\nReport: ${out}.md`);
    process.exit(findings.some(x => x.severity === 'critical') ? 1 : 0);
})();
