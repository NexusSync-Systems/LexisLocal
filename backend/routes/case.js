/**
 * routes/case.js — pomocné operace nad spisem podle sp. zn.
 * Montuje se v server.js na /api/case.
 *
 * POST /email-logged — pravdivý zápis do timeline spisu, že advokát odeslal
 * e-mail klientovi (např. přes vlastního poštovního klienta „Otevřít v poště").
 * Voláno až PO potvrzení advokáta v editoru — netvrdíme „odesláno" dřív.
 */
'use strict';

const express = require('express');
const router = express.Router();
const spisy = require('../lib/spisy');
const { logEvent } = require('../lib/audit');

// POST /api/case/email-logged
// Tělo: { caseNumber, cj?, clientName?, recipientEmail?, subject?, sender?, dmID? }
router.post('/email-logged', (req, res) => {
    try {
        const b = req.body || {};
        const caseNumber = (b.caseNumber || '').trim();
        const to = b.recipientEmail || '';
        let linkedToCase = false;
        if (caseNumber) {
            const spis = spisy.findByCase(caseNumber);
            if (spis && !require('../lib/access').canAccess(spis, req.principal, 'write')) {
                return res.status(403).json({ success: false, error: 'Přístup ke spisu odepřen.' });
            }
            if (spis) {
                spisy.addEvent(
                    spis.id,
                    'email',
                    `E-mail odeslán klientovi${to ? ' (' + to + ')' : ''}${b.subject ? ' — „' + b.subject + '"' : ''}.`,
                    { recipient: to || null, cj: b.cj || null, dmID: b.dmID || null }
                );
                linkedToCase = true;
            }
        }
        logEvent('E-mail', 'Záznam odeslání e-mailu klientovi', b.clientName || to || 'e-mail', {
            caseNumber: caseNumber || null, recipient: to || null, linkedToCase
        });
        res.json({ success: true, linkedToCase });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Zápis o odeslání e-mailu selhal: ' + err.message });
    }
});

module.exports = router;
