/**
 * routes/system.js — systémové a „sovereign" endpointy: zelené statistiky,
 * GDPR export dat, rotace klíče, přehled suverénních modelů, telemetrie.
 * Montuje se v server.js na /api/system.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../lib/database');
const { getHardwareProfile, getSystemTelemetry } = require('../lib/green_monitor');
const { loadInbox } = require('../lib/watcher');
const { buildRagReport } = require('../lib/rag_report'); // #8: přehled využití RAG
const ollama = require('../lib/ollama_client');

// GET /api/system/rag-report - Přehled reálného využití RAG po agentech (#8).
// Kolik % volání agenta skutečně dostalo aspoň jednu RAG pasáž + podíl simulovaného
// fallbacku (chybějící model). Volitelně ?days=N omezí na posledních N dní.
router.get('/rag-report', (req, res) => {
    try {
        const logs = db.get('transparency_logs') || [];
        const days = parseInt(req.query.days, 10);
        const sinceMs = (Number.isFinite(days) && days > 0) ? (Date.now() - days * 86400000) : null;
        res.json(buildRagReport(logs, { sinceMs }));
    } catch (err) {
        res.status(500).json({ error: 'Nepodařilo se sestavit RAG report: ' + err.message });
    }
});

// GET /api/system/green-metrics - Aggregate energy and CO2 statistics
router.get('/green-metrics', (req, res) => {
    try {
        const greenLogs = db.get('green_logs') || [];
        const profile = getHardwareProfile();

        let totalEnergyWh = 0;
        let totalCo2Grams = 0;
        let totalCloudWh = 0;
        let totalCloudCo2Grams = 0;
        let totalCarbonSavedGrams = 0;

        greenLogs.forEach(log => {
            totalEnergyWh += log.energyWh || 0;
            totalCo2Grams += log.co2Grams || 0;
            totalCloudWh += log.cloudEquivalentWh || 0;
            totalCloudCo2Grams += log.cloudCo2Grams || 0;
            totalCarbonSavedGrams += log.carbonSavedGrams || 0;
        });

        const co2SavingPercent = totalCloudCo2Grams > 0
            ? parseFloat(((totalCarbonSavedGrams / totalCloudCo2Grams) * 100).toFixed(1))
            : 0;

        res.json({
            hardware: profile.hardwareName,
            tdpWatts: profile.estimatedTdp,
            totalRuns: greenLogs.length,
            totalEnergyWh: parseFloat(totalEnergyWh.toFixed(5)),
            totalCo2Grams: parseFloat(totalCo2Grams.toFixed(5)),
            cloudEquivalentWh: parseFloat(totalCloudWh.toFixed(2)),
            cloudCo2Grams: parseFloat(totalCloudCo2Grams.toFixed(2)),
            carbonSavedGrams: parseFloat(totalCarbonSavedGrams.toFixed(5)),
            co2SavingPercent,
            recentRuns: greenLogs.slice(-10)
        });
    } catch (err) {
        res.status(500).json({ error: `Chyba při načítání zelených statistik: ${err.message}` });
    }
});

// GET /api/system/export - Secure de-crypted data export for GDPR portability (Article 20)
router.get('/export', async (req, res) => {
    try {
        const inbox = await loadInbox();
        const exportData = {
            metadata: {
                system: "LexisLocal",
                version: require('../../package.json').version || "1.0.0",
                exportedAt: new Date().toISOString(),
                totalInboxFiles: Object.keys(inbox.files || {}).length
            },
            database: {
                activities: db.get('activities') || [],
                timesheets: db.get('timesheets') || [],
                workflows: db.get('workflows') || [],
                conflicts: db.get('conflicts') || [],
                alerts: db.get('alerts') || [],
                email_settings: db.get('email_settings') || [],
                email_tasks: db.get('email_tasks') || [],
                green_logs: db.get('green_logs') || [],
                transparency_logs: db.get('transparency_logs') || []
            },
            inbox: inbox.files || {}
        };

        res.setHeader('Content-disposition', `attachment; filename=lexis_export_${new Date().toISOString().slice(0, 10)}.json`);
        res.setHeader('Content-type', 'application/json');
        res.write(JSON.stringify(exportData, null, 2));
        res.end();
    } catch (err) {
        res.status(500).json({ error: `Chyba při exportu dat: ${err.message}` });
    }
});

// POST /api/system/rotate-key - Rotate database encryption key
router.post('/rotate-key', (req, res) => {
    try {
        const success = db.rotateEncryptionKey();
        if (success) {
            res.json({ success: true, message: "Lokální šifrovací klíč byl úspěšně rotován a databáze byla přešifrována." });
        } else {
            res.status(500).json({ error: "Rotace klíče selhala. Podrobnosti v serverovém logu." });
        }
    } catch (err) {
        res.status(500).json({ error: `Chyba při rotaci klíče: ${err.message}` });
    }
});

// GET /api/system/models/sovereign - Get and prioritize local European/Czech models
router.get('/models/sovereign', async (req, res) => {
    try {
        // Query local Ollama installation for available models
        const localModelsResponse = await ollama.list();
        const availableTags = (localModelsResponse.models || []).map(m => m.name);

        // Preferred European & open-source sovereign models ordered by preference
        const preferredSovereignModels = [
            'mistral:latest',
            'mistral',
            'mixtral',
            'gemma2:2b',
            'gemma2',
            'llama3-czech',
            'llama3'
        ];

        const matched = preferredSovereignModels.filter(pref =>
            availableTags.some(tag => tag.toLowerCase().startsWith(pref.toLowerCase()) || pref.toLowerCase().startsWith(tag.toLowerCase()))
        );

        res.json({
            sovereignPreferred: preferredSovereignModels,
            availableLocal: availableTags,
            matchedSovereign: matched,
            recommendedActive: matched[0] || 'llama3'
        });
    } catch (err) {
        res.status(500).json({ error: `Chyba při zjišťování suverénních modelů: ${err.message}` });
    }
});

// GET /api/system/telemetry - Retrieve system performance & VRAM telemetry
router.get('/telemetry', (req, res) => {
    try {
        const stats = getSystemTelemetry();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: `Chyba při načítání systémové telemetrie: ${err.message}` });
    }
});

module.exports = router;
