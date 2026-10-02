/**
 * routes/document.js — archivace (Dublin Core) a anonymizace textu (GDPR).
 * Montuje se v server.js na /api/document.
 */
'use strict';

const express = require('express');
const router = express.Router();
const { generateDublinCoreXml } = require('../lib/archival');
const { anonymizeText } = require('../lib/anonymizer');

// POST /api/document/archive - Vygeneruje Dublin Core XML metadata
router.post('/archive', (req, res) => {
    const { title, creator, subject, description, type, language, rights } = req.body;
    try {
        const xml = generateDublinCoreXml({
            title,
            creator,
            subject,
            description,
            type,
            language,
            rights
        });

        res.setHeader('Content-type', 'application/xml');
        res.write(xml);
        res.end();
    } catch (err) {
        res.status(500).json({ error: `Chyba při generování metadat pro archivaci: ${err.message}` });
    }
});

// POST /api/document/anonymize - Anonymize text containing GDPR sensitive terms
router.post('/anonymize', (req, res) => {
    const { text } = req.body;
    if (text === undefined) {
        return res.status(400).json({ error: "Text k anonymizaci je povinný." });
    }
    try {
        const anonymized = anonymizeText(text);
        res.json({ anonymized });
    } catch (err) {
        res.status(500).json({ error: `Chyba při anonymizaci: ${err.message}` });
    }
});

// POST /api/document/verify-signature — ověření elektronických podpisů v PDF.
//   { fileBase64 }  … PDF poslané v těle (např. z editoru / ručně nahrané)
//   { fileName }    … dokument z doručené pošty (klíč indexu, ne libovolná cesta)
// Podpis se tu NEVYTVÁŘÍ — klíč advokáta zůstává v jeho počítači (LexisEditor).
router.post('/verify-signature', async (req, res) => {
    const SC = require('../lib/signature_check');
    const { fileBase64, fileName } = req.body || {};
    try {
        let buf;
        if (typeof fileBase64 === 'string' && fileBase64) {
            buf = Buffer.from(fileBase64.replace(/^data:[^,]*,/, ''), 'base64');
        } else if (typeof fileName === 'string' && fileName) {
            const { loadInbox } = require('../lib/watcher');
            const inbox = await loadInbox();
            const item = inbox.files[fileName];
            if (!item) return res.status(404).json({ error: 'Dokument nebyl nalezen v doručené poště.' });
            try { buf = require('fs').readFileSync(item.filePath); }
            catch (e) { return res.status(404).json({ error: 'Soubor na disku neexistuje.' }); }
            if (!/\.pdf$/i.test(item.fileName || item.filePath)) return res.status(400).json({ error: 'Podpis lze ověřit jen u PDF.' });
        } else {
            return res.status(400).json({ error: 'Pošlete PDF (fileBase64) nebo název dokumentu z doručené pošty (fileName).' });
        }
        if (buf.length > SC.MAX_BYTES) return res.status(413).json({ error: 'Soubor je příliš velký.' });
        const result = SC.checkPdfBuffer(buf);
        if (result === null) {
            if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ error: 'Nejde o PDF soubor.' });
            return res.status(503).json({ error: 'Ověření podpisů není na serveru dostupné (chybí závislost node-forge — spusťte npm install).' });
        }
        if (fileName && !fileBase64) {
            // uložit aktuální výsledek k dokumentu
            try {
                const { loadInbox, saveInbox } = require('../lib/watcher');
                const inbox = await loadInbox();
                if (inbox.files[fileName]) { inbox.files[fileName].signatures = result; await saveInbox(inbox); }
            } catch (e) { /* jen cache */ }
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Ověření podpisu selhalo: ' + err.message });
    }
});

module.exports = router;
