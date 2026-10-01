#!/usr/bin/env node
/**
 * Diagnostika retrievalu nad --kb-dir: kde se v pořadí umístí očekávané paragrafy
 * pro daný dotaz a jak to ovlivní α (podíl sémantiky) a počet pasáží (k).
 *
 * Příklad:
 *   EMBEDDING_MODEL=bge-m3 node backend/scripts/kb_rank_probe.js \
 *     --kb-dir backend/eval/kb/zakony.tar.gz --case resersnik-nahrada-skody \
 *     --want "OZ 89-2012 § 0629.txt,OZ 89-2012 § 0620.txt" --alphas 1,0.8,0.6,0.5,0.4
 *
 * --case <id> vezme prompt z backend/eval/model_bench.json, --query "<text>" ho přepíše.
 * První běh embeduje celou bázi (minuty), další berou vektory z cache vedle archivu.
 */
'use strict';
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch {}
try { const { setGlobalDispatcher, Agent } = require('undici');
    setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 })); } catch {}

function args(argv) {
    const o = { kbDir: 'backend/eval/kb/zakony.tar.gz', caseId: null, query: null, want: [], alphas: [1, 0.8, 0.6, 0.5, 0.4], top: 10 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], n = () => argv[++i];
        if (a === '--kb-dir') o.kbDir = n();
        else if (a === '--case') o.caseId = n();
        else if (a === '--query') o.query = n();
        else if (a === '--want') o.want = n().split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--alphas') o.alphas = n().split(',').map(Number).filter(Number.isFinite);
        else if (a === '--top') o.top = parseInt(n(), 10) || 10;
    }
    return o;
}

(async () => {
    const o = args(process.argv.slice(2));
    if (!o.query && o.caseId) {
        const bench = require('../eval/model_bench.json');
        const list = Array.isArray(bench) ? bench : (bench.cases || bench.tasks || Object.values(bench).find(Array.isArray));
        const tc = list.find(c => c.id === o.caseId);
        if (!tc) throw new Error(`Případ ${o.caseId} v model_bench.json není.`);
        o.query = tc.prompt;
    }
    if (!o.query) throw new Error('Zadej --case <id> nebo --query "<text>".');
    process.env.EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'bge-m3';
    const rag = require('../lib/rag');
    const { buildKbIndex } = require('./model_bench');
    console.log(`Dotaz: ${o.query}\nEmbedding: ${process.env.EMBEDDING_MODEL}`);
    const idx = await buildKbIndex(o.kbDir, rag);
    const qv = await rag.getEmbedding(o.query);
    const base = idx.chunks.map(c => ({ fileName: c.fileName, text: c.text, scope: c.scope,
        sem: rag.cosineSimilarity(qv, c.vector), lex: rag.lexicalScore(o.query, c.text) }));

    for (const alpha of o.alphas) {
        const ranked = base.map(c => ({ ...c, score: rag.blendScore(c.sem, c.lex, alpha) }))
            .sort((a, b) => b.score - a.score);
        const uniq = rag.dedupeKbResults(ranked);
        console.log(`\n=== α=${alpha} ${alpha === 1 ? '(čistě sémantické)' : ''}`);
        uniq.slice(0, o.top).forEach((r, i) => console.log(
            `${String(i + 1).padStart(2)}. ${r.score.toFixed(3)}  (sem ${r.sem.toFixed(3)} lex ${r.lex.toFixed(3)})  ${r.fileName}${o.want.includes(r.fileName) ? '  ◀' : ''}`));
        for (const w of o.want) {
            const pos = uniq.findIndex(r => r.fileName === w);
            console.log(`   → ${w}: ${pos < 0 ? 'nenalezeno' : `pořadí ${pos + 1}, skóre ${uniq[pos].score.toFixed(3)}`}`);
        }
    }
})().catch(e => { console.error('❌', e.message); process.exit(1); });
