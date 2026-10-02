/**
 * routes/rag.js — sémantické vyhledávání a správa vektorového indexu.
 * Montuje se v server.js na /api/rag.
 */
'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const rag = require('../lib/rag');
const { indexDocument, searchSimilar, loadIndex, reindexAllKnowledge } = rag;
const { loadInbox } = require('../lib/watcher');
const { logEvent } = require('../lib/audit');
const { resolveRagFilters } = require('../lib/rag_request');
const obory = require('../lib/obory');
const { detectObor } = require('../lib/obor_detect');

// GET /api/rag/search - Sémantické vyhledávání v podkladech
router.get('/search', async (req, res) => {
    const { query, limit, caseNumber, fileNames, scope } = req.query;
    if (!query) {
        return res.status(400).json({ error: "Vyhledávací dotaz je povinný." });
    }
    const searchLimit = limit ? parseInt(limit) : 5;
    try {
        let resolvedFilters = null;
        let filterPayload = { ragFilters: {} };
        if (fileNames) {
            filterPayload.ragFilters.fileNames = fileNames.split(',').map(f => f.trim());
        }
        if (caseNumber) {
            filterPayload.ragFilters.caseNumber = caseNumber.trim();
        }

        if (fileNames || caseNumber) {
            resolvedFilters = await resolveRagFilters(filterPayload);
        }
        // ?scope=kb → hledá ve znalostní bázi (zákony agentů), ?scope=all → spisy + báze.
        // Dřív šlo z dashboardu prohledat jen klientské spisy (test 2. 10. 2026, C22).
        if (scope === 'kb' || scope === 'all') {
            const { listKbScopes } = require('../lib/rag');
            const kbScopes = listKbScopes().filter(sc => String(sc).indexOf('_kb_obor_') !== 0);
            resolvedFilters = Object.assign({}, resolvedFilters || {}, { scopes: kbScopes });
            if (scope === 'kb') resolvedFilters.clientAccess = false;
        }

        // Lexikální fallback zapnut: dashboard vyhledávání funguje i bez modelu
        // (degradovaný, klíčový režim). Výsledky nesou method:'lexical'/degraded:true.
        const matches = await searchSimilar(query, searchLimit, resolvedFilters, { lexicalFallback: true });
        const degraded = matches.some(m => m.degraded);
        res.json({ query, matches, degraded });
    } catch (err) {
        res.status(500).json({ error: `Chyba sémantického vyhledávání: ${err.message}` });
    }
});

// GET /api/rag/detect-obor?query=... — NÁHLED auto-detekce oboru (pro UI).
// Nezasahuje do žádného vyhledávání; jen ukáže, jaký obor by systém zvolil.
router.get('/detect-obor', async (req, res) => {
    const query = req.query.query;
    if (!query || !String(query).trim()) {
        return res.status(400).json({ error: "Dotaz (query) je povinný." });
    }
    try {
        const detection = await detectObor(String(query));
        res.json({ query, detection });
    } catch (err) {
        res.status(500).json({ error: `Chyba detekce oboru: ${err.message}` });
    }
});

// GET /api/rag/obory — taxonomie oborů + pokrytí judikaturními daty (pro UI a
// kontrolu „naplnili jsme všechny obory?"). Řadí od nejméně naplněných.
router.get('/obory', (req, res) => {
    try {
        const countFor = (scope) => {
            const docs = rag.listKnowledge(scope) || [];
            return {
                documents: docs.length,
                chunks: docs.reduce((s, d) => s + (d.chunks || 0), 0),
                embedded: docs.reduce((s, d) => s + (d.embedded || 0), 0)
            };
        };
        const list = obory.OBORY.map(o => {
            const c = countFor(o.scope);
            return {
                slug: o.slug, label: o.label, scope: o.scope,
                keywords: o.keywords, ...c, hasData: c.chunks > 0, custom: false
            };
        });
        // Ruční obory mimo taxonomii (mají data, ale nejsou v seznamu OBORY).
        let existing = [];
        try { existing = rag.listJudikaturaScopes(); } catch (e) { existing = []; }
        const known = new Set(obory.allScopes());
        const extra = existing
            .filter(s => String(s).indexOf('_kb_obor_') === 0 && !known.has(s))
            .map(s => {
                const c = countFor(s);
                return {
                    slug: String(s).replace('_kb_obor_', ''), label: obory.labelForScope(s),
                    scope: s, keywords: [], ...c, hasData: c.chunks > 0, custom: true
                };
            });
        const all = list.concat(extra);
        res.json({
            obory: all,
            total: all.length,
            filled: all.filter(o => o.hasData).length,
            empty: all.filter(o => !o.hasData).length
        });
    } catch (err) {
        res.status(500).json({ error: `Chyba přehledu oborů: ${err.message}` });
    }
});

// GET /api/rag/status - Retrieve vector database size and metrics
router.get('/status', async (req, res) => {
    try {
        const index = await loadIndex();
        const uniqueFiles = new Set(index.chunks.map(c => c.fileName));
        res.json({
            chunksCount: index.chunks.length,
            filesCount: uniqueFiles.size,
            embeddingModel: 'nomic-embed-text'
        });
    } catch (err) {
        res.status(500).json({ error: `Chyba při čtení stavu RAG: ${err.message}` });
    }
});

// POST /api/rag/reindex-all - Reindex all documents from inbox on-demand
router.post('/reindex-all', async (req, res) => {
    console.log("⚡ RAG: Spouštím kompletní re-indexaci všech souborů...");
    try {
        const inbox = await loadInbox();
        const files = Object.values(inbox.files);

        let successCount = 0;
        for (const file of files) {
            if (file.filePath && fs.existsSync(file.filePath)) {
                let content = "";
                const ext = path.extname(file.filePath).toLowerCase();
                try {
                    if (ext === '.pdf') {
                        const pdfParser = require('pdf-parse');
                        const dataBuffer = await fs.promises.readFile(file.filePath);
                        const parsedPdf = await pdfParser(dataBuffer);
                        content = parsedPdf.text;
                    } else {
                        content = await fs.promises.readFile(file.filePath, 'utf-8');
                    }
                    if (content && content.trim()) {
                        await indexDocument(file.relativePath || file.fileName, content);
                        successCount++;
                    }
                } catch (parseErr) {
                    console.warn(`⚠️ RAG: Přeskakuji soubor ${file.fileName} kvůli chybě:`, parseErr.message);
                }
            }
        }
        // Znalostní báze agentů se plní textem (nemají soubor v inboxu), takže výše je
        // reindex minul — re-embedujeme je zvlášť (jinak by po změně modelu zůstaly
        // na starých/null vektorech).
        let kbChunks = 0;
        try {
            const kbResults = await reindexAllKnowledge();
            kbChunks = kbResults.reduce((s, r) => s + (r.embedded || 0), 0);
        } catch (kbErr) {
            console.warn('⚠️ RAG: Re-embedding znalostních bází selhal:', kbErr.message);
        }

        logEvent('LexisLocal Dashboard', 'Re-indexace spisy', 'Všechny spisy', {
            successCount, kbChunks
        });

        res.json({
            success: true,
            message: `Re-indexace dokončena. Úspěšně přegenerováno ${successCount} z ${files.length} souborů`
                + (kbChunks ? ` a ${kbChunks} chunků znalostních bází asistentů.` : '.')
        });
    } catch (err) {
        res.status(500).json({ error: `Chyba při re-indexaci: ${err.message}` });
    }
});

module.exports = router;
