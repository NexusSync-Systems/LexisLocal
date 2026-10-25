#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
/**
 * scripts/rag_doc_check.js — DIAGNOSTIKA golden setu: pro každý dotaz zjistí, jestli je
 * očekávaný judikát vůbec v příslušné bázi (present), kolik má chunků, a když se hledá
 * hlouběji (limit 300), na jakém RANKu se dokument vynoří a s jakým skóre. Odliší tak
 * „chybí v datech" (present=NE) od „je zahrabaný" (present=ANO, rank vysoký).
 *
 * Použití: node backend/scripts/rag_doc_check.js [eval.json] [--depth 300]
 */
const fs = require('fs');
const path = require('path');
const rag = require('../lib/rag');
const { isRelevant, distinctDocsInOrder } = require('../lib/rag_eval');

function parseArgs(argv) {
    const o = { file: null, depth: 300 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--depth') o.depth = parseInt(argv[++i], 10) || 300;
        else if (!a.startsWith('--')) o.file = a;
    }
    return o;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const file = args.file || path.join(__dirname, '..', 'eval', 'rag_eval_judikatura.json');
    const spec = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const cases = Array.isArray(spec) ? spec : (spec.cases || []);
    const semScore = r => (r.semantic == null ? r.lexical : r.semantic);

    console.log(`\n🔬 Doc-check — ${cases.length} dotazů, hloubka=${args.depth}, model=${process.env.EMBEDDING_MODEL || 'nomic-embed-text'}`);
    console.log('─'.repeat(92));
    console.log('  case                                  present  #docSc  bestChunk  docRank/uniq');
    console.log('─'.repeat(92));

    for (const c of cases) {
        const scope = (c.filters && c.filters.scopes && c.filters.scopes[0]) || null;

        // (1) je dokument fyzicky v bázi?
        let present = false, docChunks = 0;
        if (scope) {
            const docs = rag.listKnowledge(scope) || [];
            for (const d of docs) {
                if (isRelevant(d.fileName, c.relevant || [])) { present = true; docChunks = d.chunks; break; }
            }
        }

        // (2) hluboké hledání — na jakém ranku (mezi UNIKÁTNÍMI dokumenty) se vynoří?
        let res = [];
        try { res = await rag.searchSimilar(c.query, args.depth, c.filters || null, { lexicalFallback: true, withComponents: true }); }
        catch (e) { /* fail-closed → prázdné */ }
        const ranked = res.map(r => ({ fileName: r.fileName, score: semScore(r) })).sort((x, y) => y.score - x.score);
        const distinct = distinctDocsInOrder(ranked);

        let docRank = null, bestChunk = null;
        for (let i = 0; i < distinct.length; i++) {
            if (isRelevant(distinct[i], c.relevant || [])) { docRank = i + 1; break; }
        }
        // nejlepší skóre chunku právě toho dokumentu
        for (const r of ranked) { if (isRelevant(r.fileName, c.relevant || [])) { bestChunk = r.score; break; } }

        const label = String(c.label || c.query).slice(0, 36).padEnd(36);
        console.log('  ' + label +
            '  ' + (present ? 'ANO ' : 'NE  ').padStart(6) +
            '   ' + String(docChunks).padStart(5) +
            '   ' + (bestChunk == null ? '  —  ' : bestChunk.toFixed(3)).padStart(8) +
            '   ' + (docRank == null ? `>${args.depth}u` : `${docRank}/${distinct.length}`).padStart(10));
    }
    console.log('─'.repeat(92));
    console.log('  present=ANO & docRank vysoký/>depth → judikát JE v bázi, ale retrieval ho zahrabává (ranking).');
    console.log('  present=NE → judikát v bázi CHYBÍ (díra v datech, ne problém retrievalu).\n');
}
main().catch(e => { console.error('❌ Doc-check selhal:', e.message); process.exit(1); });
