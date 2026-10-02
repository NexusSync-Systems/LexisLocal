/**
 * routes/audit.js — auditní stopa a AI Act transparency ledger.
 * Sjednocuje routy, které byly dřív ve dvou částech server.js.
 * Montuje se v server.js na /api/audit.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../lib/database');
const { logEvent, clearAuditLogs, loadAuditLogs, verifyAuditChain } = require('../lib/audit');

// GET /api/audit/transparency/verify - Ověří integritu ledgeru (hash chain)
router.get('/transparency/verify', (req, res) => {
    try {
        const result = db.verifyLedger();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: `Chyba při ověřování ledgeru: ${err.message}` });
    }
});

// GET /api/audit/transparency - Retrieve AI Act Transparency Ledger
router.get('/transparency', (req, res) => {
    try {
        const logs = db.get('transparency_logs') || [];
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: `Chyba při načítání transparentního ledgeru: ${err.message}` });
    }
});

// POST /api/audit/transparency/:id/approve - Human-in-the-loop review approval
router.post('/transparency/:id/approve', (req, res) => {
    const { id } = req.params;
    const p = req.principal;
    // Lidský dohled = konkrétní člověk s oprávněním schvalovat (advokát/správce), nikdy agent.
    if (p && (p.kind === 'agent' || !require('../lib/principal').hasScope(p, 'approve'))) {
        return res.status(403).json({ error: 'Výstup AI smí schválit jen advokát nebo správce.', code: 'forbidden_role' });
    }
    try {
        const updated = db.update('transparency_logs', id, {
            humanApproved: true,
            approvedAt: new Date().toISOString(),
            approvedBy: p ? { id: p.userId, name: p.name } : null
        });

        if (updated) {
            res.json({ success: true, message: `Rozhodnutí AI ID ${id} bylo schváleno lidským dohledem.`, record: updated });
        } else {
            res.status(404).json({ error: `Záznam s ID ${id} nebyl nalezen.` });
        }
    } catch (err) {
        res.status(500).json({ error: `Chyba při schvalování záznamu: ${err.message}` });
    }
});

// GET /api/audit/logs - Auditní logy (nejnovější první)
router.get('/logs', (req, res) => {
    try {
        const logs = loadAuditLogs();
        res.json({ success: true, logs: logs.reverse() }); // return newest first
    } catch (err) {
        res.status(500).json({ error: `Nelze načíst auditní logy: ${err.message}` });
    }
});

// POST /api/audit/clear - Clear all audit trail log events
router.post('/clear', async (req, res) => {
    try {
        // Delegace do audit modulu — používá stejnou cestu jako zápis logu,
        // takže se nemůže smazat jiný soubor kvůli odlišnému výpočtu WATCH_DIR.
        clearAuditLogs();
        logEvent('LexisLocal Dashboard', 'Pročištění logů', 'Audit Trail', { cleared: true });
        res.json({ success: true, message: "Auditní logy byly vyčištěny." });
    } catch (err) {
        res.status(500).json({ error: `Nelze vyčistit logy: ${err.message}` });
    }
});

// GET /api/audit/verify-chain — ověří tamper-evident hash-chain auditního logu
router.get('/verify-chain', (req, res) => {
    try { res.json(verifyAuditChain()); }
    catch (err) { res.status(500).json({ error: 'Ověření auditního řetězu selhalo: ' + err.message }); }
});

module.exports = router;
