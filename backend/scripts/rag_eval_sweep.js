#!/usr/bin/env node
/**
 * scripts/rag_eval_sweep.js — golden set přes VÍC nastavení (semantic + hybrid pro
 * několik alph) JEDNÍM během a jedna srovnávací tabulka.
 *
 * RYCHLE: každý dotaz se vyhledá/embeduje POUZE JEDNOU (searchSimilar withComponents
 * vrátí dílčí sem/lex skóre); jednotlivé konfigurace se pak blendují OFFLINE v paměti
 * (žádné opakované embedování). Metriky přes rag_eval jádro (evaluateCase/aggregate).
 *
 * Použití:
 *   node backend/scripts/rag_eval_sweep.js [eval.json] [--alphas 0,0.1,0.2,0.35,0.5,0.7] [--k 5]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const rag = require('../lib/rag');
const { evaluateCase, aggregate } = require('../lib/rag_eval');

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
const blend = (sem, lex, a) => a * (Number.isFinite(sem) ? sem : 0) + (1 - a) * (Number.isFinite(lex) ? lex : 0);

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const file = args.file || path.join(__dirname, '..', 'eval', 'rag_eval_judikatura.json');
    const spec = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const cases = Array.isArray(spec) ? spec : (spec.cases || []);
    const k = spec.k || args.k;

    // 1) Jedno vyhledání na dotaz — vrátí kandidáty s dílčími skóre (sem, lex).
    const perCase = [];
    let degraded = false;
    for (const c of cases) {
        const res = await rag.searchSimilar(c.query, 50, c.filters || null, { lexicalFallback: true, withComponents: true });
        if (res.some(r => r.degraded)) degraded = true;
        perCase.push({ c, res });
    }

    // 2) Konfigurace: semantic + hybrid pro každou alphu. Blend OFFLINE, re-rank, metriky.
    const configs = [{ label: 'semantic', score: r => (r.semantic == null ? r.lexical : r.semantic) }];
    for (const a of args.alphas) configs.push({ label: `hybrid α=${a}`, score: r => blend(r.semantic, r.lexical, a) });

    const table = [];
    for (const cfg of configs) {
        const metrics = perCase.map(({ c, res }) => {
            const ranked = res.map(r => ({ fileName: r.fileName, score: cfg.score(r) })).sort((x, y) => y.score - x.score);
            return evaluateCase(ranked, c.relevant, k);
        });
        table.push([cfg.label, aggregate(metrics)]);
    }

    console.log(`\n📊 RAG eval sweep — ${cases.length} dotazů, k=${k}, model=${process.env.EMBEDDING_MODEL || 'nomic-embed-text'}${degraded ? ' (⚠️ lexikální fallback — embedding model neběžel)' : ''}`);
    console.log('─'.repeat(60));
    console.log('  konfigurace       hit@k    recall@k   MRR');
    console.log('─'.repeat(60));
    let best = null;
    for (const [label, s] of table) {
        if (!best || s.mrr > best.mrr) best = { label, mrr: s.mrr };
        console.log('  ' + label.padEnd(16) + ' ' + pct(s.hitRate).padStart(6) + '  ' + pct(s.recallAtK).padStart(8) + '   ' + s.mrr.toFixed(3));
    }
    console.log('─'.repeat(60));
    console.log(`  🏆 nejlepší dle MRR: ${best.label} (${best.mrr.toFixed(3)})\n`);
}
main().catch(e => { console.error('❌ Sweep selhal:', e.message); process.exit(1); });
