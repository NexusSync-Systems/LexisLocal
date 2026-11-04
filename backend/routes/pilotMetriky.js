/**
 * routes/pilotMetriky.js — měření pilotu bez obsahu spisů (lib/pilot_metriky.js).
 *   GET  /api/pilot-metriky?od=YYYY-MM-DD&do=YYYY-MM-DD   souhrn po typech úloh (jen správce)
 *   GET  /api/pilot-metriky/export.csv?od=&do=            totéž jako CSV se středníkem (jen správce)
 *   POST /api/pilot-metriky/hodnoceni                     { agentId, taskKind, hodnoceni: dobre|spatne, duvod? }
 */
'use strict';
const express = require('express');
const router = express.Router();
const M = require('../lib/pilot_metriky');

const _d = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

router.get('/', (req, res) => {
    res.json(Object.assign({ zapnuto: M.zapnuto(), duvody: M.DUVODY }, M.souhrn(_d(req.query.od), _d(req.query.do))));
});
router.get('/export.csv', (req, res) => {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="lexislocal-pilot-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + M.csv(_d(req.query.od), _d(req.query.do)));
});
router.post('/hodnoceni', (req, res) => {
    try {
        const b = req.body || {};
        M.ohodnot({ agentId: b.agentId, taskKind: b.taskKind, hodnoceni: b.hodnoceni, duvod: b.duvod });
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
module.exports = router;
