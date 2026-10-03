/**
 * routes/spisy.js — spisová služba: spis jako entita.
 * Montuje se v server.js na /api/spisy.
 */
'use strict';

const express = require('express');
const router = express.Router();
const spisy = require('../lib/spisy');
const spisFolders = require('../lib/spisFolders');
const access = require('../lib/access');
const principalLib = require('../lib/principal');

// Gating přístupu ke spisu. V solo režimu (isFirmMode=false) NEOMEZUJE. Ve
// firemním režimu vynucuje ACL fail-closed a při odepření pošle 403.
function requireAccess(req, res, spis, level) {
    if (!access.isFirmMode()) return true;
    const principal = principalLib.resolvePrincipal(req, { apiToken: process.env.API_TOKEN, enforceToken: true });
    if (!access.canAccess(spis, principal, level)) {
        res.status(403).json({ error: 'Přístup ke spisu odepřen.' });
        return false;
    }
    return true;
}
const { logEvent } = require('../lib/audit');

// GET /api/spisy — seznam všech spisů
router.get('/', (req, res) => {
    try {
        let list = spisy.listSpisy();
        // Firemní režim: seznam jen spisů, ke kterým má volající přístup (fail-closed).
        if (access.isFirmMode()) {
            const p = req.principal || principalLib.resolvePrincipal(req, { apiToken: process.env.API_TOKEN, enforceToken: true });
            list = list.filter(s => access.canAccess(s, p, 'read'));
        }
        res.json({ spisy: list });
    } catch (err) {
        res.status(500).json({ error: `Chyba při načtení spisů: ${err.message}` });
    }
});

// POST /api/spisy — založení nového spisu
router.post('/', (req, res) => {
    try {
        const data = Object.assign({}, req.body || {});
        // Vlastník = uživatel kanceláře: odpovědný advokát, pokud je to jméno účtu, jinak ten, kdo spis zakládá.
        const p = req.principal;
        if (!data.owner && p && p.kind === 'user') {
            const byName = data.odpovednyAdvokat ? require('../lib/users').findByName(data.odpovednyAdvokat) : null;
            data.owner = byName ? byName.id : p.userId;
        }
        delete data.access; // ACL se nedá podstrčit při založení
        const spis = spisy.createSpis(data);
        logEvent('Spisová služba', 'Založení spisu', spis.spisZn || spis.nazev, { id: spis.id });
        res.status(201).json({ spis });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/spisy/import { csv, dryRun } — import stávajících spisů z CSV (lib/spisy_import.js).
// Náhled (dryRun) nic nezakládá; vlastníkem nových spisů je importující uživatel.
router.post('/import', (req, res) => {
    try {
        const b = req.body || {};
        if (typeof b.csv !== 'string' || !b.csv.trim()) return res.status(400).json({ error: 'Chybí obsah CSV.' });
        if (b.csv.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'CSV je větší než 5 MB.' });
        const p = req.principal;
        const r = require('../lib/spisy_import').importCsv(b.csv, { dryRun: !!b.dryRun, owner: p && p.kind === 'user' ? p.userId : null });
        if (!r.ok) return res.status(400).json({ error: r.reason, header: r.header });
        if (!r.dryRun) logEvent('Spisová služba', 'Import spisů z CSV', `${r.summary.nove} nových`, r.summary);
        res.json(r);
    } catch (err) {
        res.status(500).json({ error: `Import selhal: ${err.message}` });
    }
});

// POST /api/spisy/sync — odvodí/synchronizuje spisy z inboxu (idempotentní)
router.post('/sync', (req, res) => {
    try {
        const result = spisy.syncFromInbox();
        logEvent('Spisová služba', 'Synchronizace z inboxu', 'inbox_files', result);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: `Chyba synchronizace spisů: ${err.message}` });
    }
});

// GET /api/spisy/unfiled — dokumenty bez rozpoznané sp. zn. (k ručnímu zařazení)
router.get('/unfiled', (req, res) => {
    try {
        res.json({ files: spisy.listUnfiled() });
    } catch (err) {
        res.status(500).json({ error: `Chyba při načtení nezařazených: ${err.message}` });
    }
});

// GET /api/spisy/nezarazeno-drafts — koncepty, které fail-closed skončily v _Nezařazeno
// (čekají na ruční zařazení). MUSÍ být před /:id, jinak Express bere řetězec jako :id.
router.get('/nezarazeno-drafts', (req, res) => {
    try {
        res.json({ files: spisFolders.listNezarazeno() });
    } catch (err) {
        res.status(500).json({ error: `Chyba při načtení nezařazených konceptů: ${err.message}` });
    }
});

// GET /api/spisy/:id — kompletní detail spisu se vším navázaným obsahem
router.get('/:id', (req, res) => {
    const detail = spisy.getSpisDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Spis nenalezen.' });
    res.json(detail);
});

// PATCH /api/spisy/:id — úprava údajů spisu
router.patch('/:id', (req, res) => {
    try {
        const updated = spisy.updateSpis(req.params.id, req.body || {});
        if (!updated) return res.status(404).json({ error: 'Spis nenalezen.' });
        res.json({ spis: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/spisy/:id/stav — změna stavu (aktivni | archiv | skartace)
router.post('/:id/stav', (req, res) => {
    try {
        const updated = spisy.setStav(req.params.id, (req.body && req.body.stav));
        if (!updated) return res.status(404).json({ error: 'Spis nenalezen.' });
        logEvent('Spisová služba', 'Změna stavu spisu', updated.spisZn || updated.nazev, { stav: updated.stav });
        res.json({ spis: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/spisy/:id/event — přidání úkonu do spisového deníku
router.post('/:id/event', (req, res) => {
    try {
        const spis = spisy.getSpis(req.params.id);
        if (!spis) return res.status(404).json({ error: 'Spis nenalezen.' });
        const ev = spisy.addEvent(req.params.id, (req.body && req.body.type), (req.body && req.body.note), (req.body && req.body.meta));
        res.status(201).json({ event: ev });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/spisy/:id/assign-file — ruční zařazení dokumentu do spisu { fileId }
router.post('/:id/assign-file', (req, res) => {
    try {
        const file = spisy.assignFileToSpis((req.body && req.body.fileId), req.params.id);
        logEvent('Spisová služba', 'Zařazení dokumentu do spisu', file.fileName || file.id, { spisId: req.params.id });
        res.json({ success: true, file });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/spisy/:id/timeline — sjednocená časová osa spisu (deník + audit + dokumenty + lhůty + jednání)
router.get('/:id/timeline', (req, res) => {
    const spis = spisy.getSpis(req.params.id);
    if (!spis) return res.status(404).json({ error: 'Spis nenalezen.' });
    if (!requireAccess(req, res, spis, 'read')) return;
    res.json(spisy.getSpisTimeline(req.params.id));
});

// POST /api/spisy/:id/folder — idempotentně založí fyzickou složku spisu + vizitku
router.post('/:id/folder', (req, res) => {
    try {
        const spis = spisy.getSpis(req.params.id);
        if (!spis) return res.status(404).json({ error: 'Spis nenalezen.' });
        if (!requireAccess(req, res, spis, 'write')) return;
        const r = spisFolders.ensureSpisFolder(spis);
        logEvent('Spisová služba', r.created ? 'Založení složky spisu' : 'Ověření složky spisu', spis.spisZn || spis.nazev, { spisId: spis.id, folderId: r.folderId });
        res.status(r.created ? 201 : 200).json({ success: true, ...r });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/spisy/:id/draft — uloží koncept do složky spisu (fail-closed do _Nezařazeno)
// Tělo: { fileName, content }. saveDraftToSpis sám zapíše do deníku i auditu se spisId.
router.post('/:id/draft', (req, res) => {
    try {
        const spis = spisy.getSpis(req.params.id);
        if (!spis) return res.status(404).json({ error: 'Spis nenalezen.' });
        if (!requireAccess(req, res, spis, 'write')) return;
        const r = spisFolders.saveDraftToSpis({
            spisId: spis.id,
            fileName: (req.body && req.body.fileName) || 'koncept.docx',
            content: (req.body && req.body.content) != null ? req.body.content : ''
        });
        res.status(201).json({ success: true, ...r });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/spisy/:id/drafts — seznam uložených konceptů ve složce spisu (03_Koncepty)
router.get('/:id/drafts', (req, res) => {
    try {
        const spis = spisy.getSpis(req.params.id);
        if (!spis) return res.status(404).json({ error: 'Spis nenalezen.' });
        if (!requireAccess(req, res, spis, 'read')) return;
        res.json({ drafts: spisFolders.listDrafts(spis.id) });
    } catch (err) {
        res.status(500).json({ error: `Chyba při načtení konceptů: ${err.message}` });
    }
});

// GET /api/spisy/:id/access — aktuální ACL spisu (owner/readers/writers)
router.get('/:id/access', (req, res) => {
    const spis = spisy.getSpis(req.params.id);
    if (!spis) return res.status(404).json({ error: 'Spis nenalezen.' });
    if (!requireAccess(req, res, spis, 'read')) return;
    res.json({ access: spisy.getSpisAccess(req.params.id) });
});

// POST /api/spisy/:id/share — sdílet spis s kolegou { userId, level: 'read'|'write' }
router.post('/:id/share', (req, res) => {
    try {
        const spis = spisy.getSpis(req.params.id);
        if (!spis) return res.status(404).json({ error: 'Spis nenalezen.' });
        if (!requireAccess(req, res, spis, 'admin')) return;
        const target = req.body && req.body.userId;
        const usersLib = require('../lib/users');
        if (usersLib.listUsers().length && !usersLib.getUser(target)) return res.status(400).json({ error: 'Sdílet lze jen s uživatelem kanceláře.' });
        const updated = spisy.shareSpis(req.params.id, target, req.body && req.body.level);
        res.json({ success: true, access: spisy.getSpisAccess(req.params.id), spis: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/spisy/:id/owner — změna vlastníka { userId } (vlastník nebo správce)
router.post('/:id/owner', (req, res) => {
    try {
        const spis = spisy.getSpis(req.params.id);
        if (!spis) return res.status(404).json({ error: 'Spis nenalezen.' });
        if (access.isFirmMode()) { if (!requireAccess(req, res, spis, 'admin')) return; }
        const uid = req.body && req.body.userId;
        const u = uid && require('../lib/users').getUser(uid);
        if (!u || u.disabled) return res.status(400).json({ error: 'Vlastníkem může být jen aktivní uživatel kanceláře.' });
        const updated = spisy.setSpisOwner(req.params.id, uid);
        res.json({ success: true, access: spisy.getSpisAccess(req.params.id), spis: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/spisy/:id/revoke — odebrat přístup kolegovi { userId }
router.post('/:id/revoke', (req, res) => {
    try {
        const spis = spisy.getSpis(req.params.id);
        if (!spis) return res.status(404).json({ error: 'Spis nenalezen.' });
        if (!requireAccess(req, res, spis, 'admin')) return;
        const updated = spisy.revokeSpisAccess(req.params.id, req.body && req.body.userId);
        res.json({ success: true, access: spisy.getSpisAccess(req.params.id), spis: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// DELETE /api/spisy/:id — odstranění spisové hlavičky (jen ve stavu skartace)
router.delete('/:id', (req, res) => {
    try {
        const removed = spisy.deleteSpis(req.params.id);
        if (!removed) return res.status(404).json({ error: 'Spis nenalezen.' });
        logEvent('Spisová služba', 'Odstranění spisu (skartace)', removed.spisZn || removed.nazev, { id: removed.id });
        res.json({ success: true, removed });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
