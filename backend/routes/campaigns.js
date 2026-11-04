/**
 * routes/campaigns.js — hromadné obesílání: validace příjemců (lustrace + odvození
 * SIMULOVANÉHO ISDS ID) a simulované odeslání s hlídáním doručenek a lhůt.
 * Montuje se v server.js na /api/campaigns.
 */
'use strict';

const express = require('express');
const { buildIcs } = require('../lib/ics');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { WATCH_DIR } = require('../lib/config');
const { checkSubject, findDataBox } = require('../lib/registries');
const { logEvent } = require('../lib/audit');
const db = require('../lib/database');
const { sanitizeFileName } = require('../lib/pathsafe');

// POST /api/campaigns/validate-recipients - Validate a list of ICOs
router.post('/validate-recipients', async (req, res) => {
    const { icos } = req.body;
    if (!icos || !Array.isArray(icos)) {
        return res.status(400).json({ error: "Parametr 'icos' musí být pole." });
    }

    try {
        const results = await Promise.all(icos.map(async (ico) => {
            const cleanIco = ico.replace(/\s+/g, '').replace(/[^0-9]/g, '').trim();
            if (!cleanIco || cleanIco.length !== 8) {
                return { ico, error: "Neplatný formát IČO (musí mít 8 číslic)." };
            }
            try {
                const checked = await checkSubject(cleanIco);
                if (checked.error) {
                    return { ico: cleanIco, error: checked.error };
                }
                // Reálné vyhledání datové schránky (ISDS FindDataBox). ŽÁDNÉ vymyšlené ID:
                // když ISDS není nakonfigurováno nebo se schránka nenajde jednoznačně,
                // vrátíme isdsResolved:false a schránku je nutné doplnit ručně.
                const box = await findDataBox(cleanIco);
                if (box && box.available && box.found && box.dataBoxId) {
                    return { ...checked, isdsId: box.dataBoxId, isdsResolved: true, isdsSimulated: false };
                }
                return {
                    ...checked,
                    isdsId: null,
                    isdsResolved: false,
                    isdsSimulated: false,
                    isdsCandidates: (box && box.candidates) || null,
                    isdsNote: (box && (box.reason || box.error)) ||
                        (box && box.ambiguous ? 'Více datových schránek pro IČO — vyberte ručně.' : 'Datovou schránku se nepodařilo ověřit — doplňte ručně.')
                };
            } catch (err) {
                return { ico: cleanIco, error: err.message };
            }
        }));
        res.json({ results });
    } catch (err) {
        res.status(500).json({ error: `Chyba při hromadné lustraci: ${err.message}` });
    }
});

// POST /api/campaigns/send - Mock sending data messages and schedule calendar reminders
router.post('/send', async (req, res) => {
    const { clientName, caseNumber, recipients, confirmedByLawyer } = req.body;
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: "Příjemci jsou povinní." });
    }
    // BEZPEČNOSTNÍ INVARIANT: nic se neodešle bez výslovného souhlasu advokáta.
    // Agent ani automatizace tento příznak nenastaví — musí přijít z potvrzené akce.
    // Příznak souhlasu nastaví kdokoli s právem zápisu — ve firemním režimu proto musí odesílat sám advokát
    // (scope approve) nebo správce (review 2, skupina 2).
    const p = req.principal;
    if (require('../lib/access').isFirmMode() && p && p.kind === 'user' && !require('../lib/principal').hasScope(p, 'approve')) {
        logEvent('Kampaně', 'Odeslání ZAMÍTNUTO — role bez schvalování', clientName || 'kampaň', { caseNumber: caseNumber || null, uzivatel: p.name || p.userId });
        return res.status(403).json({ error: 'Odeslání smí potvrdit jen advokát nebo správce.' });
    }
    if (confirmedByLawyer !== true) {
        logEvent('Kampaně', 'Odeslání ZAMÍTNUTO — chybí souhlas advokáta', clientName || 'kampaň', { caseNumber: caseNumber || null, recipients: recipients.length });
        return res.status(403).json({ error: 'Odeslání odepřeno: chybí výslovný souhlas advokáta (confirmedByLawyer).' });
    }
    logEvent('Kampaně', 'Souhlas advokáta s odesláním', clientName || 'kampaň', { caseNumber: caseNumber || null, recipients: recipients.length });

    try {
        const CALENDAR_DIR = path.join(WATCH_DIR, 'Kalendar');
        if (!fs.existsSync(CALENDAR_DIR)) {
            fs.mkdirSync(CALENDAR_DIR, { recursive: true });
        }

        const results = [];

        for (const recipient of recipients) {
            const { ico, name, isdsId, text } = recipient;

            // 1. Log simulation in audit
            logEvent('LexisEditor', `Hromadné obesílání - Odesláno přes ISDS`, 'Datová zpráva', {
                klient: clientName,
                spis: caseNumber,
                prijemce: name,
                ico: ico,
                isdsId: isdsId,
                status: 'Odesláno (Simulace)',
                textLength: text ? text.length : 0
            });

            // 2. Add alert in local database for tracking (10 days from now)
            const deadlineDate = new Date();
            deadlineDate.setDate(deadlineDate.getDate() + 10);

            const alertTitle = `Sledování doručenky výzvy pro: ${name}`;
            const alertDetails = `Hromadná kampaň obesílání pro klienta ${clientName || 'Neznámý'} (Spis: ${caseNumber || 'Neznámý'}). Příjemce: ${name} (IČO: ${ico}, Datová schránka: ${isdsId}).`;

            const alert = db.insert('alerts', {
                title: alertTitle,
                triggerRule: "Hromadné obesílání",
                status: 'pending',
                deadline: deadlineDate.toISOString(),
                payloadDetails: JSON.stringify({
                    clientName,
                    caseNumber,
                    ico,
                    name,
                    isdsId
                })
            });

            // 3. Generate ICS calendar file in Kalendar directory
            const icsContent = buildIcs({
                id: 'camp_dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
                title: `⚠️ LHŮTA: ${alertTitle}`,
                date: deadlineDate.toISOString().split('T')[0],
                description: alertDetails,
                alarm: true
            });

            const safeName = sanitizeFileName(alertTitle);
            const filePath = path.join(CALENDAR_DIR, `${safeName}.ics`);
            await fs.promises.writeFile(filePath, icsContent, 'utf-8');

            results.push({
                ico,
                name,
                isdsId,
                status: 'Simulováno (neodesláno)',
                simulated: true,
                alertId: alert.id,
                calendarFile: filePath
            });
        }

        res.json({
            success: true,
            simulated: true,
            results,
            message: `SIMULACE hromadného obesílání: ${results.length} zpráv NEBYLO reálně odesláno (chybí napojení na ISDS). Vytvořeny záznamy do logu, hlídání doručenek a kalendářní lhůty.`
        });
    } catch (err) {
        res.status(500).json({ error: `Chyba při hromadném odesílání: ${err.message}` });
    }
});

module.exports = router;
