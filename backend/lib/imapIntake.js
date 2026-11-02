/**
 * imapIntake.js — příjem e-mailů ze schránky asistentů přes IMAP.
 *
 * Fail-closed a idempotentní:
 *   • zpracují se JEN zprávy od authorized_sender; ostatní se přeskočí (nikdo cizí
 *     nemůže přes e-mail ovládat agenty); bez nastaveného authorized_sender se nezpracuje nic,
 *   • adresa From se dá podvrhnout → zpráva musí mít od serveru schránky DKIM/DMARC pass
 *     pro doménu odesílatele (lib/email_auth.js, revize 2. 11. 2026),
 *   • bez SSL se vyžaduje STARTTLS (heslo ani zadání nejdou po síti nešifrovaně),
 *   • důvěryhodné adresy (email_duveryhodni) = jako advokát, s povinným DKIM/DMARC,
 *   • cizí odesílatel podle email_cizi: ke schválení (výchozí) / ignorovat / automaticky (lib/email_pending.js),
 *   • filtr příjemce (recipient_filter): zprávy poslané na jinou adresu se nechají být (ani se neoznačí přečtené),
 *   • dedup přes uložené UID (imap_processed) — stejná zpráva se nezpracuje dvakrát,
 *   • zprávy se NEmažou; jen se označí jako přečtené (\Seen). Mazání je zakázané.
 *
 * IMAP klient (imapflow) i parser (mailparser) se načítají LÍNĚ, takže modul jde
 * require-nout i bez nich (testy injektují vlastní `adapter`).
 */
'use strict';

const db = require('./database');
const { logEvent } = require('./audit');
const { processEmailTask } = require('./emailTask');
const emailAuth = require('./email_auth');
const pending = require('./email_pending');

const PROCESSED_CAP = 500;
const MAX_TELO = 50000;   // znaků těla zadání (delší se zkrátí)

// TLS: port 993 = implicitní TLS; jinak (143) povinný STARTTLS — imapflow bez něj spojení odmítne.
function _tlsVolby(settings) {
    const secure = settings.imap_ssl !== false;
    return secure ? { secure: true } : { secure: false, doSTARTTLS: true };
}

function _requiredImap(settings) {
    const missing = [];
    ['imap_host', 'imap_port', 'imap_user', 'imap_pass'].forEach(k => { if (!settings || !settings[k]) missing.push(k); });
    return missing;
}

function _loadProcessed() { return new Set(db.get('imap_processed') || []); }
function _saveProcessed(set) {
    let arr = [...set];
    if (arr.length > PROCESSED_CAP) arr = arr.slice(arr.length - PROCESSED_CAP);
    db.set('imap_processed', arr);
}

// Vyzvedne a zpracuje nové zprávy. `adapter` (test seam) implementuje:
//   listUnseen(): Promise<[{ uid, from, subject, text, authResults, fromCount }]>
//     from = e-mailová adresa, authResults = hlavičky Authentication-Results shora dolů,
//     to = adresy příjemců (To, Cc, Delivered-To, X-Original-To) malými písmeny
//   markSeen(uid): Promise<void>
//   close?(): Promise<void>
async function pollOnce(settings, adapter) {
    settings = settings || {};
    const missing = _requiredImap(settings);
    if (missing.length) return { ok: false, reason: 'imap-config', missing };

    const authorized = (settings.authorized_sender || '').trim().toLowerCase();
    if (!authorized) {   // fail-closed: bez advokátovy adresy nezpracujeme nic (ani neoznačíme jako přečtené)
        logEvent('E-mail', 'IMAP: zpracování vypnuto — chybí autorizovaný e-mail advokáta', settings.imap_user || '');
        return { ok: false, reason: 'no-authorized-sender' };
    }
    const own = adapter ? null : await _imapflowAdapter(settings);
    const mbox = adapter || own;

    const duveryhodni = pending.duveryhodni(settings);
    const rezimCizich = pending.rezimCizich(settings);
    const filtr = String(settings.recipient_filter || '').trim().toLowerCase();
    const processed = _loadProcessed();
    let processedCount = 0, skipped = 0, errors = 0, total = 0, rejected = 0, waiting = 0, ignored = 0;
    const zpracuj = async (m, extra) => {
        try {
            await processEmailTask(Object.assign({ sender: m.from, subject: m.subject || '(bez předmětu)', body: String(m.text || '').slice(0, MAX_TELO) }, extra));
            processedCount++;
        } catch (e) {
            errors++;
            logEvent('E-mail', 'IMAP: zpracování zprávy selhalo', m.from || '', { subject: m.subject || '', error: e.message });
        }
    };
    try {
        const messages = await mbox.listUnseen();
        total = messages.length;
        for (const m of messages) {
            const key = String(m.uid);
            if (processed.has(key)) { skipped++; continue; }               // dedup
            // Filtr příjemce: zpráva na jinou adresu schránky není pro asistenty — nechá se být (zůstane nepřečtená).
            if (filtr && !(m.to || []).map(a => String(a).trim().toLowerCase()).includes(filtr)) {
                processed.add(key); ignored++; continue;
            }
            const from = String(m.from || '').trim().toLowerCase();
            const oznac = async () => { processed.add(key); try { await mbox.markSeen(m.uid); } catch (e) {} };
            if (!from || (m.fromCount || 1) !== 1) {                         // žádná / více adres ve From
                logEvent('E-mail', 'IMAP: přeskočena zpráva bez jednoznačného odesílatele', m.from || '(neznámý)', { subject: m.subject || '' });
                await oznac(); skipped++; continue;
            }
            const puvod = emailAuth.overPuvod(from, m.authResults, settings);
            if (from === authorized || duveryhodni.includes(from)) {
                if (!puvod.ok) {                                            // vydává se za advokáta / důvěryhodného
                    logEvent('E-mail', 'IMAP: zadání ZAMÍTNUTO — neověřený původ', m.from, { subject: m.subject || '', duvod: puvod.duvod });
                    await oznac(); rejected++; skipped++; continue;
                }
                await zpracuj(m, { overeni: puvod.metoda });
                await oznac(); continue;
            }
            // Cizí odesílatel.
            if (rezimCizich === 'ignorovat') {
                logEvent('E-mail', 'IMAP: přeskočen cizí odesílatel', m.from, { subject: m.subject || '' });
                await oznac(); skipped++; continue;
            }
            if (rezimCizich === 'automaticky' && puvod.ok) {
                logEvent('E-mail', 'IMAP: cizí odesílatel — zpracováno automaticky (nastavení)', m.from, { subject: m.subject || '', overeni: puvod.metoda });
                await zpracuj(m, { cizi: true, overeni: puvod.metoda });
                await oznac(); continue;
            }
            pending.pridej({ od: m.from, predmet: m.subject || '(bez předmětu)', text: String(m.text || '').slice(0, MAX_TELO),
                overeni: puvod.ok ? puvod.metoda : null, overeniDuvod: puvod.ok ? null : puvod.duvod });
            logEvent('E-mail', 'IMAP: cizí odesílatel — čeká na schválení advokátem', m.from, { subject: m.subject || '' });
            await oznac(); waiting++;
        }
    } finally {
        _saveProcessed(processed);
        if (own && own.close) { try { await own.close(); } catch (e) {} }
    }
    logEvent('E-mail', 'IMAP: vyzvednutí schránky', settings.imap_user || '', { total, processed: processedCount, skipped, rejected, waiting, ignored, errors });
    return { ok: true, total, processed: processedCount, skipped, rejected, waiting, ignored, errors };
}

// Reálný IMAP adaptér přes imapflow + mailparser (líně načtené).
async function _imapflowAdapter(settings) {
    const { ImapFlow } = require('imapflow');
    const { simpleParser } = require('mailparser');
    const client = new ImapFlow({
        host: settings.imap_host,
        port: parseInt(settings.imap_port, 10) || 993,
        ..._tlsVolby(settings),
        auth: { user: settings.imap_user, pass: settings.imap_pass },
        logger: false
    });
    await client.connect();
    await client.mailboxOpen('INBOX');
    return {
        async listUnseen() {
            const out = [];
            for await (const msg of client.fetch({ seen: false }, { uid: true, source: true })) {
                try {
                    const parsed = await simpleParser(msg.source);
                    const adresy = (parsed.from && parsed.from.value) || [];
                    const from = adresy[0] ? adresy[0].address : '';
                    const authResults = (parsed.headerLines || [])
                        .filter(h => h && h.key === 'authentication-results')
                        .map(h => String(h.line || '').replace(/^[^:]*:\s*/, ''));
                    const adr = (o) => ((o && o.value) || []).map(v => v.address).filter(Boolean);
                    const hl = (k) => (parsed.headerLines || []).filter(h => h && h.key === k)
                        .map(h => String(h.line || '').replace(/^[^:]*:\s*/, '').replace(/[<>]/g, '').trim());
                    const to = [...[].concat(parsed.to || []).flatMap(adr), ...[].concat(parsed.cc || []).flatMap(adr),
                        ...hl('delivered-to'), ...hl('x-original-to')].map(a => a.toLowerCase());
                    out.push({ uid: msg.uid, from, fromCount: adresy.length, to, subject: parsed.subject || '', text: parsed.text || '', authResults });
                } catch (e) { /* nečitelnou zprávu přeskočíme */ }
            }
            return out;
        },
        async markSeen(uid) { try { await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }); } catch (e) {} },
        async close() { try { await client.logout(); } catch (e) {} }
    };
}

// Spustí pravidelný poller na pozadí. NEspouští pod testy (drží event loop) a timer
// .unref(), ať nikdy neblokuje ukončení. Vrací handle nebo null.
function startPolling(getSettings, intervalMs) {
    if (typeof process.env.JEST_WORKER_ID !== 'undefined') return null;
    const ms = Math.max(60 * 1000, intervalMs || 5 * 60 * 1000);
    const timer = setInterval(async () => {
        try {
            const s = typeof getSettings === 'function' ? getSettings() : getSettings;
            if (!s || s.imap_enabled !== true) return;
            if (_requiredImap(s).length) return;
            await pollOnce(s);
        } catch (e) {
            console.error('⚠️ IMAP poller chyba:', e.message);
        }
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
}

// Ověří IMAP připojení (login + otevření INBOX) bez zpracování. _connector (test seam) volitelný.
async function testConnection(settings, _connector) {
    const missing = _requiredImap(settings);
    if (missing.length) return { ok: false, error: 'Chybí IMAP nastavení: ' + missing.join(', '), missing };
    try {
        if (_connector) { await _connector(settings); return { ok: true }; }
        const { ImapFlow } = require('imapflow');
        const client = new ImapFlow({
            host: settings.imap_host, port: parseInt(settings.imap_port, 10) || 993,
            ..._tlsVolby(settings), auth: { user: settings.imap_user, pass: settings.imap_pass }, logger: false
        });
        await client.connect();
        await client.mailboxOpen('INBOX');
        await client.logout();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = { pollOnce, startPolling, testConnection, _requiredImap, _imapflowAdapter, _tlsVolby };
