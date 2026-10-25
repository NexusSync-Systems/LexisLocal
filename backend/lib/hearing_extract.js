/**
 * lib/hearing_extract.js — rozpoznání nařízeného jednání v doručeném dokumentu
 * (předvolání, vyrozumění o jednání, usnesení o odročení).
 *
 *   „nařizuje jednání na den 15. 10. 2026 v 9:00 hod. do jednací síně č. 12“
 *   „Jednání se koná dne 15. října 2026 v 9.30 hodin v jednací síni č. 115“
 *
 * Výsledek je vždy jen NÁVRH k potvrzení (needsReview) — závazné je předvolání.
 */
'use strict';

const { detectCourtName, parseSpisZn, formatSpisZn } = require('./court_hearings_source');

const MONTHS = { ledn: 1, unor: 2, únor: 2, brez: 3, břez: 3, dub: 4, kvet: 5, květ: 5, cervn: 6, červn: 6, cervenc: 7, červenc: 7, srp: 8, zar: 9, zář: 9, rij: 10, říj: 10, listop: 11, prosin: 12 };

function _month(word) {
    const w = String(word || '').toLowerCase();
    // červenec před červen (delší kmen první)
    const keys = Object.keys(MONTHS).sort((a, b) => b.length - a.length);
    for (const k of keys) if (w.startsWith(k)) return MONTHS[k];
    return null;
}

const DATE_RE = '(\\d{1,2})\\.\\s*(\\d{1,2}|[a-zá-ž]+)\\s*\\.?\\s*(\\d{4})';
const TIME_RE = '(\\d{1,2})[:.](\\d{2})';
const TRIGGER = /(jednání|líčení|veřejné zasedání|ústní jednání|předvolán|odročuje)/i;

function extractHearings(text) {
    const src = String(text || '').replace(/\s+/g, ' ');
    if (!TRIGGER.test(src)) return [];
    const court = detectCourtName(src);
    const czM = src.match(/(?:sp\.\s*zn\.|č\.\s*j\.|spisová značka)\s*:?\s*(\d{1,4}\s*[A-Za-zÁ-ž]{1,5}\s*\d{1,7}\s*\/\s*\d{4})/i)
        || src.match(/\b(\d{1,4}\s?[A-Z][A-Za-z]{0,4}\s?\d{1,7}\/\d{4})\b/);
    const spisZn = czM ? formatSpisZn(parseSpisZn(czM[1])) : null;

    const out = [];
    // datum v okolí (do 120 znaků za) klíčového slova jednání
    const re = new RegExp('(jednání|líčení|veřejné zasedání|ústní jednání|předvolává|odročuje)[^.]{0,120}?' + DATE_RE + '(?:[^.]{0,30}?' + TIME_RE + ')?', 'gi');
    let m;
    while ((m = re.exec(src))) {
        const day = parseInt(m[2], 10);
        const mon = /^\d+$/.test(m[3]) ? parseInt(m[3], 10) : _month(m[3]);
        const year = parseInt(m[4], 10);
        if (!mon || day < 1 || day > 31 || mon > 12) continue;
        const date = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const time = m[5] ? `${m[5].padStart(2, '0')}:${m[6]}` : '';
        const after = src.slice(m.index, m.index + m[0].length + 80);
        const roomM = after.match(/(?:jednací\s+síň|jednací\s+síni|jednací\s+síně|síň|místnost)\s*(?:č\.\s*)?([0-9A-Za-z/]+)/i);
        const cancelled = false; // zrušení jednání pozná hlídač z InfoJednání, ne z textu
        if (!out.some(h => h.date === date && h.time === time)) {
            out.push({ date, time, room: roomM ? roomM[1] : '', court, spisZn, context: m[0].slice(0, 200), cancelled });
        }
    }
    return out;
}

module.exports = { extractHearings };
