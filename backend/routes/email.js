/**
 * routes/email.js — nastavení IMAP/SMTP, e-mailové úkoly a simulace příchozího
 * e-mailu od advokáta (výběr asistenta + vygenerování odpovědi).
 * Montuje se v server.js na /api/email.
 */
'use strict';

const express = require('express');
const { CHAT_MODEL } = require('../lib/model_config');
const router = express.Router();
const db = require('../lib/database');
const { logEvent } = require('../lib/audit');
const { loadAgents } = require('../lib/agents');
const ollama = require('../lib/ai_provider'); // Ollama | OpenAI | Anthropic (stejné rozhraní)
const { generateAgentFallback } = require('../lib/agent_fallback');
const mailer = require('../lib/mailer');
const spisy = require('../lib/spisy');
const ChiefOrchestrator = require('../lib/orchestrator');
const scheduling = require('../lib/schedulingParse');
const booking = require('../lib/calendarBooking');
const { processEmailTask } = require('../lib/emailTask');
const imapIntake = require('../lib/imapIntake');
const { deriveImapSmtp } = require('../lib/emailProviders');

// GET /api/email/settings - Načíst nastavení IMAP/SMTP a autorizovaného odesílatele
router.get('/settings', (req, res) => {
    try {
        const settingsList = db.get('email_settings') || [];
        const currentSettings = settingsList.length > 0 ? settingsList[0] : {
            authorized_sender: 'advokat@dias.cz',
            recipient_filter: 'dias+asistenti@advokatnikancelar.cz',
            imap_host: 'imap.advokatnikancelar.cz',
            imap_port: '993',
            imap_user: 'dias@advokatnikancelar.cz',
            imap_ssl: true,
            smtp_host: 'smtp.advokatnikancelar.cz',
            smtp_port: '465',
            smtp_user: 'dias@advokatnikancelar.cz',
            smtp_ssl: true,
            imap_enabled: false,
            imap_poll_minutes: 5
        };
        res.json({ success: true, settings: currentSettings });
    } catch (err) {
        res.status(500).json({ error: `Nelze načíst nastavení e-mailu: ${err.message}` });
    }
});

// POST /api/email/settings - Uložit nastavení
router.post('/settings', (req, res) => {
    try {
        const newSettings = req.body;
        const settingsList = db.get('email_settings') || [];
        if (settingsList.length > 0) {
            db.update('email_settings', settingsList[0].id, newSettings);
        } else {
            db.insert('email_settings', newSettings);
        }
        logEvent('LexisLocal Dashboard', 'Uložení nastavení e-mailu', 'AI Konfigurace');
        res.json({ success: true, message: "Nastavení e-mailu bylo uloženo." });
    } catch (err) {
        res.status(500).json({ error: `Nelze uložit nastavení e-mailu: ${err.message}` });
    }
});

// GET /api/email/tasks - Seznam všech doručených/zpracovaných úkolů
router.get('/tasks', (req, res) => {
    try {
        const tasks = db.get('email_tasks') || [];
        const sorted = [...tasks].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ success: true, tasks: sorted });
    } catch (err) {
        res.status(500).json({ error: `Nelze načíst e-mailové úkoly: ${err.message}` });
    }
});

// DELETE /api/email/tasks/:id - Smazat úkol z historie
router.delete('/tasks/:id', (req, res) => {
    const { id } = req.params;
    try {
        db.delete('email_tasks', id);
        logEvent('LexisLocal Dashboard', 'Smazání e-mailového úkolu', 'E-mailové úkoly', { id });
        res.json({ success: true, message: "E-mailový úkol byl smazán." });
    } catch (err) {
        res.status(500).json({ error: `Nelze smazat úkol: ${err.message}` });
    }
});

// POST /api/email/simulate - Simulace příchozího e-mailu od advokáta
router.post('/simulate', async (req, res) => {
    const { sender, subject, body } = req.body;

    if (!sender || !subject || !body) {
        return res.status(400).json({ error: "Odesílatel, předmět a obsah e-mailu jsou povinné." });
    }

    try {
        // 1. Ověření autorizovaného odesílatele
        const settingsList = db.get('email_settings') || [];
        const settings = settingsList.length > 0 ? settingsList[0] : {
            authorized_sender: 'advokat@dias.cz'
        };

        if (settings && settings.authorized_sender) {
            const cleanSender = sender.trim().toLowerCase();
            const cleanAuthorized = settings.authorized_sender.trim().toLowerCase();
            if (cleanSender !== cleanAuthorized) {
                return res.status(403).json({
                    error: `❌ Přístup odepřen: Odesílatel "${sender}" není autorizovaným e-mailem advokáta (${settings.authorized_sender}).`
                });
            }
        }

        // 2. Výběr příslušného asistenta
        const agents = loadAgents();
        let selectedAgentId = null;

        // A. Detekce podle předmětu v hranatých závorkách (např. [Spisovatel] nebo [Kontrolor])
        const subjectMatch = subject.match(/\[([^\]]+)\]/);
        if (subjectMatch) {
            const agentNameOrId = subjectMatch[1].trim().toLowerCase();
            const foundAgent = Object.values(agents).find(a =>
                a.id.toLowerCase() === agentNameOrId ||
                a.name.toLowerCase() === agentNameOrId
            );
            if (foundAgent) {
                selectedAgentId = foundAgent.id;
            }
        }

        // B. Detekce podle tagu na začátku těla zprávy (např. @kontrolor nebo @spisovatel)
        if (!selectedAgentId) {
            const bodyMention = body.trim().match(/^@([a-zA-Z0-9_ěščřžýáíéúůóďťňĎŤŇ]+)/);
            if (bodyMention) {
                const agentNameOrId = bodyMention[1].trim().toLowerCase();
                const foundAgent = Object.values(agents).find(a =>
                    a.id.toLowerCase() === agentNameOrId ||
                    a.name.toLowerCase() === agentNameOrId
                );
                if (foundAgent) {
                    selectedAgentId = foundAgent.id;
                }
            }
        }

        // C. Detekce podle klíčových slov v obsahu
        if (!selectedAgentId) {
            const normalizedText = (subject + ' ' + body).toLowerCase();

            if (/oponent|kontrola|revize|posouzen|audit|chyb|rizik/i.test(normalizedText)) {
                selectedAgentId = 'kontrolor';
            } else if (/smlouv|dopis|sepsat|žalob|podán|draft|vytvoř/i.test(normalizedText)) {
                selectedAgentId = 'spisovatel';
            } else if (/rešerš|judikat|vyhled|analýz|paragraf|zákon/i.test(normalizedText)) {
                selectedAgentId = 'resersnik';
            } else if (/styl|přeps|úprav|formul/i.test(normalizedText)) {
                selectedAgentId = 'stylista';
            } else {
                selectedAgentId = 'sekretarka'; // Výchozí
            }
        }

        // Získat objekt asistenta (pokud neexistuje, fallback na sekretářku)
        const agent = agents[selectedAgentId] || agents['sekretarka'];
        const selectedModel = agent.preferredModel || CHAT_MODEL;

        console.log(`📧 E-mail doručen. Zpracovává asistent: [${agent.name}] přes model [${selectedModel}]`);

        // 3. Generování odpovědi od asistenta
        let replyText = "";
        const cleanBody = body.replace(/^@[a-zA-Z0-9_ěščřžýáíéúůóďťňĎŤŇ]+\s*/, ''); // Odstranit případný tag z těla

        try {
            const response = await ollama.chat({
                model: selectedModel,
                messages: [
                    { role: 'system', content: agent.systemPrompt },
                    { role: 'user', content: cleanBody }
                ],
                options: {
                    temperature: 0.3
                }
            });
            replyText = response.message.content;
        } catch (ollamaErr) {
            console.warn(`⚠️ E-mail: Selhalo spojení s Ollama (${ollamaErr.message}). Používám robustní fallback.`);
            replyText = generateAgentFallback(agent.id, cleanBody);
        }

        // Formátování kompletní e-mailové odpovědi advokátovi
        const dateStr = new Date().toLocaleDateString('cs-CZ', {
            hour: '2-digit',
            minute: '2-digit'
        });

        const fullReply = `Vážený pane doktore,

k Vašemu e-mailovému zadání ze dne ${dateStr} ohledně předmětu "${subject.replace(/\[[^\]]+\]\s*/g, '')}" Vám zasílám požadovaný výstup.

S úctou,
Vaše AI asistentka (${agent.name} ${agent.emoji})

--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
VÝSTUP ASISTENTA:
--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

${replyText}`;

        // 4. Uložení do databáze
        const taskItem = {
            sender: sender.trim(),
            subject: subject.trim(),
            body: body.trim(),
            assignedAgentId: agent.id,
            assignedAgentName: agent.name,
            assignedAgentEmoji: agent.emoji,
            responseSent: fullReply,
            status: 'completed'
        };

        const createdTask = db.insert('email_tasks', taskItem);

        // Logování do historie dashboardu
        logEvent('LexisLocal Dashboard', `E-mailový úkol pro asistenta: ${agent.name}`, 'E-mailové úkoly', {
            id: createdTask.id,
            agentId: agent.id,
            subject: subject
        });

        res.json({
            success: true,
            task: createdTask,
            message: "E-mail byl úspěšně zpracován asistentem a odpověď odeslána zpět."
        });

    } catch (err) {
        console.error("Chyba zpracování e-mailového úkolu:", err);
        res.status(500).json({ error: `Chyba při zpracování úkolu: ${err.message}` });
    }
});

// POST /api/email/send — reálné odeslání e-mailu klientovi přes SMTP (i s přílohou)
// a pravdivý zápis do spisu (server má potvrzení od SMTP serveru).
// BEZPEČNOSTNÍ INVARIANT: bez confirmedByLawyer === true se NEODESÍLÁ (fail-closed).
router.post('/send', async (req, res) => {
    try {
        const b = req.body || {};
        const to = b.to || b.recipientEmail;
        if (!to) return res.status(400).json({ success: false, error: 'Chybí příjemce.' });
        if (b.confirmedByLawyer !== true) {
            logEvent('E-mail', 'Odeslání ZAMÍTNUTO — chybí souhlas advokáta', b.clientName || to, { caseNumber: b.caseNumber || null });
            return res.status(403).json({ success: false, error: 'Odeslání odepřeno: chybí výslovný souhlas advokáta (confirmedByLawyer).', code: 'NO_CONSENT' });
        }
        // Souhlas advokáta nesmí „odkliknout“ kdokoli: příznak platí jen od člověka se
        // scope approve (advokát/správce), nikdy od agenta (nález 14. 10. 2026).
        const p = req.principal;
        if (p && (p.kind === 'agent' || !require('../lib/principal').hasScope(p, 'approve'))) {
            logEvent('E-mail', 'Odeslání ZAMÍTNUTO — souhlas nepotvrdil advokát', b.clientName || to, { caseNumber: b.caseNumber || null });
            return res.status(403).json({ success: false, error: 'Odeslat klientovi smí jen advokát nebo správce. Připravte souhrn ke schválení.', code: 'forbidden_role' });
        }
        // SMTP nastavení z lokální DB
        const settingsList = db.get('email_settings') || [];
        const settings = settingsList.length > 0 ? settingsList[0] : {};
        const missing = mailer.validateSmtp(settings);
        if (missing.length) {
            return res.status(400).json({ success: false, error: 'Chybí SMTP nastavení: ' + missing.join(', '), code: 'SMTP_CONFIG' });
        }
        // Odeslání (mailer sám znovu vynucuje confirmedByLawyer — fail-closed jádro)
        try {
            await mailer.sendMail(settings, {
                to,
                subject: b.subject || '',
                body: b.body || '',
                attachmentPaths: Array.isArray(b.attachmentPaths) ? b.attachmentPaths : [],
                confirmedByLawyer: true
            });
        } catch (e) {
            const code = e.code || 'SEND_FAILED';
            const status = (code === 'SMTP_CONFIG' || code === 'NO_ATTACHMENT' || code === 'NO_RECIPIENT') ? 400 : 502;
            logEvent('E-mail', 'Odeslání selhalo', b.clientName || to, { caseNumber: b.caseNumber || null, error: e.message });
            return res.status(status).json({ success: false, error: e.message, code });
        }
        // Pravdivý zápis do spisu (jen když známe sp. zn. a spis existuje)
        let linkedToCase = false;
        const caseNumber = (b.caseNumber || '').trim();
        if (caseNumber) {
            const spis = spisy.findByCase(caseNumber);
            if (spis) {
                spisy.addEvent(spis.id, 'email', `E-mail odeslán klientovi (${to})` + (b.subject ? ` — „${b.subject}"` : '') + '.', { recipient: to, cj: b.cj || null, dmID: b.dmID || null });
                linkedToCase = true;
            }
        }
        logEvent('E-mail', 'Odeslání klientovi (SMTP)', b.clientName || to, { caseNumber: caseNumber || null, recipient: to, linkedToCase, spisId: (b.spisId || null) });
        res.json({ success: true, linkedToCase });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Odeslání e-mailu selhalo: ' + err.message });
    }
});

// POST /api/email/process — E-MAILOVÉ ÚKOLOVÁNÍ (multiagentní flow).
// Advokát pošle zadání → sekretářka (ChiefOrchestrator) ho roztřídí a deleguje na
// agenty (spisovatel/rešeršník/kontrolor/stylista) → výsledek se AUTOMATICKY pošle
// ZPĚT na ověřený e-mail advokáta.
//
// BEZPEČNOST (fail-closed):
//  • Spustí se JEN pro autorizovaný e-mail advokáta (jinak 403). Nikdo cizí nemůže
//    přes e-mail ovládat agenty.
//  • Automatická odpověď smí jít VÝHRADNĚ na authorized_sender (advokátovu vlastní
//    ověřenou adresu). Příjemce se nikdy nebere z obsahu → dokument nikdy neodejde
//    třetí straně. Odeslání jinam než na authorized_sender je tvrdě odmítnuto.
//  • confirmedByLawyer je splněn původem: zadání přišlo z ověřené adresy advokáta.
router.post('/process', async (req, res) => {
    try {
        const { sender, subject, body, caseNumber } = req.body || {};
        const r = await processEmailTask({ sender, subject, body, caseNumber });
        if (r.status === 'bad-request') return res.status(400).json({ error: r.error });
        if (r.status === 'unauthorized') return res.status(403).json({ error: r.error });
        res.json({ success: true, mode: r.mode, task: r.task, replied: r.replied, replyError: r.replyError, steps: r.steps, citationCheck: r.citationCheck, scheduling: r.scheduling, draft: r.draft });
    } catch (err) {
        res.status(500).json({ error: 'Zpracování e-mailového úkolu selhalo: ' + err.message });
    }
});

// POST /api/email/derive — z e-mailu odvodí IMAP/SMTP servery (zjednodušené nastavení).
// Tělo: { email }. Vrací předvyplněné nastavení, ať uživatel nezadává hosty/porty.
router.post('/derive', (req, res) => {
    const email = (req.body && req.body.email) || '';
    const derived = deriveImapSmtp(email);
    if (!derived) return res.status(400).json({ error: 'Neplatná e-mailová adresa.' });
    res.json({ success: true, ...derived });
});

// POST /api/email/test — otestuje připojení k IMAP i SMTP (login), bez odeslání/čtení.
// Tělo: volitelně { settings }; jinak vezme uložené nastavení.
router.post('/test', async (req, res) => {
    try {
        const settings = (req.body && req.body.settings) || (db.get('email_settings') || [])[0] || {};
        const [imapR, smtpR] = await Promise.all([
            imapIntake.testConnection(settings).catch(e => ({ ok: false, error: e.message })),
            mailer.verifySmtp(settings).then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message }))
        ]);
        logEvent('E-mail', 'Test připojení', settings.imap_user || settings.smtp_user || '', { imap: imapR.ok, smtp: smtpR.ok });
        res.json({ success: true, imap: imapR, smtp: smtpR });
    } catch (err) {
        res.status(500).json({ error: 'Test připojení selhal: ' + err.message });
    }
});

// POST /api/email/poll — ručně vyzvedne a zpracuje nové e-maily z IMAP schránky
// (jinak běží na pozadí dle imap_enabled). Vrací souhrn { processed, skipped, errors }.
router.post('/poll', async (req, res) => {
    try {
        const settingsList = db.get('email_settings') || [];
        const settings = settingsList.length > 0 ? settingsList[0] : {};
        const r = await imapIntake.pollOnce(settings);
        res.json({ success: !!r.ok, ...r });
    } catch (err) {
        res.status(500).json({ error: 'IMAP poll selhal: ' + err.message });
    }
});

module.exports = router;
