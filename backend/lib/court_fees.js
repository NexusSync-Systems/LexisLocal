/**
 * court_fees.js — soudní poplatek z návrhu na peněžité plnění počítá PROGRAM, ne model.
 *
 * Eval 4. 11. 2026 (L6): Claude uvedl „soudní poplatek 4 % z hodnoty sporu, min. 1 000 Kč“ — 4 % je sazba
 * elektronického platebního rozkazu, u žaloby je 5 %. Stejně jako lhůty (lib/date_facts.js) proto poplatek
 * spočítá program a model ho převezme; co model napíše jinak, program pod odpovědí opraví.
 *
 * Zákon č. 549/1991 Sb., o soudních poplatcích, znění účinné od 1. 1. 2026 (ověřeno 4. 11. 2026):
 *   položka 1 bod 1 (návrh na zahájení řízení o peněžité plnění)
 *     a) do 20 000 Kč včetně                    1 000 Kč
 *     b) nad 20 000 Kč do 40 000 000 Kč         5 % z této částky
 *     c) nad 40 000 000 Kč                      2 000 000 Kč a 1 % z částky přesahující 40 000 000 Kč;
 *                                               částka nad 250 000 000 Kč se nezapočítává
 *   položka 2 (návrh na vydání elektronického platebního rozkazu podaný přes aplikaci)
 *     a) do 10 000 Kč 400 Kč   b) nad 10 000 do 20 000 Kč 800 Kč   c) nad 20 000 Kč 4 %
 *     (nevydá-li soud EPR, poplatek se doměří do výše položky 1)
 *   položka 22 bod 1: odvolání ve věci samé o peněžité plnění — jako položka 1
 *   § 6 odst. 1: k příslušenství uplatněnému spolu s jistinou se nepřihlíží
 *   § 6 odst. 7: základ procentního poplatku se zaokrouhluje na celé desítky Kč nahoru
 * Při změně zákona upravit SAZBY a test (tests/courtFees.test.js).
 */
'use strict';

const SAZBY = { verze: '549/1991 Sb. ve znění od 1. 1. 2026', zalobaPausal: 1000, zalobaHranice: 20000, zalobaPct: 5, velkaHranice: 40000000,
    velkaZaklad: 2000000, velkaPct: 1, velkaStrop: 250000000, epr: [[10000, 400], [20000, 800]], eprPct: 4 };

function _zakladNahoru(c) { return Math.ceil(c / 10) * 10; }   // § 6 odst. 7
function _r2(x) { return Math.round(x * 100) / 100; }
function kc(x) {
    const n = _r2(x);
    const [cele, hal] = n.toFixed(2).split('.');
    return cele.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (hal !== '00' ? ',' + hal : '') + ' Kč';
}

/**
 * Poplatek z peněžitého plnění (jistina bez příslušenství). opts.epr = elektronický platební rozkaz.
 * → { castka, poplatek, polozka, popis } nebo null (neplatná částka)
 */
function poplatekPenezite(castka, opts) {
    const c = Number(castka);
    if (!Number.isFinite(c) || c <= 0) return null;
    const S = SAZBY;
    if (opts && opts.epr) {
        for (const [hranice, p] of S.epr) if (c <= hranice) return { castka: c, poplatek: p, polozka: 'pol. 2 písm. ' + (hranice === 10000 ? 'a)' : 'b)'), popis: `pevná částka ${kc(p)}` };
        const z = _zakladNahoru(c);
        return { castka: c, poplatek: _r2(z * S.eprPct / 100), polozka: 'pol. 2 písm. c)', popis: `${S.eprPct} % ze základu ${kc(z)}` };
    }
    if (c <= S.zalobaHranice) return { castka: c, poplatek: S.zalobaPausal, polozka: 'pol. 1 bod 1 písm. a)', popis: `pevná částka ${kc(S.zalobaPausal)}` };
    if (c <= S.velkaHranice) {
        const z = _zakladNahoru(c);
        return { castka: c, poplatek: _r2(z * S.zalobaPct / 100), polozka: 'pol. 1 bod 1 písm. b)', popis: `${S.zalobaPct} % ze základu ${kc(z)}` };
    }
    const nad = _zakladNahoru(Math.min(c, S.velkaStrop) - S.velkaHranice);
    return { castka: c, poplatek: _r2(S.velkaZaklad + nad * S.velkaPct / 100), polozka: 'pol. 1 bod 1 písm. c)',
        popis: `${kc(S.velkaZaklad)} + ${S.velkaPct} % z ${kc(nad)} nad 40 mil. Kč` + (c > S.velkaStrop ? ' (částka nad 250 mil. Kč se nezapočítává)' : '') };
}

// Ptá se zadání na poplatek / náklady řízení / podání žaloby?
const RE_OTAZKA = /soudn\S*\s+poplat|poplat\S*\s+(?:za|z)\s+(?:žalob|návrh|odvolán)|kolik\s+(?:to\s+)?(?:bude\s+)?(?:stát|zaplat)|náklad\S*\s+(?:řízení|sporu|žalob)|podat\s+žalob|zažalovat|vymáh|platební\s+rozkaz|variant/i;
const RE_CASTKA = /(\d{1,3}(?:[  .]\d{3})+|\d{4,9})(?:,(\d{1,2}))?\s*(?:Kč|CZK|korun)/gi;
// Částka, o kterou jde (jistina): v okolí slov o dluhu / žalobě / petitu.
const RE_KONTEXT = /zaplat|žalob|petit|jistin|dluh|pohledáv|dluž|doplat|neuhrazen|smluvní pokut|náhrad\S* škod|kupní cen|cena díla|nájemné|faktur/i;

function _castky(text, jenSKontextem) {
    const out = [];
    RE_CASTKA.lastIndex = 0;
    let m;
    while ((m = RE_CASTKA.exec(text))) {
        const v = Number(m[1].replace(/[  .]/g, '')) + (m[2] ? Number('0.' + m[2]) : 0);
        if (!(v >= 1000)) continue;
        if (jenSKontextem && !RE_KONTEXT.test(text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 40))) continue;
        if (/(?:úrok|příslušenstv|poplat|záloh|náklad)[^,;.]{0,25}$/i.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;   // příslušenství, poplatky, náklady
        if (!out.includes(v)) out.push(v);
    }
    return out;
}

/** Fakta pro model (system zpráva) — jen když se zadání týká poplatku / žaloby a je z čeho počítat. */
function buildFeeFacts({ prompt, context } = {}) {
    const q = String(prompt || '');
    if (!RE_OTAZKA.test(q)) return null;
    let castky = _castky(q, false);
    if (!castky.length) castky = _castky(String(context || ''), true);
    castky = castky.slice(0, 3);
    if (!castky.length) return null;
    const vypocty = castky.map(c => ({ c, z: poplatekPenezite(c), e: poplatekPenezite(c, { epr: true }) }));
    const lines = vypocty.map(v => `• z ${kc(v.c)}: žaloba ${kc(v.z.poplatek)} (${v.z.polozka}, ${v.z.popis}); elektronický platební rozkaz ${kc(v.e.poplatek)} (${v.e.polozka})`);
    const text = 'Soudní poplatky (spočítal program podle zákona č. 549/1991 Sb., sazebník ve znění od 1. 1. 2026 — převezmi DOSLOVA, sám nepočítej; ' +
        'z příslušenství uplatněného s jistinou se poplatek neplatí; odvolání ve věci samé = stejná sazba jako žaloba):\n' + lines.join('\n');
    return { castky, vypocty, text };
}

/**
 * Kontrola odpovědi: zmíní-li soudní poplatek se sazbou, která není 5 % (u EPR 4 %), nebo poplatek nepřevezme,
 * program doplní správný výpočet pod odpověď.
 */
function feeAppendix(response, ff) {
    const r = String(response || '');
    if (!/soudn\S*\s+poplat/i.test(r)) return '';
    const spatne = [];
    const re = /soudn\S*\s+poplat[^.\n]{0,120}?(\d+(?:,\d+)?)\s*%/gi;
    let m;
    while ((m = re.exec(r))) {
        const pct = Number(m[1].replace(',', '.'));
        const epr = /platebn\S*\s+rozkaz|EPR/i.test(m[0]);
        if (pct !== (epr ? SAZBY.eprPct : SAZBY.zalobaPct) && pct !== SAZBY.velkaPct) spatne.push(m[1] + ' %');
    }
    const chybi = ff && ff.vypocty.length && !ff.vypocty.some(v => r.replace(/[\s .]/g, '').includes(String(Math.round(v.z.poplatek))));
    if (!spatne.length && !chybi) return '';
    const lines = [];
    if (spatne.length) lines.push(`⚠️ Odpověď uvádí sazbu soudního poplatku ${[...new Set(spatne)].join(', ')} — u žaloby o peněžité plnění je ${SAZBY.zalobaPct} % (nad 20 000 Kč; do 20 000 Kč pevně ${kc(SAZBY.zalobaPausal)}), ${SAZBY.eprPct} % jen u elektronického platebního rozkazu.`);
    if (ff && ff.vypocty.length) lines.push(...ff.vypocty.map(v => `• z ${kc(v.c)}: žaloba ${kc(v.z.poplatek)} (${v.z.polozka}); EPR ${kc(v.e.poplatek)} (${v.e.polozka})`));
    return '\n\n---\n⚖️ Doplněno programem (soudní poplatek, zák. č. 549/1991 Sb.):\n' + lines.join('\n');
}

module.exports = { SAZBY, poplatekPenezite, buildFeeFacts, feeAppendix, kc };
