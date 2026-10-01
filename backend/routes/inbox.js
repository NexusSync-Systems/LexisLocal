/**
 * routes/inbox.js — doručená pošta (parsované spisy): přehled, označení,
 * timeline spisu, mazání (disk + RAG index), upload, čtení obsahu, testovací spis.
 * Montuje se v server.js na /api/inbox.
 */
'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { WATCH_DIR } = require('../lib/config');
const { loadInbox, saveInbox, processDocument } = require('../lib/watcher');
const { deleteDocumentIndex } = require('../lib/rag');
const { safePathInWatchDir } = require('../lib/pathsafe');
const { loadAuditLogs } = require('../lib/audit');
const HearingsWatcher = require('../lib/hearings');
const db = require('../lib/database');

// GET /api/inbox - Retrieve unread parsed documents
router.get('/', async (req, res) => {
    try {
        const inbox = await loadInbox();
        const unreadFiles = Object.values(inbox.files).filter(f => f.status === 'unread');
        res.json({
            inbox: unreadFiles
        });
    } catch (err) {
        res.status(500).json({ error: `Chyba při načítání doručené pošty: ${err.message}` });
    }
});

// POST /api/inbox/mark-read - Mark parsed document as read
router.post('/mark-read', async (req, res) => {
    const { fileName } = req.body;
    if (!fileName) {
        return res.status(400).json({ error: "Název souboru je povinný." });
    }

    try {
        const inbox = await loadInbox();
        if (inbox.files[fileName]) {
            inbox.files[fileName].status = 'read';
            await saveInbox(inbox);
            res.json({ success: true, message: `Soubor ${fileName} byl označen za vyřízený.` });
        } else {
            res.status(404).json({ error: "Soubor nebyl nalezen." });
        }
    } catch (err) {
        res.status(500).json({ error: `Chyba: ${err.message}` });
    }
});

// GET /api/inbox/all - Retrieve all parsed documents (both read and unread)
router.get('/all', async (req, res) => {
    try {
        const inbox = await loadInbox();
        res.json({
            inbox: Object.values(inbox.files)
        });
    } catch (err) {
        res.status(500).json({ error: `Chyba při načítání kompletní doručené pošty: ${err.message}` });
    }
});

// GET /api/inbox/case/:caseNum/timeline - Retrieve a timeline of activities for a specific case
router.get('/case/:caseNum/timeline', async (req, res) => {
    const { caseNum } = req.params;
    try {
        const timeline = [];

        // 1. Get files belonging to this case in the inbox
        const inboxData = (await loadInbox()) || { files: {} };
        const filesArray = Object.values(inboxData.files || {});
        const caseFiles = filesArray.filter(f => f.caseNumber === caseNum);

        caseFiles.forEach(file => {
            timeline.push({
                timestamp: file.timestamp || new Date().toISOString(),
                type: 'document_added',
                title: `Přidán dokument do spisu`,
                description: `${file.fileName} (${file.wasOcr ? 'Provedeno OCR' : 'Textový formát'})`,
                icon: file.wasOcr ? '🔍' : '📄'
            });
        });

        // 2. Get activities from TimeTracker for this case
        const activities = db.get('activities') || [];
        const caseFileNames = caseFiles.map(f => f.fileName);
        const caseActivities = activities.filter(act =>
            (act.documentName && caseFileNames.includes(act.documentName)) ||
            (act.documentName && act.documentName.includes(caseNum))
        );

        caseActivities.forEach(act => {
            const hours = (act.activeSeconds / 3600).toFixed(2);
            timeline.push({
                timestamp: act.timestamp,
                type: 'work_logged',
                title: `Odpracovaná práce`,
                description: `Záznam práce (${hours} hod) - úkon: ${act.actionType || 'úprava'}`,
                icon: '🕒'
            });
        });

        // 3. Get hearings / calendar events matching this case
        const hearings = HearingsWatcher.loadMonitoredHearings(WATCH_DIR) || [];
        const caseHearings = hearings.filter(h => {
            if (!h.spisovaZnacka) return false;
            const spznStr = `${h.spisovaZnacka.cisloSenatu} ${h.spisovaZnacka.druhVeci} ${h.spisovaZnacka.bcVec}/${h.spisovaZnacka.rocnik}`;
            return spznStr.includes(caseNum) || caseNum.includes(spznStr);
        });

        caseHearings.forEach(h => {
            timeline.push({
                timestamp: h.dueDate ? `${h.dueDate}T${h.time || '10:00'}:00` : new Date().toISOString(),
                type: 'hearing',
                title: `Soudní jednání`,
                description: `${h.title} (${h.location || 'soud'}) - Stav: ${h.status.toUpperCase()}`,
                icon: '⚖️'
            });
        });

        // 4. Get audit logs for this case (where target matches file names or caseNum)
        const auditLogs = loadAuditLogs() || [];
        const caseAuditLogs = auditLogs.filter(log =>
            log.target === caseNum ||
            (log.target && caseFileNames.includes(log.target))
        );

        caseAuditLogs.forEach(log => {
            timeline.push({
                timestamp: log.timestamp,
                type: 'audit',
                title: log.operation,
                description: `${log.user}: ${log.target}`,
                icon: '📜'
            });
        });

        // Sort timeline descending by timestamp
        timeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json({ success: true, timeline });
    } catch (err) {
        res.status(500).json({ error: `Nelze načíst timeline spisu: ${err.message}` });
    }
});

// POST /api/inbox/delete - Delete document from index and physically from disk
router.post('/delete', async (req, res) => {
    const { fileName } = req.body;
    if (!fileName) {
        return res.status(400).json({ error: "Název souboru je povinný." });
    }

    try {
        const inbox = await loadInbox();
        let key = fileName;
        if (!inbox.files[key]) {
            // Find key by matching relativePath or basename
            const foundKey = Object.keys(inbox.files || {}).find(k => k === fileName || path.basename(k) === fileName);
            if (foundKey) key = foundKey;
        }

        if (inbox.files[key]) {
            const fileData = inbox.files[key];

            // Delete physical file if it exists
            if (fileData.filePath && fs.existsSync(fileData.filePath)) {
                try {
                    fs.unlinkSync(fileData.filePath);
                    console.log(`🗑️ Fyzický soubor smazán: ${fileData.filePath}`);
                } catch (e) {
                    console.warn(`⚠️ Nelze smazat fyzický soubor: ${fileData.filePath}`, e.message);
                }
            }

            // Clear from local RAG vector index (checks relativePath or key)
            const indexKey = fileData.relativePath || key;
            try {
                await deleteDocumentIndex(indexKey);
            } catch (err) {
                console.error(`❌ RAG: Nelze odstranit index pro ${indexKey}:`, err.message);
            }

            delete inbox.files[key];
            await saveInbox(inbox);
            res.json({ success: true, message: `Soubor ${fileName} byl kompletně smazán z indexu i disku.` });
        } else {
            res.status(404).json({ error: "Soubor nebyl nalezen v indexu." });
        }
    } catch (err) {
        res.status(500).json({ error: `Chyba při mazání souboru: ${err.message}` });
    }
});

// POST /api/inbox/upload - Save uploaded file base64 directly to WATCH_DIR
router.post('/upload', async (req, res) => {
    const { fileName, base64 } = req.body;
    if (!fileName || !base64) {
        return res.status(400).json({ error: "Název souboru a base64 obsah jsou povinné." });
    }

    let filePath;
    try {
        filePath = safePathInWatchDir(fileName);
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }

    try {
        // Clean base64 prefix if present
        const base64Data = base64.replace(/^data:.*?;base64,/, "");

        const buffer = Buffer.from(base64Data, 'base64');
        await fs.promises.writeFile(filePath, buffer);
        console.log(`📥 Nahraný soubor uložen na disk: ${filePath}`);

        // Uložené jméno (po sanitizaci) — dřív odpověď opakovala surový vstup, např. „../../x“.
        const storedName = path.basename(filePath);

        // Trigger manual file processing immediately
        let processingError = null;
        try {
            await processDocument(filePath);
        } catch (procErr) {
            processingError = procErr.message;
            console.warn(`⚠️ Watcher: Nepodařilo se vynutit okamžité zpracování souboru ${storedName}:`, procErr.message);
        }

        if (processingError) {
            // Soubor je uložený (watcher ho zkusí znovu), ale advokát musí vědět, že
            // metadata/lhůty zatím nejsou — dřív API hlásilo úspěch i při chybě.
            return res.status(202).json({
                success: true, processed: false, fileName: storedName,
                warning: `Soubor ${storedName} byl uložen, ale zpracování selhalo: ${processingError}. Lhůty a metadata zatím nejsou k dispozici.`
            });
        }
        res.json({ success: true, processed: true, fileName: storedName, message: `Soubor ${storedName} byl úspěšně nahrán a zpracován.` });
    } catch (err) {
        res.status(500).json({ error: `Chyba při nahrávání souboru: ${err.message}` });
    }
});

// GET /api/inbox/content - Retrieve parsed document text content on-demand
router.get('/content', async (req, res) => {
    const { fileName } = req.query;
    if (!fileName) {
        return res.status(400).json({ error: "Název souboru je povinný." });
    }

    try {
        const inbox = await loadInbox();
        const fileData = inbox.files[fileName];
        if (!fileData) {
            return res.status(404).json({ error: "Soubor nebyl nalezen v indexu." });
        }

        const filePath = fileData.filePath;
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Fyzický soubor na disku neexistuje." });
        }

        const ext = path.extname(filePath).toLowerCase();
        let content = "";

        if (ext === '.pdf') {
            const pdf = require('pdf-parse');
            const dataBuffer = await fs.promises.readFile(filePath);
            const parsedPdf = await pdf(dataBuffer);
            content = parsedPdf.text;
        } else {
            content = await fs.promises.readFile(filePath, 'utf-8');
        }

        res.json({
            fileName: fileName,
            content: content
        });
    } catch (err) {
        res.status(500).json({ error: `Chyba při čtení obsahu spisu: ${err.message}` });
    }
});

// POST /api/inbox/parse-test - Generate mock legal document for sanity and user testing
router.post('/parse-test', async (req, res) => {
    try {
        const testFilePath = path.join(WATCH_DIR, 'testovaci_soudni_spis.txt');
        const sampleContent = `OKRESNÍ SOUD V BRNĚ
Polní 994/39, 608 00 Brno

spisová značka: 23 C 120/2026-14

Žalobce: Jan Novák, nar. 1. 1. 1980, bytem Veselá 12, Brno
Žalovaný: PRIMA s.r.o., IČO: 12345678, se sídlem Nádražní 5, Brno

USNESENÍ

Soud vyzývá žalovaného, aby se ve lhůtě 15 dnů od doručení tohoto usnesení písemně vyjádřil k podané žalobě. Pokud se bez vážného důvodu nevyjádříte, má se za to, že nárok žalobce uznáváte.`;

        await fs.promises.writeFile(testFilePath, sampleContent, 'utf-8');
        await processDocument(testFilePath);

        res.json({ success: true, message: "Testovací dokument byl úspěšně vygenerován a naimportován do schránky." });
    } catch (err) {
        res.status(500).json({ error: `Chyba při generování testovacího spisu: ${err.message}` });
    }
});

module.exports = router;
