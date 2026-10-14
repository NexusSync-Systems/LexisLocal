/**
 * routes/fakturace.js — fakturace / vyúčtování.
 * Montuje se v server.js na /api/fakturace.
 */
'use strict';

const express = require('express');
const router = express.Router();
const fakturace = require('../lib/fakturace');
const { logEvent } = require('../lib/audit');
const access = require('../lib/access');
const spisy = require('../lib/spisy');

// Firemní režim: faktury ke spisu jen s přístupem ke spisu (nález 14. 10. 2026).
// Faktury bez spisu (ruční položky) jsou kancelářská agenda — beze změny.
function _canInvoice(inv, principal, level) {
    if (!access.isFirmMode() || !inv || !inv.spisId) return true;
    return access.canAccess(spisy.getSpis(inv.spisId), principal, level);
}

// GET /api/fakturace — seznam faktur; filtr ?status=unpaid&spisId=
router.get('/', (req, res) => {
    try {
        const list = fakturace.listInvoices({ status: req.query.status, spisId: req.query.spisId });
        res.json({ invoices: list.filter(i => _canInvoice(i, req.principal, 'read')) });
    } catch (err) {
        res.status(500).json({ error: `Chyba při načtení faktur: ${err.message}` });
    }
});

// GET /api/fakturace/outstanding — přehled neuhrazených + dlužná částka
router.get('/outstanding', (req, res) => {
    try {
        const out = fakturace.getOutstanding();
        if (access.isFirmMode()) {
            out.invoices = out.invoices.filter(i => _canInvoice(i, req.principal, 'read'));
            out.count = out.invoices.length;
            out.totalDue = Math.round(out.invoices.reduce((s, i) => s + (i.toPay - (i.paidAmount || 0)), 0) * 100) / 100;
        }
        res.json(out);
    } catch (err) {
        res.status(500).json({ error: `Chyba při výpočtu neuhrazených: ${err.message}` });
    }
});

// POST /api/fakturace/from-spis — faktura ze spisu { spisId, rate, items, dphRate, zaloha }
router.post('/from-spis', (req, res) => {
    try {
        const body = req.body || {};
        if (!_canInvoice({ spisId: body.spisId }, req.principal, 'write')) {
            return res.status(403).json({ error: 'Přístup ke spisu odepřen.' });
        }
        const invoice = fakturace.createInvoiceFromSpis(body.spisId, body);
        logEvent('Fakturace', 'Vystavení faktury ze spisu', invoice.variabilniSymbol, { spisId: invoice.spisId, toPay: invoice.toPay });
        res.status(201).json({ invoice });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/fakturace — faktura z ručních položek { items, klient, dphRate, zaloha }
router.post('/', (req, res) => {
    try {
        const invoice = fakturace.createInvoice(req.body || {});
        logEvent('Fakturace', 'Vystavení faktury', invoice.variabilniSymbol, { toPay: invoice.toPay });
        res.status(201).json({ invoice });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/fakturace/:id/paid — zaznamená úhradu { amount }
router.post('/:id/paid', (req, res) => {
    try {
        const existing = fakturace.listInvoices({}).find(i => i.id === req.params.id);
        if (existing && !_canInvoice(existing, req.principal, 'write')) {
            return res.status(403).json({ error: 'Přístup ke spisu odepřen.' });
        }
        const updated = fakturace.markPaid(req.params.id, req.body && req.body.amount);
        logEvent('Fakturace', 'Úhrada faktury', updated.variabilniSymbol, { status: updated.status });
        res.json({ invoice: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
