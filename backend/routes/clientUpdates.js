/**
 * routes/clientUpdates.js — souhrny pro klienta: návrh → fronta → schválení advokátem → odeslání.
 * Montuje se v server.js na /api/client-updates. Logika v lib/client_updates.js.
 *
 *   POST /                 { spisId }          sestaví návrh (zápis do spisu)
 *   GET  /?status=&spisId=                     fronta / historie (jen spisy, které uživatel čte)
 *   PATCH /:id             { subject, body }   úprava textu před schválením (zápis do spisu)
 *   POST /:id/approve                          schválit a odeslat (scope approve + zápis do spisu, ne agent)
 *   POST /:id/reject       { reason }          zamítnout (scope approve + zápis do spisu)
 */
'use strict';

const express = require('express');
const router = express.Router();
const cu = require('../lib/client_updates');
const spisy = require('../lib/spisy');
const access = require('../lib/access');
const principalLib = require('../lib/principal');
const { logEvent } = require('../lib/audit');

function _fail(res, e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
}

// Přístup ke spisu (firemní režim) — vrací spis, nebo null (odpověď odeslána).
function _spisGate(req, res, spisId, level) {
    const spis = spisy.getSpis(spisId);
    if (!spis) { res.status(404).json({ error: 'Spis nenalezen.' }); return null; }
    if (!access.canAccess(spis, req.principal, level)) { res.status(403).json({ error: 'Přístup ke spisu odepřen.' }); return null; }
    return spis;
}

function _approverGate(req, res) {
    const p = req.principal;
    if (p && (p.kind === 'agent' || !principalLib.hasScope(p, 'approve'))) {
        res.status(403).json({ error: 'Souhrn pro klienta smí schválit jen advokát nebo správce.', code: 'forbidden_role' });
        return false;
    }
    return true;
}

function _load(req, res, level) {
    const u = cu.get(req.params.id);
    if (!u) { res.status(404).json({ error: 'Návrh nenalezen.' }); return null; }
    return _spisGate(req, res, u.spisId, level) ? u : null;
}

router.post('/', (req, res) => {
    const spisId = req.body && req.body.spisId;
    const spis = _spisGate(req, res, spisId, 'write'); if (!spis) return;
    try {
        const u = cu.createDraft(spis.id);
        logEvent('Souhrn pro klienta', 'Návrh souhrnu ke schválení', spis.spisZn || spis.nazev, { spisId: spis.id, updateId: u.id });
        res.status(201).json({ update: u });
    } catch (e) { _fail(res, e); }
});

router.get('/', (req, res) => {
    try {
        const l = cu.list({ status: req.query.status, spisId: req.query.spisId })
            .filter(u => access.canAccess(spisy.getSpis(u.spisId), req.principal, 'read'))
            .map(u => {
                const s = spisy.getSpis(u.spisId) || {};
                return Object.assign({}, u, { spisZn: s.spisZn || '', spisNazev: s.nazev || '', klient: s.klient || '' });
            });
        res.json({ updates: l });
    } catch (e) { _fail(res, e); }
});

router.patch('/:id', (req, res) => {
    const u = _load(req, res, 'write'); if (!u) return;
    try { res.json({ update: cu.edit(u.id, req.body || {}) }); } catch (e) { _fail(res, e); }
});

router.post('/:id/approve', async (req, res) => {
    if (!_approverGate(req, res)) return;
    const u = _load(req, res, 'write'); if (!u) return;
    try {
        const updated = await cu.approveAndSend(u.id);
        logEvent('Souhrn pro klienta', 'Schválení a odeslání souhrnu klientovi', u.to, { spisId: u.spisId, updateId: u.id, recipient: u.to });
        res.json({ update: updated });
    } catch (e) {
        logEvent('Souhrn pro klienta', 'Odeslání souhrnu se nezdařilo', u.to, { spisId: u.spisId, updateId: u.id, error: e.message });
        _fail(res, e);
    }
});

router.post('/:id/reject', (req, res) => {
    if (!_approverGate(req, res)) return;
    const u = _load(req, res, 'write'); if (!u) return;
    try {
        const updated = cu.reject(u.id, req.body && req.body.reason);
        logEvent('Souhrn pro klienta', 'Zamítnutí návrhu souhrnu', u.to, { spisId: u.spisId, updateId: u.id });
        res.json({ update: updated });
    } catch (e) { _fail(res, e); }
});

module.exports = router;
