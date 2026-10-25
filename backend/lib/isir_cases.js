/**
 * lib/isir_cases.js — insolvenční řízení podle SPISOVÉ ZNAČKY (ISIR, veřejná WS MSp).
 *
 * Dosud LexisLocal lustroval ISIR jen podle IČO (lib/registries.js). Advokát ale chce hlídat
 * konkrétní řízení („KSBR 56 INS 1000/2026“) — stav (zahájeno / úpadek / konkurs /
 * oddlužení / skončeno) a jeho změny.
 *
 * Rozhraní OVĚŘENO ZA BĚHU 3. 10. 2026 (WSDL + skutečný dotaz z prohlížeče):
 *   POST https://isir.justice.cz:8443/isir_cuzk_ws/IsirWsCuzkService (SOAP 1.1, SOAPAction "")
 *   getIsirWsCuzkDataRequest { druhVec:"INS", bcVec:int, rocnik:int, maxPocetVysledku }
 *   → data[] { cisloSenatu, druhVec, bcVec, rocnik, nazevOsoby/nazevOrganizace, jmeno, ic,
 *              druhStavKonkursu, urlDetailRizeni, dalsiDluznikVRizeni, datumPmZahajeniUpadku,
 *              datumPmUkonceniUpadku }, stav { pocetVysledku, relevanceVysledku(3 = sp. zn.),
 *              casSynchronizace, kodChyby (WS2 = prázdný výsledek), textChyby }
 *   Číslo INS je celostátní (bcVec/ročník); stejné řízení může mít víc dlužníků (manželé).
 *
 * Posílá se jen spisová značka (veřejný údaj).
 */
'use strict';

const https = require('https');

const ISIR_URL = process.env.LEXIS_ISIR_WS_URL || 'https://isir.justice.cz:8443/isir_cuzk_ws/IsirWsCuzkService';
const TIMEOUT_MS = parseInt(process.env.LEXIS_ISIR_TIMEOUT_MS || '', 10) || 12000;

/** „KSBR 56 INS 1000/2026“, „56 INS 1000 / 2026“, „INS 1000/2026“, „MSPH 98 INS 12/2025-A-5“ */
function parseInsZn(str) {
    const s = String(str || '').replace(/\s+/g, ' ').trim();
    const m = s.match(/^(?:([A-Z]{2,5})\s+)?(?:(\d{1,4})\s*)?INS\s*(\d{1,7})\s*\/\s*(\d{4})/i);
    if (!m) return null;
    return { soud: m[1] ? m[1].toUpperCase() : null, cisloSenatu: m[2] || null, bcVec: m[3], rocnik: m[4] };
}

function formatInsZn(p) {
    if (!p) return '';
    return [p.soud, p.cisloSenatu, `INS ${p.bcVec}/${p.rocnik}`].filter(Boolean).join(' ');
}

function _xmlEsc(v) { return String(v).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])); }

function buildRequest({ bcVec, rocnik }) {
    return '<?xml version="1.0" encoding="utf-8"?>' +
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:typ="http://isirws.cca.cz/types/">' +
        '<soapenv:Header/><soapenv:Body><typ:getIsirWsCuzkDataRequest>' +
        `<druhVec>INS</druhVec><bcVec>${_xmlEsc(parseInt(bcVec, 10))}</bcVec><rocnik>${_xmlEsc(parseInt(rocnik, 10))}</rocnik>` +
        '<maxPocetVysledku>20</maxPocetVysledku>' +
        '</typ:getIsirWsCuzkDataRequest></soapenv:Body></soapenv:Envelope>';
}

const _unesc = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function _tag(xml, t) { const m = xml.match(new RegExp(`<(?:\\w+:)?${t}>([^<]*)</(?:\\w+:)?${t}>`)); return m ? _unesc(m[1]).trim() : null; }
const _date = v => (v ? String(v).slice(0, 10) : null);

/** Rozbor SOAP odpovědi → { ok, cases[], empty, error?, syncedAt } */
function parseResponse(xml) {
    const x = String(xml || '');
    if (!/getIsirWsCuzkDataResponse/.test(x)) {
        return { ok: false, kind: 'invalid_response', reason: /<html|<!doctype/i.test(x) ? 'ISIR vrátil webovou stránku místo dat.' : 'Neznámá odpověď ISIR.' };
    }
    const stavBlock = (x.match(/<(?:\w+:)?stav>([\s\S]*?)<\/(?:\w+:)?stav>/) || [])[1] || '';
    const kod = _tag(stavBlock, 'kodChyby');
    const syncedAt = _tag(stavBlock, 'casSynchronizace');
    if (kod === 'WS2') return { ok: true, empty: true, cases: [], syncedAt };
    if (kod) return { ok: false, kind: kod === 'WS4' ? 'stale' : 'unavailable', reason: `ISIR: ${_tag(stavBlock, 'textChyby') || kod}` };
    const cases = [];
    const re = /<(?:\w+:)?data>([\s\S]*?)<\/(?:\w+:)?data>/g; let m;
    while ((m = re.exec(x))) {
        const d = m[1];
        const osoba = [_tag(d, 'jmeno'), _tag(d, 'nazevOsoby')].filter(Boolean).join(' ');
        cases.push({
            spisZn: `${_tag(d, 'cisloSenatu')} INS ${_tag(d, 'bcVec')}/${_tag(d, 'rocnik')}`,
            cisloSenatu: _tag(d, 'cisloSenatu'),
            dluznik: _tag(d, 'nazevOrganizace') || osoba || null,
            ic: _tag(d, 'ic') || null,
            mesto: _tag(d, 'mesto') || null,
            stav: _tag(d, 'druhStavKonkursu') || null,
            zahajeni: _date(_tag(d, 'datumPmZahajeniUpadku')),
            ukonceni: _date(_tag(d, 'datumPmUkonceniUpadku')),
            dalsiDluznik: _tag(d, 'dalsiDluznikVRizeni') === 'T',
            url: _tag(d, 'urlDetailRizeni')
        });
    }
    return { ok: true, empty: cases.length === 0, cases, syncedAt };
}

function _post(xml) {
    return new Promise((resolve, reject) => {
        const u = new URL(ISIR_URL);
        const req = https.request({
            hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', timeout: TIMEOUT_MS,
            headers: { 'Content-Type': 'text/xml;charset=UTF-8', 'SOAPAction': '', 'Content-Length': Buffer.byteLength(xml) }
        }, (res) => {
            let data = ''; res.setEncoding('utf8');
            res.on('data', c => { data += c; });
            res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300) ? resolve(data) : reject(new Error(`HTTP ${res.statusCode}`)));
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('ISIR neodpověděl včas')); });
        req.on('error', reject);
        req.write(xml); req.end();
    });
}

function _errText(e) {
    if (!e) return 'neznámá chyba';
    const inner = Array.isArray(e.errors) && e.errors.length ? e.errors.map(x => x.code || x.message).filter(Boolean).join(', ') : '';
    return e.message || inner || e.code || e.name || 'neznámá chyba';
}

/**
 * Insolvenční řízení podle sp. zn. opts.post = injektovatelné odeslání (testy).
 * Když zadání obsahuje číslo senátu, vrátí jen řízení s tímto senátem.
 */
async function fetchInsCase(spisZn, opts = {}) {
    const p = typeof spisZn === 'string' ? parseInsZn(spisZn) : spisZn;
    if (!p) return { ok: false, kind: 'not_configured', reason: 'Spisová značka insolvenčního řízení ve tvaru „KSBR 56 INS 1000/2026“ nebo „INS 1000/2026“.' };
    // Server test 3. 10. 2026 (AWS): první spojení na :8443 občas selže prázdnou chybou
    // (AggregateError z výběru IPv4/IPv6), hned další dotaz projde → jeden opakovaný pokus.
    let xml, lastErr;
    for (let attempt = 0; attempt < 2 && xml === undefined; attempt++) {
        try { xml = await (opts.post || _post)(buildRequest(p)); }
        catch (e) {
            lastErr = e;
            if (/^HTTP 4/.test(String(e && e.message))) break;
            if (attempt === 0) await new Promise(r => setTimeout(r, opts.retryDelayMs != null ? opts.retryDelayMs : 1000));
        }
    }
    if (xml === undefined) return { ok: false, kind: 'unavailable', reason: `ISIR nedostupný (${_errText(lastErr)}).` };
    const r = parseResponse(xml);
    if (r.ok && p.cisloSenatu) r.cases = r.cases.filter(c => !c.cisloSenatu || c.cisloSenatu === String(parseInt(p.cisloSenatu, 10)));
    if (r.ok) r.empty = r.cases.length === 0;
    return Object.assign(r, { query: formatInsZn(p) });
}

/** Klíč pro porovnání se spisem: „1000/2026“ (číslo INS je celostátní, senát se nepoužívá). */
function insKey(zn) {
    const p = typeof zn === 'string' ? parseInsZn(zn) : zn;
    return p ? `${p.bcVec}/${p.rocnik}` : null;
}

/**
 * Hlídač: projde aktivní spisy s INS sp. zn. (pole spisZn nebo insZn) a při změně stavu
 * řízení založí upozornění. Stav ukládá do spisu (isirStav, isirCheckedAt, isirError).
 */
async function checkInsolvencySpisy(opts = {}) {
    const db = require('./database');
    let list = [];
    try { list = require('./spisy').listSpisy(); } catch (e) { list = db.get('spisy') || []; }
    const active = list.filter(s => (s.stav || 'aktivni') === 'aktivni' && parseInsZn(s.insZn || s.spisZn));
    let checked = 0, changed = 0, failed = 0;
    for (const s of active) {
        const zn = s.insZn || s.spisZn;
        const r = await fetchInsCase(zn, opts);
        checked++;
        const now = (opts.now || new Date()).toISOString();
        if (!r.ok) { failed++; try { db.update('spisy', s.id, { isirCheckedAt: now, isirError: r.reason }); } catch (e) {} continue; }
        const stav = r.empty ? 'nenalezeno' : [...new Set(r.cases.map(c => c.stav).filter(Boolean))].join(', ') || 'neuvedeno';
        if (s.isirStav && s.isirStav !== stav) {
            changed++;
            try {
                db.insert('alerts', {
                    title: `⚖️ ISIR: změna stavu řízení ${zn}: ${s.isirStav} → ${stav}`,
                    status: 'pending', triggerRule: 'Hlídač insolvenčních řízení', deadline: null,
                    advokat: s.odpovednyAdvokat || null, kind: 'isir_change',
                    payloadDetails: JSON.stringify({ spisId: s.id, spisZn: zn, previous: s.isirStav, current: stav, url: (r.cases[0] || {}).url || null })
                });
            } catch (e) { /* upozornění je best-effort */ }
        }
        try { db.update('spisy', s.id, { isirStav: stav, isirCheckedAt: now, isirError: null }); } catch (e) {}
    }
    return { checked, changed, failed };
}

module.exports = { parseInsZn, formatInsZn, buildRequest, parseResponse, fetchInsCase, insKey, checkInsolvencySpisy, ISIR_URL };
