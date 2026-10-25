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
 *   node backend/scripts/reindex-kb.js --force       # přepočítá i chunky, co už mají vektor
 *
 * OBNOVITELNÉ: chunk, který už má vektor cílové dimenze (aktuální model), se přeskočí,
 * takže re-běh po Ctrl+C / pádu pokračuje, kde skončil, a hotové báze proletí okamžitě.
 * Ukazuje ŽIVÝ průběh (chunk po chunku). Dokončené báze se ukládají průběžně.
 */
const rag = require('../lib/rag');

function fmt(sec) { return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`; }

async function main() {
    const model = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
    const argv = process.argv.slice(2);
    const force = argv.includes('--force') || argv.includes('-f');
    const arg = argv.find(a => !a.startsWith('-')); // volitelný scope
    const t0 = Date.now();
    const elapsed = () => fmt(Math.round((Date.now() - t0) / 1000));

    // --list: jen přehled bází a jejich velikost (bez embedování)
    if (argv.includes('--list') || argv.includes('-l')) {
        const scopes = rag.listKbScopes();
        let tot = 0;
        console.log(`\n📚 Registrované znalostní báze (${scopes.length}):`);
        for (const sc of scopes) {
            const n = (rag.loadPartition(sc).chunks || []).length;
            tot += n;
            console.log(`  ${String(n).padStart(7)} chunků  ${sc}`);
        }
        console.log(`  ${String(tot).padStart(7)} chunků  CELKEM\n`);
        return;
    }

    // Zjisti cílovou dimenzi vektoru (1 embedding) — podle ní se pozná, co už je hotové.
    let targetDim = null;
    try {
        const probe = await rag.getEmbedding('test');
        if (Array.isArray(probe)) targetDim = probe.length;
    } catch (e) {
        console.error(`❌ Embedding model nedostupný (${model}): ${e.message}\n   Zkontroluj: ollama ps / ollama list`);
        process.exit(1);
    }

    console.log(`\n🧠 Re-embedding znalostních bází modelem: ${model} (dim ${targetDim})`);
    if (arg) console.log(`   (jen báze: ${arg})`);
    console.log(force
        ? '   --force: přepočítávám VŠECHNY chunky.'
        : '   Obnovitelné: chunky s vektorem dim ' + targetDim + ' přeskakuji. NEUKONČUJ zbytečně.');
    console.log('');

    const onScope = (phase, scope, i, n, extra) => {
        const tag = `[${i + 1}/${n}]`;
        if (phase === 'start') {
            process.stdout.write(`  ${tag} ${scope} … start\n`);
        } else if (phase === 'progress') {
            const reused = extra.reused ? ` [${extra.reused} recykl.]` : '';
            process.stdout.write(`\r  ${tag} ${scope} … ${extra.done}/${extra.total} (${extra.emb} s vektorem${reused})   `);
        } else if (phase === 'done') {
            const reused = extra.reused ? ` (${extra.reused} recykl.)` : '';
            process.stdout.write(`\r  ${tag} ${scope} ✓ ${extra.embedded}/${extra.chunks} vektorů${reused}  [${elapsed()}]${' '.repeat(16)}\n`);
        }
    };

    const opts = { targetDim, force };
    let results;
    if (arg) {
        onScope('start', arg, 0, 1);
        const r = await rag.reindexKnowledge(arg,
            (done, total, emb, reused) => onScope('progress', arg, 0, 1, { done, total, emb, reused }), opts);
        onScope('done', arg, 0, 1, r);
        results = [r];
    } else {
        results = await rag.reindexAllKnowledge(onScope, opts);
    }

    const totChunks = results.reduce((s, r) => s + (r.chunks || 0), 0);
    const totEmb = results.reduce((s, r) => s + (r.embedded || 0), 0);
    const totReused = results.reduce((s, r) => s + (r.reused || 0), 0);
    console.log(`\n✅ Hotovo za ${elapsed()} — ${totEmb}/${totChunks} chunků má vektor` +
        (totReused ? ` (${totReused} recyklováno)` : '') + ` (${results.length} bází).`);
    if (totEmb < totChunks) console.log('⚠️ Část chunků bez vektoru — běžel embedding model? (ollama list / ollama ps)');
    console.log('');
}

main().catch(e => { console.error('\n❌ Reindex selhal:', e.message); process.exit(1); });
