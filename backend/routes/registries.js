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
