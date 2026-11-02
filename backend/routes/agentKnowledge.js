/**
 * routes/agentKnowledge.js — správa VLASTNÍ znalostní báze agenta (per-agent RAG).
 * Každý agent má izolovanou partition `_kb_<id>` (rešeršník = judikatura/legislativa,
 * spisovatel = vzory, kontrolor = checklisty…), do níž se plní dokumenty NEZÁVISLE na
 * klientských spisech. Do vyhledávání vstupuje jen když se ptá daný agent.
 * Montuje se v server.js na /api/agent-knowledge.
 */
'use strict';

const express = require('express');
const router = express.Router();
const { loadAgents } = require('../lib/agents');
const rag = require('../lib/rag');
const { logEvent } = require('../lib/audit');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ocr = require('../lib/ocr');
const { sanitizeFileName } = require('../lib/pathsafe');

// Formáty, z nichž umíme vytáhnout text (digitální i skenované PDF přes OCR).
const KB_ALLOWED_EXT = ['.pdf', '.docx', '.txt', '.html', '.htm', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.webp'];

// Vrátí agenta + jeho scope, nebo pošle 404.
function resolveAgent(req, res) {
    const agents = loadAgents();
    const agent = agents[req.params.agentId];
    if (!agent) {
        res.status(404).json({ error: `Agent „${req.params.agentId}" nebyl nalezen.` });
        return null;
    }
    if (!agent.knowledgeScope) {
        res.status(500).json({ error: `Agent „${agent.id}" nemá nastavenou znalostní bázi (knowledgeScope).` });
        return null;
    }
    return agent;
}

// GET /api/agent-knowledge/:agentId — seznam dokumentů ve znalostní bázi agenta
router.get('/:agentId', (req, res) => {
    const agent = resolveAgent(req, res);
    if (!agent) return;
    try {
        res.json({ success: true, agentId: agent.id, scope: agent.knowledgeScope, documents: rag.listKnowledge(agent.knowledgeScope) });
    } catch (err) {
        res.status(500).json({ error: `Nelze načíst znalostní bázi: ${err.message}` });
    }
});

// POST /api/agent-knowledge/:agentId — přidá/aktualizuje dokument ve znalostní bázi
// Body: { fileName, text }
router.post('/:agentId', async (req, res) => {
    const agent = resolveAgent(req, res);
    if (!agent) return;
    const { fileName, text, verejne } = req.body || {};
    if (!fileName || !String(fileName).trim() || !text || !String(text).trim()) {
        return res.status(400).json({ error: 'Povinné je „fileName" i „text".' });
    }
    // Do cloudu jako veřejná pasáž jen výslovně (verejne: true = zákon / judikatura); jinak dokument kanceláře.
    const puvod = require('../lib/kb_puvod').puvodZVolby(verejne);
    try {
        const result = await rag.indexKnowledge(agent.knowledgeScope, String(fileName).trim(), String(text), { puvod });
        logEvent('LexisLocal Dashboard', `Znalostní báze agenta: ${agent.name}`, 'Per-agent RAG', {
            agentId: agent.id, scope: agent.knowledgeScope, fileName: fileName, chunks: result.indexed, puvod
        });
        res.json({ success: true, agentId: agent.id, scope: agent.knowledgeScope, ...result });
    } catch (err) {
        res.status(500).json({ error: `Indexace do znalostní báze selhala: ${err.message}` });
    }
});

// POST /api/agent-knowledge/:agentId/reindex — re-embeduje bázi (po změně modelu)
router.post('/:agentId/reindex', async (req, res) => {
    const agent = resolveAgent(req, res);
    if (!agent) return;
    try {
        const result = await rag.reindexKnowledge(agent.knowledgeScope);
        logEvent('LexisLocal Dashboard', `Re-embedding báze: ${agent.name}`, 'Per-agent RAG', {
            agentId: agent.id, scope: agent.knowledgeScope, embedded: result.embedded, chunks: result.chunks
        });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: `Re-embedding znalostní báze selhal: ${err.message}` });
    }
});

// DELETE /api/agent-knowledge/:agentId/:fileName — odstraní dokument ze znalostní báze
router.delete('/:agentId/:fileName', async (req, res) => {
    const agent = resolveAgent(req, res);
    if (!agent) return;
    try {
        const result = await rag.deleteKnowledge(agent.knowledgeScope, decodeURIComponent(req.params.fileName));
        logEvent('LexisLocal Dashboard', `Smazání z báze agenta: ${agent.name}`, 'Per-agent RAG', {
            agentId: agent.id, fileName: req.params.fileName, removed: result.removed
        });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: `Mazání ze znalostní báze selhalo: ${err.message}` });
    }
});

// POST /api/agent-knowledge/:agentId/upload — nahraje SOUBOR (PDF/DOCX/TXT/obrázek),
// server z něj vytáhne text (u skenů OCR) a zaindexuje do znalostní báze agenta.
// Body: { fileName, base64 }  (stejná konvence jako /api/inbox/upload)
router.post('/:agentId/upload', async (req, res) => {
    const agent = resolveAgent(req, res);
    if (!agent) return;
    const { fileName, base64, verejne } = req.body || {};
    const puvod = require('../lib/kb_puvod').puvodZVolby(verejne);
    if (!fileName || !String(fileName).trim() || !base64) {
        return res.status(400).json({ error: 'Povinné je „fileName" i „base64" (obsah souboru).' });
    }
    // Label do báze = čitelný název s příponou (jen metadata, nikdy cesta na disku).
    const label = path.basename(String(fileName).trim());
    const ext = path.extname(label).toLowerCase();
    if (!KB_ALLOWED_EXT.includes(ext)) {
        return res.status(400).json({ error: `Nepodporovaný formát „${ext || '(bez přípony)'}". Povolené: ${KB_ALLOWED_EXT.join(', ')}.` });
    }

    let tmpPath = null;
    try {
        const base64Data = String(base64).replace(/^data:.*?;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        if (!buffer.length) {
            return res.status(400).json({ error: 'Soubor je prázdný nebo poškozený (base64).' });
        }
        // Bezpečný, kontrolovaný název temp souboru — zachová příponu kvůli detekci typu.
        const stem = sanitizeFileName(path.basename(label, ext)) || 'dokument';
        tmpPath = path.join(os.tmpdir(), `lexis_kb_${Date.now()}_${process.pid}_${stem}${ext}`);
        await fs.promises.writeFile(tmpPath, buffer);

        const { text, ocr: usedOcr } = await ocr.extractTextFromFile(tmpPath);
        if (!text || !String(text).trim()) {
            return res.status(422).json({
                error: `Ze souboru „${label}" se nepodařilo získat žádný text${usedOcr ? ' (ani přes OCR)' : ''}. Zkuste jiný formát nebo čitelnější sken.`
            });
        }

        const result = await rag.indexKnowledge(agent.knowledgeScope, label, String(text), { puvod });
        logEvent('LexisLocal Dashboard', `Nahrání souboru do báze agenta: ${agent.name}`, 'Per-agent RAG', {
            agentId: agent.id, scope: agent.knowledgeScope, fileName: label, ocr: !!usedOcr, puvod,
            chars: String(text).length, chunks: result.indexed
        });
        res.json({
            success: true, agentId: agent.id, scope: agent.knowledgeScope,
            fileName: label, ocr: !!usedOcr, chars: String(text).length, ...result
        });
    } catch (err) {
        res.status(500).json({ error: `Nahrání do znalostní báze selhalo: ${err.message}` });
    } finally {
        if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
    }
});

module.exports = router;
