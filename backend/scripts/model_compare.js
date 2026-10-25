#!/usr/bin/env node
/**
 * model_compare.js — srovnání modelů na stejné eval sadě agentů (fáze E server_suite).
 *
 * Pro každý model spustí `server_suite.js --only E --model <m>` proti běžícímu serveru
 * (podklady D už musí být nahrané — spusťte nejdřív plnou sadu) a ze vzniklých JSON
 * reportů složí srovnávací tabulku: úspěšnost celkem, po kategoriích, latence, případ po případu.
 *
 *   node backend/scripts/model_compare.js --base https://127.0.0.1 --token <t> --insecure \
 *        --models qwen2.5:7b,qwen3.5:9b,llama3.1:8b,granite4.2:8b [--repeat 1] [--out <dir>]
 *
 * Modely musí být na serveru stažené (ollama pull). Nestažený model se v tabulce označí.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function args(argv) {
    const o = { base: null, token: process.env.LEXIS_API_TOKEN || '', insecure: false, models: [], repeat: 1,
        out: path.join(__dirname, '..', 'eval', 'server_suite', 'reports') };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], n = () => argv[++i];
        if (a === '--base') o.base = n();
        else if (a === '--token') o.token = n();
        else if (a === '--insecure') o.insecure = true;
        else if (a === '--models') o.models = n().split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--repeat') o.repeat = Math.max(1, parseInt(n(), 10) || 1);
        else if (a === '--out') o.out = n();
    }
    return o;
}

const slug = (m) => 'cmp-' + m.replace(/[^\w.-]/g, '_');

function newestReport(dir, label) {
    if (!fs.existsSync(dir)) return null;
    const f = fs.readdirSync(dir).filter(x => x.endsWith('_' + label.replace(/[^\w-]/g, '') + '.json')).sort().pop();
    return f ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null;
}

function summarize(rep) {
    const runs = rep.agentRuns || [];
    const cases = (rep.results || []).filter(r => r.phase === 'E' && !/^E-/.test(r.id));
    const pass = cases.filter(r => r.ok).length;
    const ms = runs.map(r => r.ms).filter(Number.isFinite).sort((a, b) => a - b);
    const p50 = ms.length ? ms[Math.floor(ms.length / 2)] : null;
    const simulated = runs.filter(r => r.simulated).length;
    return { pass, n: cases.length, byCat: rep.byCat || {}, p50, simulated, perCase: Object.fromEntries(cases.map(r => [r.id, r.ok])) };
}

(function main() {
    const O = args(process.argv.slice(2));
    if (!O.base || !O.token || !O.models.length) {
        console.error('Použití: --base <url> --token <t> --models m1,m2,… [--insecure] [--repeat N]');
        process.exit(2);
    }
    const suite = path.join(__dirname, 'server_suite.js');
    const rows = [];
    for (const m of O.models) {
        console.log(`\n══ Model ${m} ══`);
        const a = [suite, '--base', O.base, '--token', O.token, '--only', 'E', '--model', m, '--label', slug(m), '--out', O.out, '--repeat', String(O.repeat)];
        if (O.insecure) a.push('--insecure');
        const r = spawnSync(process.execPath, a, { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
        const rep = newestReport(O.out, slug(m));
        rows.push({ model: m, exit: r.status, s: rep ? summarize(rep) : null });
    }

    const cats = [...new Set(rows.flatMap(r => (r.s ? Object.keys(r.s.byCat) : [])))].sort();
    const ids = [...new Set(rows.flatMap(r => (r.s ? Object.keys(r.s.perCase) : [])))].sort();
    const L = ['# Srovnání modelů — agenti (fáze E)', '', `- Server: ${O.base} · ${new Date().toISOString()} · opakování ${O.repeat}`,
        '- Stejné zadání, stejné podklady, stejné deterministické doplňky (doložky, lhůty, název zákona) — liší se jen model.', '',
        '| Model | Prošlo | Medián odpovědi | Fallback (model nedostupný) |', '|---|---|---|---|'];
    for (const r of rows) {
        if (!r.s) { L.push(`| ${r.model} | — (běh selhal, exit ${r.exit}) | | |`); continue; }
        L.push(`| ${r.model} | **${r.s.pass}/${r.s.n}** | ${r.s.p50 != null ? (r.s.p50 / 1000).toFixed(1) + ' s' : '—'} | ${r.s.simulated} |`);
    }
    if (cats.length) {
        L.push('', '## Po kategoriích (prošlo / průměrné skóre)', '', '| Kategorie | ' + rows.map(r => r.model).join(' | ') + ' |', '|---|' + rows.map(() => '---|').join(''));
        for (const c of cats) L.push(`| ${c} | ` + rows.map(r => { const v = r.s && r.s.byCat[c]; return v ? `${v.pass}/${v.n} · ${Math.round(v.score / v.n * 100)} %` : '—'; }).join(' | ') + ' |');
    }
    if (ids.length) {
        L.push('', '## Případ po případu', '', '| Případ | ' + rows.map(r => r.model).join(' | ') + ' |', '|---|' + rows.map(() => '---|').join(''));
        for (const id of ids) L.push(`| ${id} | ` + rows.map(r => (r.s && id in r.s.perCase) ? (r.s.perCase[id] ? '✅' : '❌') : '—').join(' | ') + ' |');
    }
    fs.mkdirSync(O.out, { recursive: true });
    const file = path.join(O.out, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_model-compare.md`);
    fs.writeFileSync(file, L.join('\n'));
    console.log('\n' + L.join('\n') + `\n\nReport: ${file}`);
})();
