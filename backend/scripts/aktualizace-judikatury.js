#!/usr/bin/env node
/**
 * aktualizace-judikatury.js — měsíční doplnění judikatury do báze rešeršníka.
 *
 *  1) stáhne nová rozhodnutí: ÚS z NALUS (posledních --dni dní, výchozí 60), Sbírka NSS
 *     a Sbírka NS od loňského roku (skripty navazují — co už je staženo, přeskočí),
 *  2) porovná složky před/po a vypíše nová rozhodnutí,
 *  3) nová rozhodnutí nahraje do báze rešeršníka přes API běžícího serveru (seed-kb
 *     přeskočí, co v bázi už je). Server neběží → jen stažení, nahrání příště.
 *  4) zapíše souhrn do scratch/ukoly/aktualizace-judikatury-<datum>.md.
 *
 *   node backend/scripts/aktualizace-judikatury.js [--dni 60] [--bez-nahrani]
 *
 * Jen veřejné zdroje (NALUS, sbirka.nsoud.cz, sbirka.nssoud.cz) s pauzami jako při ručním
 * stahování. Spouští ho spouštěč úloh (úloha aktualizace_judikatury) nebo ručně.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch (e) { /* bez dotenv */ }
const NODE = process.execPath;
const TOKEN_FILE = path.join(os.homedir(), '.lexislocal', 'api_token');

const ZDROJE = [
    { nazev: 'ÚS (NALUS)', dir: 'judikatura-us', args: (o) => ['backend/scripts/fetch-us.js', '--nalus', '--od', o.od, '--out', './judikatura-us'] },
    { nazev: 'NSS (Sbírka)', dir: 'judikatura-nss', args: (o) => ['backend/scripts/fetch-nss-sbirka.js', '--out', './judikatura-nss', '--od-roku', String(o.odRoku)] },
    { nazev: 'NS (Sbírka)', dir: 'judikatura-ns', args: (o) => ['backend/scripts/fetch-ns-sbirka.js', '--out', './judikatura-ns', '--od-roku', String(o.odRoku), '--by-druh'] },
];

function listTxt(dir) {
    const out = new Set();
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else if (/\.txt$/i.test(e.name)) out.add(path.relative(dir, p));
    } };
    if (fs.existsSync(dir)) walk(dir);
    return out;
}

function run(args, label) {
    return new Promise(resolve => {
        console.log(`\n▶ ${label}: node ${args.join(' ')}`);
        const ch = spawn(NODE, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        let tail = '';
        const feed = b => { const s = String(b); process.stdout.write(s); tail = (tail + s).slice(-2000); };
        ch.stdout.on('data', feed); ch.stderr.on('data', feed);
        ch.on('close', code => resolve({ code, tail }));
        ch.on('error', e => resolve({ code: -1, tail: e.message }));
    });
}

function ddmmyyyy(d) { return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`; }

/** Běží server? Jen zkouška spojení na port (bez HTTP/TLS); vrátí základ URL pro seed-kb. */
async function serverUrl() {
    const port = Number(process.env.PORT || 4000);
    const https = String(process.env.USE_HTTPS || '').toLowerCase() === 'true';
    const ok = await new Promise(res => {
        const s = require('net').connect({ port, host: '127.0.0.1' });
        const done = v => { s.destroy(); res(v); };
        s.setTimeout(2000, () => done(false)); s.on('connect', () => done(true)); s.on('error', () => done(false));
    });
    return ok ? `${https ? 'https' : 'http'}://127.0.0.1:${port}` : null;
}

async function main(argv) {
    const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
    const dni = Math.max(7, Math.min(400, parseInt(arg('--dni') || '60', 10) || 60));
    const now = new Date();
    const o = { od: ddmmyyyy(new Date(now.getTime() - dni * 86400000)), odRoku: now.getFullYear() - 1 };
    const souhrn = [`# Aktualizace judikatury — ${now.toISOString().slice(0, 10)}`, '', `ÚS od ${o.od}, NS a NSS od roku ${o.odRoku}.`, ''];
    const nove = {};
    let chyby = 0;

    for (const z of ZDROJE) {
        const dir = path.join(ROOT, z.dir);
        const pred = listTxt(dir);
        const r = await run(z.args(o), z.nazev);
        const po = listTxt(dir);
        nove[z.dir] = [...po].filter(f => !pred.has(f)).sort();
        if (r.code !== 0) chyby++;
        souhrn.push(`- **${z.nazev}**: ${nove[z.dir].length} nových${r.code !== 0 ? ` — ⚠️ skript skončil kódem ${r.code}` : ''}`);
    }
    const celkem = Object.values(nove).reduce((n, a) => n + a.length, 0);

    let nahrano = 'nic nového';
    if (celkem && argv.includes('--bez-nahrani')) nahrano = 'přeskočeno (--bez-nahrani)';
    else if (celkem) {
        const url = await serverUrl();
        if (!url) nahrano = '⚠️ server neběží — rozhodnutí jsou stažená, nahrají se při příští aktualizaci (nebo úloha seed_kb)';
        else {
            const res = [];
            for (const z of ZDROJE) {
                if (!nove[z.dir].length) continue;
                const r = await run(['backend/scripts/seed-kb.js', '--agent', 'resersnik', '--dir', './' + z.dir, '--api', url, '--token-file', TOKEN_FILE], `nahrání ${z.dir}`);
                const m = /Hotovo:[^\n]*/.exec(r.tail);
                res.push(`${z.dir}: ${m ? m[0] : `kód ${r.code}`}`);
                if (r.code !== 0) chyby++;
            }
            nahrano = res.join('; ');
        }
    }
    souhrn.push('', `Nahrání do báze rešeršníka: ${nahrano}`, '');
    for (const [d, list] of Object.entries(nove)) {
        if (!list.length) continue;
        souhrn.push(`## ${d} (${list.length})`, ...list.slice(0, 200).map(f => `- ${f}`), list.length > 200 ? `- … a dalších ${list.length - 200}` : '', '');
    }
    const outDir = path.join(ROOT, 'scratch', 'ukoly');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `aktualizace-judikatury-${now.toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(out, souhrn.join('\n'));
    console.log(`\n📝 Souhrn: ${path.relative(ROOT, out)} — nových rozhodnutí ${celkem}${chyby ? `, chyb ${chyby}` : ''}`);
    return chyby ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error('❌ ' + e.message); process.exit(1); });

module.exports = { listTxt, ddmmyyyy, ZDROJE };
