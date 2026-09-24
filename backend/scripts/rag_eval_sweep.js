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
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') }); // načti .env (EMBEDDING_MODEL, RAG_*)
const fs = require('fs');
const path = require('path');
const rag = require('../lib/rag');
const { evaluateCase, aggregate, isRelevant } = require('../lib/rag_eval');

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

    // 3) Per-case (semantic): rank a skóre SPRÁVNÉHO dokumentu — kde leží práh?
    const semScore = r => (r.semantic == null ? r.lexical : r.semantic);
    console.log('🔎 Per-case (semantic) — rank a skóre správného dokumentu:');
    console.log('─'.repeat(72));
    console.log('  case                                      rank   skóre_rel   top1');
    console.log('─'.repeat(72));
    const relScores = [];
    for (const { c, res } of perCase) {
        const ranked = res.map(r => ({ fileName: r.fileName, score: semScore(r) })).sort((x, y) => y.score - x.score);
        let relScore = null, rank = null;
        for (let i = 0; i < ranked.length; i++) {
            if (isRelevant(ranked[i].fileName, c.relevant || [])) { relScore = ranked[i].score; rank = i + 1; break; }
        }
        if (relScore != null) relScores.push(relScore);
        const label = String(c.label || c.query).slice(0, 40).padEnd(40);
        const top1 = ranked.length ? ranked[0].score : 0;
        console.log('  ' + label + ' ' + String(rank == null ? '—' : rank).padStart(4) +
            '   ' + (relScore == null ? '  —  ' : relScore.toFixed(3)).padStart(7) +
            '   ' + top1.toFixed(3).padStart(6));
    }
    console.log('─'.repeat(72));
    if (relScores.length) {
        const minRel = Math.min(...relScores);
        console.log(`  Nejnižší skóre správného dokumentu: ${minRel.toFixed(3)}` +
            ` → aby se neztratil žádný zásah, RAG_MIN_SCORE musí být ≤ ${minRel.toFixed(3)}.\n`);
    }

    // 4) Prahová tabulka (semantic): hit@k po zahození kandidátů pod prahem.
    console.log('🎚️  Práh RAG_MIN_SCORE (semantic) — hit@k po odfiltrování kandidátů pod prahem:');
    console.log('─'.repeat(48));
    const envThr = parseFloat(process.env.RAG_MIN_SCORE);
    const thresholds = [0.10, 0.14, 0.20, 0.25, 0.30, 0.40];
    if (Number.isFinite(envThr) && !thresholds.includes(envThr)) thresholds.push(envThr);
    thresholds.sort((a, b) => a - b);
    for (const t of thresholds) {
        const metrics = perCase.map(({ c, res }) => {
            const ranked = res.filter(r => semScore(r) >= t)
                .map(r => ({ fileName: r.fileName, score: semScore(r) })).sort((x, y) => y.score - x.score);
            return evaluateCase(ranked, c.relevant || [], k);
        });
        const s = aggregate(metrics);
        const mark = (Number.isFinite(envThr) && Math.abs(t - envThr) < 1e-9) ? '  ← .env' : '';
        console.log('  t=' + t.toFixed(2) + '   hit@k ' + pct(s.hitRate).padStart(6) + '   recall@k ' + pct(s.recallAtK).padStart(6) + mark);
    }
    console.log('─'.repeat(48) + '\n');
}
main().catch(e => { console.error('❌ Sweep selhal:', e.message); process.exit(1); });
