/**
 * routes/aiUsage.js — spotřeba a rozpočet cloudové AI (lib/ai_usage.js, lib/aws_billing.js).
 * Montuje se v server.js na /api/ai-usage. Jen správce (lib/authz.js, jako manažerský přehled).
 *
 *   GET  /api/ai-usage/summary?mesic=YYYY-MM  přehled: rozpočet, utraceno, řada pro graf, rozpady
 *   GET  /api/ai-usage/settings               rozpočet, hranice varování, tvrdý strop, tolerance, ceník
 *   POST /api/ai-usage/settings               { mesicniRozpocetUsd, varovaniPct, tvrdyStrop, tolerancePct, cenik }
 *   POST /api/ai-usage/sync                   porovnat s fakturací AWS hned (jinak večer automaticky)
 */
'use strict';

const express = require('express');
const router = express.Router();
const usage = require('../lib/ai_usage');
const billing = require('../lib/aws_billing');

router.get('/summary', (req, res) => {
    try {
        const s = usage.souhrn(req.query && req.query.mesic);
        res.json(Object.assign({ synchronizaceZapnuta: billing.zapnuto(), hodinaSynchronizace: parseInt(process.env.LEXIS_AWS_SYNC_HOUR || '22', 10) }, s));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/settings', (req, res) => {
    res.json({ nastaveni: usage.nastaveni(), vychoziCenik: usage.VYCHOZI_CENIK });
});

router.post('/settings', (req, res) => {
    try { res.json({ success: true, nastaveni: usage.ulozNastaveni(req.body || {}) }); }
    catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/sync', async (req, res) => {
    try {
        const z = await billing.synchronizuj();
        res.status(z.stav === 'chyba' ? 502 : 200).json({ success: z.stav !== 'chyba', sync: z });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
