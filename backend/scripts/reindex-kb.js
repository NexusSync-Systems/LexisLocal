#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
/**
 * scripts/reindex-kb.js — re-embeduje znalostní báze a judikaturu (_kb_*) aktuálním
 * EMBEDDING_MODEL z .env. Nutné po změně embedding modelu (viz BGE_M3_REINDEX.md).
 *
 * Použití:
 *   node backend/scripts/reindex-kb.js               # všechny báze
 *   node backend/scripts/reindex-kb.js _kb_resersnik # jen jedna báze (rychlé ověření)
 *   node backend/scripts/reindex-kb.js --list        # jen vypíše báze + počty chunků
 *
 * Ukazuje ŽIVÝ průběh (chunk po chunku), takže NEJDE o černou skříňku. NEUKONČUJ ho —
 * dokončené báze se ukládají průběžně, takže případný Ctrl+C ztratí jen rozdělanou bázi.
 */
const rag = require('../lib/rag');

function fmt(sec) { return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`; }

async function main() {
    const model = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
    const arg = process.argv[2];
    const t0 = Date.now();
    const elapsed = () => fmt(Math.round((Date.now() - t0) / 1000));

    // --list: jen přehled bází a jejich velikost (bez embedování)
    if (arg === '--list' || arg === '-l') {
        const scopes = rag.listKbScopes();
        console.log(`\n📚 Registrované znalostní báze (${scopes.length}):`);
        for (const sc of scopes) {
            const n = (rag.loadPartition(sc).chunks || []).length;
            console.log(`  ${String(n).padStart(7)} chunků  ${sc}`);
        }
        console.log('');
        return;
    }

    console.log(`\n🧠 Re-embedding znalostních bází modelem: ${model}`);
    if (arg) console.log(`   (jen báze: ${arg})`);
    console.log('   Ukazuji průběh; NEUKONČUJ — hotové báze se ukládají průběžně.\n');

    const onScope = (phase, scope, i, n, extra) => {
        const tag = `[${i + 1}/${n}]`;
        if (phase === 'start') {
            process.stdout.write(`  ${tag} ${scope} … start\n`);
        } else if (phase === 'progress') {
            process.stdout.write(`\r  ${tag} ${scope} … ${extra.done}/${extra.total} (${extra.emb} s vektorem)   `);
        } else if (phase === 'done') {
            process.stdout.write(`\r  ${tag} ${scope} ✓ ${extra.embedded}/${extra.chunks} vektorů  [${elapsed()}]${' '.repeat(20)}\n`);
        }
    };

    let results;
    if (arg) {
        onScope('start', arg, 0, 1);
        const r = await rag.reindexKnowledge(arg, (done, total, emb) => onScope('progress', arg, 0, 1, { done, total, emb }));
        onScope('done', arg, 0, 1, r);
        results = [r];
    } else {
        results = await rag.reindexAllKnowledge(onScope);
    }

    const totChunks = results.reduce((s, r) => s + (r.chunks || 0), 0);
    const totEmb = results.reduce((s, r) => s + (r.embedded || 0), 0);
    console.log(`\n✅ Hotovo za ${elapsed()} — ${totEmb}/${totChunks} chunků má vektor (${results.length} bází).`);
    if (totEmb < totChunks) console.log('⚠️ Část chunků bez vektoru — běžel embedding model? (ollama list / ollama ps)');
    console.log('');
}

main().catch(e => { console.error('\n❌ Reindex selhal:', e.message); process.exit(1); });
