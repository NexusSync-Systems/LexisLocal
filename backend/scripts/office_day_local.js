#!/usr/bin/env node
/**
 * office_day_local.js — simulace dne v kanceláři na TOMTO počítači (Mac jako budoucí Mac mini),
 * v oddělené dočasné instalaci: vlastní datová složka, klíč a spisovna v dočasném adresáři,
 * vlastní port a náhodný token. Skutečná data LexisLocalu na počítači se nepoužijí ani nezmění.
 *
 *   1. instalace báze rešeršníka z balíčku (scratch/kb-balicek/lexis-baze-*.tar.gz, nejnovější)
 *   2. start oddělené instance backendu (127.0.0.1:<port>, firemní režim nastaví simulace)
 *   3. office_day.js (zavedení + den --hours, bez restartu), paměť backendu každou minutu
 *   4. zastavení instance, výsledky do scratch/ukoly/office_day_mac/<čas>/, smazání dočasných dat
 *
 *   node backend/scripts/office_day_local.js [--hours 3] [--port 4199] [--bez-baze] [--ponechat]
 *
 * Ollama musí běžet (model z .env / CHAT_MODEL, jako běžná aplikace). Na macOS drží počítač
 * vzhůru `caffeinate`. Spouští ho úloha spouštěče `office_day_mac`. Jen syntetická data.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = n => process.argv.includes(n);

function portFree(port) {
    return new Promise(res => {
        const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(false); });
        s.on('error', () => res(true));
        s.setTimeout(1500, () => { s.destroy(); res(true); });
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Zastavení úlohy (spouštěč pošle SIGINT): ukončit i oddělený backend a simulaci, smazat dočasná data.
const RUN = { procs: [], tmp: null };
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        console.log(`⏹  ${sig}: ukončuji simulaci a oddělenou instanci`);
        for (const p of RUN.procs) { try { p.kill('SIGTERM'); } catch (e) { /* už neběží */ } }
        setTimeout(() => { if (RUN.tmp && !has('--ponechat')) cleanup(RUN.tmp); process.exit(130); }, 5000);
    });
}

function latestKbPackage() {
    const dir = path.join(ROOT, 'scratch', 'kb-balicek');
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /^lexis-baze-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(n)).sort(); } catch (e) { /* žádný */ }
    return names.length ? path.join(dir, names[names.length - 1]) : null;
}

function rssMb(pid) {
    try { return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024); } catch (e) { return null; }
}

async function main() {
    const hours = Math.min(8, Math.max(0.1, parseFloat(arg('--hours', '3'))));
    const port = parseInt(arg('--port', '4199'), 10);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = path.join(ROOT, 'scratch', 'ukoly', 'office_day_mac', stamp);
    fs.mkdirSync(out, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-officeday-mac-'));
    RUN.tmp = tmp;
    const dirs = { data: path.join(tmp, 'data'), key: path.join(tmp, 'key'), ingest: path.join(tmp, 'spisovna') };
    Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));
    const token = crypto.randomBytes(24).toString('hex'); // jen pro tuto dočasnou instanci, nikam se nezapisuje
    const env = Object.assign({}, process.env, {
        WATCH_DIR: dirs.ingest, INGEST_DIR: dirs.ingest, LEXIS_DATA_DIR: dirs.data, LEXIS_KEY_DIR: dirs.key,
        PORT: String(port), BIND_HOST: '127.0.0.1', API_TOKEN: token, LEXIS_PILOT_LOCAL_ONLY: '1',
        LEXIS_FIRM_MODE: '', RAG_KB_SAVE_DEBOUNCE_MS: process.env.RAG_KB_SAVE_DEBOUNCE_MS || '3000',
        NODE_OPTIONS: '--max-old-space-size=8192'
    });
    delete env.LEXIS_FIRM_MODE; delete env.EMBED_CACHE_FILE;
    const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(path.join(out, 'prubeh.log'), l + '\n'); };
    log(`Simulace dne v kanceláři na tomto počítači: den ${hours} h, port ${port}, dočasná data ${tmp}`);
    if (!(await portFree(port))) { log(`❌ Port ${port} je obsazený — zvolte jiný (--port).`); process.exit(2); }
    // Ollama musí běžet — jinak by simulace měřila jen „model nedostupný“ (zkouška 27. 10. 2026)
    const oh = String(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    try {
        const r = await fetch((/^https?:/.test(oh) ? oh : 'http://' + oh) + '/api/tags', { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const models = ((await r.json()).models || []).map(m => m.name);
        log(`Ollama běží, modely: ${models.join(', ') || '(žádné)'}`);
    } catch (e) { log(`❌ Ollama neodpovídá (${oh}: ${e.message}) — spusťte ji a úlohu zopakujte.`); cleanup(tmp); process.exit(2); }

    // 1) báze
    if (!has('--bez-baze')) {
        const pkg = latestKbPackage();
        if (!pkg) log('⚠️ Balíček báze (scratch/kb-balicek/lexis-baze-*.tar.gz) nenalezen — rešerše poběží bez báze zákonů.');
        else {
            log(`Instaluji bázi z ${path.basename(pkg)} …`);
            const t0 = Date.now();
            const r = spawnSync(process.execPath, [path.join(ROOT, 'backend', 'scripts', 'kb-balicek.js'), '--instaluj', pkg, '--agent', 'resersnik'],
                { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            fs.writeFileSync(path.join(out, 'instalace-baze.log'), (r.stdout || '') + (r.stderr || ''));
            log(`Báze: kód ${r.status} za ${((Date.now() - t0) / 60000).toFixed(1)} min`);
            if (r.status !== 0) { log('❌ Instalace báze selhala (instalace-baze.log).'); cleanup(tmp); process.exit(1); }
        }
    }

    // 2) oddělená instance backendu
    const srvLog = fs.openSync(path.join(out, 'backend.log'), 'a');
    const srv = spawn(process.execPath, [path.join(ROOT, 'backend', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', srvLog, srvLog] });
    RUN.procs.push(srv);
    let caf = null;
    if (process.platform === 'darwin') { try { caf = spawn('caffeinate', ['-i', '-w', String(srv.pid)], { stdio: 'ignore' }); } catch (e) { caf = null; } }
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 180000) {
        if (!(await portFree(port))) { up = true; break; }
        await sleep(1000);
    }
    log(up ? `Backend běží (PID ${srv.pid}) po ${((Date.now() - t0) / 1000).toFixed(0)} s` : '❌ Backend nenaběhl do 3 min (backend.log).');
    if (!up) { srv.kill('SIGTERM'); cleanup(tmp); process.exit(1); }
    await sleep(60000); // předehřátí báze
    const memLog = path.join(out, 'pamet.log');
    const mem = setInterval(() => fs.appendFileSync(memLog, `${new Date().toISOString()} backend RSS MB: ${rssMb(srv.pid)} · volná RAM MB: ${Math.round(os.freemem() / 1048576)}\n`), 60000);
    fs.appendFileSync(memLog, `${new Date().toISOString()} start · backend RSS MB: ${rssMb(srv.pid)} · RAM celkem MB: ${Math.round(os.totalmem() / 1048576)}\n`);

    // 3) simulace
    // asynchronně — měření paměti (setInterval) musí běžet i během simulace
    const odLogFile = path.join(out, 'office_day.log');
    const odLog = fs.openSync(odLogFile, 'a');
    const odProc = spawn(process.execPath, [path.join(ROOT, 'backend', 'scripts', 'office_day.js'), '--base', `http://127.0.0.1:${port}`,
        '--hours', String(hours), '--out', out, '--label', 'mac', ...(has('--smoke') ? ['--smoke'] : [])], { cwd: ROOT, env: Object.assign({}, env, { LEXIS_API_TOKEN: token }), stdio: ['ignore', odLog, odLog] });
    RUN.procs.unshift(odProc);
    const odStatus = await new Promise(res => odProc.on('close', code => res(code)));
    const od = { status: odStatus };
    log(`office_day skončil s kódem ${od.status}`);
    fs.readFileSync(odLogFile, 'utf8').split('\n').filter(l => /^(  [✓✗]|Report|Kontroly)/.test(l)).forEach(l => console.log(l));

    // 4) úklid
    clearInterval(mem);
    srv.kill('SIGTERM');
    for (let i = 0; i < 60 && srv.exitCode === null; i++) await sleep(1000);
    if (srv.exitCode === null) srv.kill('SIGKILL');
    if (caf) try { caf.kill(); } catch (e) { /* už skončil */ }
    if (!has('--ponechat')) cleanup(tmp); else log(`Dočasná data ponechána: ${tmp}`);
    log(`Výsledky: ${path.relative(ROOT, out)}`);
    process.exit(od.status === 0 ? 0 : 1);
}

function cleanup(tmp) {
    // jen náš dočasný adresář (název z mkdtemp s pevným prefixem)
    if (/lexis-officeday-mac-/.test(path.basename(tmp))) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* nevadí */ }
}

main().catch(e => { console.error('❌ ' + (e.stack || e.message)); process.exit(1); });
