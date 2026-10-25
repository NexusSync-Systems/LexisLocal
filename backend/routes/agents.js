/**
 * routes/agents.js — správa AI agentů (CRUD).
 * Montuje se v server.js na /api/agents.
 */
'use strict';

const express = require('express');
const router = express.Router();
const { loadAgents, saveAgent, saveExamples, deleteAgent, resetAgentToDefault, DEFAULT_AGENTS } = require('../lib/agents');
const { logEvent } = require('../lib/audit');

// GET /api/agents - Seznam agentů
router.get('/', (req, res) => {
    try {
        const agents = loadAgents();
        res.json({ success: true, agents: Object.values(agents) });
    } catch (err) {
        res.status(500).json({ error: `Nelze načíst agenty: ${err.message}` });
    }
});

// GET /api/agents/:agentId/examples — vzorové výstupy agenta (few-shot)
router.get('/:agentId/examples', (req, res) => {
    const a = loadAgents()[req.params.agentId];
    if (!a) return res.status(404).json({ error: 'Agent nebyl nalezen.' });
    const defs = require('../lib/agent_examples').DEFAULT_EXAMPLES[a.id] || [];
    res.json({ success: true, examples: a.examples || [], hasDefaults: defs.length > 0, limits: require('../lib/agent_examples').LIMITS });
});

// POST /api/agents/:agentId/examples — uložit celý seznam ukázek { examples: [...] }
// nebo { reset: true } = vrátit výchozí ukázky systémového agenta. (admin, viz authz)
router.post('/:agentId/examples', (req, res) => {
    const { agentId } = req.params;
    try {
        const list = req.body && req.body.reset ? (require('../lib/agent_examples').DEFAULT_EXAMPLES[agentId] || []) : (req.body || {}).examples;
        const saved = saveExamples(agentId, list);
        logEvent('LexisLocal Dashboard', 'Úprava vzorových výstupů agenta', 'AI Konfigurace', { agentId, count: saved.length });
        res.json({ success: true, examples: saved });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
    }
});

// POST /api/agents/:agentId - Update an agent
router.post('/:agentId', (req, res) => {
    const { agentId } = req.params;
    const { name, emoji, role, systemPrompt, preferredModel, permissions, spisAccess, useJudikatura } = req.body;
    try {
        const updated = saveAgent(agentId, { name, emoji, role, systemPrompt, preferredModel, permissions, spisAccess, useJudikatura });
        logEvent('LexisLocal Dashboard', `Úprava agenta (${updated.name})`, 'AI Konfigurace', { agentId });
        res.json({ success: true, agent: updated });
    } catch (err) {
        res.status(500).json({ error: `Nelze upravit agenta: ${err.message}` });
    }
});

// POST /api/agents - Create a new custom agent
router.post('/', (req, res) => {
    const { id, name, emoji, role, systemPrompt, preferredModel, permissions, spisAccess, useJudikatura } = req.body;
    if (!id || !name) {
        return res.status(400).json({ error: "ID a název agenta jsou povinné údaje." });
    }
    const cleanId = id.toLowerCase().replace(/[^a-z0-9_-]/g, '_').trim();
    try {
        const agents = loadAgents();
        if (agents[cleanId]) {
            return res.status(400).json({ error: `Agent s ID "${cleanId}" již existuje.` });
        }
        const created = saveAgent(cleanId, { name, emoji, role, systemPrompt, preferredModel, permissions, spisAccess, useJudikatura });
        logEvent('LexisLocal Dashboard', `Vytvoření agenta (${created.name})`, 'AI Konfigurace', { agentId: cleanId });
        res.json({ success: true, agent: created });
    } catch (err) {
        res.status(500).json({ error: `Nelze vytvořit agenta: ${err.message}` });
    }
});

// DELETE /api/agents/:agentId - Delete a custom agent
router.delete('/:agentId', (req, res) => {
    const { agentId } = req.params;
    try {
        deleteAgent(agentId);
        logEvent('LexisLocal Dashboard', `Smazání agenta (${agentId})`, 'AI Konfigurace', { agentId });
        res.json({ success: true, message: `Agent ${agentId} byl smazán.` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/agents/:agentId/reset - Reset system agent back to default
router.post('/:agentId/reset', (req, res) => {
    const { agentId } = req.params;
    try {
        const reseted = resetAgentToDefault(agentId);
        logEvent('LexisLocal Dashboard', `Reset agenta (${reseted.name})`, 'AI Konfigurace', { agentId });
        res.json({ success: true, agent: reseted });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
