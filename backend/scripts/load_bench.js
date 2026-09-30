#!/usr/bin/env node
/**
 * scripts/load_bench.js — zátěžový test: kolik advokátů zvládne jedna GPU současně.
 *
 * Pro každý model a každou úroveň souběhu (--levels 1,3,5,10) pošle N SOUČASNÝCH
 * dotazů do Ollamy (každý „advokát" má jiný kontext ~ jako RAG pasáže) a změří:
 *   - čas do první odpovědi (TTFT; zahrnuje čekání ve frontě a zpracování kontextu),
 *   - rychlost generování na jednoho uživatele (tok/s na proud),
 *   - celkovou propustnost GPU (tok/s součet),
 *   - celkový čas odpovědi.
 * Výstup: tabulka v konzoli + load_bench_<čas>.md a .json do --out.
 *
 * Ollama musí mít OLLAMA_NUM_PARALLEL ≥ nejvyšší úroveň, jinak dotazy čekají ve frontě
 * (i to je užitečné měření — výchozí nastavení kanceláře).
 *
 * Použití:
 *   node backend/scripts/load_bench.js --models qwen2.5:7b --levels 1,3,5,10 \
 *        --context-file /opt/ctx.txt --out bench-results
 * Přepínače: --ctx-chars 6000 (≈ 2000 tokenů kontextu na dotaz)  --max-tokens 400
 *            --num-ctx 8192  --rounds 2 (opakování každé úrovně)  --host http://127.0.0.1:11434
 * Bez závislostí (Node 18+). Jen syntetická / veřejná data (zákony), nikdy klientské spisy.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs(argv) {
    const o = { models: [], levels: [1, 3, 5, 10], ctxChars: 6000, maxTokens: 400, numCtx: 8192, rounds: 2,
        out: 'bench-results', host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', contextFile: null, timeoutS: 900 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], next = () => argv[++i];
        if (a === '--models') o.models = next().split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--levels') o.levels = next().split(',').map(Number).filter(n => n > 0);
        else if (a === '--ctx-chars') o.ctxChars = parseInt(next(), 10);
        else if (a === '--max-tokens') o.maxTokens = parseInt(next(), 10);
        else if (a === '--num-ctx') o.numCtx = parseInt(next(), 10);
        else if (a === '--rounds') o.rounds = Math.max(1, parseInt(next(), 10));
        else if (a === '--out') o.out = next();
        else if (a === '--host') o.host = next();
        else if (a === '--context-file') o.contextFile = next();
        else if (a === '--timeout') o.timeoutS = parseInt(next(), 10);
    }
    return o;
}

const QUESTIONS = [
    'Shrň, jaká pravidla pro promlčení z uvedených ustanovení plynou, a uveď přesné citace.',
    'Klient se ptá, dokdy může uplatnit nárok. Odpověz stručně podle podkladů a cituj paragrafy.',
    'Vysvětli laicky, co z podkladů vyplývá pro běh lhůt, a na konci uveď seznam použitých ustanovení.',
    'Připrav krátkou rešerši (max. 10 vět) k otázce uvedené v podkladech, s citacemi.',
];

/** Kontext pro i-tý souběžný dotaz — jiný úsek textu, ať se nesdílí cache promptu. */
function contextSlice(text, i, chars) {
    if (!text) return '';
    const start = (i * 7919) % Math.max(1, text.length - chars);
    return text.slice(start, start + chars);
}

async function streamGenerate(host, body, timeoutS) {
    const t0 = performance.now();
    const res = await fetch(host + '/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.timeout(timeoutS * 1000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const dec = new TextDecoder();
    let buf = '', ttft = null, last = {};
    for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let k;
        while ((k = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, k); buf = buf.slice(k + 1);
            if (!line.trim()) continue;
            const o = JSON.parse(line);
            if (o.error) throw new Error(o.error);
            if (ttft === null && o.response) ttft = (performance.now() - t0) / 1000;
            last = o;
        }
    }
    if (buf.trim()) last = JSON.parse(buf);
    const wall = (performance.now() - t0) / 1000;
    return {
        ttftS: ttft ?? wall, wallS: wall, tokens: last.eval_count || 0,
        tokS: last.eval_duration ? last.eval_count / (last.eval_duration / 1e9) : 0,
        promptTokens: last.prompt_eval_count || 0,
    };
}

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

async function runLevel(o, model, n, ctxText, round) {
    const reqs = Array.from({ length: n }, (_, i) => {
        const idx = round * 97 + i;
        const ctx = contextSlice(ctxText, idx, o.ctxChars);
        return {
            model, stream: true, keep_alive: '30m',
            system: 'Jsi Rešeršník, český právní asistent. Odpovídej česky a cituj jen ustanovení z podkladů.' +
                (ctx ? `\n\nPodklady:\n${ctx}` : ''),
            prompt: QUESTIONS[idx % QUESTIONS.length],
            options: { temperature: 0.2, num_ctx: o.numCtx, num_predict: o.maxTokens },
        };
    });
    const t0 = performance.now();
    const settled = await Promise.allSettled(reqs.map(b => streamGenerate(o.host, b, o.timeoutS)));
    const levelWall = (performance.now() - t0) / 1000;
    const ok = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
    const errors = settled.filter(s => s.status === 'rejected').map(s => String(s.reason && s.reason.message || s.reason));
    return {
        n, round, ok: ok.length, errors,
        ttftP50: pct(ok.map(r => r.ttftS), 50), ttftP95: pct(ok.map(r => r.ttftS), 95),
        tokSPerUser: avg(ok.map(r => r.tokS)),
        aggTokS: ok.reduce((a, r) => a + r.tokens, 0) / levelWall,
        wallP50: pct(ok.map(r => r.wallS), 50), wallMax: Math.max(0, ...ok.map(r => r.wallS)),
        promptTokens: avg(ok.map(r => r.promptTokens)),
    };
}

function mergeRounds(rows) {
    // pro každou úroveň: horší (vyšší) časy a nižší rychlosti z kol = konzervativní odhad
    const by = new Map();
    for (const r of rows) (by.get(r.n) || by.set(r.n, []).get(r.n)).push(r);
    return [...by.entries()].map(([n, rs]) => ({
        n, ok: rs.reduce((a, r) => a + r.ok, 0), total: n * rs.length,
        errors: rs.flatMap(r => r.errors),
        ttftP50: avg(rs.map(r => r.ttftP50)), ttftP95: Math.max(...rs.map(r => r.ttftP95)),
        tokSPerUser: avg(rs.map(r => r.tokSPerUser)), aggTokS: avg(rs.map(r => r.aggTokS)),
        wallP50: avg(rs.map(r => r.wallP50)), wallMax: Math.max(...rs.map(r => r.wallMax)),
        promptTokens: avg(rs.map(r => r.promptTokens)),
    }));
}

async function gpuName() {
    try { return require('child_process').execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', { timeout: 5000 }).toString().trim(); }
    catch { return 'bez NVIDIA GPU / neznámé'; }
}

function toMarkdown(meta, results) {
    const L = [`# LexisLocal — zátěžový test (souběžní uživatelé)`, '',
        `- Datum: ${meta.date}`, `- Stroj: ${meta.host} · ${meta.cpus} CPU · ${meta.ramGb} GB RAM · GPU: ${meta.gpu}`,
        `- Kontext na dotaz: ~${meta.ctxChars} znaků (≈ ${Math.round(meta.ctxChars / 3)} tokenů), odpověď max. ${meta.maxTokens} tokenů, num_ctx ${meta.numCtx}`,
        `- OLLAMA_NUM_PARALLEL: ${meta.numParallel || 'výchozí'} · kol na úroveň: ${meta.rounds}`, '',
        '> Pro plynulou práci: první slova do ~3 s (TTFT p95) a ≥ 10 tok/s na uživatele (rychleji, než se čte).', ''];
    for (const r of results) {
        L.push(`## ${r.model}`, '', '| Souběžně | OK | TTFT p50 (s) | TTFT p95 (s) | tok/s na uživatele | Propustnost GPU (tok/s) | Odpověď p50 (s) | Nejdelší (s) |',
            '|---|---|---|---|---|---|---|---|');
        for (const l of r.levels) {
            L.push(`| ${l.n} | ${l.ok}/${l.total} | ${f1(l.ttftP50)} | ${f1(l.ttftP95)} | ${f1(l.tokSPerUser)} | ${f1(l.aggTokS)} | ${f1(l.wallP50)} | ${f1(l.wallMax)} |`);
        }
        const errs = r.levels.flatMap(l => l.errors);
        if (errs.length) L.push('', `Chyby: ${[...new Set(errs)].slice(0, 5).join('; ')}`);
        L.push('');
    }
    return L.join('\n');
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (!o.models.length) { console.error('Použij --models a,b'); process.exit(1); }
    const ctxText = o.contextFile ? fs.readFileSync(o.contextFile, 'utf8').replace(/\s+/g, ' ') : '';
    const meta = { date: new Date().toISOString(), host: os.hostname(), cpus: os.cpus().length,
        ramGb: Math.round(os.totalmem() / 1e9), gpu: await gpuName(), ctxChars: ctxText ? o.ctxChars : 0,
        maxTokens: o.maxTokens, numCtx: o.numCtx, rounds: o.rounds, numParallel: process.env.OLLAMA_NUM_PARALLEL || null };
    fs.mkdirSync(o.out, { recursive: true });
    const stamp = meta.date.replace(/[:.]/g, '-').slice(0, 19);
    const results = [];
    const save = () => {
        fs.writeFileSync(path.join(o.out, `load_bench_${stamp}.json`), JSON.stringify({ meta, results }, null, 2));
        fs.writeFileSync(path.join(o.out, `load_bench_${stamp}.md`), toMarkdown(meta, results));
    };
    console.log(`🏋️  Zátěžový test — ${o.models.join(', ')} · úrovně ${o.levels.join('/')} · GPU: ${meta.gpu}`);
    for (const model of o.models) {
        console.log(`\n▶ ${model}`);
        try { await streamGenerate(o.host, { model, prompt: 'ano', keep_alive: '30m', options: { num_predict: 1, num_ctx: o.numCtx } }, 1800); }
        catch (e) { console.log(`   ⚠️  zahřátí selhalo: ${e.message}`); results.push({ model, levels: [], error: e.message }); save(); continue; }
        const rows = [];
        for (const n of o.levels) {
            for (let r = 0; r < o.rounds; r++) {
                const row = await runLevel(o, model, n, ctxText, r);
                rows.push(row);
                console.log(`   ${String(n).padStart(2)} souběžně (kolo ${r + 1}): TTFT p50 ${f1(row.ttftP50)} s / p95 ${f1(row.ttftP95)} s · ${f1(row.tokSPerUser)} tok/s na uživatele · GPU ${f1(row.aggTokS)} tok/s · ${row.ok}/${n} OK`);
            }
        }
        results.push({ model, levels: mergeRounds(rows) });
        save();
    }
    console.log(`\n📄 ${path.join(o.out, `load_bench_${stamp}.md`)}`);
}

if (require.main === module) main().catch(e => { console.error('❌', e.message); process.exit(1); });
module.exports = { parseArgs, contextSlice, mergeRounds, pct, toMarkdown };
