/**
 * routes/workflows.js — pravidla workflow, procesní lhůty (alerts) a ruční triggery.
 * Montuje se v server.js na /api/workflows.
 */
'use strict';

const express = require('express');
const router = express.Router();
const WorkflowEngine = require('../lib/workflow');
const db = require('../lib/database');

// GET /api/workflows/rules - Retrieve all workflow rules
router.get('/rules', (req, res) => {
    try {
        const rules = WorkflowEngine.getRules();
        res.json({ success: true, rules });
    } catch (err) {
        res.status(500).json({ error: `Nelze načíst pravidla workflow: ${err.message}` });
    }
});

// POST /api/workflows/rules - Create new custom workflow rule
router.post('/rules', (req, res) => {
    try {
        const b = req.body || {};
        // Prázdné tělo dřív vytvořilo „Nové pravidlo“ s výchozí akcí (test 2. 10. 2026).
        if (typeof b.name !== 'string' || !b.name.trim()) {
            return res.status(400).json({ error: 'Pravidlo musí mít název (name).' });
        }
        const rule = WorkflowEngine.addRule(b);
        res.json({ success: true, rule });
    } catch (err) {
        res.status(500).json({ error: `Nelze vytvořit pravidlo workflow: ${err.message}` });
    }
});

// DELETE /api/workflows/rules/:id - Delete custom workflow rule
router.delete('/rules/:id', (req, res) => {
    const { id } = req.params;
    try {
        const deleted = WorkflowEngine.deleteRule(id);
        res.json({ success: true, deleted });
    } catch (err) {
        res.status(500).json({ error: `Nelze smazat pravidlo workflow: ${err.message}` });
    }
});

// GET /api/workflows/alerts - Retrieve all pending calendar tasks and deadlines
router.get('/alerts', (req, res) => {
    try {
        const alerts = db.get('alerts');
        res.json({ success: true, alerts });
    } catch (err) {
        res.status(500).json({ error: `Nelze načíst procesní lhůty: ${err.message}` });
    }
});

// POST /api/workflows/alerts/:id/complete - Mark task/deadline as resolved
router.post('/alerts/:id/complete', (req, res) => {
    const { id } = req.params;
    try {
        const updated = db.update('alerts', id, { status: 'completed', completedAt: new Date().toISOString() });
        res.json({ success: true, alert: updated });
    } catch (err) {
        res.status(500).json({ error: `Nelze splnit lhůtu: ${err.message}` });
    }
});

// POST /api/workflows/trigger - Manually trigger an event in the workflow engine
router.post('/trigger', async (req, res) => {
    const { triggerType, payload } = req.body;
    if (!triggerType) {
        return res.status(400).json({ error: "Typ události (triggerType) je povinný." });
    }
    try {
        const createdAlerts = await WorkflowEngine.triggerEvent(triggerType, payload || {});
        res.json({ success: true, triggeredCount: createdAlerts.length, alerts: createdAlerts });
    } catch (err) {
        res.status(500).json({ error: `Chyba při spouštění workflow: ${err.message}` });
    }
});

module.exports = router;
