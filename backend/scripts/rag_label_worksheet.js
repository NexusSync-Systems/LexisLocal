#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
/**
 * rag_label_worksheet.js — POLOAUTOMATICKÝ labeling pro rozšíření golden setu.
 *
 * Ke každému draftovanému dotazu vytáhne z reálného indexu top-K UNIKÁTNÍCH judikátů
 * (nejlepší chunk na dokument) se snippety a vygeneruje EDITOVATELNÝ worksheet. Člověk
 * pak jen u relevantních judikátů přepíše "relevant": false → true (klidně u víc než
 * jednoho). rag_label_compile.js z toho složí rozšířený golden set.
 *
 * Použití:
 *   node backend/scripts/rag_label_worksheet.js [queries.json] [--topk 15] [--out worksheet.json]
 * Výchozí vstup: backend/eval/rag_eval_queries.draft.json
 * Výchozí výstup: backend/eval/rag_label_worksheet.json
 */
const fs = require('fs');
const path = require('path');
const rag = require('../lib/rag');

function parseArgs(argv) {
    const o = { file: null, topk: null, out: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--topk') o.topk = parseInt(argv[++i], 10) || null;
        else if (a === '--out') o.out = argv[++i];
        else if (!a.startsWith('--')) o.file = a;
    }
    return o;
}

// Redukce chunků na UNIKÁTNÍ dokumenty (nejlepší skóre na fileName), v pořadí skóre.
function distinctTopDocs(results, topK) {
    const best = new Map();
    for (const r of results) {
        const key = String(r.fileName);
        const prev = best.get(key);
        if (!prev || (r.score || 0) > (prev.score || 0)) {
            best.set(key, { fileName: r.fileName, score: r.score, text: r.text });
        }
    }
    return [...best.values()].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, topK);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const file = args.file || path.join(__dirname, '..', 'eval', 'rag_eval_queries.draft.json');
    const outPath = args.out || path.join(__dirname, '..', 'eval', 'rag_label_worksheet.json');
    const spec = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const cases = Array.isArray(spec) ? spec : (spec.cases || []);
    const topK = args.topk || spec.topK || 15;

    // ověř embedding model (jinak lexikální fallback → nesmyslné kandidáty)
    let model = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
    try { const probe = await rag.getEmbedding('test'); if (!Array.isArray(probe)) throw new Error('no vector'); }
    catch (e) { console.error(`❌ Embedding model nedostupný (${model}): ${e.message}\n   Zapni Ollamu (ollama ps).`); process.exit(1); }

    console.log(`\n📝 Generuji labeling worksheet — ${cases.length} dotazů, top-${topK}, model=${model}\n`);
    const outCases = [];
    let emptyScopes = 0;
    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const scope = c.scope || (c.filters && c.filters.scopes && c.filters.scopes[0]);
        const filters = { scopes: scope ? [scope] : [], clientAccess: false };
        let results = [];
        try { results = await rag.searchSimilar(c.query, Math.max(topK * 4, 60), filters, { lexicalFallback: true }); }
        catch (e) { /* fail-closed → prázdné */ }
        const docs = distinctTopDocs(results, topK);
        if (!docs.length) emptyScopes++;
        outCases.push({
            label: c.label || c.query,
            query: c.query,
            scope: scope || null,
            candidates: docs.map((d, idx) => ({
                rank: idx + 1,
                fileName: d.fileName,
                score: typeof d.score === 'number' ? Number(d.score.toFixed(3)) : d.score,
                relevant: false, // ← ČLOVĚK PŘEPÍŠE na true u relevantních judikátů
                snippet: String(d.text == null ? '' : d.text).replace(/\s+/g, ' ').slice(0, 240)
            }))
        });
        process.stdout.write(`\r  [${i + 1}/${cases.length}] ${String(c.label || '').slice(0, 44).padEnd(44)}`);
    }
    process.stdout.write('\n');

    const worksheet = {
        _instrukce: 'U RELEVANTNÍCH judikátů přepiš "relevant": false → true (klidně u víc kandidátů na dotaz). Pak spusť rag_label_compile.js.',
        generatedAt: new Date().toISOString(),
        model, topK,
        cases: outCases
    };
    fs.writeFileSync(outPath, JSON.stringify(worksheet, null, 2), 'utf-8');
    console.log(`\n✅ Worksheet uložen: ${outPath}`);
    console.log(`   Dotazů: ${outCases.length}, kandidátů celkem: ${outCases.reduce((s, c) => s + c.candidates.length, 0)}`);
    if (emptyScopes) console.log(`   ⚠️ ${emptyScopes} dotazů nevrátilo kandidáty (prázdný/špatný scope?).`);
    console.log(`\n👉 Teď projdi worksheet a u relevantních judikátů nastav "relevant": true.\n`);
}
main().catch(e => { console.error('\n❌ Worksheet selhal:', e.message); process.exit(1); });
