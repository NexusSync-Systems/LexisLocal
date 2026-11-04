/**
 * routes/alerts.js — upozornění (insolvence, hlídané lhůty) z doručené pošty.
 * Montuje se v server.js na /api/alerts.
 */
'use strict';

const express = require('express');
const router = express.Router();
const { loadInbox, saveInbox, checkAllInsolvencies } = require('../lib/watcher');

// GET /api/alerts - Aktivní upozornění
router.get('/', async (req, res) => {
    try {
        const inbox = await loadInbox();
        const activeAlerts = (inbox.alerts || []).filter(a => a.status === 'active');
        const vazby = a => ({ spisZn: a.caseNumber, files: a.citedFiles });
        res.json({ alerts: require('../lib/file_acl').viditelneZaznamy(activeAlerts, req.principal, vazby) });
    } catch (err) {
        res.status(500).json({ error: `Nepodařilo se získat upozornění: ${err.message}` });
    }
});

// POST /api/alerts/check - Manually trigger background insolvency verification for all IČOs
router.post('/check', async (req, res) => {
    try {
        const stats = await checkAllInsolvencies();
        res.json({ success: true, ...stats });
    } catch (err) {
        res.status(500).json({ error: `Hromadná prověrka insolvencí selhala: ${err.message}` });
    }
});

// POST /api/alerts/dismiss/:alertId - Dismiss/mute an active alert
router.post('/dismiss/:alertId', async (req, res) => {
    const { alertId } = req.params;
    try {
        const inbox = await loadInbox();
        if (inbox.alerts) {
            inbox.alerts = inbox.alerts.map(a => {
                if (a.id === alertId) {
                    return { ...a, status: 'dismissed', dismissedAt: new Date().toISOString() };
                }
                return a;
            });
            await saveInbox(inbox);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: `Nepodařilo se skrýt upozornění: ${err.message}` });
    }
});

module.exports = router;
