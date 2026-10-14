/**
 * routes/skartace.js — skartační/archivační režim spisové služby.
 * Montuje se v server.js na /api/skartace.
 */
'use strict';

const express = require('express');
const router = express.Router();
const skartace = require('../lib/skartace');
const { logEvent } = require('../lib/audit');

// GET /api/skartace/navrh — spisy s uplynulou retencí + čekající na skartaci
router.get('/navrh', (req, res) => {
    try {
        const n = skartace.getSkartaceNavrh();
        const access = require('../lib/access');
        if (access.isFirmMode() && !access.isAdminOrSolo(req.principal)) {
            const ok = s => access.canAccess(s, req.principal, 'read');
            n.expired = n.expired.filter(ok); n.retained = n.retained.filter(ok); n.inSkartace = n.inSkartace.filter(ok);
            n.summary = { expired: n.expired.length, retained: n.retained.length, inSkartace: n.inSkartace.length };
        }
        res.json(n);
    } catch (err) {
        res.status(500).json({ error: `Chyba skartačního návrhu: ${err.message}` });
    }
});

// GET /api/skartace/protokoly — historie skartačních protokolů
router.get('/protokoly', (req, res) => {
    try {
        res.json({ protokoly: skartace.listProtokoly() });
    } catch (err) {
        res.status(500).json({ error: `Chyba při načtení protokolů: ${err.message}` });
    }
});

// POST /api/skartace/protokol — vytvoří skartační protokol { spisIds, zpracoval, poznamka }
router.post('/protokol', (req, res) => {
    try {
        const { spisIds, zpracoval, poznamka } = req.body || {};
        const protokol = skartace.buildProtokol(spisIds, { zpracoval, poznamka });
        logEvent('Skartace', 'Vytvoření skartačního protokolu', protokol.id, { pocet: protokol.pocet });
        res.status(201).json({ protokol });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
