'use strict';
/**
 * client_updates.js — průběžné informování klienta o stavu věci.
 *
 * Tok: sekretářka/kdokoli s právem zápisu do spisu nechá sestavit NÁVRH souhrnu →
 * návrh čeká ve frontě ke schválení → advokát (scope 'approve' + zápis do spisu)
 * ho zkontroluje, případně upraví a „Schválí a odešle“. Nic neodchází automaticky.
 *
 * Text skládá PROGRAM, ne model (stejně jako oslovení v cz_salutation): bere jen
 * události z whitelistu typů, které jsou pro klienta určené (lhůty, jednání, schůzky,
 * nové dokumenty, faktury, změna stavu). Interní poznámky, sdílení, vlastnictví, AML,
 * úpravy údajů a vlastní typy z deníku se do souhrnu NIKDY nedostanou. Názvy souborů
 * se neuvádějí (mohou nést jména třetích osob) — jen počet nových dokumentů.
 */
const db = require('./database');
const spisy = require('./spisy');

const COLLECTION = 'client_updates';
const STATUSES = ['ke_schvaleni', 'odeslano', 'zamitnuto', 'chyba'];
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const STAV_TEXT = {
    aktivni: 'Věc je vedena jako aktivní.',
    archiv: 'Věc byla uzavřena a spis archivován.',
    skartace: 'Věc je uzavřena.'
};

function isValidEmail(s) { return EMAIL_RE.test(String(s || '').trim()); }

function _czDate(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${parseInt(m[3], 10)}. ${parseInt(m[2], 10)}. ${m[1]}` : String(iso || '');
}
function _today() { return new Date().toISOString().split('T')[0]; }

/** Kdy klient naposledy dostal souhrn (odeslaný), nebo null. */
function lastSentAt(spisId) {
    const sent = (db.get(COLLECTION) || []).filter(u => u.spisId === spisId && u.status === 'odeslano' && u.sentAt);
    sent.sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
    return sent.length ? sent[sent.length - 1].sentAt : null;
}

/**
 * Obsah souhrnu (čistá funkce nad detailem spisu). since = ISO čas, od kdy brát události.
 * Vrací { subject, body, facts, eventIds }.
 */
function composeSummary(detail, opts) {
    opts = opts || {};
    const s = detail.spis;
    const since = opts.since || null;
    const today = opts.today || _today();
    const events = (detail.events || []).filter(e => !since || String(e.createdAt || '') > since);
    const used = [];
    const facts = [];

    const newDocs = events.filter(e => e.type === 'zarazeni');
    if (newDocs.length) {
        facts.push(newDocs.length === 1 ? 'Do spisu byl zařazen 1 nový dokument.' : `Do spisu bylo zařazeno ${newDocs.length} nových dokumentů.`);
        newDocs.forEach(e => used.push(e.id));
    }
    const stav = events.filter(e => e.type === 'stav').pop();
    if (stav && STAV_TEXT[s.stav]) { facts.push(STAV_TEXT[s.stav]); used.push(stav.id); }
    events.filter(e => e.type === 'schuzka').forEach(e => {
        const m = String(e.note || '').match(/na (\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2})/);
        facts.push(m ? `Sjednali jsme schůzku na ${_czDate(m[1])} v ${m[2]}.` : 'Sjednali jsme schůzku.');
        used.push(e.id);
    });
    events.filter(e => e.type === 'faktura').forEach(e => {
        const vystavena = String(e.note || '').match(/Vystavena faktura (\S+) na ([\d\s.,]+) Kč/);
        const uhrada = String(e.note || '').match(/Úhrada faktury (\S+):.*\((paid|partial)\)/);
        if (vystavena) facts.push(`Vystavili jsme fakturu č. ${vystavena[1]} na ${vystavena[2].trim()} Kč.`);
        else if (uhrada) facts.push(uhrada[2] === 'paid' ? `Děkujeme, faktura č. ${uhrada[1]} je uhrazena.` : `Evidujeme částečnou úhradu faktury č. ${uhrada[1]}.`);
        else return;
        used.push(e.id);
    });

    // Výhled: jen POTVRZENÉ budoucí lhůty a nadcházející jednání (nejvýš 3 + 3).
    const upcomingDl = (detail.deadlines || []).filter(d => d.date && d.date >= today && !d.needsReview).slice(0, 3);
    const upcomingHearings = (detail.hearings || [])
        .filter(h => h.dueDate && h.dueDate >= today && String(h.status || '').toLowerCase() !== 'zruseno')
        .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).slice(0, 3);
    const outlook = [];
    upcomingHearings.forEach(h => outlook.push(`jednání u soudu ${_czDate(h.dueDate)}${h.time ? ' v ' + h.time : ''}${h.location ? ' (' + h.location + ')' : ''}`));
    upcomingDl.forEach(d => outlook.push(`lhůta končí ${_czDate(d.date)}`));

    let greeting = 'Dobrý den,';
    try {
        const sal = require('./cz_salutation').salutation(s.klient || '');
        if (sal && !/s\.\s?r\.\s?o\.|a\.\s?s\.|spol\.|v\.\s?o\.\s?s\./i.test(s.klient || '')) greeting = sal;
    } catch (e) { /* zůstane neutrální */ }

    const ref = s.spisZn ? `sp. zn. ${s.spisZn}` : (s.nazev || 'Vaše věc');
    const lines = [greeting, '', `posíláme Vám přehled o průběhu Vaší věci (${ref})${since ? ' od ' + _czDate(since) : ''}.`, ''];
    if (facts.length) { lines.push('Co se událo:'); facts.forEach(f => lines.push('• ' + f)); lines.push(''); }
    else { lines.push('Od posledního přehledu nedošlo k podstatným změnám.'); lines.push(''); }
    if (outlook.length) { lines.push('Co nás čeká:'); outlook.forEach(o => lines.push('• ' + o.charAt(0).toUpperCase() + o.slice(1) + '.')); lines.push(''); }
    lines.push('V případě dotazů se na nás neváhejte obrátit.', '', 'S pozdravem', s.odpovednyAdvokat || '');
    return {
        subject: `Informace o stavu věci — ${ref}`,
        body: lines.join('\n').replace(/\n+$/, '\n'),
        facts: facts.concat(outlook),
        eventIds: used
    };
}

function _actor() {
    try { return require('./request_context').currentActor(); } catch (e) { return null; }
}

/** Sestaví návrh a zařadí ho do fronty ke schválení. */
function createDraft(spisId) {
    const detail = spisy.getSpisDetail(spisId);
    if (!detail) throw Object.assign(new Error('Spis nenalezen.'), { status: 404 });
    const s = detail.spis;
    if (!isValidEmail(s.klientEmail)) {
        throw Object.assign(new Error('Ve spisu chybí platný e-mail klienta (pole „E-mail klienta“).'), { status: 400, code: 'NO_CLIENT_EMAIL' });
    }
    const since = lastSentAt(spisId);
    const c = composeSummary(detail, { since });
    return db.insert(COLLECTION, {
        spisId, to: String(s.klientEmail).trim(), subject: c.subject, body: c.body,
        facts: c.facts, eventIds: c.eventIds, periodFrom: since, status: 'ke_schvaleni',
        createdBy: _actor()
    });
}

function get(id) { return (db.get(COLLECTION) || []).find(u => u.id === id) || null; }

function list(filter) {
    filter = filter || {};
    let l = db.get(COLLECTION) || [];
    if (filter.status) l = l.filter(u => u.status === filter.status);
    if (filter.spisId) l = l.filter(u => u.spisId === filter.spisId);
    return l.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Úprava textu před schválením (odeslané/zamítnuté se už nemění). */
function edit(id, patch) {
    const u = get(id);
    if (!u) throw Object.assign(new Error('Návrh nenalezen.'), { status: 404 });
    if (u.status !== 'ke_schvaleni' && u.status !== 'chyba') throw Object.assign(new Error('Odeslaný nebo zamítnutý souhrn už nelze upravit.'), { status: 409 });
    const clean = { editedBy: _actor(), editedAt: new Date().toISOString() };
    if (patch.subject !== undefined) clean.subject = String(patch.subject).slice(0, 300);
    if (patch.body !== undefined) clean.body = String(patch.body).slice(0, 20000);
    return db.update(COLLECTION, id, clean);
}

function reject(id, reason) {
    const u = get(id);
    if (!u) throw Object.assign(new Error('Návrh nenalezen.'), { status: 404 });
    if (u.status === 'odeslano') throw Object.assign(new Error('Souhrn už byl odeslán.'), { status: 409 });
    return db.update(COLLECTION, id, { status: 'zamitnuto', rejectedBy: _actor(), rejectedAt: new Date().toISOString(), rejectReason: String(reason || '').slice(0, 500) });
}

/**
 * Schválení advokátem + odeslání. Oprávnění (scope approve, zápis do spisu) ověřuje routa.
 * Příjemce se znovu porovná s aktuálním e-mailem ve spisu — když se mezitím změnil,
 * neodešle se (návrh je třeba sestavit znovu).
 */
async function approveAndSend(id, deps) {
    deps = deps || {};
    const mailer = deps.mailer || require('./mailer');
    const u = get(id);
    if (!u) throw Object.assign(new Error('Návrh nenalezen.'), { status: 404 });
    if (u.status !== 'ke_schvaleni' && u.status !== 'chyba') throw Object.assign(new Error('Tento souhrn už není ve frontě ke schválení.'), { status: 409 });
    const spis = spisy.getSpis(u.spisId);
    if (!spis) throw Object.assign(new Error('Spis nenalezen.'), { status: 404 });
    if (String(spis.klientEmail || '').trim().toLowerCase() !== String(u.to).trim().toLowerCase()) {
        throw Object.assign(new Error('E-mail klienta ve spisu se od sestavení návrhu změnil — sestavte nový návrh.'), { status: 409, code: 'RECIPIENT_CHANGED' });
    }
    const settings = (db.get('email_settings') || [])[0] || {};
    const missing = mailer.validateSmtp(settings);
    if (missing.length) throw Object.assign(new Error('Chybí SMTP nastavení: ' + missing.join(', ')), { status: 400, code: 'SMTP_CONFIG' });

    const approver = _actor();
    const approvedAt = new Date().toISOString();
    try {
        await mailer.sendMail(settings, { to: u.to, subject: u.subject, body: u.body, attachmentPaths: [], confirmedByLawyer: true });
    } catch (e) {
        db.update(COLLECTION, id, { status: 'chyba', error: e.message, approvedBy: approver, approvedAt });
        throw Object.assign(new Error('Odeslání selhalo: ' + e.message), { status: 502, code: e.code || 'SEND_FAILED' });
    }
    const sentAt = new Date().toISOString();
    const updated = db.update(COLLECTION, id, { status: 'odeslano', approvedBy: approver, approvedAt, sentAt, error: null });
    spisy.addEvent(u.spisId, 'email', `Klientovi odeslán souhrn o stavu věci (${u.to}), schválil ${(approver && approver.name) || 'advokát'}.`, { recipient: u.to, clientUpdateId: id });
    return updated;
}

module.exports = { composeSummary, createDraft, list, get, edit, reject, approveAndSend, lastSentAt, isValidEmail, STATUSES, COLLECTION };
