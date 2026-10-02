/**
 * routes/calendar.js — generování .ics událostí, přehled událostí a
 * synchronizace sledovaných soudních jednání.
 * Montuje se v server.js na /api/calendar.
 */
'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { WATCH_DIR } = require('../lib/config');
const { sanitizeFileName } = require('../lib/pathsafe');
const { writeToSystemCalendar } = require('../lib/calendar');
const HearingsWatcher = require('../lib/hearings');
const db = require('../lib/database');
const availability = require('../lib/calendarAvailability');
const booking = require('../lib/calendarBooking');
const { logEvent } = require('../lib/audit');

// Sjednocený seznam událostí (lhůty + jednání + rezervované schůzky) ve tvaru,
// který čte i /events i engine dostupnosti. Jeden zdroj pravdy.
function collectAllEvents() { return booking.collectAllEvents(); }


// POST /api/calendar/add - Generate standard .ics file inside LexisSpisy/Kalendar folder
router.post('/add', async (req, res) => {
    const { id, title, dueDate, context, time, location, isHearing, courtCode, spisovaZnacka } = req.body;
    if (!title || !dueDate) {
        return res.status(400).json({ error: "Název a datum splatnosti jsou povinné parametry." });
    }

    try {
        const CALENDAR_DIR = path.join(WATCH_DIR, 'Kalendar');
        if (!fs.existsSync(CALENDAR_DIR)) {
            fs.mkdirSync(CALENDAR_DIR, { recursive: true });
        }

        const cleanId = id || 'dl_' + Date.now();
        const dtstamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        const startDate = dueDate.replace(/-/g, '');

        let startLine, endLine;
        if (time) {
            const timeClean = time.replace(/:/g, '').substring(0, 4) + '00';
            startLine = `DTSTART;TZID=Europe/Prague:${startDate}T${timeClean}`;

            // Assume 1 hour
            const [h, m] = time.split(':');
            const startD = new Date(`${dueDate}T${h}:${m}:00`);
            const endD = new Date(startD.getTime() + 60 * 60 * 1000);
            const endDateStr = endD.toISOString().split('T')[0].replace(/-/g, '');
            const endTimeClean = endD.toTimeString().split(' ')[0].replace(/:/g, '');
            endLine = `DTEND;TZID=Europe/Prague:${endDateStr}T${endTimeClean}`;
        } else {
            startLine = `DTSTART;VALUE=DATE:${startDate}`;
            const endD = new Date(dueDate);
            endD.setDate(endD.getDate() + 1);
            const endDateStr = endD.toISOString().split('T')[0].replace(/-/g, '');
            endLine = `DTEND;VALUE=DATE:${endDateStr}`;
        }

        const prefix = isHearing ? '⚖️ JEDNÁNÍ' : '⚠️ LHŮTA';
        const cleanTitle = `${prefix}: ${title}`;
        const cleanDesc = context ? context.replace(/\r?\n/g, ' ') : `Detekovaná událost v systému Lexis.`;

        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//LexisLocal//NONSGML iCalendar Generator//CS',
            'CALSCALE:GREGORIAN',
            'BEGIN:VEVENT',
            `UID:${cleanId}@lexislocal`,
            `DTSTAMP:${dtstamp}`,
            startLine,
            endLine,
            `SUMMARY:${cleanTitle}`,
            `DESCRIPTION:${cleanDesc}`
        ];

        if (location) {
            lines.push(`LOCATION:${location}`);
        }

        lines.push('END:VEVENT');
        lines.push('END:VCALENDAR');

        const icsContent = lines.join('\r\n');

        const safeName = sanitizeFileName(title);
        const filePath = path.join(CALENDAR_DIR, `${safeName}.ics`);

        await fs.promises.writeFile(filePath, icsContent, 'utf-8');
        console.log(`📅 ICS Kalendářová událost vygenerována: ${filePath}`);

        // Write directly to local system calendar (Apple Calendar / Outlook)
        let syncStatus = 'unsupported';
        try {
            syncStatus = await writeToSystemCalendar({
                title: cleanTitle,
                date: dueDate,
                time: time,
                location: location,
                description: cleanDesc
            });
        } catch (syncErr) {
            console.error(`⚠️ Nepodařilo se zapsat do systémového kalendáře: ${syncErr.message}`);
        }

        // Register the hearing for background tracking if isHearing is true
        if (isHearing && courtCode && spisovaZnacka) {
            const hearings = HearingsWatcher.loadMonitoredHearings(WATCH_DIR);

            // Remove any existing record with the same ID or same sp.zn + date
            const filtered = hearings.filter(h => h.id !== cleanId && !(h.courtCode === courtCode && h.dueDate === dueDate && h.spisovaZnacka.cisloSenatu === spisovaZnacka.cisloSenatu && h.spisovaZnacka.druhVeci === spisovaZnacka.druhVeci && h.spisovaZnacka.bcVec === spisovaZnacka.bcVec && h.spisovaZnacka.rocnik === spisovaZnacka.rocnik));

            filtered.push({
                id: cleanId,
                title: title,
                dueDate: dueDate,
                time: time,
                location: location,
                courtCode: courtCode,
                courtName: location ? location.split(',')[0] : 'Soud',
                spisovaZnacka: spisovaZnacka,
                icsFilePath: filePath,
                status: 'scheduled',
                lastChecked: new Date().toISOString()
            });

            HearingsWatcher.saveMonitoredHearings(WATCH_DIR, filtered);
            console.log(`⚖️ Registrováno soudní jednání pro sledování změn: sp. zn. ${spisovaZnacka.cisloSenatu} ${spisovaZnacka.druhVeci} ${spisovaZnacka.bcVec}/${spisovaZnacka.rocnik}`);
        }

        // Událost uložíme i do databáze — dřív vznikl jen .ics soubor a v kalendáři
        // dashboardu (/events) se nová lhůta/jednání vůbec neobjevila (test 2. 10. 2026).
        try {
            const list = (db.get('calendar_events') || []).filter(e => e.id !== cleanId);
            list.push({ id: cleanId, type: isHearing ? 'hearing' : 'deadline', title: cleanTitle, date: dueDate,
                time: time || '', status: 'scheduled', description: cleanDesc, location: location || '',
                createdAt: new Date().toISOString() });
            db.set('calendar_events', list);
        } catch (dbErr) { console.warn('⚠️ Kalendář: uložení události do DB selhalo:', dbErr.message); }

        res.json({ success: true, id: cleanId, filePath, syncStatus, message: "ICS soubor byl úspěšně vygenerován a synchronizován do kalendáře." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: `Chyba při generování ICS kalendáře: ${err.message}` });
    }
});

// GET /api/calendar/events - Retrieve all events (deadlines & hearings) for dashboard calendar
router.get('/events', async (req, res) => {
    try {
        const alerts = db.get('alerts') || [];
        const hearings = HearingsWatcher.loadMonitoredHearings(WATCH_DIR) || [];

        const events = [];

        // Add alerts (procedural tasks/deadlines)
        alerts.forEach(alert => {
            let dateVal = null;
            let timeVal = null;
            if (alert.deadline) {
                const parts = alert.deadline.split('T');
                dateVal = parts[0];
                if (parts[1]) {
                    timeVal = parts[1].substring(0, 5); // HH:MM
                }
            }
            events.push({
                id: alert.id,
                type: 'deadline',
                title: alert.title,
                date: dateVal,
                time: timeVal,
                status: alert.status,
                description: alert.triggerRule || 'Procesní lhůta',
                location: ''
            });
        });

        // Add monitored hearings
        hearings.forEach(hearing => {
            events.push({
                id: hearing.id,
                type: 'hearing',
                title: hearing.title,
                date: hearing.dueDate,
                time: hearing.time || '',
                status: hearing.status,
                description: `Soudní jednání - sp. zn. ${hearing.spisovaZnacka ? (hearing.spisovaZnacka.cisloSenatu + ' ' + hearing.spisovaZnacka.druhVeci + ' ' + hearing.spisovaZnacka.bcVec + '/' + hearing.spisovaZnacka.rocnik) : ''}`,
                location: hearing.location || ''
            });
        });

        // Události přidané přes /add (lhůty a jednání zadané ručně / z inboxu)
        const seen = new Set(events.map(e => e.id));
        (db.get('calendar_events') || []).forEach(e => {
            if (!seen.has(e.id)) events.push(Object.assign({}, e));
        });

        // Rezervované schůzky
        (db.get('meetings') || []).forEach(m => {
            events.push({ id: m.id, type: 'meeting', title: m.title, date: m.date, time: m.time || '', status: m.status || 'scheduled', description: m.description || 'Schůzka', location: m.location || '' });
        });

        res.json({ success: true, events });
    } catch (err) {
        res.status(500).json({ error: `Nelze načíst kalendářní události: ${err.message}` });
    }
});

// POST /api/calendar/availability — kontrola volného termínu / návrh volných slotů.
// Tělo: { date, durationMin?, time?, travelBufferMin?, workStart?, workEnd? }
//   • s `time`  → ověří konkrétní slot (free + konflikty + návrhy, když obsazeno),
//   • bez `time`→ vrátí volné termíny pro daný den.
router.post('/availability', (req, res) => {
    try {
        const b = req.body || {};
        if (!b.date) return res.status(400).json({ error: 'Datum je povinné (YYYY-MM-DD).' });
        const durationMin = Number.isFinite(b.durationMin) ? b.durationMin : 60;
        const opts = {};
        if (Number.isFinite(b.travelBufferMin)) opts.travelBufferMin = b.travelBufferMin;
        if (typeof b.workStart === 'string') { const v = availability._toMin(b.workStart); if (v != null) opts.workStartMin = v; }
        if (typeof b.workEnd === 'string') { const v = availability._toMin(b.workEnd); if (v != null) opts.workEndMin = v; }
        const events = collectAllEvents();
        if (b.time) {
            const startMin = availability._toMin(b.time);
            const check = availability.checkSlot(events, b.date, startMin, durationMin, opts);
            const suggestions = check.free ? [] : availability.findFreeSlots(events, b.date, durationMin, opts).slice(0, 8);
            return res.json({ success: true, date: b.date, durationMin, check, suggestions });
        }
        const slots = availability.findFreeSlots(events, b.date, durationMin, opts);
        res.json({ success: true, date: b.date, durationMin, freeSlots: slots });
    } catch (err) {
        res.status(500).json({ error: 'Chyba při výpočtu dostupnosti: ' + err.message });
    }
});

// POST /api/calendar/book — REZERVACE schůzky. FAIL-CLOSED: rezervuje JEN když je
// volno (s ohledem na dopravu). Při kolizi vrátí 409 + konflikty + volné alternativy.
// Tělo: { title, date, time, durationMin?, location?, travelBufferMin?, spisId?, description? }
router.post('/book', async (req, res) => {
    try {
        const b = req.body || {};
        const r = booking.tryBook({
            title: b.title, date: b.date, time: b.time,
            durationMin: Number.isFinite(b.durationMin) ? b.durationMin : 60,
            location: b.location, description: b.description,
            travelBufferMin: Number.isFinite(b.travelBufferMin) ? b.travelBufferMin : undefined,
            spisId: b.spisId, source: 'manual'
        });
        if (r.reason === 'missing-fields') return res.status(400).json({ error: 'Název, datum a čas jsou povinné.' });
        if (!r.booked) {
            return res.status(409).json({ success: false, error: r.reason === 'out-of-hours' ? 'Termín je mimo pracovní hodiny.' : 'Termín koliduje s jinou událostí (včetně rezervy na dopravu).', check: r.check, suggestions: r.suggestions || [] });
        }
        res.status(201).json({ success: true, meeting: r.meeting });
    } catch (err) {
        res.status(500).json({ error: 'Rezervace schůzky selhala: ' + err.message });
    }
});

// POST /api/calendar/sync - Manually trigger check of all monitored hearings
router.post('/sync', async (req, res) => {
    try {
        const result = await HearingsWatcher.checkAllHearings(WATCH_DIR);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: `Chyba při synchronizaci jednání: ${err.message}` });
    }
});

module.exports = router;
