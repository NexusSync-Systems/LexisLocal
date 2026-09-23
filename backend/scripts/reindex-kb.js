#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
/**
 * scripts/reindex-kb.js — re-embeduje VŠECHNY znalostní báze a judikaturu (_kb_*)
 * aktuálním EMBEDDING_MODEL z .env. Nutné po změně embedding modelu (viz
 * BGE_M3_REINDEX.md). Klientské spisy se re-indexují zvlášť (dashboard / API).
 *
 * NEUKONČUJ předčasně — u velkého korpusu (tisíce chunků) to na bge-m3 trvá minuty.
 */
const rag = require('../lib/rag');

async function main() {
    const model = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
    console.log(`\n🧠 Re-embedding znalostních bází modelem: ${model}`);
    console.log('   (běží, NEUKONČUJ — u velkého korpusu to trvá i pár minut)\n');
    const t0 = Date.now();
    const results = await rag.reindexAllKnowledge();
    const totChunks = results.reduce((s, r) => s + (r.chunks || 0), 0);
    const totEmb = results.reduce((s, r) => s + (r.embedded || 0), 0);
    for (const r of results.sort((a, b) => (b.chunks || 0) - (a.chunks || 0))) {
        console.log(`  ${String(r.embedded || 0).padStart(5)}/${String(r.chunks || 0).padEnd(5)} vektorů  ${r.scope}`);
    }
    console.log(`\n✅ Hotovo za ${Math.round((Date.now() - t0) / 1000)}s — ${totEmb}/${totChunks} chunků má vektor (${results.length} bází).`);
    if (totEmb < totChunks) console.log('⚠️ Část chunků bez vektoru — běžel embedding model? (ollama list)');
    console.log('');
}
main().catch(e => { console.error('❌ Reindex selhal:', e.message); process.exit(1); });
