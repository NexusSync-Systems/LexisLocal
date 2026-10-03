/**
 * lib/court_hearings_source.js — dotaz na nařízená jednání soudu (InfoJednání, MSp).
 *
 * Proč samostatný modul (2. 10. 2026):
 *  • Justiční weby (InfoSoud, InfoJednání) byly od 1. 10. 2026 mimo provoz a hlídač
 *    to jen zapsal do logu — advokát neviděl, že jeho jednání nikdo nekontroluje.
 *  • Adresa rozhraní, kterou hlídač volal, nebyla nikde ověřena. Je proto KONFIGUROVATELNÁ
 *    (LEXIS_INFOJEDNANI_URL) a odpověď se čte tolerantně (různé názvy polí). Po obnovení
 *    webů se skutečné rozhraní ověří skriptem scripts/infojednani_probe.js
 *    (postup v backend/docs/INFOJEDNANI.md).
 *
 * Kontrakt fetchHearings():
 *   { ok:true,  events:[{date:'YYYY-MM-DD', time:'HH:MM'|'', room, cancelled}], court }
 *   { ok:false, kind:'not_configured'|'unavailable'|'invalid_response', reason }
 * Chyba NIKDY neznamená „beze změny“ — volající ji musí evidovat (hearings_health).
 *
 * Posílá se jen sp. zn. a kód soudu (veřejné údaje), žádná data klienta.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Adresa odpovídá oficiálnímu frontendu InfoJednání (apiUrl "" + "api/v1" + "/jednani/vyhledej").
// OVĚŘENO ZA BĚHU 3. 10. 2026 (Chrome, Network): POST JSON, u okresního soudu
// druhOrganizace = nadřízený KS/MS + okresniSoud = OS (samotný OS → HTTP 400
// JEDNANI_VALIDATION_0009), odpověď {organizace, udalosti:[{datum:"05.10.2026", cas:"12:45",
// jednaciSin, jednaniZruseno, druhJednani, …}], platneK}; nenalezeno = udalosti: [].
const DEFAULT_URL = 'https://infojednani.gov.cz/api/v1/jednani/vyhledej';
const TIMEOUT_MS = parseInt(process.env.LEXIS_INFOJEDNANI_TIMEOUT_MS || '', 10) || 15000;

function config() {
    return {
        enabled: process.env.LEXIS_INFOJEDNANI_ENABLED !== '0',
        url: process.env.LEXIS_INFOJEDNANI_URL || DEFAULT_URL,
        // POST (výchozí) s JSON tělem, nebo GET s parametry v URL šabloně.
        method: (process.env.LEXIS_INFOJEDNANI_METHOD || 'POST').toUpperCase(),
        // Volitelná šablona těla/URL s {cisloSenatu} {druhVeci} {bcVec} {rocnik} {courtCode}
        // — po ověření skutečného rozhraní jde přizpůsobit BEZ změny kódu.
        bodyTemplate: process.env.LEXIS_INFOJEDNANI_BODY_TEMPLATE || null,
        verified: process.env.LEXIS_INFOJEDNANI_VERIFIED === '1'
    };
}

function _fill(tpl, vars, encode) {
    return String(tpl).replace(/\{(\w+)\}/g, (m, k) => vars[k] == null ? '' : (encode ? encodeURIComponent(vars[k]) : String(vars[k])));
}

/** „12 C 45/2026“, „12C45/2026-58“, „23 Co 120/2025“ → části sp. zn. (č. j. za pomlčkou se zahodí). */
function parseSpisZn(str) {
    const m = String(str || '').replace(/\s+/g, ' ').trim()
        .match(/^(\d{1,4})\s*([A-Za-zÁ-žá-ž]{1,5}(?:\s+[aA]\s+[A-Za-zÁ-žá-ž]{1,4})?)\s*(\d{1,7})\s*\/\s*(\d{4})/);
    if (!m) return null;
    // Rejstřík „P a Nc“ (opatrovnické) má mezery; InfoJednání (ověřeno 3. 10. 2026) bere
    // druhVeci bez ohledu na velikost písmen a vrací ho velkými („NC“, „P A NC“).
    return { cisloSenatu: m[1], druhVeci: m[2].replace(/\s+/g, ' '), bcVec: m[3], rocnik: m[4] };
}

function formatSpisZn(p) {
    return p ? `${p.cisloSenatu} ${p.druhVeci} ${p.bcVec}/${p.rocnik}` : '';
}

// ── Kódy soudů ──────────────────────────────────────────────────────────────
// InfoJednání vyhledává podle KÓDU soudu (OSJIMJI = Okresní soud Jihlava, …).
// Zdroj: oficiální číselník InfoJednání přibalený v data/courts_infojednani_lov.json
// (staženo 5/2026). Přednost má explicitní soudKod ve spisu, pak ruční mapa
// <data>/courts_infojednani.json nebo env LEXIS_COURT_CODES, pak číselník podle názvu.
let _codesCache = null, _lovCache = null;
function _loadCourtCodes() {
    if (_codesCache) return _codesCache;
    let map = {};
    try {
        const { dataPath } = require('./config');
        const f = dataPath('courts_infojednani.json');
        if (fs.existsSync(f)) map = Object.assign(map, JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch (e) { /* bez souboru */ }
    try {
        if (process.env.LEXIS_COURT_CODES) map = Object.assign(map, JSON.parse(process.env.LEXIS_COURT_CODES));
    } catch (e) { /* neplatný JSON v env */ }
    _codesCache = map;
    return map;
}
function courtList() {
    if (_lovCache) return _lovCache;
    try {
        const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'courts_infojednani_lov.json'), 'utf8'));
        _lovCache = Array.isArray(j) ? j : (j.soudy || []);
    } catch (e) { _lovCache = []; }
    return _lovCache;
}
function _resetCourtCodes() { _codesCache = null; _lovCache = null; }

const _norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// „Okresní soud v Jihlavě“ / „Okresní soud Jihlava“ → { typ:'okresni', mesto:['jihlave'], cislo:null }
function _courtKey(name) {
    let n = _norm(name).replace(/\s*[–-]\s*pobock\w*.*$/, ''); // pobočka spadá pod krajský soud
    const typ = (n.match(/^(okresni|krajsky|mestsky|obvodni|vrchni|nejvyssi)/) || [])[1] || null;
    n = n.replace(/^(okresni|krajsky|mestsky|obvodni|vrchni|nejvyssi)\s+soud\s*/, '').replace(/^(v|ve|pro)\s+/, '');
    const cislo = (n.match(/\b(\d{1,2})\b/) || [])[1] || null;
    const mesto = n.replace(/\d+/g, ' ').split(/[\s-]+/).filter(t => t.length >= 2 && !['nad', 'pod', 'v', 've', 'pro'].includes(t));
    return { typ, mesto, cislo };
}

// Město z číselníku (1. pád) vs. text dokumentu (často 6. pád: Jihlava/Jihlavě, Praha/Praze,
// Brno/Brně, Most/Mostě): shoda, když se liší jen koncovkou (max. 2 znaky).
function _cityMatch(nom, word) {
    let i = 0;
    while (i < nom.length && i < word.length && nom[i] === word[i]) i++;
    return i >= Math.max(2, nom.length - 2);
}

function _matchLov(name) {
    const k = _courtKey(name);
    if (!k.typ || !k.mesto.length) return null;
    const hits = courtList().filter(c => {
        const ck = _courtKey(c.nazev);
        return ck.typ === k.typ && ck.cislo === k.cislo && ck.mesto.length === k.mesto.length &&
            ck.mesto.every((m, i) => _cityMatch(m, k.mesto[i]));
    });
    return hits.length === 1 ? hits[0].kod : null; // nejednoznačné → raději nic
}

/** Kód soudu: explicitní soudKod > ruční mapa > oficiální číselník podle názvu > null. */
function resolveCourtCode(soudKod, soudNazev) {
    if (soudKod && String(soudKod).trim()) return String(soudKod).trim();
    if (!soudNazev) return null;
    const map = _loadCourtCodes();
    const want = _norm(soudNazev);
    for (const k of Object.keys(map)) if (_norm(k) === want) return map[k];
    return _matchLov(soudNazev);
}

/**
 * Nadřízený soud pro okresní (OSJIMJI → KSJIMBM, OSPHA08 → MSPHAAB). Oficiální web
 * InfoJednání posílá u okresního soudu druhOrganizace = nadřízený + okresniSoud = OS.
 */
function parentCourtCode(code) {
    if (!/^OS/.test(String(code || ''))) return null;
    const region = String(code).slice(2, 5);
    const p = courtList().find(c => /^(KS|MS)/.test(c.kod) && c.kod.slice(2, 5) === region);
    return p ? p.kod : null;
}

/** Název soudu z textu dokumentu („Okresní soud v Jihlavě“, „Krajský soud v Brně – pobočka v Jihlavě“). */
function detectCourtName(text) {
    const m = String(text || '').match(/\b((?:Obvodní|Okresní|Městský|Krajský|Vrchní|Nejvyšší)\s+soud(?:\s+(?:v|ve|pro)\s+[A-ZÁ-Ž][\wÁ-žá-ž]*(?:\s+(?:nad|pod)\s+[A-ZÁ-Ž][\wÁ-žá-ž]*)?(?:\s+\d+)?)?(?:\s*[–-]\s*pobočk[aay]\s+v\s+[A-ZÁ-Ž][\wÁ-žá-ž]*)?)/);
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

// ── Normalizace odpovědi ────────────────────────────────────────────────────
function _isoDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.replace(/\s+/g, '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
}
function _time(v) {
    const m = String(v || '').match(/(\d{1,2})[:.](\d{2})/);
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}
const _pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };

// Sp. zn. z polí odpovědi ({cislo, druh, bcVec, rocnik}) — při hledání podle síně je
// má každá událost, při hledání podle sp. zn. je má hlavička odpovědi.
function _spisZnFrom(o) {
    if (!o || o.cislo == null || o.bcVec == null || !o.druh || o.rocnik == null) return null;
    return `${o.cislo} ${String(o.druh).trim()} ${o.bcVec}/${o.rocnik}`;
}

function normalizeResponse(json) {
    if (!json || typeof json !== 'object') return null;
    const list = Array.isArray(json) ? json : _pick(json, ['udalosti', 'jednani', 'items', 'data', 'results', 'vysledky']);
    if (!Array.isArray(list)) return null;
    // Hledání podle síně a data: datum a síň jsou v hlavičce, ne u událostí (ověřeno 3. 10. 2026).
    const headDate = Array.isArray(json) ? null : _pick(json, ['datum']);
    const headRoom = Array.isArray(json) ? null : _pick(json, ['jednaciSin']);
    const headZn = Array.isArray(json) ? null : _spisZnFrom(json);
    const events = list.map(ev => {
        const rawDate = _pick(ev, ['datum', 'datumJednani', 'date', 'datumCas', 'zacatek']) || headDate;
        // Oficiální pole je „jednaniZruseno“ (frontend InfoJednání 5/2026); „jednaciZruseno“
        // používal původní hlídač i LexisEditor — čteme obě.
        const cancelledRaw = _pick(ev, ['jednaniZruseno', 'jednaciZruseno', 'zruseno', 'cancelled', 'zrusene']);
        return {
            date: _isoDate(rawDate),
            time: _time(_pick(ev, ['cas', 'casJednani', 'time']) || rawDate),
            room: String(_pick(ev, ['jednaciSin', 'sin', 'mistnost', 'room']) || headRoom || ''),
            cancelled: cancelledRaw === true || /^(ano|true|1)$/i.test(String(cancelledRaw || '')),
            kind: _pick(ev, ['druhJednani']) || null,
            result: _pick(ev, ['vysledek']) || null,
            spisZn: _spisZnFrom(ev) || headZn || null,
            judge: _pick(ev, ['resitel']) || null,
            nonPublic: ev.neverejneJednani === true || /^(ano|true|1)$/i.test(String(ev.neverejneJednani || ''))
        };
    }).filter(e => e.date);
    return { events, court: _pick(json, ['organizace', 'soud', 'court']) || null };
}

/**
 * Dotaz na jednání ve věci. opts.fetch = injektovatelný fetch (testy, probe).
 * @returns {Promise<{ok:boolean, kind?:string, reason?:string, events?:Array, court?:string}>}
 */
async function fetchHearings({ courtCode, spisZn }, opts = {}) {
    const cfg = config();
    if (!cfg.enabled) return { ok: false, kind: 'not_configured', reason: 'Hlídání InfoJednání je vypnuté (LEXIS_INFOJEDNANI_ENABLED=0).' };
    const p = typeof spisZn === 'string' ? parseSpisZn(spisZn) : spisZn;
    if (!p) return { ok: false, kind: 'not_configured', reason: 'Neplatná spisová značka.' };
    if (!courtCode) return { ok: false, kind: 'not_configured', reason: 'Chybí kód soudu (doplňte soud ve spisu).' };
    const vars = Object.assign({ courtCode }, p);
    // Stejně jako oficiální web (Angular frontend InfoJednání, zachycený 5/2026):
    // okresní soud = druhOrganizace: nadřízený KS/MS + okresniSoud: OS; jinak jen druhOrganizace.
    const isOs = /^OS/.test(courtCode);
    vars.parentCode = isOs ? (parentCourtCode(courtCode) || '') : '';
    const body = cfg.bodyTemplate ? _fill(cfg.bodyTemplate, vars, false) : JSON.stringify({
        druhOrganizace: isOs ? (vars.parentCode || null) : courtCode,
        okresniSoud: isOs ? courtCode : null,
        cisloSenatu: p.cisloSenatu, druhVeci: p.druhVeci, bcVec: p.bcVec, rocnik: p.rocnik,
        agenda: null, typHledani: 'SPZN'
    });
    const url = _fill(opts.url || cfg.url, vars, true);
    return _request(url, cfg.method, body, opts);
}

async function _request(url, method, body, opts = {}) {
    const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return { ok: false, kind: 'unavailable', reason: 'fetch není k dispozici.' };
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ac ? setTimeout(() => ac.abort(), opts.timeoutMs || TIMEOUT_MS) : null;
    try {
        const res = await doFetch(url, method === 'GET'
            ? { method: 'GET', headers: { 'Accept': 'application/json' }, signal: ac ? ac.signal : undefined }
            : { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body, signal: ac ? ac.signal : undefined });
        if (!res.ok) return { ok: false, kind: 'unavailable', reason: `InfoJednání odpovědělo HTTP ${res.status}.` };
        // Při výpadku vrací web HTML stránku („Stránka nebyla nalezena“) s HTTP 200.
        let json = null;
        if (typeof res.text === 'function') {
            const text = await res.text();
            try { json = JSON.parse(text); } catch (e) {
                return { ok: false, kind: 'invalid_response', reason: /<html|<!doctype/i.test(text) ? 'InfoJednání vrátilo webovou stránku místo dat (výpadek nebo změna rozhraní).' : 'Odpověď InfoJednání není JSON.' };
            }
        } else {
            try { json = await res.json(); } catch (e) { return { ok: false, kind: 'invalid_response', reason: 'Odpověď InfoJednání není JSON.' }; }
        }
        const norm = normalizeResponse(json);
        if (!norm) return { ok: false, kind: 'invalid_response', reason: 'Neznámý formát odpovědi InfoJednání (změna rozhraní?).' };
        return { ok: true, events: norm.events, court: norm.court };
    } catch (e) {
        return { ok: false, kind: 'unavailable', reason: e && e.name === 'AbortError' ? 'InfoJednání neodpovědělo včas.' : `InfoJednání nedostupné (${e.message}).` };
    } finally {
        if (t) clearTimeout(t);
    }
}

// Kořen API odvozený od adresy vyhledávání (…/api/v1/jednani/vyhledej → …/api/v1).
function _apiBase() {
    const u = config().url;
    const m = String(u).match(/^(https?:\/\/[^/]+\/(?:[^{]*?\/)?api\/v\d+)\//);
    return m ? m[1] : 'https://infojednani.gov.cz/api/v1';
}

function _orgFields(courtCode) {
    const isOs = /^OS/.test(courtCode);
    const parent = isOs ? (parentCourtCode(courtCode) || null) : null;
    return { druhOrganizace: isOs ? parent : courtCode, okresniSoud: isOs ? courtCode : null };
}

/**
 * Rozpis jednání v jedné jednací síni v daný den (InfoJednání, typHledani JEDNANI —
 * ověřeno 3. 10. 2026). Každá událost nese svou sp. zn. (ev.spisZn).
 */
async function searchByRoom({ courtCode, room, date }, opts = {}) {
    const cfg = config();
    if (!cfg.enabled) return { ok: false, kind: 'not_configured', reason: 'Hlídání InfoJednání je vypnuté (LEXIS_INFOJEDNANI_ENABLED=0).' };
    if (!courtCode) return { ok: false, kind: 'not_configured', reason: 'Vyberte soud.' };
    if (!room) return { ok: false, kind: 'not_configured', reason: 'Vyberte jednací síň.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, kind: 'not_configured', reason: 'Datum ve tvaru RRRR-MM-DD.' };
    const body = JSON.stringify(Object.assign(_orgFields(courtCode), { jednaciSin: String(room), datumJednani: date, typHledani: 'JEDNANI' }));
    return _request(_apiBase() + '/jednani/vyhledej', 'POST', body, opts);
}

/** Seznam jednacích síní soudu (číselník InfoJednání). → { ok, rooms:[názvy] } */
async function fetchRooms(courtCode, opts = {}) {
    if (!courtCode || !/^[A-Z0-9]{5,10}$/.test(courtCode)) return { ok: false, kind: 'not_configured', reason: 'Neplatný kód soudu.' };
    const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return { ok: false, kind: 'unavailable', reason: 'fetch není k dispozici.' };
    try {
        const res = await doFetch(_apiBase() + '/organizace/lovkod/jednaci-sin?idOrganizace=' + encodeURIComponent(courtCode), { method: 'GET', headers: { 'Accept': 'application/json' } });
        if (!res.ok) return { ok: false, kind: 'unavailable', reason: `InfoJednání odpovědělo HTTP ${res.status}.` };
        const j = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
        if (!Array.isArray(j)) return { ok: false, kind: 'invalid_response', reason: 'Neznámý formát číselníku síní.' };
        return { ok: true, rooms: j.map(r => (r && (r.kod || r.nazev)) || (typeof r === 'string' ? r : null)).filter(Boolean) };
    } catch (e) {
        return { ok: false, kind: 'unavailable', reason: `InfoJednání nedostupné (${e.message}).` };
    }
}

/** Porovnatelný klíč sp. zn.: „6 P a Nc 53/2026“ ≡ „6 P A NC 53/2026“ ≡ „6PANC53/2026“. */
function spisZnKey(zn) {
    const p = typeof zn === 'string' ? parseSpisZn(zn) : zn;
    return p ? `${p.cisloSenatu}|${String(p.druhVeci).toUpperCase().replace(/\s+/g, '')}|${p.bcVec}|${p.rocnik}` : null;
}

module.exports = {
    searchByRoom, fetchRooms, spisZnKey,
    fetchHearings, normalizeResponse, parseSpisZn, formatSpisZn,
    resolveCourtCode, parentCourtCode, courtList, detectCourtName, config, DEFAULT_URL, _resetCourtCodes
};
