/**
 * routes/citations.js — ověřování právních citací (§, zákony, spisové značky) proti
 * podkladům, referenčnímu indexu a EXTERNÍM zdrojům (e-Sbírka, justice.cz).
 * Montuje se v server.js na /api/citations.
 *
 * Deterministické jádro (citation_verifier) + async nadstavba se zdroji. Fail-closed:
 * co nelze ověřit, zůstává „neověřeno" a v annotatedText je označeno „⚠ NEOVĚŘENO".
 */
'use strict';

const express = require('express');
const router = express.Router();
const { verifyCitations, verifyCitationsWithSources } = require('../lib/citation_verifier');
const { logEvent } = require('../lib/audit');
const legalSources = require('../lib/legalSources');

// POST /api/citations/verify — ověří citace v textu (volitelně proti externím zdrojům)
// Tělo: { text, contextChunks?, referenceIndex?, useSources?:true, strict? }
router.post('/verify', async (req, res) => {
    try {
        const b = req.body || {};
        if (typeof b.text !== 'string' || !b.text.trim()) {
            return res.status(400).json({ error: 'Text k ověření je povinný.' });
        }
        const opts = {
            contextChunks: Array.isArray(b.contextChunks) ? b.contextChunks : [],
            referenceIndex: b.referenceIndex || undefined,
            strict: !!b.strict
        };
        // Paragrafy z nahrané báze zákonů (stejně jako u odpovědí agentů). Dřív tahle cesta
        // index nedostávala → „§ 629 OZ nelze ověřit“, i když OZ v bázi je (test 5. 10. 2026).
        try { opts.kbIndex = require('../lib/kb_law_index').getKbLawIndex(); } catch (e) { /* bez báze */ }
        const useSources = b.useSources !== false; // výchozí: zkusit i externí zdroje
        const result = useSources
            ? await verifyCitationsWithSources(b.text, opts)
            : verifyCitations(b.text, opts);
        logEvent('Citace', 'Ověření citací', 'dokument', {
            total: result.total, unverified: result.unverifiedCount, sourcesConsulted: !!result.sourcesConsulted, spisId: b.spisId || null
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Ověření citací selhalo: ' + err.message });
    }
});

// GET /api/citations/sources — přehled právních zdrojů (providerů) a zda jsou zapnuté
router.get('/sources', (req, res) => {
    try {
        res.json({ providers: legalSources.listProviders() });
    } catch (err) {
        res.status(500).json({ error: 'Načtení právních zdrojů selhalo: ' + err.message });
    }
});

module.exports = router;
