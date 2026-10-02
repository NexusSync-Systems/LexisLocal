const path = require('path');
const fs = require('fs');
const { buildIcs, sanitizeFileName } = require('./ics'); // jeden generátor ICS + sanitizace názvu

const HEARINGS_FILE = (WATCH_DIR) => path.join(WATCH_DIR, '.hearings.json');

function loadMonitoredHearings(WATCH_DIR) {
    const file = HEARINGS_FILE(WATCH_DIR);
    if (fs.existsSync(file)) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (e) {
            console.error("⚠️ Nepodařilo se načíst .hearings.json:", e.message);
        }
    }
    return [];
}

function saveMonitoredHearings(WATCH_DIR, hearings) {
    try {
        fs.writeFileSync(HEARINGS_FILE(WATCH_DIR), JSON.stringify(hearings, null, 2), 'utf-8');
    } catch (e) {
        console.error("⚠️ Nepodařilo se uložit .hearings.json:", e.message);
    }
}


// Escapování textu do ICS dle RFC 5545 (zpětné lomítko, středník, čárka, nový řádek).
// Generate an ICS content helper — deleguje na sdílený lib/ics.js (jeden zdroj escapování).
function generateIcs(id, title, dateStr, timeStr, location, context, isCancelled) {
    return buildIcs({
        id: id || 'hearing_' + Date.now(),
        title: isCancelled ? `❌ ZRUŠENO: ${title}` : title,
        date: dateStr,
        time: timeStr,
        location,
        description: context,
        isCancelled
    });
}

const source = require('./court_hearings_source');
const health = require('./hearings_health');

function _alert(title, details, extra = {}) {
    try {
        const db = require('./database');
        return db.insert('alerts', Object.assign({
            title, status: 'pending', triggerRule: 'Hlídač soudních jednání',
            deadline: null, payloadDetails: typeof details === 'string' ? details : JSON.stringify(details || {})
        }, extra));
    } catch (e) { return null; }
}

function _todayIso(now) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function _spisZnOf(h) {
    const z = h.spisovaZnacka;
    return z ? `${z.cisloSenatu} ${z.druhVeci} ${z.bcVec}/${z.rocnik}` : (h.spisZn || '');
}

function _writeIcs(WATCH_DIR, h, isCancelled, statusText) {
    const titleForIcs = isCancelled ? `❌ ZRUŠENO: ${h.title}` : (statusText === 'updated' ? `⚠️ PŘESUNUTO: ${h.title}` : h.title);
    const desc = `Soudní jednání u ${h.courtName || 'soudu'}.\nSpisová značka: ${_spisZnOf(h)}\nStav hlídače: ${String(statusText || h.status).toUpperCase()}`;
    const ics = generateIcs(h.id, titleForIcs, h.dueDate, h.time, h.location, desc, isCancelled);
    try {
        if (h.icsFilePath && fs.existsSync(h.icsFilePath)) { fs.writeFileSync(h.icsFilePath, ics, 'utf-8'); return; }
        const dir = path.join(WATCH_DIR, 'Kalendar');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, `${sanitizeFileName(titleForIcs)}.ics`);
        fs.writeFileSync(p, ics, 'utf-8');
        h.icsFilePath = p;
    } catch (e) { /* ICS je best-effort */ }
}

/**
 * Výpadek / obnovení zdroje → jedno upozornění (bez zaplavení alertů každou hodinu).
 */
function _handleHealthAlerts(WATCH_DIR, now) {
    const sum = health.summary(WATCH_DIR, now);
    const st = health.load(WATCH_DIR);
    if (sum.status === 'down' && !st.outageAlertId) {
        const a = _alert('⚠️ Hlídač jednání: InfoJednání nedostupné — ověřte termíny ručně',
            { since: sum.outageSince, lastError: sum.lastError, hint: 'Zkontrolujte předvolání v datové schránce nebo na webu soudu.' },
            { kind: 'hearings_outage' });
        st.outageAlertId = a ? a.id : 'x';
        fs.writeFileSync(path.join(WATCH_DIR, '.hearings_health.json'), JSON.stringify(Object.assign(health.load(WATCH_DIR), { outageAlertId: st.outageAlertId }), null, 2));
    }
    return sum;
}

/**
 * Kontrola sledovaných jednání proti InfoJednání.
 * opts: { now, fetch, url } — testy / probe.
 */
async function checkAllHearings(WATCH_DIR, opts = {}) {
    const now = opts.now || new Date();
    const hearings = loadMonitoredHearings(WATCH_DIR);
    if (hearings.length === 0) return { checked: 0, updated: 0, failed: 0 };
    console.log(`🚨 Hlídač soudních jednání: kontroluji ${hearings.length} sledovaných jednání…`);

    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const todayIso = _todayIso(today);
    let checked = 0, updated = 0, failed = 0, succeeded = 0, dirty = false, lastError = null;

    for (const h of hearings) {
        if (h.status === 'cancelled' || h.status === 'past') continue;
        const diffDays = Math.ceil((new Date(h.dueDate).getTime() - today.getTime()) / 86400000);
        if (diffDays < -1) { h.status = 'past'; dirty = true; continue; }
        if (diffDays > 30) continue; // InfoJednání drží data ~30 dní dopředu

        checked++;
        const courtCode = source.resolveCourtCode(h.courtCode, h.courtName);
        const r = await source.fetchHearings({ courtCode, spisZn: h.spisovaZnacka || h.spisZn }, opts);
        if (!r.ok) {
            // Nedostupnost ≠ „beze změny“: zapíšeme ji k jednání, stav NEMĚNÍME.
            failed++; lastError = r.reason;
            h.lastCheckError = r.reason; h.lastCheckAt = now.toISOString(); dirty = true;
            if (r.kind !== 'not_configured') console.warn(`⚠️ Hlídač jednání: ${h.title}: ${r.reason}`);
            continue;
        }
        succeeded++;
        h.lastVerifiedAt = now.toISOString(); h.lastCheckAt = h.lastVerifiedAt; h.lastCheckError = null; dirty = true;

        const events = r.events || [];
        const same = events.find(ev => ev.date === h.dueDate);
        const newLocation = ev => `${r.court || h.courtName || 'Soud'}${ev.room ? ', síň ' + ev.room : ''}`;
        let statusText = null, isCancelled = false;

        if (same) {
            if (same.cancelled) { isCancelled = true; statusText = 'cancelled'; }
            else if ((same.time && h.time !== same.time) || (same.room && h.location !== newLocation(same))) {
                h.time = same.time || h.time; h.location = newLocation(same); statusText = 'updated';
            }
        } else if (events.length > 0) {
            // Přesun: jen na nejbližší BUDOUCÍ termín, nikdy do minulosti.
            const future = events.filter(e => e.date >= todayIso).sort((a, b) => a.date < b.date ? -1 : 1);
            if (future.length) {
                const ev = future[0];
                h.previousDate = h.dueDate;
                h.dueDate = ev.date; h.time = ev.time; h.location = newLocation(ev);
                isCancelled = ev.cancelled; statusText = isCancelled ? 'cancelled' : 'updated';
            }
        }
        // Prázdný seznam událostí NEZNAMENÁ zrušení (může jít o výpadek) — beze změny.

        if (statusText) {
            h.status = statusText;
            _writeIcs(WATCH_DIR, h, isCancelled, statusText);
            _alert(isCancelled ? `❌ Jednání ZRUŠENO: ${h.title}` : `⚠️ Jednání PŘESUNUTO: ${h.title} → ${h.dueDate} ${h.time || ''}`.trim(),
                { spisZn: _spisZnOf(h), dueDate: h.dueDate, time: h.time, location: h.location, previousDate: h.previousDate || null },
                { kind: 'hearing_change', hearingId: h.id, advokat: h.advokat || null, deadline: h.dueDate + 'T' + (h.time || '00:00') });
            updated++;
            console.log(`⚖️ Hlídač jednání: ${statusText.toUpperCase()} — ${h.title}`);
        }
    }

    if (dirty || updated) saveMonitoredHearings(WATCH_DIR, hearings);
    if (checked > 0) {
        if (succeeded > 0) {
            const rec = health.recordSuccess(WATCH_DIR, now);
            if (rec.recovered) {
                const st = health.load(WATCH_DIR);
                if (st.outageAlertId) {
                    try { require('./database').update('alerts', st.outageAlertId, { status: 'resolved' }); } catch (e) {}
                    _alert('✅ Hlídač jednání: InfoJednání opět dostupné — termíny znovu ověřeny',
                        { outageSince: rec.outageSince }, { kind: 'hearings_recovered', status: 'info' });
                }
                st.outageAlertId = null;
                fs.writeFileSync(path.join(WATCH_DIR, '.hearings_health.json'), JSON.stringify(st, null, 2));
            }
        } else if (failed > 0) {
            health.recordFailure(WATCH_DIR, lastError, now);
            _handleHealthAlerts(WATCH_DIR, now);
        }
    }
    return { checked, updated, failed };
}

/**
 * Zaregistruje jednání ke sledování (z InfoJednání, z dokumentu nebo ručně).
 * Duplicitu (stejná sp. zn. + datum) nezakládá. Vrací { hearing, created }.
 */
function registerHearing(WATCH_DIR, data) {
    const hearings = loadMonitoredHearings(WATCH_DIR);
    const p = source.parseSpisZn(data.spisZn);
    const zn = p ? source.formatSpisZn(p) : (data.spisZn || '');
    const dup = hearings.find(h => _spisZnOf(h).replace(/\s+/g, '') === zn.replace(/\s+/g, '') && h.dueDate === data.date);
    if (dup) return { hearing: dup, created: false };
    const h = {
        id: data.id || 'hear_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        title: data.title || `Jednání ${zn}`.trim(),
        dueDate: data.date,
        time: data.time || '',
        location: [data.court, data.room ? 'síň ' + data.room : ''].filter(Boolean).join(', '),
        courtCode: data.courtCode || null,
        courtName: data.court || null,
        spisovaZnacka: p,
        spisZn: zn,
        spisId: data.spisId || null,
        advokat: data.advokat || null,
        source: data.source || 'manual',
        // Návrh z dokumentu nebo z InfoJednání musí advokát potvrdit.
        status: data.needsReview ? 'needs_review' : 'scheduled',
        needsReview: !!data.needsReview,
        createdAt: new Date().toISOString()
    };
    hearings.push(h);
    saveMonitoredHearings(WATCH_DIR, hearings);
    return { hearing: h, created: true };
}

function confirmHearing(WATCH_DIR, id) {
    const hearings = loadMonitoredHearings(WATCH_DIR);
    const h = hearings.find(x => x.id === id);
    if (!h) return null;
    h.status = 'scheduled'; h.needsReview = false; h.confirmedAt = new Date().toISOString();
    saveMonitoredHearings(WATCH_DIR, hearings);
    return h;
}

/**
 * Prohledá InfoJednání pro všechny AKTIVNÍ spisy se sp. zn. a soudem a přidá nová
 * nařízená jednání (k potvrzení) — dřív se hlídala jen ručně zadaná jednání.
 */
async function checkSpisy(WATCH_DIR, opts = {}) {
    const now = opts.now || new Date();
    const todayIso = _todayIso(now);
    let spisyList = [];
    try { spisyList = require('./spisy').listSpisy ? require('./spisy').listSpisy() : (require('./database').get('spisy') || []); } catch (e) { spisyList = []; }
    const active = spisyList.filter(s => (s.stav || 'aktivni') === 'aktivni' && source.parseSpisZn(s.spisZn));
    let checked = 0, found = 0, failed = 0, succeeded = 0, unmonitorable = [], lastError = null;
    for (const s of active) {
        const code = source.resolveCourtCode(s.soudKod, s.soud);
        if (!code) { unmonitorable.push({ id: s.id, spisZn: s.spisZn, reason: s.soud ? 'neznámý kód soudu' : 'chybí soud' }); continue; }
        checked++;
        const r = await source.fetchHearings({ courtCode: code, spisZn: s.spisZn }, opts);
        try { require('./database').update('spisy', s.id, { hearingsCheckedAt: now.toISOString(), hearingsCheckError: r.ok ? null : r.reason }); } catch (e) {}
        if (!r.ok) { failed++; lastError = r.reason; continue; }
        succeeded++;
        for (const ev of (r.events || []).filter(e => e.date >= todayIso && !e.cancelled)) {
            const reg = registerHearing(WATCH_DIR, {
                spisZn: s.spisZn, date: ev.date, time: ev.time, room: ev.room, court: r.court || s.soud,
                courtCode: code, spisId: s.id, advokat: s.odpovednyAdvokat || null,
                source: 'infojednani', needsReview: true
            });
            if (reg.created) {
                found++;
                _alert(`📅 Nové jednání ve spisu ${s.spisZn}: ${ev.date} ${ev.time || ''} (k potvrzení)`.trim(),
                    { spisZn: s.spisZn, date: ev.date, time: ev.time, room: ev.room, zdroj: 'InfoJednání' },
                    { kind: 'hearing_found', hearingId: reg.hearing.id, advokat: s.odpovednyAdvokat || null, deadline: ev.date + 'T' + (ev.time || '00:00') });
            }
        }
    }
    if (checked > 0) {
        if (succeeded > 0) health.recordSuccess(WATCH_DIR, now);
        else { health.recordFailure(WATCH_DIR, lastError, now); _handleHealthAlerts(WATCH_DIR, now); }
    }
    return { checked, found, failed, unmonitorable };
}

module.exports = {
    loadMonitoredHearings,
    saveMonitoredHearings,
    checkAllHearings,
    checkSpisy,
    registerHearing,
    confirmHearing,
    generateIcs
};
