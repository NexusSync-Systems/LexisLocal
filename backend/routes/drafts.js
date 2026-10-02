/**
 * routes/drafts.js — sdílené koncepty (webový LexisEditor Lite). Montuje se na /api/drafts.
 *
 *   GET    /                     seznam (?spisId=&status=)
 *   POST   /                     založit { title, spisId, caseNumber, spec | text }
 *   GET    /:id                  detail (aktuální spec, verze, komentáře, zámek)
 *   GET    /:id/versions/:v      konkrétní verze (spec)
 *   PUT    /:id                  uložit novou verzi { spec | text, baseVersion, note }  → 409 při souběhu
 *   POST   /:id/lock             zamknout pro editaci (prodlouží TTL)   DELETE /:id/lock  odemknout
 *   POST   /:id/status           { status: koncept | ke_kontrole | schvaleno } (schvaluje jen člověk)
 *   POST   /:id/comments         { text, blockId }   POST /:id/comments/:cid/resolve
 *   GET    /:id/text             prostý text (pro agenty)
 *   GET    /:id/export.docx      .docx s vnořeným LexisEditor spec
 *   GET    /:id/editor-spec      spec pro LexisEditor (applyDocumentSpec)
 *   POST   /:id/file             uložit schválený koncept (.docx) do složky spisu (03_Koncepty)
 *   DELETE /:id                  smazat (měkce; agent nesmí)
 *
 * Přístup: koncept ve spisu dědí ACL spisu (ve firemním režimu fail-closed).
 * Agent (per-agent token) potřebuje scope 'write' pro zápis; schválit/smazat nesmí nikdy.
 */
'use strict';

const express = require('express');
const router = express.Router();
const D = require('../lib/drafts');
const { logEvent } = require('../lib/audit');
const access = require('../lib/access');
const principalLib = require('../lib/principal');

function principalOf(req) {
    return req.principal || principalLib.resolvePrincipal(req, { apiToken: process.env.API_TOKEN, enforceToken: process.env.LEXIS_ENFORCE_TOKEN !== '0' })
        || { userId: 'local', name: 'Místní uživatel', scopes: ['read', 'write', 'admin'], kind: 'implicit' };
}

function _spis(spisId) {
    if (!spisId) return null;
    try { return require('../lib/spisy').getSpis(spisId); } catch (e) { return null; }
}

// ACL: koncept bez spisu = dostupný všem přihlášeným (solo i firma), ve spisu dle ACL spisu.
function allowed(req, res, draftOrSpisId, level) {
    const p = principalOf(req);
    if (level === 'write' && p.kind === 'agent' && !principalLib.hasScope(p, 'write')) {
        res.status(403).json({ error: 'Agent nemá oprávnění zapisovat koncepty (scope write).' });
        return false;
    }
    const spisId = typeof draftOrSpisId === 'string' ? draftOrSpisId : (draftOrSpisId && draftOrSpisId.spisId);
    if (!spisId || !access.isFirmMode()) return true;
    const spis = _spis(spisId);
    if (!access.canAccess(spis, p, level)) { res.status(403).json({ error: 'Přístup ke spisu odepřen.' }); return false; }
    return true;
}

function fail(res, e) {
    const status = e.status || 500;
    const body = { error: e.message };
    if (e.code) body.code = e.code;
    if (e.currentVersion) body.currentVersion = e.currentVersion;
    if (e.lock) body.lock = e.lock;
    res.status(status).json(body);
}

function load(req, res, level) {
    const d = D.getDraft(req.params.id);
    if (!d) { res.status(404).json({ error: 'Koncept nenalezen.' }); return null; }
    if (!allowed(req, res, d, level)) return null;
    return d;
}

function audit(action, d, req, extra) {
    const p = principalOf(req);
    try { logEvent('Koncepty', action, d.title, Object.assign({ draftId: d.id, spisId: d.spisId, version: d.version, by: p.userId }, extra || {})); } catch (e) { /* audit best-effort */ }
}

router.get('/', (req, res) => {
    try {
        const p = principalOf(req);
        let list = D.listDrafts({ spisId: req.query.spisId || null, status: req.query.status || null });
        if (access.isFirmMode()) list = list.filter(d => !d.spisId || access.canAccess(_spis(d.spisId), p, 'read'));
        res.json({ drafts: list });
    } catch (e) { fail(res, e); }
});

router.post('/', (req, res) => {
    const b = req.body || {};
    if (!allowed(req, res, b.spisId || null, 'write')) return;
    try {
        if (b.spisId && !_spis(b.spisId)) return res.status(400).json({ error: 'Spis nenalezen.' });
        const p = principalOf(req);
        const src = p.kind === 'agent' ? { type: 'agent', agentId: p.name, agentName: p.name } : (b.source && b.source.type === 'import' ? { type: 'import' } : { type: 'user' });
        const d = D.createDraft({ title: b.title, spisId: b.spisId, caseNumber: b.caseNumber, spec: b.spec, text: b.text, note: b.note, source: src }, p);
        audit('Založení konceptu', d, req, { ai: d.aiGenerated });
        res.status(201).json(D.view(d));
    } catch (e) { fail(res, e); }
});

router.get('/:id', (req, res) => {
    const d = load(req, res, 'read'); if (!d) return;
    res.json(D.view(d));
});

router.get('/:id/versions/:v', (req, res) => {
    const d = load(req, res, 'read'); if (!d) return;
    const v = D.getVersion(d.id, req.params.v);
    if (!v) return res.status(404).json({ error: 'Verze nenalezena.' });
    res.json(v);
});

router.get('/:id/text', (req, res) => {
    const d = load(req, res, 'read'); if (!d) return;
    res.json({ id: d.id, title: d.title, version: d.version, status: d.status, text: D.specToText(d.versions[d.versions.length - 1].spec) });
});

router.put('/:id', (req, res) => {
    const d = load(req, res, 'write'); if (!d) return;
    try {
        const r = D.saveVersion(d.id, req.body || {}, principalOf(req));
        if (!r.unchanged) audit('Uložení verze konceptu', r.draft, req, { kind: r.draft.versions[r.draft.versions.length - 1].kind });
        res.json(Object.assign(D.view(r.draft), { unchanged: r.unchanged }));
    } catch (e) { fail(res, e); }
});

router.post('/:id/lock', (req, res) => {
    const d = load(req, res, 'write'); if (!d) return;
    try { res.json({ lock: D.acquireLock(d.id, principalOf(req)), version: d.version }); } catch (e) { fail(res, e); }
});

router.delete('/:id/lock', (req, res) => {
    const d = load(req, res, 'write'); if (!d) return;
    try { D.releaseLock(d.id, principalOf(req)); res.json({ success: true }); } catch (e) { fail(res, e); }
});

router.post('/:id/status', (req, res) => {
    const d = load(req, res, 'write'); if (!d) return;
    try {
        const st = req.body && req.body.status;
        const r = D.setStatus(d.id, st, principalOf(req));
        audit(st === 'schvaleno' ? 'Schválení konceptu' : 'Změna stavu konceptu', r, req, { status: st });
        res.json(D.view(r));
    } catch (e) { fail(res, e); }
});

router.post('/:id/comments', (req, res) => {
    const d = load(req, res, 'read'); if (!d) return; // komentovat smí i čtenář
    try { res.status(201).json(D.addComment(d.id, req.body || {}, principalOf(req))); } catch (e) { fail(res, e); }
});

router.post('/:id/comments/:cid/resolve', (req, res) => {
    const d = load(req, res, 'write'); if (!d) return;
    try { res.json(D.resolveComment(d.id, req.params.cid, principalOf(req))); } catch (e) { fail(res, e); }
});

router.get('/:id/editor-spec', (req, res) => {
    const d = load(req, res, 'read'); if (!d) return;
    res.json({ id: d.id, title: d.title, version: d.version, status: d.status, lexisSpec: D.editorSpec(d) });
});

function _fileName(d) {
    const base = String(d.title || 'koncept').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\-. ]+/g, '_').trim().slice(0, 80) || 'koncept';
    return `${base}_v${d.version}.docx`;
}

router.get('/:id/export.docx', async (req, res) => {
    const d = load(req, res, 'read'); if (!d) return;
    try {
        const buf = await D.exportDocx(d);
        audit('Export konceptu (.docx)', d, req);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${_fileName(d)}"`);
        res.send(buf);
    } catch (e) { fail(res, e); }
});

// Uložení do složky spisu jen po schválení — do spisu nejde neodsouhlasený výstup AI.
router.post('/:id/file', async (req, res) => {
    const d = load(req, res, 'write'); if (!d) return;
    if (!d.spisId) return res.status(400).json({ error: 'Koncept není přiřazen ke spisu.' });
    if (d.status !== 'schvaleno') return res.status(409).json({ error: 'Do spisu se ukládá jen schválený koncept.' });
    try {
        const spisFolders = require('../lib/spisFolders');
        const spis = _spis(d.spisId);
        if (spis) spisFolders.ensureSpisFolder(spis);
        const buf = await D.exportDocx(d);
        const r = spisFolders.saveDraftToSpis({ spisId: d.spisId, fileName: _fileName(d), content: buf });
        audit('Uložení konceptu do spisu', d, req, { filed: r && r.filed });
        res.status(201).json(Object.assign({ success: true }, r));
    } catch (e) { fail(res, e); }
});

router.delete('/:id', (req, res) => {
    const d = load(req, res, 'write'); if (!d) return;
    try { D.deleteDraft(d.id, principalOf(req)); audit('Smazání konceptu', d, req); res.json({ success: true }); } catch (e) { fail(res, e); }
});

module.exports = router;
