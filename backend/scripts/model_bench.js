#!/usr/bin/env node
/**
 * scripts/model_bench.js — srovnání chat modelů (Ollama) pro LexisLocal.
 *
 * Pro každý model projede sadu SYNTETICKÝCH právních úloh (backend/eval/model_bench.json)
 * se skutečnými systémovými prompty agentů (backend/prompts.json) a změří:
 *   - kvalitu: automatické kontroly (klíčová fakta, [Doplnit...] místo vymyšlených údajů,
 *     čeština bez angličtiny, validní JSON, odmítnutí neexistujícího §),
 *   - rychlost: tokeny/s generování, čas do první odpovědi, celkový čas úlohy,
 *   - paměť: VRAM / RAM modelu podle `ollama ps`,
 *   - volitelně známku 1–5 od silnějšího „soudce" (--judge).
 * Výsledek: tabulka v konzoli + bench-results/model_bench_<čas>.md a .json.
 *
 * Běží kdekoli, kde běží Ollama (Mac, PC kanceláře, GPU instance v AWS).
 * Nepoužívá žádné závislosti (Node 18+ kvůli fetch).
 *
 * Použití:
 *   node backend/scripts/model_bench.js                       # výchozí kandidáti
 *   node backend/scripts/model_bench.js --models llama3,qwen2.5:7b,gemma3:12b
 *   node backend/scripts/model_bench.js --cpu                 # simulace PC bez GPU
 *   node backend/scripts/model_bench.js --judge qwen2.5:32b   # + známka od soudce
 *   node backend/scripts/model_bench.js --only spisovatel     # jen úlohy jednoho agenta
 * Další přepínače: --cases <soubor>  --out <složka>  --num-ctx 8192  --no-pull
 *                  --timeout 600 (s na jednu odpověď)  --host http://127.0.0.1:11434
 *
 * DŮLEŽITÉ: do sady úloh nikdy nedávat skutečné klientské spisy — skript se pouští
 * i v cloudu. Jen syntetická nebo plně anonymizovaná data.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Kandidáti, pokud nejsou zadány --models. Pořadí = pořadí testu (malé napřed).
// Tagy, které v Ollamě neexistují, se přeskočí s varováním.
const DEFAULT_MODELS = [
    'qwen2.5:3b',        // dnešní volba setup.js pro slabý HW
    'gemma3:4b',
    'llama3',            // dnešní výchozí CHAT_MODEL (8B)
    'llama3.1:8b',
    'qwen2.5:7b',
    'qwen3:8b',
    'gemma3:12b',
    'mistral-nemo:12b',
    'qwen2.5:14b',
    'qwen3:14b',
    'gemma3:27b'         // ~17 GB — ještě se vejde do 24 GB VRAM (L4 / A10G)
];

// ---------------------------------------------------------------- argumenty
function parseArgs(argv) {
    const out = {
        models: null, cases: null, out: null, judge: null, only: null,
        cpu: false, pull: true, numCtx: 8192, timeoutS: 600,
        host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--models') out.models = next().split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--cases') out.cases = next();
        else if (a === '--out') out.out = next();
        else if (a === '--judge') out.judge = next();
        else if (a === '--only') out.only = next();
        else if (a === '--cpu') out.cpu = true;
        else if (a === '--no-pull') out.pull = false;
        else if (a === '--num-ctx') out.numCtx = parseInt(next(), 10) || 8192;
        else if (a === '--timeout') out.timeoutS = parseInt(next(), 10) || 600;
        else if (a === '--host') out.host = next();
        else if (a === '--help' || a === '-h') out.help = true;
    }
    if (!/^https?:\/\//.test(out.host)) out.host = 'http://' + out.host;
    out.host = out.host.replace(/\/+$/, '');
    return out;
}

// ---------------------------------------------------------------- Ollama API
async function ollama(host, endpoint, body, timeoutS) {
    const res = await fetch(host + endpoint, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutS * 1000)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
}

async function ensureModel(host, model, pull) {
    const tags = await ollama(host, '/api/tags', null, 30);
    const have = (tags.models || []).some(m => m.name === model || m.name === model + ':latest');
    if (have) return true;
    if (!pull) return false;
    process.stdout.write(`   ⬇️  stahuji ${model} … `);
    try {
        await ollama(host, '/api/pull', { model, name: model, stream: false }, 3600);
        console.log('hotovo');
        return true;
    } catch (e) {
        console.log(`nelze (${e.message.split('\n')[0]})`);
        return false;
    }
}

async function unloadAll(host) {
    try {
        const ps = await ollama(host, '/api/ps', null, 30);
        for (const m of ps.models || []) {
            await ollama(host, '/api/generate', { model: m.name, keep_alive: 0 }, 60);
        }
    } catch { /* starší Ollama bez /api/ps — nevadí */ }
}

async function memoryOf(host, model) {
    try {
        const ps = await ollama(host, '/api/ps', null, 30);
        const m = (ps.models || []).find(x => x.name === model || x.name === model + ':latest');
        if (!m) return null;
        return { sizeGb: m.size / 1e9, vramGb: (m.size_vram || 0) / 1e9 };
    } catch { return null; }
}

// ---------------------------------------------------------------- kontroly kvality
const EN_STOPWORDS = ['the', 'and', 'is', 'are', 'of', 'to', 'with', 'this', 'that', 'for', 'you', 'your', 'please', 'however'];

/** Podíl anglických stop-slov v textu (0–1). Čeština by měla být ~0. */
function englishRatio(text) {
    const words = (text.toLowerCase().match(/[a-záčďéěíňóřšťúůýž]+/g) || []);
    if (!words.length) return 0;
    const en = words.filter(w => EN_STOPWORDS.includes(w)).length;
    return en / words.length;
}

/** Vytáhne první JSON objekt/pole z odpovědi (modely rády přidají ```json … ```). */
function extractJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.search(/[[{]/);
    if (start < 0) return null;
    for (let end = candidate.length; end > start; end--) {
        const ch = candidate[end - 1];
        if (ch !== '}' && ch !== ']') continue;
        try { return JSON.parse(candidate.slice(start, end)); } catch { /* zkus kratší */ }
    }
    return null;
}

const rx = (p) => new RegExp(p, 'iu');

/**
 * Vyhodnotí odpověď podle kontrol případu. Vrací seznam {name, pass, detail}.
 * Kontroly:
 *   mustInclude:    [[alternativa, …], …] — každá skupina musí mít aspoň jednu shodu
 *   mustNotInclude: [regex, …]             — žádný nesmí sednout
 *   czech: true                            — max. 2 % anglických stop-slov
 *   json: { required: ["klíč", …] }        — odpověď obsahuje validní JSON s klíči
 *   maxWords: n                            — odpověď nemá být delší
 */
function runChecks(testCase, answer) {
    const checks = [];
    const c = testCase.checks || {};
    for (const group of c.mustInclude || []) {
        const alts = Array.isArray(group) ? group : [group];
        const ok = alts.some(p => rx(p).test(answer));
        checks.push({ name: `obsahuje: ${alts[0]}`, pass: ok });
    }
    for (const p of c.mustNotInclude || []) {
        const m = answer.match(rx(p));
        checks.push({ name: `neobsahuje: ${p}`, pass: !m, detail: m ? `nalezeno „${m[0]}“` : undefined });
    }
    if (c.czech) {
        const r = englishRatio(answer);
        checks.push({ name: 'čeština bez angličtiny', pass: r <= 0.02, detail: `${(r * 100).toFixed(1)} % EN slov` });
    }
    if (c.json) {
        const obj = extractJson(answer);
        const missing = obj ? (c.json.required || []).filter(k => !(k in obj)) : null;
        checks.push({
            name: 'validní JSON',
            pass: !!obj && missing.length === 0,
            detail: !obj ? 'JSON nenalezen' : (missing.length ? `chybí ${missing.join(', ')}` : undefined)
        });
    }
    if (c.maxWords) {
        const n = answer.split(/\s+/).filter(Boolean).length;
        checks.push({ name: `max ${c.maxWords} slov`, pass: n <= c.maxWords, detail: `${n} slov` });
    }
    return checks;
}

// ---------------------------------------------------------------- soudce (volitelně)
const JUDGE_PROMPT = `Jsi přísný hodnotitel výstupů právního AI asistenta pro českou advokacii.
Ohodnoť ODPOVĚĎ na ZADÁNÍ známkou 1–5:
5 = věcně správně, úplně, profesionální čeština, nic nevymyšleného
4 = drobné nedostatky
3 = použitelné po úpravě
2 = podstatné chyby nebo vymyšlené údaje/paragrafy
1 = nepoužitelné
Vrať POUZE JSON: {"znamka": <1-5>, "duvod": "<jedna věta>"}`;

async function judge(host, judgeModel, testCase, answer, opts) {
    const prompt = `ZADÁNÍ:\n${testCase.prompt}\n\n${testCase.reference ? `CO MÁ ODPOVĚĎ OBSAHOVAT (reference):\n${testCase.reference}\n\n` : ''}ODPOVĚĎ:\n${answer}`;
    const r = await ollama(host, '/api/generate', {
        model: judgeModel, system: JUDGE_PROMPT, prompt, stream: false, format: 'json',
        options: { temperature: 0, num_ctx: opts.numCtx }
    }, opts.timeoutS);
    const obj = extractJson(r.response || '') || {};
    const score = Math.max(1, Math.min(5, Number(obj.znamka) || 0)) || null;
    return { score, reason: obj.duvod || '' };
}

// ---------------------------------------------------------------- běh
function loadSystemPrompts() {
    try { return require('../prompts.json'); } catch { return {}; }
}

async function benchModel(host, model, cases, prompts, opts) {
    await unloadAll(host); // férové měření načtení a paměti
    const options = { temperature: 0.2, seed: 42, num_ctx: opts.numCtx };
    if (opts.cpu) options.num_gpu = 0;

    // Zahřátí = změření načtení modelu do paměti.
    const t0 = Date.now();
    const warm = await ollama(host, '/api/generate', { model, prompt: 'Odpověz jedním slovem: ano.', stream: false, options }, opts.timeoutS);
    const loadS = (warm.load_duration || (Date.now() - t0) * 1e6) / 1e9;
    const mem = await memoryOf(host, model);

    const results = [];
    for (const tc of cases) {
        const system = tc.system || prompts[tc.agent] || '';
        let r, error = null;
        const started = Date.now();
        try {
            r = await ollama(host, '/api/generate', { model, system, prompt: tc.prompt, stream: false, options }, opts.timeoutS);
        } catch (e) { error = e.message; }
        const wallS = (Date.now() - started) / 1000;
        const answer = r ? (r.response || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '';
        const checks = error ? [{ name: 'odpověď', pass: false, detail: error }] : runChecks(tc, answer);
        const genTokS = r && r.eval_duration ? r.eval_count / (r.eval_duration / 1e9) : null;
        const ttftS = r ? ((r.prompt_eval_duration || 0) + (r.load_duration || 0)) / 1e9 : null;
        const judged = null; // soudce běží až po všech modelech (viz judgeAll)
        const passed = checks.filter(c => c.pass).length;
        results.push({ id: tc.id, agent: tc.agent, wallS, genTokS, ttftS, tokens: r ? r.eval_count : 0, passed, total: checks.length, checks, judge: judged, answer, error });
        const mark = passed === checks.length ? '✅' : (passed ? '🟡' : '❌');
        console.log(`   ${mark} ${tc.id.padEnd(34)} ${passed}/${checks.length}  ${genTokS ? genTokS.toFixed(1).padStart(6) + ' tok/s' : '     —      '}  ${wallS.toFixed(1)} s`);
    }
    return { model, loadS, mem, results, summary: summarize(results) };
}

/**
 * Soudce hodnotí až po doběhnutí všech modelů — v paměti je tak vždy jen jeden
 * model (soudce 30B+ by se jinak s testovaným modelem do 24 GB VRAM nevešel).
 */
async function judgeAll(host, runs, cases, opts) {
    await unloadAll(host);
    console.log(`⚖️  Soudce ${opts.judge} hodnotí odpovědi…`);
    const byId = Object.fromEntries(cases.map(c => [c.id, c]));
    for (const run of runs.filter(r => !r.skipped)) {
        for (const x of run.results) {
            if (x.error) continue;
            try { x.judge = await judge(host, opts.judge, byId[x.id], x.answer, opts); }
            catch (e) { x.judge = { score: null, reason: e.message }; }
        }
        run.summary = summarize(run.results);
        console.log(`   ${run.model.padEnd(20)} ⌀ ${f1(run.summary.judge, 2)} / 5`);
    }
    console.log('');
}

function avg(xs) { const v = xs.filter(x => typeof x === 'number' && isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

function summarize(results) {
    const checksPassed = results.reduce((a, r) => a + r.passed, 0);
    const checksTotal = results.reduce((a, r) => a + r.total, 0);
    return {
        quality: checksTotal ? checksPassed / checksTotal : 0,
        casesFullyPassed: results.filter(r => r.total && r.passed === r.total).length,
        cases: results.length,
        tokS: avg(results.map(r => r.genTokS)),
        ttftS: avg(results.map(r => r.ttftS)),
        wallS: avg(results.map(r => r.wallS)),
        judge: avg(results.map(r => r.judge && r.judge.score))
    };
}

// ---------------------------------------------------------------- výstup
const f1 = (x, d = 1) => (x == null ? '—' : x.toFixed(d));

function rankRows(runs) {
    return runs
        .filter(r => !r.skipped)
        .sort((a, b) => (b.summary.judge || 0) - (a.summary.judge || 0)
            || b.summary.quality - a.summary.quality
            || (b.summary.tokS || 0) - (a.summary.tokS || 0));
}

function toMarkdown(runs, meta) {
    const L = [];
    L.push(`# LexisLocal — srovnání modelů`, '');
    L.push(`- Datum: ${meta.date}`);
    L.push(`- Stroj: ${meta.host} · ${meta.cpus} CPU · ${meta.ramGb} GB RAM${meta.gpu ? ' · GPU: ' + meta.gpu : ''}${meta.cpuOnly ? ' · **režim jen CPU**' : ''}`);
    L.push(`- Úloh: ${meta.cases} · kontext ${meta.numCtx} tokenů${meta.judge ? ` · soudce: ${meta.judge}` : ''}`, '');
    L.push(`| # | Model | Kvalita (kontroly) | Úlohy bez chyby | ${meta.judge ? 'Soudce ⌀ | ' : ''}Rychlost (tok/s) | Do 1. odpovědi (s) | ⌀ úloha (s) | Načtení (s) | Paměť (GB) |`);
    L.push(`|---|---|---|---|${meta.judge ? '---|' : ''}---|---|---|---|---|`);
    rankRows(runs).forEach((r, i) => {
        const s = r.summary;
        const mem = r.mem ? `${f1(r.mem.sizeGb)}${r.mem.vramGb ? ` (VRAM ${f1(r.mem.vramGb)})` : ''}` : '—';
        L.push(`| ${i + 1} | ${r.model} | ${(s.quality * 100).toFixed(0)} % | ${s.casesFullyPassed}/${s.cases} | ${meta.judge ? f1(s.judge, 2) + ' | ' : ''}${f1(s.tokS)} | ${f1(s.ttftS, 2)} | ${f1(s.wallS)} | ${f1(r.loadS)} | ${mem} |`);
    });
    const skipped = runs.filter(r => r.skipped);
    if (skipped.length) L.push('', `Přeskočeno: ${skipped.map(r => `${r.model} (${r.skipped})`).join(', ')}`);
    L.push('', '> Pro plynulou práci advokáta chceme ≥ 15 tok/s a ⌀ úlohu pod ~30 s. Kvalita je podle automatických kontrol — před rozhodnutím si přečti i odpovědi níže.', '');

    L.push('## Nesplněné kontroly', '');
    for (const r of rankRows(runs)) {
        const fails = r.results.flatMap(x => x.checks.filter(c => !c.pass).map(c => `${x.id}: ${c.name}${c.detail ? ` (${c.detail})` : ''}`));
        L.push(`**${r.model}** — ${fails.length ? '' : 'vše splněno'}`);
        fails.forEach(f => L.push(`- ${f}`));
        L.push('');
    }
    L.push('## Odpovědi', '');
    for (const r of rankRows(runs)) {
        L.push(`<details><summary><b>${r.model}</b></summary>`, '');
        for (const x of r.results) {
            L.push(`#### ${x.id} (${x.passed}/${x.total}${x.judge && x.judge.score ? `, soudce ${x.judge.score}/5 — ${x.judge.reason}` : ''})`, '');
            L.push('```', (x.error || x.answer || '').slice(0, 4000), '```', '');
        }
        L.push('</details>', '');
    }
    return L.join('\n');
}

async function detectGpu() {
    try {
        const { execSync } = require('child_process');
        return execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().trim().split('\n').join(' + ');
    } catch { return null; }
}

// ---------------------------------------------------------------- main
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        return;
    }
    const casesFile = opts.cases || path.join(__dirname, '..', 'eval', 'model_bench.json');
    const suite = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
    let cases = suite.cases || [];
    if (opts.only) cases = cases.filter(c => c.agent === opts.only || c.id === opts.only);
    if (!cases.length) throw new Error('Žádné úlohy k testu (zkontroluj --only / soubor úloh).');
    const prompts = loadSystemPrompts();
    const models = opts.models || suite.models || DEFAULT_MODELS;

    try { await ollama(opts.host, '/api/tags', null, 10); } catch (e) {
        throw new Error(`Ollama na ${opts.host} neodpovídá (${e.message}). Spusť ji: \`ollama serve\``);
    }

    const meta = {
        date: new Date().toISOString(), host: os.hostname(), cpus: os.cpus().length,
        ramGb: Math.round(os.totalmem() / 1e9), gpu: opts.cpu ? null : await detectGpu(),
        cpuOnly: opts.cpu, cases: cases.length, numCtx: opts.numCtx, judge: opts.judge
    };
    console.log(`\n🔬 LexisLocal model bench — ${models.length} modelů × ${cases.length} úloh${meta.gpu ? ` na ${meta.gpu}` : ''}${opts.cpu ? ' (jen CPU)' : ''}\n`);
    if (opts.judge && !(await ensureModel(opts.host, opts.judge, opts.pull))) throw new Error(`Soudce ${opts.judge} není k dispozici.`);

    const outDir = opts.out || path.join(process.cwd(), 'bench-results');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = meta.date.replace(/[:.]/g, '-').slice(0, 19);
    const runs = [];
    const save = () => {
        fs.writeFileSync(path.join(outDir, `model_bench_${stamp}.json`), JSON.stringify({ meta, runs }, null, 2));
        fs.writeFileSync(path.join(outDir, `model_bench_${stamp}.md`), toMarkdown(runs, meta));
    };

    for (const model of models) {
        console.log(`▶ ${model}`);
        try {
            if (!(await ensureModel(opts.host, model, opts.pull))) { runs.push({ model, skipped: 'není k dispozici' }); continue; }
            const run = await benchModel(opts.host, model, cases, prompts, opts);
            runs.push(run);
            const s = run.summary;
            console.log(`   = kvalita ${(s.quality * 100).toFixed(0)} %, ${f1(s.tokS)} tok/s, načtení ${f1(run.loadS)} s${run.mem ? `, ${f1(run.mem.sizeGb)} GB` : ''}\n`);
        } catch (e) {
            console.log(`   ⚠️  chyba: ${e.message}\n`);
            runs.push({ model, skipped: e.message.slice(0, 120) });
        }
        save(); // průběžně — při pádu/vypnutí instance nepřijdeme o hotové modely
    }
    if (opts.judge) await judgeAll(opts.host, runs, cases, opts);
    await unloadAll(opts.host);
    save();

    console.log('🏁 Pořadí:');
    rankRows(runs).forEach((r, i) => {
        const s = r.summary;
        console.log(`  ${String(i + 1).padStart(2)}. ${r.model.padEnd(20)} kvalita ${String((s.quality * 100).toFixed(0)).padStart(3)} %  ${f1(s.tokS).padStart(6)} tok/s  ⌀ ${f1(s.wallS)} s${s.judge ? `  soudce ${f1(s.judge, 2)}` : ''}`);
    });
    console.log(`\n📄 ${path.join(outDir, `model_bench_${stamp}.md`)}\n`);
}

if (require.main === module) {
    main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
}

module.exports = { runChecks, englishRatio, extractJson, summarize, toMarkdown, parseArgs };
