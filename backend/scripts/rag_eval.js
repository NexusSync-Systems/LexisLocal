#!/usr/bin/env node
/**
 * scripts/rag_eval.js — CLI runner RAG evalu. Načte sadu dotazů z JSON souboru
 * a spustí je proti skutečnému vyhledávání (rag.searchSimilar), vytiskne tabulku
 * a souhrn (recall@k, precision@k, MRR, hit-rate).
 *
 * Použití:
 *   node backend/scripts/rag_eval.js [cesta/k/eval.json] [--k 5] [--json]
 * Výchozí soubor: backend/eval/rag_eval.json (viz rag_eval.sample.json jako vzor).
 *
 * Pozn.: Metriky dávají smysl jen když běží embedding model (Ollama / zvolený
 * poskytovatel). Bez modelu se vyhledávání degraduje na lexikální fallback —
 * runner to označí (mode = lexical-fallback), ať se čísla nepřeceňují.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') }); // načti .env (EMBEDDING_MODEL, RAG_*)

const fs = require('fs');
const path = require('path');
const rag = require('../lib/rag');
const { runEval } = require('../lib/rag_eval');

function parseArgs(argv) {
    const out = { file: null, k: 5, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--k') { out.k = parseInt(argv[++i], 10) || 5; }
        else if (a === '--json') { out.json = true; }
        else if (!a.startsWith('--')) { out.file = a; }
    }
    return out;
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const file = args.file || path.join(__dirname, '..', 'eval', 'rag_eval.json');
    if (!fs.existsSync(file)) {
        console.error(`❌ Eval soubor nenalezen: ${file}`);
        console.error(`   Vytvořte jej podle vzoru backend/eval/rag_eval.sample.json.`);
        process.exit(2);
    }
    let spec;
    try { spec = JSON.parse(fs.readFileSync(file, 'utf-8')); }
    catch (e) { console.error(`❌ Neplatný JSON v ${file}: ${e.message}`); process.exit(2); }

    const cases = Array.isArray(spec) ? spec : (spec.cases || []);
    const k = spec.k || args.k;
    if (!cases.length) { console.error('❌ Sada neobsahuje žádné případy (cases).'); process.exit(2); }

    // Vyhledávání s opt-in lexikálním fallbackem (eval nesmí spadnout, když neběží model).
    const searchFn = (query, filters) => rag.searchSimilar(query, Math.max(k, 10), filters || null, { lexicalFallback: true });

    const report = await runEval({ cases, searchFn, k });

    if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }

    console.log(`\n📊 RAG eval — ${report.perCase.length} dotazů, k=${report.k}, režim: ${report.mode}`);
    if (report.mode === 'lexical-fallback') {
        console.log('   ⚠️  Embedding model neběžel → měřeno na lexikálním fallbacku (spusťte Ollamu pro sémantická čísla).');
    }
    console.log('─'.repeat(72));
    for (const p of report.perCase) {
        if (p.skipped) { console.log(`  ⏭  „${p.query}" — přeskočeno (${p.error})`); continue; }
        const flag = p.hit ? '✅' : '❌';
        const rank = p.firstRank ? `#${p.firstRank}` : '—';
        console.log(`  ${flag} r@k=${pct(p.recall)}  p@k=${pct(p.precision)}  1.rel=${rank}  „${p.label || p.query}"`);
    }
    console.log('─'.repeat(72));
    const s = report.summary;
    console.log(`  SOUHRN:  hit-rate ${pct(s.hitRate)} | recall@${k} ${pct(s.recallAtK)} | precision@${k} ${pct(s.precisionAtK)} | MRR ${s.mrr.toFixed(3)}`);
    console.log('');
}

main().catch(err => { console.error('❌ Eval selhal:', err.message); process.exit(1); });
