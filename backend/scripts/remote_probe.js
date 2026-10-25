#!/usr/bin/env node
/**
 * remote_probe.js — měření LexisLocalu přes síť (vzdálený přístup na server kanceláře).
 *
 * Měří, co uživatel reálně zažije: síťovou odezvu (GET /api/status), dobu celé
 * odpovědi agenta (POST /api/agent/<id>) jednotlivě i při souběhu. Pusť jednou na
 * serveru proti https://127.0.0.1 (základ bez sítě) a jednou z počítače advokáta
 * proti veřejné adrese — rozdíl je cena vzdáleného přístupu.
 *
 *   node backend/scripts/remote_probe.js --base https://1.2.3.4 --token <token> --insecure
 *   volby: --agent resersnik --levels 1,2,4 --rounds 2 --out <složka> --label vzdáleně
 *
 * --insecure: přijme self-signed certifikát (testovací server). Bez závislostí, Node ≥ 18.
 * Jen syntetické dotazy — žádná klientská data.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PROMPTS = [
    'Jaká je obecná promlčecí lhůta podle občanského zákoníku a odkdy běží?',
    'Jaká je lhůta k podání odvolání proti rozsudku okresního soudu a odkdy se počítá?',
    'Jaká je výpovědní doba, když pronajímatel vypovídá nájem bytu na dobu neurčitou?',
    'Kdy může jednatel s.r.o. odpovídat za škodu společnosti a co je péče řádného hospodáře?',
    'Do kdy může klient žalovat náhradu škody z vytopení bytu sousedem?'
];

function parseArgs(argv) {
    const o = { base: null, token: process.env.LEXIS_API_TOKEN || '', agent: 'resersnik', levels: [1, 2, 4], rounds: 2, insecure: false, out: null, label: '', pings: 10 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], n = () => argv[++i];
        if (a === '--base') o.base = String(n()).replace(/\/+$/, '');
        else if (a === '--token') o.token = n();
        else if (a === '--agent') o.agent = n();
        else if (a === '--levels') o.levels = n().split(',').map(Number).filter(x => x > 0);
        else if (a === '--rounds') o.rounds = Math.max(1, parseInt(n(), 10) || 1);
        else if (a === '--pings') o.pings = Math.max(1, parseInt(n(), 10) || 10);
        else if (a === '--insecure') o.insecure = true;
        else if (a === '--out') o.out = n();
        else if (a === '--label') o.label = n();
    }
    return o;
}

function request(o, method, urlPath, body) {
    return new Promise((resolve) => {
        const u = new URL(o.base + urlPath);
        const lib = u.protocol === 'https:' ? https : http;
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const t0 = process.hrtime.bigint();
        let tFirst = null;
        const req = lib.request({
            method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname,
            rejectUnauthorized: !o.insecure, timeout: 600000,
            headers: { 'X-API-Token': o.token, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }
        }, (res) => {
            const chunks = [];
            res.on('data', c => { if (tFirst === null) tFirst = process.hrtime.bigint(); chunks.push(c); });
            res.on('end', () => {
                const ms = Number(process.hrtime.bigint() - t0) / 1e6;
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, ms, firstByteMs: tFirst ? Number(tFirst - t0) / 1e6 : ms, bytes: text.length, text });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, error: e.message }));
        if (data) req.write(data);
        req.end();
    });
}

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const r1 = x => x == null ? '—' : (Math.round(x * 10) / 10).toString();

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (!o.base) { console.error('Zadej --base https://<adresa serveru>'); process.exit(2); }
    if (!o.token) { console.error('Zadej --token (nebo LEXIS_API_TOKEN)'); process.exit(2); }
    const result = { label: o.label, base: o.base.replace(/\/\/[^/]+/, '//<server>'), date: new Date().toISOString(), agent: o.agent, ping: null, levels: [] };

    // 1) Síťová odezva + kontrola tokenu
    const noTok = await request({ ...o, token: '' }, 'GET', '/api/status');
    result.tokenEnforced = noTok.status === 401;
    const pings = [];
    for (let i = 0; i < o.pings; i++) { const r = await request(o, 'GET', '/api/status'); if (r.status === 200) pings.push(r.ms); }
    result.ping = { ok: pings.length, p50: pct(pings, 50), p95: pct(pings, 95) };
    console.log(`🔐 bez tokenu: HTTP ${noTok.status} ${result.tokenEnforced ? '(správně odmítnuto)' : '(!! NEODMÍTNUTO)'}`);
    console.log(`📶 odezva /api/status: p50 ${r1(result.ping.p50)} ms, p95 ${r1(result.ping.p95)} ms (${pings.length}/${o.pings} OK)`);

    // 2) Agent jednotlivě i v souběhu
    for (const lvl of o.levels) {
        const times = []; let fails = 0, bytes = 0;
        for (let round = 0; round < o.rounds; round++) {
            const jobs = Array.from({ length: lvl }, (_, i) => request(o, 'POST', `/api/agent/${encodeURIComponent(o.agent)}`,
                { prompt: PROMPTS[(round * lvl + i) % PROMPTS.length] }));
            for (const r of await Promise.all(jobs)) {
                if (r.status === 200) { times.push(r.ms / 1000); bytes += r.bytes; } else { fails++; console.log(`   !! HTTP ${r.status} ${r.error || (r.text || '').slice(0, 120)}`); }
            }
        }
        const row = { level: lvl, ok: times.length, fail: fails, p50: pct(times, 50), p95: pct(times, 95), max: times.length ? Math.max(...times) : null, avgBytes: times.length ? Math.round(bytes / times.length) : 0 };
        result.levels.push(row);
        console.log(`🤖 souběžně ${lvl}: OK ${row.ok}, chyb ${row.fail}, odpověď p50 ${r1(row.p50)} s, p95 ${r1(row.p95)} s, max ${r1(row.max)} s`);
    }

    // 3) Výstup
    const md = [
        `# LexisLocal — síťový test ${o.label ? '(' + o.label + ')' : ''}`, '',
        `- Datum: ${result.date}`, `- Agent: ${o.agent}`,
        `- Token vynucen: ${result.tokenEnforced ? 'ano (bez tokenu 401)' : 'NE'}`,
        `- Odezva /api/status: p50 ${r1(result.ping.p50)} ms, p95 ${r1(result.ping.p95)} ms`, '',
        '| Souběžně | OK | Chyby | Odpověď p50 (s) | p95 (s) | Max (s) |', '|---|---|---|---|---|---|',
        ...result.levels.map(r => `| ${r.level} | ${r.ok} | ${r.fail} | ${r1(r.p50)} | ${r1(r.p95)} | ${r1(r.max)} |`), ''
    ].join('\n');
    if (o.out) {
        fs.mkdirSync(o.out, { recursive: true });
        const ts = result.date.replace(/[:.]/g, '-').slice(0, 19);
        const base = path.join(o.out, `remote_probe_${o.label ? o.label.replace(/\W+/g, '_') + '_' : ''}${ts}`);
        fs.writeFileSync(base + '.md', md); fs.writeFileSync(base + '.json', JSON.stringify(result, null, 2));
        console.log(`📄 ${base}.md`);
    } else console.log('\n' + md);
}

if (require.main === module) main().catch(e => { console.error('❌', e.message); process.exit(1); });
module.exports = { parseArgs, pct };
