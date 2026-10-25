/**
 * routes/models.js — seznam a stahování lokálních Ollama modelů.
 * Montuje se v server.js na /api/models.
 */
'use strict';

const express = require('express');
const router = express.Router();
const ollama = require('../lib/ollama_client');
const { preflightModels } = require('../lib/model_preflight'); // #6: kontrola role-modelů

// GET /api/models - Seznam stažených modelů (s fallbackem, když Ollama neběží)
router.get('/', async (req, res) => {
    try {
        console.log("🔍 Dotazuji lokální Ollama na stažené modely...");
        const response = await ollama.list();
        res.json({
            models: response.models || []
        });
    } catch (err) {
        console.warn("⚠️ Nelze se spojit s Ollama službou na pozadí. Vracím výchozí simulovaný seznam modelů.");
        res.json({
            models: [
                { name: "llama3:latest", size: 4700000000 },
                { name: "mistral:latest", size: 4100000000 },
                { name: "lia:latest", size: 3800000000 }
            ],
            warning: "Ollama server není spuštěn. Zobrazen simulovaný přehled."
        });
    }
});

// POST /api/models/pull - Stáhne model přes Ollama
router.post('/pull', async (req, res) => {
    const { model } = req.body;
    if (!model) {
        return res.status(400).json({ error: "Název modelu je povinný." });
    }

    console.log(`📥 Spouštím stahování modelu Ollama: ${model}`);
    try {
        await ollama.pull({ model });
        res.json({ success: true, message: `Model ${model} byl úspěšně stažen.` });
    } catch (err) {
        res.status(500).json({ error: `Chyba při stahování modelu ${model}: ${err.message}` });
    }
});

// GET /api/models/preflight - Které role-modely (CHAT/FAST/DRAFT/REVIEW/EMBEDDING)
// jsou reálně v Ollamě stažené. UI podle toho může varovat, že agenti spadnou na
// simulovaný fallback. Best-effort; při nedostupné Ollamě vrací ok:false s varováním.
router.get('/preflight', async (req, res) => {
    try {
        const report = await preflightModels({ logger: { log() {}, warn() {} } });
        if (!report) {
            return res.json({ ok: false, skipped: true, warnings: ['Preflight přeskočen (cloud provider nebo Ollama nedostupná).'] });
        }
        res.json(report);
    } catch (err) {
        res.status(200).json({ ok: false, error: err.message, warnings: ['Preflight modelů selhal: ' + err.message] });
    }
});

module.exports = router;
