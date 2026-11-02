'use strict';
/**
 * email_attachments.js — přílohy e-mailu jen z dokumentů kanceláře, ke kterým má odesílatel přístup.
 *
 * Bezpečnostní revize 2. 11. 2026: POST /api/email/send bral `attachmentPaths` jako libovolné cesty na disku →
 * šlo odeslat klíč databáze, seznam uživatelů nebo dokument cizího spisu. Nově se příloha musí najít v evidenci
 * dokumentů (schránka / spisovna) podle názvu nebo cesty, skutečná cesta (po symlincích) musí ležet ve spisovně
 * a odesílatel k dokumentu musí mít právo čtení (lib/file_acl.js). Cokoli jiného → chyba, nic se neodešle.
 */
const fs = require('fs');
const path = require('path');

function _real(p) { try { return fs.realpathSync(p); } catch (e) { return null; } }

function _uvnitr(root, p) {
    const r = _real(root); const x = _real(p);
    if (!r || !x) return false;
    const rs = r.endsWith(path.sep) ? r : r + path.sep;
    return x.startsWith(rs);
}

/**
 * @param {string[]} pozadovane  názvy dokumentů (klíč ve schránce) nebo cesty
 * @param {object} principal     odesílatel
 * @param {object} [opts]        { inbox, ingestDir, fileAcl } pro testy
 * @returns {Promise<string[]>}  ověřené absolutní cesty pro mailer
 */
async function overPrilohy(pozadovane, principal, opts = {}) {
    const list = (Array.isArray(pozadovane) ? pozadovane : []).filter(x => typeof x === 'string' && x.trim());
    if (!list.length) return [];
    const inbox = opts.inbox || await require('./watcher').loadInbox();
    const files = (inbox && inbox.files) || {};
    const ingestDir = opts.ingestDir || require('./config').getIngestDir();
    const acl = opts.fileAcl || require('./file_acl');
    const podleCesty = new Map();
    for (const [k, f] of Object.entries(files)) {
        if (f && f.filePath) { const r = _real(f.filePath); if (r) podleCesty.set(r, Object.assign({ _key: k }, f)); }
    }
    return list.map(x => {
        const chyba = msg => Object.assign(new Error(`Příloha „${path.basename(x)}“: ${msg}`), { code: 'ATTACHMENT_FORBIDDEN', status: 403 });
        let f = files[x] ? Object.assign({ _key: x }, files[x]) : null;
        if (!f) { const r = _real(x); f = r ? podleCesty.get(r) || null : null; }
        if (!f || !f.filePath) throw chyba('není dokument evidovaný v LexisLocalu');
        if (!_uvnitr(ingestDir, f.filePath)) throw chyba('soubor neleží ve spisovně');
        if (path.basename(f.filePath).startsWith('.')) throw chyba('interní soubor aplikace');
        if (!acl.canAccessFile(f, principal, 'read')) throw chyba('k dokumentu nemáte přístup');
        return _real(f.filePath);
    });
}

module.exports = { overPrilohy };
