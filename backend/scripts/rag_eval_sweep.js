#!/usr/bin/env node
/**
 * scripts/rag_eval_sweep.js — spustí golden set přes VÍC nastavení najednou
 * (semantic + hybrid pro několik alph) a vypíše JEDNU srovnávací tabulku.
 * Ideální pro rychlé přeměření po výměně embedding modelu (viz BGE_M3_REINDEX.md).
 *
 * _hybridEnabled()/_hybridAlpha() v rag.js čtou process.env při KAŽDÉM volání
 * searchSimilar, takže stačí přepínat env mezi běhy v jednom procesu.
 *
 * Použití:
 *   node backend/scripts/rag_eval_sweep.js [eval.json] [--alphas 0,0.1,0.2,0.35,0.5,0.7] [--k 5]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const rag = require('../lib/rag');
const { runEval } = require('../lib/rag_eval');

function parseArgs(argv) {
    const o = { file: null, k: 5, alphas: [0, 0.1, 0.2, 0.35, 0.5, 0.7] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--k') o.k = parseInt(argv[++i], 10) || 5;
        else if (a === '--alphas') o.alphas = String(argv[++i]).split(',').map(Number).filter(x => Number.isFinite(x));
        else if (!a.startsWith('--')) o.file = a;
    }
    return o;
}
const pct = x => (x * 100).toFixed(1) + '%';

async function runConfig(cases, k, hybrid, alpha) {
    if (hybrid) { process.env.RAG_HYBRID = '1'; process.env.RAG_HYBRID_ALPHA = String(alpha); }
    else { process.env.RAG_HYBRID = '0'; delete process.env.RAG_HYBRID_ALPHA; }
    const searchFn = (q, f) => rag.searchSimilar(q, Math.max(k, 10), f || null, { lexicalFallback: true });
    const r = await runEval({ cases, searchFn, k });
    return r.summary;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const file = args.file || path.join(__dirname, '..', 'eval', 'rag_eval_judikatura.json');
    const spec = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const cases = Array.isArray(spec) ? spec : (spec.cases || []);
    const k = spec.k || args.k;

    const rows = [];
    rows.push(['semantic', await runConfig(cases, k, false)]);
    for (const a of args.alphas) rows.push([`hybrid α=${a}`, await runConfig(cases, k, true, a)]);

    console.log(`\n📊 RAG eval sweep — ${cases.length} dotazů, k=${k}, model=${process.env.EMBEDDING_MODEL || 'nomic-embed-text'}`);
    console.log('─'.repeat(60));
    console.log('  konfigurace       hit@k    recall@k   MRR');
    console.log('─'.repeat(60));
    let best = null;
    for (const [label, s] of rows) {
        if (!best || s.mrr > best.mrr) best = { label, mrr: s.mrr };
        console.log('  ' + label.padEnd(16) + ' ' + pct(s.hitRate).padStart(6) + '  ' + pct(s.recallAtK).padStart(8) + '   ' + s.mrr.toFixed(3));
    }
    console.log('─'.repeat(60));
    console.log(`  🏆 nejlepší dle MRR: ${best.label} (${best.mrr.toFixed(3)})`);
    console.log('');
}
main().catch(e => { console.error('❌ Sweep selhal:', e.message); process.exit(1); });
