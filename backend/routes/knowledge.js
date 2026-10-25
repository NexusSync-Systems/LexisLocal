/**
 * routes/knowledge.js — OBOROVÁ znalostní báze (dělený RAG podle oboru kanceláře).
 * Judikatura/vzory se plní do partitionů `_kb_obor_<slug>` NEZÁVISLE na agentech
 * i na klientských spisech. Do vyhledávání vstoupí, jen když dotaz nese daný obor
 * (explicitně, nebo se odvodí z pole `agenda` spisu — viz lib/rag_request.js).
 * Montuje se v server.js na /api/knowledge.
 *
 * Bezpečnost: obor se vždy převede na scope `_kb_obor_<slug>` (oborScope), takže
 * volající NEMŮŽE zvenčí zacílit cizí/agentní partition.
 */
'use strict';

const express = require('express');
const router = express.Router();
const rag = require('../lib/rag');
const { oborScope } = require('../lib/rag_request');
const { logEvent } = require('../lib/audit');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ocr = require('../lib/ocr');
const { sanitizeFileName } = require('../lib/pathsafe');

const KB_ALLOWED_EXT = ['.pdf', '.docx', '.txt', '.html', '.htm', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.webp'];

// Převede :obor na bezpečný scope; při prázdném oboru pošle 400.
function resolveScope(req, res) {
    const scope = oborScope(req.params.obor);
    if (!scope) {
        res.status(400).json({ error: `Neplatný obor „${req.params.obor}" (po normalizaci prázdný).` });
        return null;
    }
    return scope;
}

// GET /api/knowledge/:obor — výpis dokumentů oborové báze
router.get('/:obor', (req, res) => {
    const scope = resolveScope(req, res);
    if (!scope) return;
    try {
        res.json({ success: true, obor: req.params.obor, scope, documents: rag.listKnowledge(scope) });
    } catch (err) {
        res.status(500).json({ error: `Nelze načíst oborovou bázi: ${err.message}` });
    }
});

// POST /api/knowledge/:obor — přidá dokument (text). Body: { fileName, text }
router.post('/:obor', async (req, res) => {
    const scope = resolveScope(req, res);
    if (!scope) return;
    const { fileName, text } = req.body || {};
    if (!fileName || !String(fileName).trim() || !text || !String(text).trim()) {
        return res.status(400).json({ error: 'Povinné je „fileName" i „text".' });
    }
    try {
        const result = await rag.indexKnowledge(scope, String(fileName).trim(), String(text));
        logEvent('LexisLocal Dashboard', `Oborová báze: ${req.params.obor}`, 'Oborový RAG', { scope, fileName, chunks: result.indexed });
        res.json({ success: true, obor: req.params.obor, scope, ...result });
    } catch (err) {
        res.status(500).json({ error: `Indexace do oborové báze selhala: ${err.message}` });
    }
});

// POST /api/knowledge/:obor/reindex — re-embedding oborové báze
router.post('/:obor/reindex', async (req, res) => {
    const scope = resolveScope(req, res);
    if (!scope) return;
    try {
        const result = await rag.reindexKnowledge(scope);
        logEvent('LexisLocal Dashboard', `Re-embedding oborové báze: ${req.params.obor}`, 'Oborový RAG', { scope, embedded: result.embedded, chunks: result.chunks });
        res.json({ success: true, obor: req.params.obor, ...result });
    } catch (err) {
        res.status(500).json({ error: `Re-embedding oborové báze selhal: ${err.message}` });
    }
});

// DELETE /api/knowledge/:obor/:fileName — odstraní dokument z oborové báze
router.delete('/:obor/:fileName', async (req, res) => {
    const scope = resolveScope(req, res);
    if (!scope) return;
    try {
        const result = await rag.deleteKnowledge(scope, decodeURIComponent(req.params.fileName));
        logEvent('LexisLocal Dashboard', `Smazání z oborové báze: ${req.params.obor}`, 'Oborový RAG', { scope, fileName: req.params.fileName, removed: result.removed });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: `Mazání z oborové báze selhalo: ${err.message}` });
    }
});

// POST /api/knowledge/:obor/upload — nahraje SOUBOR (server vytáhne text, u skenů OCR).
// Body: { fileName, base64 }
router.post('/:obor/upload', async (req, res) => {
    const scope = resolveScope(req, res);
    if (!scope) return;
    const { fileName, base64 } = req.body || {};
    if (!fileName || !String(fileName).trim() || !base64) {
        return res.status(400).json({ error: 'Povinné je „fileName" i „base64" (obsah souboru).' });
    }
    const label = path.basename(String(fileName).trim());
    const ext = path.extname(label).toLowerCase();
    if (!KB_ALLOWED_EXT.includes(ext)) {
        return res.status(400).json({ error: `Nepodporovaný formát „${ext || '(bez přípony)'}". Povolené: ${KB_ALLOWED_EXT.join(', ')}.` });
    }
    let tmpPath = null;
    try {
        const base64Data = String(base64).replace(/^data:.*?;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        if (!buffer.length) return res.status(400).json({ error: 'Soubor je prázdný nebo poškozený (base64).' });
        const stem = sanitizeFileName(path.basename(label, ext)) || 'dokument';
        tmpPath = path.join(os.tmpdir(), `lexis_obor_${Date.now()}_${process.pid}_${stem}${ext}`);
        await fs.promises.writeFile(tmpPath, buffer);
        const { text, ocr: usedOcr } = await ocr.extractTextFromFile(tmpPath);
        if (!text || !String(text).trim()) {
            return res.status(422).json({ error: `Ze souboru „${label}" se nepodařilo získat text${usedOcr ? ' (ani přes OCR)' : ''}.` });
        }
        const result = await rag.indexKnowledge(scope, label, String(text));
        logEvent('LexisLocal Dashboard', `Nahrání do oborové báze: ${req.params.obor}`, 'Oborový RAG', { scope, fileName: label, ocr: !!usedOcr, chars: String(text).length, chunks: result.indexed });
        res.json({ success: true, obor: req.params.obor, scope, fileName: label, ocr: !!usedOcr, chars: String(text).length, ...result });
    } catch (err) {
        res.status(500).json({ error: `Nahrání do oborové báze selhalo: ${err.message}` });
    } finally {
        if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
    }
});

module.exports = router;
