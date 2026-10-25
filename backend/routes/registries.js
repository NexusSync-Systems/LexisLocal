/**
 * routes/registries.js — rozšířená lustrace (ARES + ISIR + CEE/Katastr, jsou-li nakonfigurovány)
 * a ukládání prověrky do složky spisu.
 * Montuje se v server.js na /api/registries.
 */
'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const { checkSubject, findDataBox, isIsdsConfigured, getRegistryConfig, setRegistryConfig } = require('../lib/registries');
const { safePathInWatchDir } = require('../lib/pathsafe');

// GET /api/registries/check - Query all registries for an ICO
router.get('/check', async (req, res) => {
    const { ico } = req.query;
    if (!ico) {
        return res.status(400).json({ error: "IČO je povinný údaj." });
    }
    try {
        const result = await checkSubject(ico);

        // CEE a Katastr: jen skutečná data z lib/registries (s přístupovými údaji). Dřív
        // tu routa dopočítávala „simulované“ exekuce a plombu z poslední číslice IČO —
        // advokát by v lustraci viděl smyšlené údaje. Bez přístupu → available:false.
        if (!result.cee) result.cee = { available: false, configured: false, reason: 'CEE není nakonfigurováno (doplňte přístup Exekutorské komory v nastavení).' };
        if (!result.katastr) result.katastr = { available: false, configured: false, reason: 'Dálkový přístup do Katastru není nakonfigurován.' };

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: `Lustrace selhala: ${err.message}` });
    }
});

// GET /api/registries/isir/case?spisZn=KSBR 56 INS 1000/2026 — insolvenční řízení podle
// SPISOVÉ ZNAČKY (veřejná WS ISIR, posílá se jen sp. zn.). Výsledek porovná se spisy,
// ke kterým má uživatel přístup (shoda podle čísla INS a ročníku).
router.get('/isir/case', async (req, res) => {
    const isir = require('../lib/isir_cases');
    const zn = String(req.query.spisZn || '').slice(0, 80);
    if (!isir.parseInsZn(zn)) return res.status(400).json({ error: 'Zadejte spisovou značku insolvenčního řízení, např. „KSBR 56 INS 1000/2026“ nebo „INS 1000/2026“.' });
    const r = await isir.fetchInsCase(zn);
    if (!r.ok) return res.status(r.kind === 'not_configured' ? 400 : 502).json({ error: r.reason, kind: r.kind });
    const key = isir.insKey(zn);
    let spisy = [];
    try {
        const access = require('../lib/access');
        spisy = (require('../lib/spisy').listSpisy() || [])
            .filter(s => access.canAccess(s, req.principal, 'read'))
            .filter(s => isir.insKey(s.insZn || s.spisZn) === key)
            .map(s => ({ id: s.id, spisZn: s.spisZn, nazev: s.nazev || s.name || null, isirStav: s.isirStav || null }));
    } catch (e) { /* bez porovnání se spisy */ }
    res.json({ query: r.query, syncedAt: r.syncedAt || null, empty: r.empty, cases: r.cases, spisy });
});

// POST /api/registries/isir/check-now — hlídač insolvencí hned (jinak běží každou hodinu).
router.post('/isir/check-now', async (req, res) => {
    try {
        const r = await require('../lib/isir_cases').checkInsolvencySpisy();
        res.json(Object.assign({ success: true }, r));
    } catch (err) {
        res.status(500).json({ error: `Kontrola ISIR selhala: ${err.message}` });
    }
});

// GET /api/registries/databox?ico=... — vyhledání ID datové schránky (ISDS FindDataBox).
// Vyžaduje nastavené přihlašovací údaje ISDS (ISDS_LOGIN/ISDS_PASSWORD nebo v nastavení).
// Bez nich vrací available:false, configured:false (nikdy nefabrikuje ID).
router.get('/databox', async (req, res) => {
    const { ico } = req.query;
    if (!ico) {
        return res.status(400).json({ error: "IČO je povinný údaj." });
    }
    try {
        const result = await findDataBox(ico);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: `Dotaz do ISDS selhal: ${err.message}` });
    }
});

// GET /api/registries/isds-status — zda je ISDS nakonfigurováno (bez odhalení hesla).
router.get('/isds-status', (req, res) => {
    res.json({ configured: isIsdsConfigured() });
});

// GET/POST /api/registries/config — přístupy k CEE, Katastru a datové schránce.
// Hesla a klíče se nikdy nevracejí (jen hasKey/hasPassword). Uložení smí jen správce
// (lib/authz.js). UI na tyto cesty volalo, ale routy chyběly (nalezeno 3. 10. 2026).
router.get('/config', (req, res) => {
    const c = getRegistryConfig();
    c.isds.inbox = require('../lib/isds_inbox').status();
    res.json({ success: true, config: c });
});
router.post('/config', (req, res) => {
    try {
        const b = req.body || {};
        const c = setRegistryConfig({ cee: b.cee, katastr: b.katastr, isds: b.isds });
        if (b.isds && typeof b.isds.inbox === 'boolean') require('../lib/isds_inbox').setEnabled(b.isds.inbox);
        try { require('../lib/audit').logEvent('Nastavení', 'Přístupy k registrům a datové schránce', 'registries', { isdsInbox: b.isds && b.isds.inbox }); } catch (e) {}
        c.isds.inbox = require('../lib/isds_inbox').status();
        res.json({ success: true, config: c });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Datová schránka — příjem doručených zpráv (lib/isds_inbox.js).
router.get('/isds/inbox', (req, res) => res.json(require('../lib/isds_inbox').status()));
router.post('/isds/inbox/poll', async (req, res) => {
    // Ruční „Stáhnout teď“ je výslovný pokyn — stáhne i při vypnutém automatickém stahování
    // (test 5. 10. 2026: hlásilo „stahování je vypnuté“, i když uživatel klikl sám).
    const r = await require('../lib/isds_inbox').pollOnce({ force: true });
    if (!r.ok) return res.status(r.kind === 'unavailable' ? 502 : 400).json({ error: r.reason, kind: r.kind });
    res.json(r);
});

// GET /api/registries/isds/messages — přehled zpráv přijatých z datové schránky (stažených
// i nahraných jako .zfo) pro záložku „Datová schránka“: doručení, lhůta, spis.
router.get('/isds/messages', async (req, res) => {
    try {
        const inbox = await require('../lib/watcher').loadInbox();
        const byId = new Map();
        Object.values(inbox.files || {}).forEach(f => {
            if (!f || !f.isds || !f.isds.dmID) return;
            const id = String(f.isds.dmID);
            const m = byId.get(id) || { dmID: id, sender: f.isds.sender || null, annotation: f.isds.annotation || null,
                senderRefNumber: f.isds.senderRefNumber || null, deliveryDate: f.isds.deliveryDate || null,
                deliveryHow: f.isds.deliveryHow || null, deliveryExact: f.isds.deliveryExact !== false,
                caseNumber: null, deadlineDate: null, deadlineDays: 0, files: [] };
            m.files.push({ fileName: f.fileName, relativePath: f.relativePath });
            if (f.caseNumber && f.caseNumber !== 'Neznámá sp. zn.' && !m.caseNumber) m.caseNumber = f.caseNumber;
            if (f.deadlineDate && (!m.deadlineDate || f.deadlineDate < m.deadlineDate)) { m.deadlineDate = f.deadlineDate; m.deadlineDays = f.deadlineDays || 0; }
            byId.set(id, m);
        });
        const messages = [...byId.values()].map(m => {
            let spis = null;
            try { spis = m.caseNumber ? require('../lib/spisy').findByCase(m.caseNumber) : null; } catch (e) { spis = null; }
            return Object.assign(m, { spisId: spis ? spis.id : null, spisZn: spis ? spis.spisZn : null,
                systemMessage: require('../lib/isds_inbox').isSystemMessage({ sender: m.sender }) });
        }).sort((a, b) => String(b.deliveryDate || '').localeCompare(String(a.deliveryDate || '')));
        res.json({ success: true, messages, status: require('../lib/isds_inbox').status() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/registries/save-report - Save structured registry audit to Desktop case directory
router.post('/save-report', async (req, res) => {
    const { ico, name, reportText, caseNumber } = req.body;
    if (!ico || !name || !reportText) {
        return res.status(400).json({ error: "Chybí povinná data pro uložení prověrky." });
    }

    // IČO smí obsahovat pouze číslice (obrana proti path traversal přes ico).
    const cleanIco = String(ico).replace(/\D/g, '').slice(0, 12);
    if (!cleanIco) {
        return res.status(400).json({ error: "Neplatné IČO." });
    }

    try {
        const cleanName = name.replace(/[^a-zA-Z0-9čšžýáíéóúůďťňĎŤŇČŠŽÝÁÍÉÓÚŮ\s-_]/g, '').replace(/\s+/g, '_');
        const fileName = `Proverka_${cleanName}_${cleanIco}.txt`;
        const filePath = safePathInWatchDir(fileName);

        await fs.promises.writeFile(filePath, reportText, 'utf-8');
        console.log(`📥 Lustrační centrum: Uložena nová prověrka do: ${filePath}`);

        res.json({ success: true, fileName, filePath });
    } catch (err) {
        res.status(500).json({ error: `Nepodařilo se uložit prověrku: ${err.message}` });
    }
});

module.exports = router;
