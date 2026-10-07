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
function buildDateFacts(text, { maxFacts = 8, question = null } = {}) {
    const src = String(text || '');
    const dates = findDates(src);
    // Bez českých dat může jít o anglický podklad (splatnost „15 July 2026“) → promlčení se zkusí níže.
    if (!dates.length && !/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|\d{4}\s*$/i.test(src)) return null;
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
    // Promlčení jen když se na náhradu škody / promlčení ptá zadání (ne u každé smlouvy se slovem „škoda“).
    // Ptá se zadání (nebo klient v podkladech) „do kdy / how long“? Samotné slovo „lhůta“ v podkladech nestačí.
    const asksTimeQ = /how long|do we have|time limit|limitation|do kdy|promlč|lh[uů]t/i;
    const asksTimeSrc = /how long|do we have|time limit|do kdy\s*\?|do kdy m[uů]/i;
    const limitation = (question == null || CLAIM_CTX.test(String(question)) || asksTimeQ.test(String(question)) || asksTimeSrc.test(src))
        ? (limitationFacts(src) || debtLimitationFacts(src)) : null;
    if (!facts.length && !delivery.conflict && !limitation) return null;
    const lines = facts.map(f =>
        `• ${_fmt(f.base)} + ${f.amount} ${_plural(f.amount, f.unit)} = ${_fmt(f.raw)}` +
        (f.shifted ? ` → připadá na víkend/svátek, konec lhůty se posouvá na ${_fmt(f.end)} (§ 57 odst. 2 o.s.ř.)` : '')
    );
    if (delivery.conflict) {
        lines.push(`• POZOR: v podkladech jsou RŮZNÁ data doručení (${delivery.all.map(_fmt).join(', ')}). ` +
            `Upozorni na rozpor a konzervativně počítej od nejdřívějšího.`);
    }
    if (limitation) lines.push(...limitation.lines);
    const textOut = 'Výpočty dat (spočítal program, jsou správné — převezmi je DOSLOVA, sám datumy nepočítej):\n' + lines.join('\n');
    // Konzervativní konec lhůty při rozporu dat doručení = od nejdřívějšího data.
    let conflictEnd = null;
    if (delivery.conflict) {
        const f0 = facts.find(f => f.base === delivery.all[0]);
        if (f0) conflictEnd = f0.end;
    }
    return { facts, deliveryConflict: delivery.conflict, deliveryDates: delivery.all, conflictEnd, limitation, text: textOut };
}

// ── Promlčení práva na náhradu škody (§ 619, § 620, § 629, § 636 OZ) ──────────
// Změřeno 2. 10. 2026: Rešeršník u vytopení bytu nespočítal konec promlčecí lhůty.
// Vezmeme datum škodní události z textu (věta se slovy škoda/vytopil/nehoda/zjistil…)
// a spočítáme subjektivní 3 roky a objektivních 10 let. Posun z víkendu/svátku § 607 OZ.
const DAMAGE_CTX = /(škod|vytopil|vytopen|nehod|poškod|způsobil|zranil|úraz|havári|praskl|vznikl)/i;
const CLAIM_CTX = /(náhrad\S*\s+škod|vymáh|odškodn|promlč|uplatnit\s+nárok|zaplatit\s+škod|škod[ayu]\b)/i;

function limitationFacts(src) {
    const t = String(src || '');
    if (!CLAIM_CTX.test(t)) return null;
    // Datum škodní události: první datum, v jehož okolí (−60 / +160 znaků) je škodní kontext.
    // Data z hlaviček e-mailu („Datum: …“) se přeskakují.
    let event = null, knownSameDay = false;
    const re = /(?<!\d)(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})(?!\d)/g; let m;
    while (!event && (m = re.exec(t))) {
        const lineStart = t.lastIndexOf('\n', m.index) + 1;
        if (/^\s*(Datum|Date|Odesláno|Sent|Doručeno)\s*:/i.test(t.slice(lineStart, m.index))) continue;
        const win = t.slice(Math.max(lineStart, m.index - 60), m.index + 160);
        if (!DAMAGE_CTX.test(win)) continue;
        const key = findDates(m[0])[0];
        if (!key) continue;
        event = key;
        const after = t.slice(m.index, m.index + 300);
        knownSameDay = /(ten den|téhož dne|tentýž den|ihned|hned)[^.?!]{0,40}zjist|zjistil\S*[^.?!]{0,20}(ten den|téhož dne|ihned|hned)/i.test(after);
    }
    if (!event) return null;
    const subj = calculateDeadlineByUnit(3, 'year', event + 'T12:00:00');
    const subjRaw = _rawEnd(event, 3, 'year');
    const obj = calculateDeadlineByUnit(10, 'year', event + 'T12:00:00');
    const objRaw = _rawEnd(event, 10, 'year');
    if (!subj || !obj) return null;
    const shift = (raw, end) => raw !== end ? ` → připadá na víkend/svátek, posouvá se na ${_fmt(end)} (§ 607 OZ)` : '';
    const lines = [
        `• PROMLČENÍ náhrady škody — škodní událost ${_fmt(event)}.`,
        `• Subjektivní promlčecí lhůta 3 roky (§ 629 odst. 1 OZ) běží ode dne, kdy se poškozený dozvěděl o škodě a o tom, kdo ji má nahradit (§ 619 odst. 1, § 620 odst. 1 OZ)` +
            (knownSameDay ? ' — podle podkladů ještě týž den' : ' — pokud se to dozvěděl ten den') +
            `: ${_fmt(event)} + 3 roky = ${_fmt(subjRaw)}${shift(subjRaw, subj)}.`,
        `• Objektivní lhůta nejpozději 10 let ode dne vzniku škody (§ 636 odst. 2 OZ): ${_fmt(objRaw)}${shift(objRaw, obj)}.`,
        `• Do konce subjektivní lhůty je třeba nárok uplatnit u soudu (podat žalobu) — mimosoudní výzva běh lhůty nestaví.`
    ];
    return { event, subjectiveEnd: subj, objectiveEnd: obj, knownSameDay, lines };
}

// ── Promlčení peněžité pohledávky (faktura / splatnost) — § 629 odst. 1, § 619 odst. 2 OZ ──
const EN_MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const DEBT_CTX = /(faktur|invoice|splatn|due\s+(on|date)|dlu[žz]|pohled[aá]vk|nezaplatil|neuhradil|not\s+paid|unpaid|have not paid)/i;

function _dueDate(t) {
    let m = t.match(/splatn\S*[^.\d]{0,25}(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/i);
    if (m) return _key(+m[3], +m[2], +m[1]);
    m = t.match(/due(?:\s+(?:on|date|by))?[^.\d]{0,15}(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
    if (m) return _key(+m[3], EN_MONTHS[m[2].toLowerCase()], +m[1]);
    m = t.match(/due(?:\s+(?:on|date|by))?[^.\d]{0,15}(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i);
    if (m) return _key(+m[3], EN_MONTHS[m[1].toLowerCase()], +m[2]);
    return null;
}

function debtLimitationFacts(src) {
    const t = String(src || '');
    if (!DEBT_CTX.test(t)) return null;
    const due = _dueDate(t);
    if (!due) return null;
    const end = calculateDeadlineByUnit(3, 'year', due + 'T12:00:00');
    const raw = _rawEnd(due, 3, 'year');
    if (!end) return null;
    const [y, mo, d] = end.split('-').map(Number);
    const enDate = `${d} ${Object.keys(EN_MONTHS)[mo - 1].replace(/^./, c => c.toUpperCase())} ${y}`;
    const lines = [
        `• PROMLČENÍ peněžité pohledávky — splatnost ${_fmt(due)}.`,
        `• Promlčecí lhůta 3 roky (§ 629 odst. 1 OZ) běží od doby, kdy šlo právo uplatnit poprvé, tj. od splatnosti (§ 619 OZ): ` +
            `${_fmt(due)} + 3 roky = ${_fmt(raw)}` + (raw !== end ? ` → připadá na víkend/svátek, posouvá se na ${_fmt(end)} (§ 607 OZ)` : '') +
            ` (English: limitation period three years, ends ${enDate}).`,
        `• Do té doby je třeba podat žalobu (uplatnění práva u soudu běh lhůty zastaví — § 648 OZ); písemné uznání dluhu dlužníkem běh lhůty také mění.`
    ];
    return { event: due, subjectiveEnd: end, objectiveEnd: null, kind: 'debt', lines };
}

function _dateRe(key) {
    const [y, m, d] = String(key).split('-').map(Number);
    return new RegExp(`(?<!\\d)${d}\\.\\s?${m}\\.\\s?${y}(?!\\d)`, 'g');
}

/**
 * Konec lhůty popsaný jako její začátek („lhůta 3 let, která běží od 13. 3. 2028“ —
 * server test 4. 10. 2026, R1) → program opraví „od“ na „do“. Jen u dat, která program
 * sám spočítal jako KONEC lhůty, a jen v kontextu lhůty/promlčení.
 * Vrací { text, fixed: počet }.
 */
function fixDeadlineWording(response, df) {
    let t = String(response || '');
    if (!df) return { text: t, fixed: 0 };
    const ends = new Set();
    if (df.limitation) { ends.add(df.limitation.subjectiveEnd); if (df.limitation.objectiveEnd) ends.add(df.limitation.objectiveEnd); }
    if (df.conflictEnd) ends.add(df.conflictEnd);
    for (const f of df.facts || []) if (f && f.end) ends.add(f.end);
    let fixed = 0;
    for (const key of ends) {
        if (!key) continue;
        const [y, m, d] = String(key).split('-').map(Number);
        const date = `${d}\\.\\s?${m}\\.\\s?${y}(?!\\d)`;
        const re = new RegExp(`(běží|plyne|počíná(?:\\s+běžet)?|začíná(?:\\s+běžet)?|počítá\\s+se|lh[uů]t\\S*)\\s+(od|ode)(\\s+(?:dne|data))?\\s+(${date})`, 'giu');
        t = t.replace(re, (all, verb, od, dne, dt, idx, whole) => {
            // jen ve větě, která mluví o lhůtě / promlčení
            let before = whole.slice(Math.max(0, idx - 90), idx + verb.length);
            let cut = 0; const reB = /[.!?]\s+(?=\p{Lu})|\n/gu; let b;
            while ((b = reB.exec(before))) cut = b.index + b[0].length;
            if (!/lh[uů]t|promlč/i.test(before.slice(cut))) return all;
            fixed++;
            if (/^(počíná|začíná)/i.test(verb)) return `končí${dne || ''} ${dt}`;
            return `${verb} do${dne || ''} ${dt}`;
        });
    }
    // Run 7 (7. 10. 2026), R1: „Klientka by měla hned po uplynutí lhůty 3 let (13. 3. 2028) podat žalobu“
    // — obrácená rada: po uplynutí je nárok promlčený. Opravíme na „nejpozději před uplynutím“.
    t = t.replace(/(?:\b(?:hned|ihned|až|teprve)\s+)?\bpo\s+uplynut[ií]((?:[^.!?\n]|\.(?=\s?\d)){0,60}?)(?=\s*(?:podat|uplatnit|zažalovat|vymáhat)\b)/giu,
        (all, mid) => {
            if (!/lh[uů]t|promlč/i.test(mid)) return all;
            fixed++;
            return `nejpozději před uplynutím${mid}`;
        });
    return { text: t, fixed };
}

/**
 * Co model z vypočtených dat vynechal, doplní program pod odpověď:
 * rozpor dat doručení (bez zmínky o rozporu) a konec promlčecí lhůty (bez data).
 */
function dateFactsAppendix(response, df) {
    if (!df) return '';
    const r = String(response || '');
    const out = [];
    if (df.deliveryConflict && !/rozpor|nesoulad|r[uů]zn[aáé]\s+dat|dv[eě]\s+(r[uů]zn[aá]\s+)?dat|odli[šs]n/i.test(r)) {
        out.push(`⚠️ Podklady uvádějí RŮZNÁ data doručení (${(df.deliveryDates || []).map(_fmt).join(', ')}). ` +
            (df.conflictEnd ? `Konzervativně počítáno od nejdřívějšího: konec lhůty ${_fmt(df.conflictEnd)}. ` : '') +
            'Ověřte skutečné datum doručení (datová schránka / doručenka).');
    }
    if (df.limitation) {
        // Celý výpočet se doplní, když v odpovědi chybí KTERÝKOLI z klíčových údajů: konec
        // subjektivní lhůty, u škody i objektivní 10letá lhůta, a § 629 (server test 4. 10. 2026,
        // R1: datum tam bylo, ale chyběla 10letá lhůta a § — advokát by dostal neúplný rozbor).
        const L = df.limitation;
        const hasSubj = _dateRe(L.subjectiveEnd).test(r);
        const hasObj = !L.objectiveEnd || _dateRe(L.objectiveEnd).test(r) || /(10|deset)\s+let/i.test(r);
        const hasPar = /§\s?629|629\s+odst/.test(r);
        if (!hasSubj || !hasObj || !hasPar) out.push(...L.lines);
    }
    return out.length ? '\n\n---\n📅 Doplněno programem (výpočet lhůt):\n' + out.join('\n') : '';
}

module.exports = { buildDateFacts, findDates, limitationFacts, debtLimitationFacts, dateFactsAppendix, fixDeadlineWording };
