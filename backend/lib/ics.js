/**
 * ics.js — jeden generátor iCalendar (.ics) pro celý backend.
 *
 * Dřív se ICS stavěl na třech místech: správně (s escapováním) v hearings.js,
 * ale SYROVĚ v /api/calendar/add a /api/campaigns/send — čárka, středník nebo
 * nový řádek v názvu/popisu tam rozbil celou událost. Nově má escapování
 * jeden zdroj a všechny cesty stavějí ICS přes buildIcs().
 */
'use strict';

// Escapování textové hodnoty dle RFC 5545 (zpětné lomítko, středník, čárka, nový řádek).
function escapeIcsText(value) {
    return String(value == null ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');
}

// Vrátí kompaktní UTC timestamp (DTSTAMP) — bez pomlček, dvojteček a milisekund.
function icsStamp(date) {
    return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/**
 * Sestaví ICS řetězec.
 * @param {Object} o
 * @param {string} o.id            UID (bez domény)
 * @param {string} o.title         SUMMARY (escapuje se)
 * @param {string} o.date          datum začátku ve formátu YYYY-MM-DD
 * @param {string} [o.time]        HH:MM — když chybí, jde o celodenní událost
 * @param {string} [o.location]    LOCATION (escapuje se)
 * @param {string} [o.description] DESCRIPTION (escapuje se)
 * @param {boolean} [o.isCancelled] přidá STATUS:CANCELLED
 * @param {boolean} [o.alarm]      přidá VALARM (připomenutí)
 * @param {string} [o.alarmTrigger] TRIGGER pro VALARM (default -P1D = den předem)
 * @param {string} [o.alarmText]   text připomenutí
 * @param {Date}   [o.stamp]       DTSTAMP (default teď) — předává se kvůli testovatelnosti
 */
function buildIcs(o) {
    // Datum, čas a UID jdou do ICS bez escapování → musí mít pevný tvar (jinak by šlo vložit další řádky).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.date || ''))) throw new Error('Datum musí být ve tvaru RRRR-MM-DD.');
    if (o.time != null && o.time !== '' && !/^\d{1,2}:\d{2}$/.test(String(o.time))) throw new Error('Čas musí být ve tvaru HH:MM.');
    if (o.time === '') o = Object.assign({}, o, { time: null });
    if (o.alarmTrigger && !/^-?P(T?\d+[WDHMS])+$/.test(String(o.alarmTrigger))) throw new Error('Neplatné připomenutí.');
    const cleanId = String(o.id || 'lexis_' + Date.now()).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
    const dtstamp = icsStamp(o.stamp || new Date());
    const startDate = String(o.date).replace(/-/g, '');

    let startLine, endLine;
    if (o.time) {
        const [hh, mm] = String(o.time).split(':');
        const timeClean = hh.padStart(2, '0') + mm + '00';
        startLine = `DTSTART;TZID=Europe/Prague:${startDate}T${timeClean}`;
        const startD = new Date(`${o.date}T${hh.padStart(2, '0')}:${mm}:00`);
        const endD = new Date(startD.getTime() + 60 * 60 * 1000);
        const endDateStr = endD.toISOString().split('T')[0].replace(/-/g, '');
        const endTimeClean = endD.toTimeString().split(' ')[0].replace(/:/g, '');
        endLine = `DTEND;TZID=Europe/Prague:${endDateStr}T${endTimeClean}`;
    } else {
        startLine = `DTSTART;VALUE=DATE:${startDate}`;
        const endD = new Date(o.date);
        endD.setDate(endD.getDate() + 1);
        const endDateStr = endD.toISOString().split('T')[0].replace(/-/g, '');
        endLine = `DTEND;VALUE=DATE:${endDateStr}`;
    }

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
        `SUMMARY:${escapeIcsText(o.title)}`,
        `DESCRIPTION:${escapeIcsText(o.description || '')}`
    ];

    if (o.isCancelled) lines.push('STATUS:CANCELLED');
    if (o.location) lines.push(`LOCATION:${escapeIcsText(o.location)}`);

    if (o.alarm) {
        lines.push(
            'BEGIN:VALARM',
            `TRIGGER:${o.alarmTrigger || '-P1D'}`,
            'ACTION:DISPLAY',
            `DESCRIPTION:${escapeIcsText(o.alarmText || 'Připomenutí blížící se lhůty Lexis')}`,
            'END:VALARM'
        );
    }

    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n');
}

// Očistí název pro použití jako název .ics souboru (dřív duplicitně v server.js i hearings.js).
function sanitizeFileName(name) {
    return String(name == null ? '' : name).replace(/[^a-zA-Z0-9_á-žÁ-Ž]/g, '_').substring(0, 100);
}

module.exports = { escapeIcsText, buildIcs, icsStamp, sanitizeFileName };
