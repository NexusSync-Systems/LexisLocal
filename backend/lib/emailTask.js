/**
 * emailTask.js — jádro e-mailového úkolování (sdílené endpointem i IMAP pollerem).
 *
 * processEmailTask({ sender, subject, body, caseNumber }) → výsledek:
 *   { status:'bad-request' } | { status:'unauthorized' } |
 *   { status:'ok', mode, task, replied, replyError, steps, citationCheck, scheduling, fullReply }
 *
 * Bezpečnost (fail-closed):
 *   • spustí se JEN pro authorized_sender (jinak status 'unauthorized'),
 *   • schůzku rezervuje jen sekretářka s oprávněním manage_calendar (deterministicky),
 *   • auto-odpověď smí jít VÝHRADNĚ zpět na authorized_sender.
 */
'use strict';

const db = require('./database');
const { logEvent } = require('./audit');
const { loadAgents } = require('./agents');
const { CHAT_MODEL } = require('./model_config');
const ollama = require('./ai_provider');
const { generateAgentFallback, isFallbackText } = require('./agent_fallback');
const spisFolders = require('./spisFolders');
const { verifyCitationsWithSources } = require('./citation_verifier');
const ChiefOrchestrator = require('./orchestrator');
const scheduling = require('./schedulingParse');
const booking = require('./calendarBooking');
const mailer = require('./mailer');
const spisy = require('./spisy');
const docTemplates = require('./documentTemplates');

// Timeout kolem volání modelu — ať to při pomalém/zaseklém modelu nevisí dlouho,
// ale rychle spadne na poctivý fallback. Přepis přes LEXIS_AI_TIMEOUT_MS.
const AI_TIMEOUT_MS = parseInt(process.env.LEXIS_AI_TIMEOUT_MS, 10) || 600000; // 10 min — lokální modely (9B) na běžném HW jsou pomalé; timeout jen proti opravdu zaseklým
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('AI timeout po ' + ms + ' ms')), ms); if (t.unref) t.unref(); })
    ]);
}

// Lehký převod markdown-ish výstupu agenta na HTML, aby se koncept otevřel v
// LexisEditoru SPRÁVNĚ NAFORMÁTOVANÝ (nadpisy, tučné, odstavce, seznamy) — ne jako
// holý text. Bez závislostí; escapuje HTML a pak aplikuje jednoduché formátování.
function _mdToHtml(md, title) {
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (t) => esc(t)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    const lines = String(md || '').split(/\r?\n/);
    let html = '', list = null;
    const closeList = () => { if (list) { html += '</' + list + '>\n'; list = null; } };
    for (let raw of lines) {
        const line = raw.replace(/\s+$/,'');
        if (!line.trim()) { closeList(); continue; }
        let m;
        if ((m = line.match(/^###\s+(.*)/))) { closeList(); html += '<h3>' + inline(m[1]) + '</h3>\n'; continue; }
        if ((m = line.match(/^##\s+(.*)/)))  { closeList(); html += '<h2>' + inline(m[1]) + '</h2>\n'; continue; }
        if ((m = line.match(/^#\s+(.*)/)))   { closeList(); html += '<h1>' + inline(m[1]) + '</h1>\n'; continue; }
        if ((m = line.match(/^\s*[-•*]\s+(.*)/))) { if (list !== 'ul') { closeList(); html += '<ul>\n'; list = 'ul'; } html += '<li>' + inline(m[1]) + '</li>\n'; continue; }
        if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { closeList(); html += '<ol>\n'; list = 'ol'; } html += '<li>' + inline(m[1]) + '</li>\n'; continue; }
        closeList(); html += '<p>' + inline(line) + '</p>\n';
    }
    closeList();
    const esc2 = (t) => String(t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return '<!doctype html>\n<html lang="cs"><head><meta charset="utf-8"><title>' + esc2(title || 'Koncept') + '</title></head>\n<body>\n' + html + '</body></html>\n';
}

async function processEmailTask(input) {
    const { sender, subject, body, caseNumber } = input || {};
    if (!sender || !subject || !body) {
        return { status: 'bad-request', error: 'Odesílatel, předmět a obsah jsou povinné.' };
    }

    const settingsList = db.get('email_settings') || [];
    const settings = settingsList.length > 0 ? settingsList[0] : { authorized_sender: 'advokat@dias.cz' };
    const authorized = (settings.authorized_sender || '').trim().toLowerCase();
    const cleanSender = String(sender).trim().toLowerCase();

    // INVARIANT: jen autorizovaný advokát smí spustit flow.
    if (authorized && cleanSender !== authorized) {
        logEvent('E-mail', 'Úkolování ZAMÍTNUTO — neautorizovaný odesílatel', sender, { subject });
        return { status: 'unauthorized', error: `Přístup odepřen: odesílatel „${sender}" není autorizovaný e-mail advokáta.` };
    }

    const agents = loadAgents();

    // Explicitní volba jednoho agenta: [Tag] v předmětu nebo @zmínka na začátku těla.
    let explicitAgentId = null;
    const subjMatch = subject.match(/\[([^\]]+)\]/);
    const bodyMatch = body.trim().match(/^@([a-zA-Z0-9_ěščřžýáíéúůóďťňĎŤŇ]+)/);
    const tag = (subjMatch && subjMatch[1]) || (bodyMatch && bodyMatch[1]);
    if (tag) {
        const t = tag.trim().toLowerCase();
        const found = Object.values(agents).find(a => a.id.toLowerCase() === t || a.name.toLowerCase() === t);
        if (found) explicitAgentId = found.id;
    }
    const cleanBody = body.replace(/^@[a-zA-Z0-9_ěščřžýáíéúůóďťňĎŤŇ]+\s*/, '');

    let mode = 'orchestrate';
    let output = '';
    let stepsSummary = [];
    let citationCheck = null;
    let aiOk = true;
    let templateUsed = false;
    let templateWarnings = [];
    let draftTitle = null;

    if (explicitAgentId) {
        mode = 'single';
        const agent = agents[explicitAgentId];
        // ŠABLONOVÝ REŽIM (Spisovatel): u rozpoznaného typu podání se použije
        // ověřená šablona (fixní právní text + deterministicky doplněné částka/lhůta),
        // místo aby text vymýšlel model. Odpadá komolená čeština i halucinované §.
        let templated = null;
        if (agent.id === 'spisovatel') {
            try { templated = docTemplates.tryTemplate(String(subject) + ' ' + cleanBody); } catch (e) { templated = null; }
        }
        if (templated && templated.matched) {
            output = templated.markdown;
            templateUsed = true;
            templateWarnings = templated.warnings || [];
            draftTitle = templated.title;
            stepsSummary = [`${agent.emoji || ''} ${agent.name} (šablona: ${templated.title})`];
        } else {
            try {
                const r = await withTimeout(ollama.chat({
                    model: agent.preferredModel || CHAT_MODEL,
                    messages: [{ role: 'system', content: agent.systemPrompt }, { role: 'user', content: cleanBody }],
                    options: { temperature: 0.3 }
                }), AI_TIMEOUT_MS);
                output = r.message.content;
            } catch (e) {
                aiOk = false;
                output = generateAgentFallback(agent.id, cleanBody);
            }
            stepsSummary = [`${agent.emoji || ''} ${agent.name}`];
        }
    } else {
        try {
            // B2: e-mailový vstup dříve jel s ragFilters=null → orchestrátor bez oboru
            // i judikatury. Zkus obor auto-detekovat z těla e-mailu; při jistotě ho
            // předej (přesnost), jinak null → per-agent scope (B1) přidá judikaturu
            // celoplošně u agentů se čtením spisů.
            let emailFilters = null;
            try {
                const { detectObor } = require('./obor_detect');
                const d = await detectObor(cleanBody);
                if (d && d.confident && d.scope) {
                    emailFilters = { scopes: [d.scope], oborScope: d.scope, oborSource: 'auto' };
                }
            } catch (oErr) { /* bez oboru → orchestrátor doplní judikaturu celoplošně */ }
            const r = await ChiefOrchestrator.orchestrate(cleanBody, '', CHAT_MODEL, null, emailFilters);
            output = r.finalOutput || '';
            stepsSummary = (r.steps || []).map(st => `${st.agentEmoji || ''} ${st.agentName}: ${st.instruction}`);
            citationCheck = r.citationCheck || null;
        } catch (e) {
            aiOk = false;
            mode = 'orchestrate-fallback';
            output = generateAgentFallback('sekretarka', cleanBody);
            stepsSummary = ['⏰ Sekretářka (fallback)'];
        }
    }

    // Ověření citací i pro jednoagentní výstup (orchestrace ho už dělá sama).
    // Vymyšlené paragrafy se tak označí „⚠ NEOVĚŘENO" — kritické pro slabší modely.
    // U šablony se ověření přeskakuje: její § jsou pevné a ověřené (žádná halucinace).
    if (!citationCheck && aiOk && !templateUsed && output && output.trim() && !isFallbackText(output)) {
        try {
            const cc = await verifyCitationsWithSources(output, {});
            citationCheck = cc ? { total: cc.total, unverifiedCount: cc.unverifiedCount, citations: cc.citations, annotatedText: cc.annotatedText, sourcesConsulted: cc.sourcesConsulted } : null;
        } catch (e) { /* ověření je best-effort */ }
    }

    // ULOŽENÍ KONCEPTU: skutečný výstup agenta se uloží jako koncept do spisu
    // (fail-closed → _Nezařazeno, když spis neznáme), aby ho advokát otevřel a
    // doeditoval v LexisEditoru. Fallback (AI nedostupná) se NEUKLÁDÁ.
    let draft = null;
    if (aiOk && output && output.trim() && !isFallbackText(output)) {
        try {
            let draftSpisId = null;
            if (caseNumber) { try { const sp = spisy.findByCase(caseNumber); if (sp) draftSpisId = sp.id; } catch (e) {} }
            const base = (draftTitle || String(subject).replace(/\[[^\]]+\]\s*/g, '').trim().slice(0, 60)) || 'koncept';
            const safe = base.replace(/[\/\\:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'koncept';
            const htmlDoc = _mdToHtml(output, base);
            // Preferuj .docx (nativní pro LexisEditor, plné formátování). Fallback .html,
            // kdyby html-to-docx nebyl nainstalován (funguje i před `npm install`).
            let fileName, content, fmt;
            try {
                const HTMLtoDOCX = require('html-to-docx');
                content = await HTMLtoDOCX(htmlDoc, null, { title: base });
                fileName = safe + '.docx'; fmt = 'docx';
            } catch (e) {
                content = htmlDoc; fileName = safe + '.html'; fmt = 'html';
            }
            const dr = spisFolders.saveDraftToSpis({ spisId: draftSpisId || '__none__', fileName, content });
            draft = { savedPath: dr.savedPath, filed: dr.filed, folderId: dr.folderId || null, reason: dr.reason || null, format: fmt };
        } catch (e) { draft = { error: e.message }; }
    }

    // ROZPOZNÁNÍ A REZERVACE SCHŮZKY (deterministicky). Řeší jen sekretářka.
    let scheduleResult = null;
    let scheduleNote = '';
    const secretary = agents['sekretarka'];
    const calendarAllowed = !!(secretary && secretary.permissions && secretary.permissions.manage_calendar === true);
    if (scheduling.detectSchedulingIntent(body) && !calendarAllowed) {
        scheduleResult = { intent: true, skipped: 'no-permission' };
        scheduleNote = '\n\n📅 Rozpoznal jsem žádost o schůzku, ale správu kalendáře nemá povolenou žádný agent (sekretářka: manage_calendar). Rezervaci proveďte ručně.';
    } else if (scheduling.detectSchedulingIntent(body)) {
        const parsed = scheduling.parseMeeting(body, new Date());
        if (!parsed) {
            scheduleResult = { intent: true, parsed: false };
            scheduleNote = '\n\n📅 Rozpoznal jsem žádost o schůzku, ale nepodařilo se spolehlivě určit datum a čas. Uveďte prosím konkrétní termín (např. „ve čtvrtek ve 14:00 na hodinu").';
        } else {
            let spisId = null;
            if (caseNumber) { try { const sp = spisy.findByCase(caseNumber); if (sp) spisId = sp.id; } catch (e) {} }
            const meetTitle = 'Schůzka: ' + String(subject).replace(/\[[^\]]+\]\s*/g, '').trim();
            const r = booking.tryBook({
                title: meetTitle, date: parsed.date, time: parsed.time, durationMin: parsed.durationMin,
                location: parsed.location, spisId, source: 'email',
                description: 'Automaticky navrženo z e-mailového zadání advokáta.'
            });
            if (r.booked) {
                scheduleResult = { intent: true, parsed: true, booked: true, meeting: r.meeting };
                scheduleNote = `\n\n📅 Sekretářka rezervovala: ${parsed.date} v ${parsed.time} (${parsed.durationMin} min)${parsed.location ? ', ' + parsed.location : ''}. Termín je volný i s rezervou na dopravu.`;
            } else {
                const alts = (r.suggestions || []).map(sl => sl.start).slice(0, 5);
                scheduleResult = { intent: true, parsed: true, booked: false, reason: r.reason, suggestions: r.suggestions || [] };
                scheduleNote = `\n\n📅 Termín ${parsed.date} v ${parsed.time} NELZE rezervovat (${r.reason === 'out-of-hours' ? 'mimo pracovní hodiny' : 'koliduje s jinou událostí / dopravou'}). ` + (alts.length ? 'Volné alternativy ten den: ' + alts.join(', ') + '.' : 'Ten den nejsou volné termíny — zkuste jiný den.');
            }
        }
    }

    const draftNote = (draft && draft.savedPath)
        ? `\n\n📄 Koncept uložen jako ${(draft.format || 'dokument').toUpperCase()} ${draft.filed ? 'do složky spisu (03_Koncepty)' : 'do _Nezařazeno (spis nerozpoznán)'} — otevřete a doeditujte v LexisEditoru.`
        : '';
    const dateStr = new Date().toLocaleString('cs-CZ');
    const citationNote = (citationCheck && citationCheck.unverifiedCount > 0)
        ? `\n\n⚠️ UPOZORNĚNÍ: ${citationCheck.unverifiedCount} citací nebylo možné ověřit — před použitím zkontrolujte ručně.`
        : '';
    const templateNote = (templateWarnings && templateWarnings.length)
        ? `\n\n⚠️ UPOZORNĚNÍ K ŠABLONĚ: ${templateWarnings.join(' ')}`
        : '';
    const stepsBlock = stepsSummary.length ? `\nPrůběh zpracování:\n- ${stepsSummary.join('\n- ')}\n` : '';
    const fullReply = `Vážený pane doktore,\n\nk Vašemu zadání ze dne ${dateStr} („${subject.replace(/\[[^\]]+\]\s*/g, '')}") zasílám zpracovaný výstup.\n${stepsBlock}\nS úctou,\nVaše AI kancelář (LexisLocal)\n\n${'-'.repeat(80)}\nVÝSTUP:\n${'-'.repeat(80)}\n\n${output}${citationNote}${templateNote}${scheduleNote}${draftNote}`;

    const createdTask = db.insert('email_tasks', {
        sender: String(sender).trim(), subject: String(subject).trim(), body: String(body).trim(),
        mode, steps: stepsSummary, caseNumber: caseNumber || null, responseSent: fullReply, status: 'completed'
    });

    // AUTO-ODPOVĚĎ — výhradně na authorized_sender (fail-closed).
    let replied = false, replyError = null;
    const to = String(sender).trim();
    if (!authorized || to.toLowerCase() !== authorized) {
        replyError = 'Odpověď neodeslána: příjemce není autorizovaný e-mail advokáta (fail-closed).';
        logEvent('E-mail', 'Auto-odpověď ZAMÍTNUTA — příjemce != advokát', to, { subject });
    } else {
        const missing = mailer.validateSmtp(settings);
        if (missing.length) {
            replyError = 'SMTP není nakonfigurováno (' + missing.join(', ') + ') — výstup je uložen v úkolech.';
        } else {
            try {
                await mailer.sendMail(settings, {
                    to, subject: subject.match(/^re:/i) ? subject : ('Re: ' + subject),
                    body: fullReply, confirmedByLawyer: true
                });
                replied = true;
                logEvent('E-mail', 'Auto-odpověď advokátovi odeslána', to, { subject, mode, taskId: createdTask.id });
            } catch (e) {
                replyError = e.message;
                logEvent('E-mail', 'Auto-odpověď selhala', to, { subject, error: e.message });
            }
        }
    }

    return { status: 'ok', mode, task: createdTask, replied, replyError, steps: stepsSummary, citationCheck, scheduling: scheduleResult, draft, fullReply, templateUsed };
}

module.exports = { processEmailTask };
