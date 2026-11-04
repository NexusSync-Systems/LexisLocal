/**
 * pilot_metriky.js — měření pilotu BEZ obsahu spisů (eval harness → provoz, 4. 11. 2026).
 *
 * Za každý dotaz agenta se do denního součtu (den × typ úlohy × agent) přičtou jen POČTY a KÓDY:
 * výsledek (ok / odepřeno / cloud nedostupný / chyba), doba odpovědi, citace celkem / neověřené / mimo
 * podklady, doporučení celkem / bez opory, kódy kontroly výstupu (např. „bez_opory“) a zda pomohla oprava.
 * Žádný text dotazu ani odpovědi, žádná sp. zn., žádné jméno — jde to vidět v testu (pilotMetriky.test.js).
 *
 * Data zůstávají na Macu advokáta (databáze aplikace). Na konci týdne pošle advokát CSV z přehledu
 * (GET /api/pilot-metriky/export.csv) — z něj se vyčte četnost chyb po typech úloh, viz eval/spis_eval/README.
 * Vypnout: LEXIS_PILOT_METRIKY=0.
 */
'use strict';

const db = require('./database');

const TABULKA = 'pilot_metriky';
const VYSLEDKY = ['ok', 'odepreno', 'cloud_nedostupny', 'chyba'];
const HODNOCENI = ['dobre', 'spatne'];
const DUVODY = ['spatna_citace', 'chybi_opora', 'vymyslene', 'nepresne', 'neuplne', 'mimo_zadani', 'jine'];

function zapnuto() { return process.env.LEXIS_PILOT_METRIKY !== '0'; }
function _den(now) { return (now || new Date()).toISOString().slice(0, 10); }
function _kod(v) { const s = String(v == null ? '' : v).toLowerCase(); return /^[a-z][a-z0-9_]{0,39}$/.test(s) ? s : 'jine'; }
function _n(v) { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.round(x) : 0; }

function _radek(den, taskKind, agentId) {
    const list = db.get(TABULKA) || [];
    let r = list.find(x => x.den === den && x.taskKind === taskKind && x.agentId === agentId);
    if (!r) {
        r = db.insert(TABULKA, { den, taskKind, agentId, dotazu: 0, ok: 0, odepreno: 0, cloud_nedostupny: 0, chyba: 0, cloud: 0,
            msSoucet: 0, msMax: 0, citace: 0, citaceNeoverene: 0, citaceMimoPodklady: 0, doporuceni: 0, bezOpory: 0, vyslovneBezOpory: 0,
            sChybouKontroly: 0, opraveno: 0, zbyvaChyba: 0, kody: {}, judikatyVypusteno: 0, injekce: 0, hodnoceniDobre: 0, hodnoceniSpatne: 0, duvody: {} });
    }
    return r;
}

/**
 * Jeden dotaz agenta. info: { agentId, taskKind, vysledek, cloud, ms, citationCheck, opora, selfCheck,
 * judikatyVypusteno, injection } — vše z route agenta, texty se zahodí.
 */
function zaznamenej(info, now) {
    if (!zapnuto()) return null;
    try {
        info = info || {};
        const r = _radek(_den(now), _kod(info.taskKind || 'obecne'), _kod(info.agentId || 'neznamy'));
        const p = {};
        const vysl = VYSLEDKY.includes(info.vysledek) ? info.vysledek : 'ok';
        p.dotazu = r.dotazu + 1;
        p[vysl] = (r[vysl] || 0) + 1;
        if (info.cloud) p.cloud = r.cloud + 1;
        const ms = _n(info.ms);
        p.msSoucet = r.msSoucet + ms; p.msMax = Math.max(r.msMax, ms);
        const cc = info.citationCheck || null;
        if (cc) {
            p.citace = r.citace + _n(cc.total);
            p.citaceNeoverene = r.citaceNeoverene + _n(cc.unverifiedCount);
            p.citaceMimoPodklady = r.citaceMimoPodklady + _n(cc.outsideContextCount);
        }
        const op = info.opora || null;
        if (op) {
            p.doporuceni = r.doporuceni + _n(op.doporuceni);
            p.bezOpory = r.bezOpory + _n(Array.isArray(op.bezOpory) ? op.bezOpory.length : op.bezOpory);
            p.vyslovneBezOpory = r.vyslovneBezOpory + _n(Array.isArray(op.vyslovneBez) ? op.vyslovneBez.length : op.vyslovneBez);
        }
        const sc = info.selfCheck || null;
        if (sc && Array.isArray(sc.found) && sc.found.length) {
            p.sChybouKontroly = r.sChybouKontroly + 1;
            const zbyva = Array.isArray(sc.remaining) ? sc.remaining.length : 0;
            if (sc.retried && !zbyva) p.opraveno = r.opraveno + 1;
            if (zbyva) p.zbyvaChyba = r.zbyvaChyba + 1;
            const kody = Object.assign({}, r.kody);
            for (const k of new Set(sc.found.map(_kod))) kody[k] = (kody[k] || 0) + 1;
            p.kody = kody;
        }
        p.judikatyVypusteno = r.judikatyVypusteno + _n(Array.isArray(info.judikatyVypusteno) ? info.judikatyVypusteno.length : info.judikatyVypusteno);
        p.injekce = r.injekce + _n(Array.isArray(info.injection) ? info.injection.length : info.injection);
        return db.update(TABULKA, r.id, p);
    } catch (e) { return null; }   // měření nesmí shodit odpověď
}

/** Hodnocení odpovědi advokátem (👍/👎 + důvod z pevného výčtu, bez textu). */
function ohodnot(o, now) {
    if (!zapnuto()) return null;
    o = o || {};
    if (!HODNOCENI.includes(o.hodnoceni)) throw new Error('Hodnocení musí být „dobre“ nebo „spatne“.');
    const duvod = o.duvod == null || o.duvod === '' ? null : String(o.duvod);
    if (duvod && !DUVODY.includes(duvod)) throw new Error('Neznámý důvod. Povolené: ' + DUVODY.join(', ') + '.');
    const r = _radek(_den(now), _kod(o.taskKind || 'obecne'), _kod(o.agentId || 'neznamy'));
    const p = o.hodnoceni === 'dobre' ? { hodnoceniDobre: r.hodnoceniDobre + 1 } : { hodnoceniSpatne: r.hodnoceniSpatne + 1 };
    if (duvod) { const d = Object.assign({}, r.duvody); d[duvod] = (d[duvod] || 0) + 1; p.duvody = d; }
    return db.update(TABULKA, r.id, p);
}

function _pct(a, b) { return b ? Math.round(1000 * a / b) / 10 : null; }

/** Souhrn za období po typech úloh. od/do = 'YYYY-MM-DD' (včetně). */
function souhrn(od, doDne) {
    const rows = (db.get(TABULKA) || []).filter(r => (!od || r.den >= od) && (!doDne || r.den <= doDne));
    const poTypu = {};
    for (const r of rows) {
        const t = poTypu[r.taskKind] || (poTypu[r.taskKind] = { taskKind: r.taskKind, dotazu: 0, ok: 0, odepreno: 0, cloud_nedostupny: 0, chyba: 0, msSoucet: 0, msMax: 0,
            citace: 0, citaceNeoverene: 0, citaceMimoPodklady: 0, doporuceni: 0, bezOpory: 0, vyslovneBezOpory: 0, sChybouKontroly: 0, opraveno: 0, zbyvaChyba: 0,
            judikatyVypusteno: 0, injekce: 0, hodnoceniDobre: 0, hodnoceniSpatne: 0, kody: {}, duvody: {} });
        for (const k of Object.keys(t)) if (typeof t[k] === 'number' && typeof r[k] === 'number') t[k] = k === 'msMax' ? Math.max(t[k], r[k]) : t[k] + r[k];
        for (const [k, v] of Object.entries(r.kody || {})) t.kody[k] = (t.kody[k] || 0) + v;
        for (const [k, v] of Object.entries(r.duvody || {})) t.duvody[k] = (t.duvody[k] || 0) + v;
    }
    const typy = Object.values(poTypu).map(t => Object.assign(t, {
        msPrumer: t.dotazu ? Math.round(t.msSoucet / t.dotazu) : null,
        pctNeovereneCitace: _pct(t.citaceNeoverene, t.citace),
        pctBezOpory: _pct(t.bezOpory, t.doporuceni),
        pctChybaKontroly: _pct(t.sChybouKontroly, t.dotazu),
        pctOpravaPomohla: _pct(t.opraveno, t.sChybouKontroly),
        pctSpatneHodnoceni: _pct(t.hodnoceniSpatne, t.hodnoceniDobre + t.hodnoceniSpatne),
        pctNedostupny: _pct(t.cloud_nedostupny + t.chyba, t.dotazu)
    })).sort((a, b) => b.dotazu - a.dotazu);
    return { od: od || null, do: doDne || null, dnu: new Set(rows.map(r => r.den)).size, typy };
}

const SLOUPCE = ['taskKind', 'dotazu', 'ok', 'odepreno', 'cloud_nedostupny', 'chyba', 'msPrumer', 'msMax', 'citace', 'citaceNeoverene', 'citaceMimoPodklady',
    'doporuceni', 'bezOpory', 'vyslovneBezOpory', 'sChybouKontroly', 'opraveno', 'zbyvaChyba', 'judikatyVypusteno', 'injekce', 'hodnoceniDobre', 'hodnoceniSpatne', 'kody', 'duvody'];
function csv(od, doDne) {
    const s = souhrn(od, doDne);
    const bunka = v => (v && typeof v === 'object') ? Object.entries(v).map(([k, n]) => k + '=' + n).join(' ') : (v == null ? '' : String(v));
    return [SLOUPCE.join(';')].concat(s.typy.map(t => SLOUPCE.map(k => bunka(t[k])).join(';'))).join('\n') + '\n';
}

module.exports = { zapnuto, zaznamenej, ohodnot, souhrn, csv, VYSLEDKY, HODNOCENI, DUVODY, TABULKA };
