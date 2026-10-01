/**
 * lib/date_facts.js — deterministické výpočty dat pro agenty.
 *
 * Změřeno 1. 10. 2026 (qwen2.5:7b): „28. 9. 2026 + 10 dní“ → model 8× z 8 vrátil
 * 28. 10. 2026 (správně 8. 10.); „3. 10. + 15 dní“ → 17. 10. (správně 19. 10., 18. 10.
 * je neděle). LLM datumovou aritmetiku neumí — spočítáme ji v kódu a modelu ji
 * předáme jako hotový fakt, který má převzít doslova.
 */
'use strict';

const { calculateDeadlineByUnit, detectDeadlines, extractDeliveryDates } = require('./extraction');

const UNIT_CZ = { day: ['den', 'dny', 'dní'], week: ['týden', 'týdny', 'týdnů'], month: ['měsíc', 'měsíce', 'měsíců'], year: ['rok', 'roky', 'let'] };
const DOW = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];

function _plural(n, unit) {
    const f = UNIT_CZ[unit] || UNIT_CZ.day;
    return n === 1 ? f[0] : (n >= 2 && n <= 4 ? f[1] : f[2]);
}
function _fmt(key) { // 'YYYY-MM-DD' → '8. 10. 2026 (čtvrtek)'
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 12);
    return `${d}. ${m}. ${y} (${DOW[dt.getDay()]})`;
}
function _key(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

// Všechna data ve tvaru d. m. rrrr (validní kalendářně), bez duplicit, v pořadí výskytu.
function findDates(text) {
    const out = [];
    const re = /(?<!\d)(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})(?!\d)/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
        const d = +m[1], mo = +m[2], y = +m[3];
        const dt = new Date(y, mo - 1, d, 12);
        if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) continue;
        const k = _key(y, mo, d);
        if (!out.includes(k)) out.push(k);
    }
    return out;
}

// Kalendářní konec bez posunu (pro transparentnost, když padne na víkend/svátek).
function _rawEnd(baseKey, amount, unit) {
    const [y, m, d] = baseKey.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 12);
    if (unit === 'week') dt.setDate(dt.getDate() + 7 * amount);
    else if (unit === 'month' || unit === 'year') {
        const months = unit === 'year' ? amount * 12 : amount;
        const t = new Date(y, m - 1 + months, 1, 12);
        const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
        t.setDate(Math.min(d, last));
        return _key(t.getFullYear(), t.getMonth() + 1, t.getDate());
    } else dt.setDate(dt.getDate() + amount);
    return _key(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

/**
 * Z textu (prompt + kontext) vytáhne data a délky lhůt a spočítá konce.
 * Vrací { facts: [{base, amount, unit, raw, end, shifted}], deliveryConflict, text } nebo null.
 */
function buildDateFacts(text, { maxFacts = 8 } = {}) {
    const src = String(text || '');
    const dates = findDates(src);
    if (!dates.length) return null;
    const delivery = extractDeliveryDates(src);
    // Základem jsou přednostně data doručení; jinak všechna nalezená data.
    const bases = delivery.all.length ? delivery.all : dates;
    const durs = [];
    for (const d of detectDeadlines(src)) {
        if (!durs.some(x => x.amount === d.amount && x.unit === d.unit)) durs.push({ amount: d.amount, unit: d.unit });
    }
    // „+ 10 dní“, „za 10 dní“ apod. bez lhůtového kontextu detectDeadlines u dnů chytí;
    // týdny/měsíce bez kontextu doplníme jednoduchým vzorem s „+“/„za“/„plus“.
    const re = /(?:\+|plus|za|po)\s*(\d{1,3})\s*(t[ýy]dn[uůy]?|t[ýy]den|m[ěe]s[íi]c[eůu]?|let|rok[uy]?)/gi;
    let m;
    while ((m = re.exec(src))) {
        const w = m[2].toLowerCase();
        const unit = /^t/.test(w) ? 'week' : /^m/.test(w) ? 'month' : 'year';
        const amount = +m[1];
        if (!durs.some(x => x.amount === amount && x.unit === unit)) durs.push({ amount, unit });
    }
    const facts = [];
    for (const base of bases) {
        for (const d of durs) {
            if (facts.length >= maxFacts) break;
            const end = calculateDeadlineByUnit(d.amount, d.unit, base + 'T12:00:00');
            if (!end) continue;
            const raw = _rawEnd(base, d.amount, d.unit);
            facts.push({ base, amount: d.amount, unit: d.unit, raw, end, shifted: raw !== end });
        }
    }
    if (!facts.length && !delivery.conflict) return null;
    const lines = facts.map(f =>
        `• ${_fmt(f.base)} + ${f.amount} ${_plural(f.amount, f.unit)} = ${_fmt(f.raw)}` +
        (f.shifted ? ` → připadá na víkend/svátek, konec lhůty se posouvá na ${_fmt(f.end)} (§ 57 odst. 2 o.s.ř.)` : '')
    );
    if (delivery.conflict) {
        lines.push(`• POZOR: v podkladech jsou RŮZNÁ data doručení (${delivery.all.map(_fmt).join(', ')}). ` +
            `Upozorni na rozpor a konzervativně počítej od nejdřívějšího.`);
    }
    const textOut = 'Výpočty dat (spočítal program, jsou správné — převezmi je DOSLOVA, sám datumy nepočítej):\n' + lines.join('\n');
    return { facts, deliveryConflict: delivery.conflict, text: textOut };
}

module.exports = { buildDateFacts, findDates };
