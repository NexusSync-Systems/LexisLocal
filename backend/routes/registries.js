/**
 * routes/registries.js — rozšířená lustrace (ARES + ISIR + CEE/Katastr, jsou-li nakonfigurovány)
 * a ukládání prověrky do složky spisu.
 * Montuje se v server.js na /api/registries.
 */
'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const { checkSubject, findDataBox, isIsdsConfigured } = require('../lib/registries');
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
