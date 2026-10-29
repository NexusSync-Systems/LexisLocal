/**
 * lib/aws_billing.js — večerní porovnání odhadu LexisLocal se skutečnou fakturací AWS.
 *
 * Cost Explorer (GetCostAndUsage, endpoint ce.us-east-1 — služba je globální, vrací jen částky,
 * žádný obsah dotazů): náklady Bedrocku/Claude po dnech za aktuální měsíc do VČERA (dnešek AWS
 * ještě nemá kompletní; celý měsíc se při každé synchronizaci přepočítá, takže pozdní doúčtování
 * se samo srovná). Výsledek: potvrzená částka AWS, odhad LexisLocal za stejné dny, rozdíl.
 * Dny potvrzené AWS pak dashboard ukazuje podle AWS (lib/ai_usage.souhrn).
 *
 * Cena: AWS účtuje cca 0,01 USD za dotaz na Cost Explorer API (1–2 dotazy na synchronizaci).
 * Oprávnění (scripts/aws/bedrock-eu-kancelar.yaml): ce:GetCostAndUsage. Cost Explorer musí být
 * v účtu zapnutý (konzole Billing → Cost Explorer; data do 24 h).
 * Částky BEZ odečtu kreditů (RECORD_TYPE=Usage) — porovnává se spotřeba, ne zůstatek kreditů.
 */
'use strict';

const db = require('./database');

const HOST = 'ce.us-east-1.amazonaws.com';
const SLUZBY = /bedrock|claude|anthropic/i; // názvy služeb, pod kterými AWS účtuje Claude v Bedrocku

function _round(n, d = 4) { const f = Math.pow(10, d); return Math.round((Number(n) || 0) * f) / f; }
function _addDays(den, n) { const d = new Date(den + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/** Období k porovnání: od 1. dne měsíce do dneška (exkluzivně). 1. den v měsíci → celý minulý měsíc. */
function obdobi(now) {
    const dnes = (now || new Date()).toISOString().slice(0, 10);
    let od = dnes.slice(0, 7) + '-01';
    if (od === dnes) od = _addDays(dnes, -1).slice(0, 7) + '-01';
    return { od, do: dnes, mesic: od.slice(0, 7) };
}

async function _ce(target, payload, creds) {
    const B = require('./bedrock');
    const body = JSON.stringify(payload);
    const s = B.sign({ method: 'POST', host: HOST, pathSegments: [], headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSInsightsIndexService.' + target }, body, service: 'ce', region: 'us-east-1', creds });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), parseInt(process.env.AWS_BILLING_TIMEOUT_MS || '30000', 10));
    let res;
    try { res = await fetch(`https://${HOST}/`, { method: 'POST', headers: s.headers, body, signal: ctl.signal }); }
    finally { clearTimeout(t); }
    const text = await res.text();
    if (!res.ok) {
        let msg = text.slice(0, 300);
        try { const j = JSON.parse(text); msg = (j.__type ? String(j.__type).split('#').pop() + ': ' : '') + (j.message || j.Message || ''); } catch (e) { /* text */ }
        if (/AccessDenied/i.test(msg)) msg += ' — doplňte oprávnění ce:GetCostAndUsage (šablona bedrock-eu-kancelar.yaml).';
        if (/DataUnavailable/i.test(msg)) msg += ' — zapněte Cost Explorer v konzoli AWS Billing (data do 24 h).';
        const e = new Error('AWS Cost Explorer: ' + msg); e.status = res.status; throw e;
    }
    return JSON.parse(text);
}

/** Náklady Bedrocku/Claude po dnech: { dny: {YYYY-MM-DD: usd}, celkem, sluzby: [{nazev, usd}] }. */
async function nakladyAws(od, doEx, opts) {
    opts = opts || {};
    const creds = opts.creds || await require('./bedrock').credentialsAsync();
    const dny = {}; const sluzby = new Map(); const vsechny = new Set();
    let token, pages = 0;
    do {
        const payload = {
            TimePeriod: { Start: od, End: doEx }, Granularity: 'DAILY', Metrics: ['UnblendedCost'],
            Filter: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Usage'] } },
            GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }]
        };
        if (token) payload.NextPageToken = token;
        const r = await _ce('GetCostAndUsage', payload, creds);
        for (const per of (r.ResultsByTime || [])) {
            const den = per.TimePeriod && per.TimePeriod.Start;
            for (const g of (per.Groups || [])) {
                const nazev = (g.Keys || [])[0] || '';
                vsechny.add(nazev);
                if (!SLUZBY.test(nazev)) continue;
                const usd = parseFloat(((g.Metrics || {}).UnblendedCost || {}).Amount || '0') || 0;
                dny[den] = (dny[den] || 0) + usd;
                sluzby.set(nazev, (sluzby.get(nazev) || 0) + usd);
            }
        }
        token = r.NextPageToken; pages++;
    } while (token && pages < 10);
    const celkem = Object.values(dny).reduce((a, b) => a + b, 0);
    return { dny: Object.fromEntries(Object.entries(dny).map(([k, v]) => [k, _round(v, 6)])), celkem: _round(celkem, 6), sluzby: [...sluzby.entries()].map(([nazev, usd]) => ({ nazev, usd: _round(usd, 4) })).sort((a, b) => b.usd - a.usd), vsechnySluzby: [...vsechny].sort() };
}

/**
 * Synchronizace: stáhne náklady z AWS, porovná s odhadem LexisLocal za stejné dny a uloží.
 * Vrací uložený záznam (i při chybě — se stavem 'chyba' a textem chyby).
 */
async function synchronizuj(opts) {
    opts = opts || {};
    const usage = require('./ai_usage');
    const per = obdobi(opts.now);
    const kdy = (opts.now || new Date()).toISOString();
    const odhadUsd = _round((db.get('ai_usage') || [])
        .filter(r => r.den >= per.od && r.den < per.do && r.odhadUsd != null)
        .reduce((a, r) => a + r.odhadUsd, 0), 6);
    let zaznam;
    if (per.od >= per.do) {
        zaznam = { kdy, mesic: per.mesic, obdobiOd: per.od, obdobiDo: per.do, stav: 'nic_k_porovnani', awsUsd: 0, odhadUsd: 0, rozdilUsd: 0, rozdilPct: 0, awsDny: {} };
    } else {
        try {
            const aws = await nakladyAws(per.od, per.do, opts);
            const rozdilUsd = _round(aws.celkem - odhadUsd, 4);
            const rozdilPct = odhadUsd > 0 ? _round(rozdilUsd / odhadUsd * 100, 1) : (aws.celkem > 0 ? 100 : 0);
            const tol = usage.nastaveni().tolerancePct;
            const stav = (Math.abs(rozdilPct) <= tol || Math.abs(rozdilUsd) < 0.5) ? 'sedi' : 'rozdil';
            zaznam = { kdy, mesic: per.mesic, obdobiOd: per.od, obdobiDo: per.do, stav, awsUsd: _round(aws.celkem, 4), odhadUsd: _round(odhadUsd, 4), rozdilUsd, rozdilPct, awsDny: aws.dny, sluzby: aws.sluzby };
        } catch (e) {
            zaznam = { kdy, mesic: per.mesic, obdobiOd: per.od, obdobiDo: per.do, stav: 'chyba', chyba: e.message };
        }
    }
    const saved = db.insert('ai_billing_sync', zaznam);
    // Držet jen posledních 90 záznamů.
    const all = db.get('ai_billing_sync') || [];
    if (all.length > 90) db.set('ai_billing_sync', all.slice(-90));
    try {
        const op = zaznam.stav === 'chyba' ? 'Porovnání s AWS selhalo' : zaznam.stav === 'rozdil' ? 'Porovnání s AWS: odhad nesedí' : 'Porovnání s AWS: v pořádku';
        require('./audit').logEvent('Cloud AI', op, `${per.od} – ${per.do}`, { awsUsd: zaznam.awsUsd, odhadUsd: zaznam.odhadUsd, rozdilPct: zaznam.rozdilPct, chyba: zaznam.chyba || null });
    } catch (e) { /* audit best-effort */ }
    if (zaznam.stav === 'rozdil') {
        console.warn(`⚠️ AI náklady: odhad ${zaznam.odhadUsd} USD vs. AWS ${zaznam.awsUsd} USD (${zaznam.rozdilPct} %) — zkontrolujte ceník v Manažerském přehledu.`);
    }
    return saved;
}

/** Má smysl synchronizovat? (Bedrock nastavený a nevypnuté LEXIS_AWS_BILLING_SYNC) */
function zapnuto() {
    if (String(process.env.LEXIS_AWS_BILLING_SYNC || '').trim() === '0') return false;
    return String(process.env.AI_CHAT_PROVIDER || process.env.AI_PROVIDER || '').toLowerCase() === 'bedrock';
}

/** Plánovač: jednou denně po hodině LEXIS_AWS_SYNC_HOUR (místní čas, výchozí 22). */
function spustPlanovac() {
    const hodina = parseInt(process.env.LEXIS_AWS_SYNC_HOUR || '22', 10);
    let posledniDen = null;
    const tick = () => {
        if (!zapnuto()) return;
        const now = new Date();
        const den = now.toLocaleDateString('sv-SE'); // YYYY-MM-DD v místním čase
        if (now.getHours() < hodina || posledniDen === den) return;
        posledniDen = den;
        synchronizuj().catch(err => console.error('⚠️ AI náklady: synchronizace s AWS selhala:', err.message));
    };
    const t = setInterval(tick, 10 * 60 * 1000);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
}

module.exports = { obdobi, nakladyAws, synchronizuj, zapnuto, spustPlanovac, SLUZBY };
