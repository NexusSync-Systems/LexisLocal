/**
 * routes/lhutnik.js — centrální přehled lhůt napříč spisy.
 * Montuje se v server.js na /api/lhutnik.
 */
'use strict';

const express = require('express');
const router = express.Router();
const lhutnik = require('../lib/lhutnik');
const { logEvent } = require('../lib/audit');
const access = require('../lib/access');
const spisy = require('../lib/spisy');
const db = require('../lib/database');
const fileAcl = require('../lib/file_acl');

// Firemní režim: lhůty jen ze spisů, ke kterým má uživatel přístup (nezařazené = podatelna).
function _readable(item, principal) {
    if (!access.isFirmMode() || !item.spisId) return true;
    return access.canAccess(spisy.getSpis(item.spisId), principal, 'read');
}
function _summary(items) {
    return {
        total: items.length,
        overdue: items.filter(i => i.urgency === 'overdue').length,
        urgent: items.filter(i => i.urgency === 'urgent').length,
        soon: items.filter(i => i.urgency === 'soon').length,
        needsReview: items.filter(i => i.needsReview).length
    };
}
function _denyFile(req, res, fileId) {
    const file = (db.get('inbox_files') || []).find(f => f.id === fileId);
    if (!file || fileAcl.canAccessFile(file, req.principal, 'write')) return false;
    res.status(403).json({ error: 'Přístup ke spisu odepřen.' });
    return true;
}

// GET /api/lhutnik — přehled + souhrn. Filtry: ?spisId=, ?onlyReview=1
router.get('/', (req, res) => {
    try {
        const result = lhutnik.getLhutnik({
            spisId: req.query.spisId || null,
            onlyReview: req.query.onlyReview === '1' || req.query.onlyReview === 'true'
        });
        if (access.isFirmMode()) {
            result.items = result.items.filter(i => _readable(i, req.principal));
            result.summary = _summary(result.items);
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: `Chyba při sestavení lhůtníku: ${err.message}` });
    }
});

// POST /api/lhutnik/confirm — potvrdí nejistou lhůtu { fileId, index }
router.post('/confirm', (req, res) => {
    try {
        const { fileId, index } = req.body || {};
        if (_denyFile(req, res, fileId)) return;
        const dl = lhutnik.confirmDeadline(fileId, parseInt(index, 10));
        logEvent('Lhůtník', 'Potvrzení lhůty', fileId, { index });
        res.json({ success: true, deadline: dl });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/lhutnik/dismiss — odloží/zamítne nejistou lhůtu { fileId, index }
router.post('/dismiss', (req, res) => {
    try {
        const { fileId, index } = req.body || {};
        if (_denyFile(req, res, fileId)) return;
        const dl = lhutnik.dismissDeadline(fileId, parseInt(index, 10));
        logEvent('Lhůtník', 'Odložení lhůty', fileId, { index });
        res.json({ success: true, deadline: dl });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
