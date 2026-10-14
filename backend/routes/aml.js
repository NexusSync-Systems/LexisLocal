/**
 * routes/aml.js — AML identifikace a kontrola klienta (zák. 253/2008 Sb.).
 * Montuje se v server.js na /api/aml.
 */
'use strict';

const express = require('express');
const router = express.Router();
const aml = require('../lib/aml');
const { logEvent } = require('../lib/audit');
const sanctions = require('../lib/sanctions');
const sanctionsImport = require('../lib/sanctionsImport');
const { DATA_DIR } = require('../lib/config');
const path = require('path');
const fs = require('fs');

// POST /api/aml/identify — identifikace + kontrola klienta
// Firemní režim: prověrka navázaná na spis = podle ACL spisu; bez spisu = autor nebo správce.
// (AML záznam nese rodné číslo, adresu a rizikové faktory klienta.)
const access = require('../lib/access');
function _canSeeCheck(c, principal) {
    if (!access.isFirmMode()) return true;
    if (access.isAdminOrSolo(principal)) return true;
    if (c.spisId) return !access.checkSpisAccess(c.spisId, principal, 'read');
    return !!(c.createdBy && principal && c.createdBy.id === principal.userId);
}

router.post('/identify', async (req, res) => {
    const sid = req.body && req.body.spisId;
    if (sid) {
        const deny = access.checkSpisAccess(sid, req.principal, 'write');
        if (deny) return res.status(deny.status).json({ error: deny.error });
    }
    try {
        const record = await aml.identify(req.body || {});
        logEvent('AML', 'Identifikace klienta', record.jmeno, { risk: record.risk, spisId: record.spisId });
        res.status(201).json({ check: record });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/aml/checks — historie AML prověrek; filtr ?spisId=&risk=
router.get('/checks', (req, res) => {
    try {
        res.json({ checks: aml.listChecks({ spisId: req.query.spisId, risk: req.query.risk }).filter(c => _canSeeCheck(c, req.principal)) });
    } catch (err) {
        res.status(500).json({ error: `Chyba při načtení AML prověrek: ${err.message}` });
    }
});

// GET /api/aml/checks/:id — detail prověrky
router.get('/checks/:id', (req, res) => {
    const check = aml.getCheck(req.params.id);
    if (!check) return res.status(404).json({ error: 'AML prověrka nenalezena.' });
    if (!_canSeeCheck(check, req.principal)) return res.status(403).json({ error: 'Přístup k prověrce odepřen.' });
    res.json({ check });
});

// GET /api/aml/watchlist — lokální PEP/sankční seznam kanceláře
router.get('/watchlist', (req, res) => {
    try {
        res.json({ watchlist: aml.listWatch() });
    } catch (err) {
        res.status(500).json({ error: `Chyba při načtení seznamu: ${err.message}` });
    }
});

// POST /api/aml/watchlist — přidání záznamu { name, type, note }
router.post('/watchlist', (req, res) => {
    try {
        const entry = aml.addWatch(req.body || {});
        logEvent('AML', 'Přidání do PEP/sankčního seznamu', entry.name, { type: entry.type });
        res.status(201).json({ entry });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/aml/sanctions/status — je načtený oficiální sankční seznam?
router.get('/sanctions/status', (req, res) => {
    res.json({ available: sanctions.isAvailable(), file: process.env.LEXIS_SANCTIONS_FILE || path.join(DATA_DIR, 'sanctions.json') });
});

// POST /api/aml/sanctions/import — sestaví sankční seznam z lokálních souborů
// (body: { ofacFile, euFile, unFile }) NEBO z konfigurovaných URL (env SANCTIONS_*_URL),
// uloží do LEXIS_SANCTIONS_FILE a znovu načte engine. Fail-closed: bez zdrojů chyba.
router.post('/sanctions/import', async (req, res) => {
    try {
        const b = req.body || {};
        const outFile = process.env.LEXIS_SANCTIONS_FILE || path.join(DATA_DIR, 'sanctions.json');
        let entries = null;
        const readIf = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch (e) { return null; } };
        const ofacCsv = readIf(b.ofacFile); const euXml = readIf(b.euFile); const unXml = readIf(b.unFile);
        if (ofacCsv || euXml || unXml) {
            entries = sanctionsImport.buildNormalized({ ofacCsv, euXml, unXml });
        } else if (process.env.SANCTIONS_OFAC_URL || process.env.SANCTIONS_EU_URL || process.env.SANCTIONS_UN_URL) {
            entries = await sanctionsImport.fetchAndBuild({ ofacUrl: process.env.SANCTIONS_OFAC_URL, euUrl: process.env.SANCTIONS_EU_URL, unUrl: process.env.SANCTIONS_UN_URL });
        } else {
            return res.status(400).json({ error: 'Zdroje sankčních seznamů nejsou k dispozici (zadejte cesty k souborům nebo nastavte SANCTIONS_*_URL).' });
        }
        if (!entries || !entries.length) return res.status(422).json({ error: 'Import nevrátil žádné záznamy — zkontrolujte zdroje.' });
        try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); } catch (e) {}
        sanctionsImport.writeList(entries, outFile);
        const loaded = sanctions.loadList({ file: outFile, source: 'import' });
        logEvent('AML', 'Import sankčního seznamu', 'sanctions.json', { count: entries.length });
        res.json({ success: true, imported: entries.length, file: outFile, loaded });
    } catch (err) {
        res.status(500).json({ error: 'Import sankčního seznamu selhal: ' + err.message });
    }
});

module.exports = router;
