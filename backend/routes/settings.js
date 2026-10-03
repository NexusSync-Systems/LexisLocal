/**
 * routes/settings.js — nastavení aplikace. Zatím: výběr SPISOVNY (INGEST_DIR).
 * Montuje se v server.js na /api/settings.
 *
 * Spisovnu lze nastavit za běhu: cesta se perzistuje a watcher se přepne bez
 * restartu (nové dokumenty se hned berou z nové složky). Plné promítnutí do
 * všech částí (např. RAG sken) se dorovná po restartu — proto restartRecommended.
 */
'use strict';

const express = require('express');
const router = express.Router();
const config = require('../lib/config');
const { logEvent } = require('../lib/audit');

let watcher = null;
try { watcher = require('../lib/watcher'); } catch (e) { /* watcher volitelný */ }

// GET /api/settings/ingest-dir — aktuální spisovna, datová složka a zda je výchozí
router.get('/ingest-dir', (req, res) => {
    const persisted = config.readSettings().ingestDir || null;
    res.json({
        ingestDir: config.getIngestDir(),
        dataDir: config.DATA_DIR,
        persisted: persisted,
        isDefault: !persisted && !process.env.WATCH_DIR && !process.env.INGEST_DIR
    });
});

// POST /api/settings/ingest-dir { path } — nastaví spisovnu + přepne watcher za běhu
router.post('/ingest-dir', (req, res) => {
    try {
        const resolved = config.setIngestDir(req.body && req.body.path);
        let repointed = false;
        try {
            if (watcher && watcher.repointWatcher) { watcher.repointWatcher(resolved); repointed = true; }
        } catch (e) { /* repoint best-effort */ }
        logEvent('Nastavení', 'Změna spisovny', resolved, { repointed });
        res.json({ success: true, ingestDir: resolved, repointed, restartRecommended: !repointed });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/settings/external-research — stav cloud rešerše pro roj (persistováno; env = výchozí)
router.get('/external-research', (req, res) => {
    const s = config.readSettings();
    const persisted = (s && typeof s.externalResearch === 'boolean') ? s.externalResearch : null;
    const env = ['1', 'true', 'yes', 'on'].indexOf(String(process.env.AGENT_EXTERNAL_RESEARCH || '').toLowerCase()) >= 0;
    res.json({ enabled: persisted != null ? persisted : env, persisted: persisted, envDefault: env });
});

// POST /api/settings/external-research { enabled } — zapne/vypne cloud rešerši roje ZA BĚHU (bez restartu)
router.post('/external-research', (req, res) => {
    try {
        const enabled = !!(req.body && req.body.enabled);
        const s = config.readSettings();
        s.externalResearch = enabled;
        config.writeSettings(s);
        logEvent('Nastavení', 'Externí rešerše (cloud) pro roj', enabled ? 'zapnuto' : 'vypnuto', {});
        res.json({ success: true, enabled: enabled });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Firemní režim (přístup ke spisům podle vlastníka a sdílení) ──────────────
// GET /api/settings/firm-mode — stav + kolik spisů nemá vlastníka s účtem (uvidí je jen správce).
router.get('/firm-mode', (req, res) => {
    try {
        const access = require('../lib/access');
        const users = require('../lib/users').listUsers().filter(u => !u.disabled);
        const ids = new Set(users.map(u => u.id));
        const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        const names = new Set(users.map(u => norm(u.name)));
        const spisy = require('../lib/spisy').listSpisy();
        const orphan = spisy.filter(sp => {
            const o = access.normalizeAccess(sp).owner;
            return !ids.has(o) && !names.has(norm(o));
        });
        res.json({
            enabled: access.isFirmMode(), source: access.firmModeSource(),
            users: users.length, spisy: spisy.length, spisyWithoutOwnerAccount: orphan.length
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/settings/firm-mode { enabled } — jen správce (lib/authz: POST /api/settings).
router.post('/firm-mode', (req, res) => {
    try {
        const access = require('../lib/access');
        const want = !!(req.body && req.body.enabled);
        if (access.firmModeSource() === 'env') {
            return res.status(409).json({ error: 'Firemní režim je pevně nastaven proměnnou LEXIS_FIRM_MODE na serveru — v dashboardu ho nelze změnit.' });
        }
        if (want && require('../lib/users').listUsers().filter(u => !u.disabled).length === 0) {
            return res.status(409).json({ error: 'Nejdřív založte uživatele kanceláře — bez účtů by firemní režim nikoho nerozlišil.' });
        }
        const enabled = access.persistFirmMode(want);
        logEvent('Nastavení', enabled ? 'Zapnutí firemního režimu' : 'Vypnutí firemního režimu', 'Přístup ke spisům', { by: req.principal && req.principal.name });
        res.json({ success: true, enabled });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Profil aplikace: „pilot“ skryje moduly, které v pilotu nejsou (plán pilotu 3. 10. 2026).
// Moduly zůstávají v kódu a API; skrývá se jen navigace. LEXIS_PROFILE na serveru má přednost.
const PILOT_HIDDEN = ['models', 'chat', 'timetracking', 'risks', 'aml', 'managerial'];
function _profile() {
    const env = String(process.env.LEXIS_PROFILE || '').toLowerCase();
    if (env === 'pilot' || env === 'full') return { profile: env, source: 'env' };
    const p = config.readSettings().profile;
    return { profile: p === 'pilot' ? 'pilot' : 'full', source: 'settings' };
}
router.get('/profile', (req, res) => {
    const p = _profile();
    res.json(Object.assign(p, { hiddenTabs: p.profile === 'pilot' ? PILOT_HIDDEN : [] }));
});
// POST /api/settings/profile { profile: 'pilot' | 'full' } — jen správce (lib/authz: POST /api/settings).
router.post('/profile', (req, res) => {
    const want = req.body && req.body.profile;
    if (!['pilot', 'full'].includes(want)) return res.status(400).json({ error: 'Profil musí být „pilot“ nebo „full“.' });
    if (_profile().source === 'env') return res.status(409).json({ error: 'Profil je pevně nastaven proměnnou LEXIS_PROFILE na serveru.' });
    const s = config.readSettings(); s.profile = want; config.writeSettings(s);
    logEvent('Nastavení', want === 'pilot' ? 'Zapnutí pilotního profilu' : 'Vypnutí pilotního profilu', 'Profil aplikace', { by: req.principal && req.principal.name });
    res.json({ success: true, profile: want, hiddenTabs: want === 'pilot' ? PILOT_HIDDEN : [] });
});

module.exports = router;
