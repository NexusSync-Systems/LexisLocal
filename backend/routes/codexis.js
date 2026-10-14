/**
 * routes/codexis.js — rešeršní dotaz do CODEXIS AI (lib/codexis.js).
 * Montuje se v server.js na /api/codexis. POST = scope write (čerpá kredity kanceláře).
 *   POST /ask { question } → { source, text, citations } | { error }
 */
'use strict';

const express = require('express');
const router = express.Router();
const cx = require('../lib/codexis');

router.post('/ask', async (req, res) => {
    const q = req.body && req.body.question;
    if (!q || !String(q).trim()) return res.status(400).json({ error: 'Chybí otázka.' });
    if (!cx.isEnabled()) return res.status(409).json({ error: 'CODEXIS AI není zapnuté (Nastavení → Uživatelé → CODEXIS AI).', ...cx.status() });
    const r = await cx.ask(q, { via: 'dashboard' });
    res.status(r.error ? 502 : 200).json(r);
});

module.exports = router;
