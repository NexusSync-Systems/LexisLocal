'use strict';
/**
 * file_acl.js — oprávnění k DOKUMENTŮM (inbox_files) a jejich RAG úsekům ve firemním režimu.
 *
 * Nález 14. 10. 2026: ACL spisu (lib/access.js) se kontrolovala jen v routes/spisy.js
 * a drafts. Doručená pošta, lhůtník, fakturace a hlavně RAG agentů pracovaly se VŠEMI
 * dokumenty kanceláře — kolega bez sdílení tak mohl přes agenta dostat úryvky z cizího spisu.
 *
 * Pravidla (jen firemní režim; solo režim je beze změny):
 *   • bez principala (watcher, cron — mimo HTTP)   → bez omezení (systémový běh),
 *   • správce (scope admin)                         → vše,
 *   • dokument zařazený do spisu (sp. zn. → spis)   → podle access.canAccess(spis, level),
 *   • nezařazený dokument (spis zatím neexistuje)   → vidí jen podatelna (role asistent), správce
 *                                                     a ten, kdo ho nahrál (mlčenlivost — simulace kanceláře
 *                                                     27. 10. 2026: smlouvu klienta bez sp. zn. dřív viděli všichni
 *                                                     i ve vyhledávání a v odpovědích AI),
 *   • RAG úsek bez záznamu v inbox_files            → fail-closed (neznámý původ), kromě
 *     znalostní báze (`_kb_*`), která je společná pro celou kancelář.
 */
const access = require('./access');
const db = require('./database');

function _principal(p) {
    if (p !== undefined) return p;
    try { return require('./request_context').currentPrincipal(); } catch (e) { return null; }
}

function _unrestricted(principal) {
    if (!access.isFirmMode()) return true;
    if (!principal) return true;
    try { if (require('./principal').hasScope(principal, 'admin')) return true; } catch (e) { /* fail-closed níž */ }
    return false;
}

function _norm(name) { return String(name || '').toLowerCase().replace(/\\/g, '/'); }

/** Spis, do kterého dokument patří (podle sp. zn.), nebo null. */
function spisForFile(file) {
    if (!file || !file.caseNumber) return null;
    try { return require('./spisy').findByCase(file.caseNumber); } catch (e) { return null; }
}

/** Smí principal dokument číst/měnit? level: 'read' | 'write'. */
function canAccessFile(file, principal, level) {
    principal = _principal(principal);
    if (_unrestricted(principal)) return true;
    const spis = spisForFile(file);
    if (!spis) return unfiledVisible(file, principal);
    return access.canAccess(spis, principal, level || 'read');
}

/** Nezařazený dokument: podatelna (role asistent), správce, nebo ten, kdo ho nahrál. */
function unfiledVisible(file, principal) {
    if (!principal || principal.kind !== 'user') return false;
    if (file && file.uploadedBy && file.uploadedBy === principal.userId) return true;
    return principal.role === 'asistent' || principal.role === 'spravce';
}

/** Odfiltruje seznam dokumentů na ty, ke kterým má principal přístup. */
function filterFiles(files, principal, level) {
    principal = _principal(principal);
    if (_unrestricted(principal)) return files;
    return (files || []).filter(f => canAccessFile(f, principal, level));
}

/**
 * Množina normalizovaných jmen (relativePath, id, fileName) čitelných dokumentů,
 * nebo null = bez omezení.
 */
function readableFileNames(principal) {
    principal = _principal(principal);
    if (_unrestricted(principal)) return null;
    const allowed = new Set();
    (db.get('inbox_files') || []).forEach(f => {
        if (!canAccessFile(f, principal, 'read')) return;
        [f.relativePath, f.id, f.fileName].forEach(n => { if (n) allowed.add(_norm(n)); });
    });
    return allowed;
}

/** Odfiltruje RAG úseky klientských spisů. KB úseky (scope `_kb_*`) zůstávají. */
function filterChunks(chunks, principal) {
    const allowed = readableFileNames(principal);
    if (!allowed) return chunks;
    return (chunks || []).filter(c => {
        if (typeof c.scope === 'string' && c.scope.indexOf('_kb_') === 0) return true;
        return allowed.has(_norm(c.fileName));
    });
}

/** Je RAG výsledek (fileName) pro principala čitelný? */
function canReadChunkFile(fileName, principal) {
    const allowed = readableFileNames(principal);
    return !allowed || allowed.has(_norm(fileName));
}

/** Spis podle jména RAG úseku (relativePath/id/fileName dokumentu), nebo null. */
function spisForFileName(name) {
    const n = _norm(name);
    if (!n) return null;
    const f = (db.get('inbox_files') || []).find(x => [x.relativePath, x.id, x.fileName].some(v => v && _norm(v) === n));
    return f ? spisForFile(f) : null;
}

/**
 * Auditní stopa čtení přes RAG: za každý spis, z něhož výsledky obsahují klientský
 * úsek, jeden záznam (deduplikovaný v audit.logRead). KB úseky se nelogují.
 */
function logChunkReads(matches, operation) {
    try {
        const { logRead, readLoggingEnabled } = require('./audit');
        if (!readLoggingEnabled()) return;
        const bySpis = new Map();
        (matches || []).forEach(m => {
            if (!m || (typeof m.scope === 'string' && m.scope.indexOf('_kb_') === 0)) return;
            const spis = spisForFileName(m.fileName);
            if (!spis) return;
            if (!bySpis.has(spis.id)) bySpis.set(spis.id, { spis, files: new Set() });
            bySpis.get(spis.id).files.add(m.fileName);
        });
        for (const { spis, files } of bySpis.values()) {
            logRead(operation, spis.spisZn || spis.nazev || spis.id, spis.id, { files: [...files].slice(0, 10) });
        }
    } catch (e) { /* audit čtení nesmí shodit odpověď */ }
}

module.exports = { unfiledVisible, spisForFileName, logChunkReads, spisForFile, canAccessFile, filterFiles, readableFileNames, filterChunks, canReadChunkFile };
