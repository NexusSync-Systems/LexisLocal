#!/usr/bin/env node
'use strict';
/**
 * rag_label_compile.js — z označeného worksheetu (rag_label_worksheet.json) složí
 * ROZŠÍŘENÝ golden set ve formátu rag_eval (k, cases[{label, query, relevant[], filters}]).
 * Bere jen kandidáty s "relevant": true. Dotazy bez jediného označeného kandidáta VYNECHÁ
 * (a nahlásí je) — do golden setu nemá smysl dávat dotaz bez správné odpovědi.
 *
 * Použití:
 *   node backend/scripts/rag_label_compile.js [worksheet.json] [--out eval.json] [--k 5]
 * Výchozí vstup:  backend/eval/rag_label_worksheet.json
 * Výchozí výstup: backend/eval/rag_eval_expanded.json
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const o = { file: null, out: null, k: 5 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') o.out = argv[++i];
        else if (a === '--k') o.k = parseInt(argv[++i], 10) || 5;
        else if (!a.startsWith('--')) o.file = a;
    }
    return o;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const file = args.file || path.join(__dirname, '..', 'eval', 'rag_label_worksheet.json');
    const outPath = args.out || path.join(__dirname, '..', 'eval', 'rag_eval_expanded.json');
    const ws = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const cases = Array.isArray(ws) ? ws : (ws.cases || []);

    const out = [];
    const skipped = [];
    let totalRelevant = 0;
    for (const c of cases) {
        const relevant = (c.candidates || [])
            .filter(x => x && x.relevant === true)
            .map(x => x.fileName);
        if (!relevant.length) { skipped.push(c.label || c.query); continue; }
        totalRelevant += relevant.length;
        out.push({
            label: c.label || c.query,
            query: c.query,
            relevant,
            filters: { scopes: c.scope ? [c.scope] : [], clientAccess: false }
        });
    }

    if (!out.length) {
        console.error('❌ Žádný dotaz nemá označený relevantní judikát. Nejdřív ve worksheetu nastav "relevant": true.');
        process.exit(1);
    }

    const goldenSet = {
        _comment: 'Rozšířený golden set (víc dotazů, víc relevantních judikátů na dotaz). Vytvořeno z labeling worksheetu. Spuštění: node backend/scripts/rag_eval_sweep.js backend/eval/rag_eval_expanded.json',
        k: args.k,
        cases: out
    };
    fs.writeFileSync(outPath, JSON.stringify(goldenSet, null, 2), 'utf-8');
    console.log(`\n✅ Golden set uložen: ${outPath}`);
    console.log(`   Dotazů se štítky: ${out.length} / ${cases.length}`);
    console.log(`   Relevantních judikátů celkem: ${totalRelevant} (průměr ${(totalRelevant / out.length).toFixed(1)}/dotaz)`);
    if (skipped.length) {
        console.log(`   ⚠️ Vynecháno (0 označených): ${skipped.length}`);
        for (const s of skipped.slice(0, 20)) console.log(`      - ${s}`);
    }
    console.log(`\n👉 Změř: node backend/scripts/rag_eval_sweep.js ${path.relative(path.join(__dirname, '..', '..'), outPath)} --rerank\n`);
}
main();
