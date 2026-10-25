#!/usr/bin/env node
/**
 * scripts/rag_score_probe.js — kalibrace prahu RAG_MIN_SCORE.
 *
 * Pro každý case golden setu spustí searchSimilar a vypíše SKÓRE, s jakým se objeví
 * SPRÁVNÝ dokument (relevant) v top-N — abys viděl, kam nastavit RAG_MIN_SCORE, aby
 * aplikace skutečné trefy NEzahodila. Respektuje RAG_HYBRID / RAG_HYBRID_ALPHA
 * (spouštěj se stejným nastavením, jaké chceš do .env).
 *
 * Použití:
 *   RAG_HYBRID=1 RAG_HYBRID_ALPHA=0.2 node backend/scripts/rag_score_probe.js [eval.json] [--topn 10]
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') }); // načti .env (EMBEDDING_MODEL, RAG_*)
const fs = require('fs');
const path = require('path');
const rag = require('../lib/rag');
const { isRelevant } = require('../lib/rag_eval');

function args(argv) {
    const o = { file: null, topn: 10 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--topn') o.topn = parseInt(argv[++i], 10) || 10;
        else if (!argv[i].startsWith('--')) o.file = argv[i];
    }
    return o;
}

async function main() {
    const a = args(process.argv.slice(2));
    const file = a.file || path.join(__dirname, '..', 'eval', 'rag_eval_judikatura.json');
    const spec = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const cases = Array.isArray(spec) ? spec : (spec.cases || []);

    console.log(`\n🎯 Kalibrace RAG_MIN_SCORE — hybrid=${process.env.RAG_HYBRID || 'off'} alpha=${process.env.RAG_HYBRID_ALPHA || '(default)'} | top${a.topn}`);
    console.log('─'.repeat(76));
    const hitScores = [];
    for (const c of cases) {
        let res;
        try { res = await rag.searchSimilar(c.query, a.topn, c.filters || null, { lexicalFallback: true }); }
        catch (e) { console.log(`  ⏭  „${c.label}" — chyba: ${e.message}`); continue; }
        let rank = 0, found = null;
        for (let i = 0; i < res.length; i++) {
            if (isRelevant(res[i].fileName, c.relevant)) { rank = i + 1; found = res[i]; break; }
        }
        const top = res[0] ? res[0].score : 0;
        if (found) {
            hitScores.push(found.score);
            console.log(`  ✅ #${rank}  skóre trefy=${found.score.toFixed(3)}  (top=${top.toFixed(3)})  „${c.label}"`);
        } else {
            console.log(`  ❌ —   (mimo top${a.topn}; top=${top.toFixed(3)})  „${c.label}"`);
        }
    }
    console.log('─'.repeat(76));
    if (hitScores.length) {
        const min = Math.min(...hitScores), max = Math.max(...hitScores);
        const avg = hitScores.reduce((x, y) => x + y, 0) / hitScores.length;
        const suggested = Math.max(0, Math.floor((min - 0.02) * 100) / 100);
        console.log(`  Skóre trefů: min=${min.toFixed(3)} avg=${avg.toFixed(3)} max=${max.toFixed(3)} (n=${hitScores.length})`);
        console.log(`  💡 Návrh RAG_MIN_SCORE ≈ ${suggested.toFixed(2)} (těsně pod min trefů, ať se skutečné trefy nezahodí).`);
    } else {
        console.log('  Žádné trefy v top-N — nejdřív vyřeš pokrytí/retrieval, práh nemá co kalibrovat.');
    }
    console.log('');
}
main().catch(e => { console.error('❌ Probe selhal:', e.message); process.exit(1); });
