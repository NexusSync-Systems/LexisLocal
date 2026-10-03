/**
 * lib/isds_inbox.js — příjem doručených zpráv z DATOVÉ SCHRÁNKY (ISDS) a import .zfo.
 *
 * Tok: GetListOfReceivedMessages → pro každou novou zprávu SignedMessageDownload (.zfo,
 * právně platná podoba, archivuje se) + MessageDownload (přílohy) → přílohy se uloží do
 * spisovny (datova-schranka/<datum>_<dmID>/) a zpracují běžnou cestou (processDocument)
 * s datem DORUČENÍ z ISDS. Lhůta tak běží od skutečného doručení, ne od data v textu.
 *
 * Doručení (§ 17 zák. č. 300/2008 Sb.): přihlášením oprávněné osoby, nebo fikcí 10. dnem
 * od dodání. POZOR: přihlášení serveru účtem s právem číst zprávy = přihlášení oprávněné
 * osoby → zprávy se tím DORUČÍ. Proto je stahování vypnuté, dokud ho kancelář výslovně
 * nezapne (nastavení registry_isds_inbox = "1" nebo ISDS_INBOX=1).
 *
 * Rozhraní ISDS (provozní řád ISDS, WS v20, SOAP 1.1, basic auth jméno+heslo):
 *   <základ>/DS/dz  dm_info:        GetListOfReceivedMessages
 *   <základ>/DS/dx  dm_operations:  MessageDownload, SignedMessageDownload
 *   Produkce https://ws1.mojedatovaschranka.cz, test https://ws1.czebox.cz
 * ⚠ Ověřeno jen proti dokumentaci a syntetickým odpovědím — před pilotem ověřit na czebox.cz.
 *
 * Nic se nemaže ani neoznačuje (MarkMessageAsDownloaded se nevolá).
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const NS = 'http://isds.czechpoint.cz/v20';
const DEFAULT_BASE = 'https://ws1.mojedatovaschranka.cz';
const TIMEOUT_MS = parseInt(process.env.LEXIS_ISDS_TIMEOUT_MS || '', 10) || 120000;
const FIRST_RUN_DAYS = 14;
const DOC_EXTS = ['.pdf', '.txt', '.html', '.docx', '.png', '.jpg', '.jpeg', '.tif', '.tiff'];
const STATUS = {
    1: 'podána', 2: 'dostala časové razítko', 3: 'neprošla antivirem', 4: 'dodána do schránky (nedoručena)',
    5: 'doručena fikcí', 6: 'doručena přihlášením', 7: 'přečtena', 8: 'nedoručitelná', 9: 'smazána', 10: 'v datovém trezoru'
};

// ── nastavení ───────────────────────────────────────────────────────────────
function _setting(dbKey, envKey) {
    try {
        const s = (require('./database').get('settings') || []).find(x => x.key === dbKey);
        if (s && s.value != null && String(s.value).trim() !== '') return String(s.value);
    } catch (e) { /* bez databáze */ }
    return process.env[envKey] || '';
}
function config() {
    const url = _setting('registry_isds_url', 'ISDS_WS_URL');
    const m = String(url || '').match(/^(https:\/\/[^/]+)/);
    return {
        base: m ? m[1] : DEFAULT_BASE,
        login: _setting('registry_isds_login', 'ISDS_LOGIN'),
        password: _setting('registry_isds_password', 'ISDS_PASSWORD'),
        enabled: ['1', 'true', 'ano'].includes(String(_setting('registry_isds_inbox', 'ISDS_INBOX')).toLowerCase())
    };
}
function isConfigured() { const c = config(); return !!(c.login && c.password); }

// ── XML pomůcky (odpovědi ISDS mají pevný tvar; žádná závislost navíc) ──────────
const _unesc = s => String(s == null ? '' : s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const _esc = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
function _tag(xml, t) {
    const m = String(xml).match(new RegExp(`<(?:[\\w-]+:)?${t}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${t}>`));
    return m ? _unesc(m[1]).trim() : null;
}
function _blocks(xml, t) {
    const out = []; const re = new RegExp(`<(?:[\\w-]+:)?${t}(\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${t}>`, 'g'); let m;
    while ((m = re.exec(String(xml)))) out.push({ attrs: m[1] || '', body: m[2] });
    return out;
}
function _attr(attrs, name) { const m = String(attrs).match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? _unesc(m[1]) : null; }

function _status(xml) {
    const st = _blocks(xml, 'dmStatus')[0] || _blocks(xml, 'dbStatus')[0];
    const code = st ? _tag(st.body, 'dmStatusCode') || _tag(st.body, 'dbStatusCode') : null;
    const msg = st ? _tag(st.body, 'dmStatusMessage') || _tag(st.body, 'dbStatusMessage') : null;
    return { code, msg };
}

/** Datum v kalendáři ČR (Europe/Prague) z časové značky ISDS → YYYY-MM-DD. */
function pragueDate(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    if (isNaN(d)) return null;
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const g = k => (p.find(x => x.type === k) || {}).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
}

/**
 * Datum doručení pro výpočet lhůty. Přednost má čas doručení (dmAcceptanceTime —
 * přihlášením i fikcí). Zpráva jen dodaná (stav 4) ještě doručená není → odhad fikce
 * (dodání + 10 dní) s needsReview.
 */
function deliveryOf(rec) {
    const status = parseInt(rec.status, 10) || null;
    if (rec.acceptanceTime) {
        return { date: pragueDate(rec.acceptanceTime), how: status === 5 ? 'fikcí' : 'přihlášením', exact: true, status };
    }
    if (rec.deliveryTime) {
        const d = new Date(rec.deliveryTime); d.setUTCDate(d.getUTCDate() + 10);
        return { date: pragueDate(d.toISOString()), how: 'odhad fikce (dodáno ' + pragueDate(rec.deliveryTime) + ' + 10 dní)', exact: false, status };
    }
    return { date: null, how: 'neznámé', exact: false, status };
}

function _record(body) {
    return {
        dmID: _tag(body, 'dmID'),
        sender: _tag(body, 'dmSender'),
        senderBoxId: _tag(body, 'dbIDSender'),
        annotation: _tag(body, 'dmAnnotation'),
        senderRefNumber: _tag(body, 'dmSenderRefNumber'),
        senderIdent: _tag(body, 'dmSenderIdent'),
        recipientRefNumber: _tag(body, 'dmRecipientRefNumber'),
        toHands: _tag(body, 'dmToHands'),
        personalDelivery: _tag(body, 'dmPersonalDelivery') === 'true',
        status: _tag(body, 'dmMessageStatus'),
        deliveryTime: _tag(body, 'dmDeliveryTime'),
        acceptanceTime: _tag(body, 'dmAcceptanceTime')
    };
}

// ── SOAP požadavky a rozbor odpovědí ─────────────────────────────────────────
function _envelope(inner) {
    return '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
        `<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}
function buildListRequest({ from, to, offset = 1, limit = 100 }) {
    return _envelope(`<GetListOfReceivedMessages xmlns="${NS}"><dmFromTime>${_esc(from)}</dmFromTime><dmToTime>${_esc(to)}</dmToTime>` +
        `<dmRecipientOrgUnitNum xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/><dmStatusFilter>-1</dmStatusFilter>` +
        `<dmOffset>${parseInt(offset, 10)}</dmOffset><dmLimit>${parseInt(limit, 10)}</dmLimit></GetListOfReceivedMessages>`);
}
function buildDownloadRequest(dmID, signed) {
    const op = signed ? 'SignedMessageDownload' : 'MessageDownload';
    return _envelope(`<${op} xmlns="${NS}"><dmID>${_esc(String(dmID).replace(/\D/g, ''))}</dmID></${op}>`);
}

function parseList(xml) {
    const st = _status(xml);
    if (st.code && st.code !== '0000') return { ok: false, reason: `ISDS ${st.code}: ${st.msg || 'chyba'}` };
    if (!/GetListOfReceivedMessagesResponse/.test(xml)) return { ok: false, reason: 'Neznámá odpověď ISDS (seznam zpráv).' };
    return { ok: true, records: _blocks(xml, 'dmRecord').map(b => _record(b.body)).filter(r => r.dmID) };
}

/** Přílohy a metadata z odpovědi MessageDownload nebo z XML uvnitř .zfo. */
function parseMessage(xml) {
    const st = _status(xml);
    if (st.code && st.code !== '0000') return { ok: false, reason: `ISDS ${st.code}: ${st.msg || 'chyba'}` };
    const files = _blocks(xml, 'dmFile').map(b => ({
        name: _attr(b.attrs, 'dmFileDescr') || 'priloha',
        mime: _attr(b.attrs, 'dmMimeType') || '',
        metaType: _attr(b.attrs, 'dmFileMetaType') || '',
        base64: (_tag(b.body, 'dmEncodedContent') || '').replace(/\s+/g, '')
    })).filter(f => f.base64);
    if (!files.length && !_tag(xml, 'dmID')) return { ok: false, reason: 'Ve zprávě nejsou přílohy ani identifikace zprávy.' };
    return { ok: true, record: _record(xml), files };
}

function parseSigned(xml) {
    const st = _status(xml);
    if (st.code && st.code !== '0000') return { ok: false, reason: `ISDS ${st.code}: ${st.msg || 'chyba'}` };
    const b64 = (_tag(xml, 'dmSignature') || '').replace(/\s+/g, '');
    return b64 ? { ok: true, zfo: Buffer.from(b64, 'base64') } : { ok: false, reason: 'ISDS nevrátil podepsanou zprávu.' };
}

/**
 * .zfo = CMS SignedData (PKCS#7) s XML zprávy uvnitř. Najde vložený obsah (OCTET STRING,
 * i dělený) a vrátí XML. Bez ověření podpisu (to dělá ISDS / Datovka).
 */
function extractZfoXml(buf) {
    const forge = require('node-forge');
    const bin = Buffer.isBuffer(buf) ? buf.toString('binary') : String(buf);
    let found = null;
    try {
        const asn = forge.asn1.fromDer(forge.util.createBuffer(bin), { strict: false, parseAllBytes: false, decodeBitStrings: false });
        const octets = (n) => {
            if (n.type !== forge.asn1.Type.OCTETSTRING) return null;
            return n.constructed ? n.value.map(octets).join('') : n.value;
        };
        const walk = (n) => {
            if (found || !n) return;
            if (n.tagClass === forge.asn1.Class.UNIVERSAL && n.type === forge.asn1.Type.OCTETSTRING) {
                const v = octets(n);
                if (v && /^\s*(<\?xml|<)/.test(v) && /dmDm|isds\.czechpoint\.cz/.test(v)) { found = v; return; }
            }
            if (Array.isArray(n.value)) n.value.forEach(walk);
        };
        walk(asn);
    } catch (e) { /* zkusí se hrubé vyhledání */ }
    if (!found) {
        const i = bin.indexOf('<?xml'); const j = bin.lastIndexOf('Response>');
        if (i >= 0 && j > i) found = bin.slice(i, j + 'Response>'.length);
    }
    return found ? Buffer.from(found, 'binary').toString('utf8') : null;
}

// ── síť ─────────────────────────────────────────────────────────────────────
function _soap(url, xml, cfg) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
            hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST', timeout: TIMEOUT_MS,
            headers: {
                'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '""', 'Content-Length': Buffer.byteLength(xml),
                'Authorization': 'Basic ' + Buffer.from(`${cfg.login}:${cfg.password}`).toString('base64')
            }
        }, (res) => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode === 401) return reject(new Error('ISDS odmítl přihlášení (HTTP 401) — zkontrolujte jméno a heslo.'));
                if (res.statusCode >= 400 && !/Envelope/.test(body)) return reject(new Error(`HTTP ${res.statusCode}`));
                resolve(body);
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('ISDS neodpověděl včas')); });
        req.on('error', e => reject(new Error(e.message || e.code || 'chyba spojení')));
        req.write(xml); req.end();
    });
}

// ── uložení a zpracování ─────────────────────────────────────────────────────
function _safeName(name, i) {
    const base = path.basename(String(name || '')).replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').slice(0, 120);
    return base || `priloha-${i + 1}`;
}
function _metaStore() { return require('./database'); }

/** Metadata doručení k souboru v spisovně (čte watcher.processDocument). */
function metaForFile(relativePath) {
    try {
        const m = (_metaStore().get('isds_files') || []).find(x => x.relativePath === relativePath);
        return m || null;
    } catch (e) { return null; }
}

/**
 * Uloží přílohy zprávy do spisovny a zpracuje je. `opts.process` (test) nahrazuje
 * watcher.processDocument, `opts.dir` spisovnu.
 */
async function storeMessage({ record, files, zfo }, opts = {}) {
    const dir = opts.dir || require('./config').getIngestDir();
    const delivery = deliveryOf(record);
    const day = delivery.date || pragueDate(new Date().toISOString());
    const folderRel = path.join('datova-schranka', `${day}_${String(record.dmID).replace(/\D/g, '')}`);
    const folder = path.join(dir, folderRel);
    fs.mkdirSync(folder, { recursive: true });
    if (zfo) {
        const zdir = path.join(dir, '.isds-zfo'); fs.mkdirSync(zdir, { recursive: true });
        fs.writeFileSync(path.join(zdir, `${String(record.dmID).replace(/\D/g, '')}.zfo`), zfo);
    }
    const db = _metaStore();
    const processDoc = opts.process || require('./watcher').processDocument;
    const stored = [];
    const used = new Set();
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (/signature/i.test(f.metaType)) continue;
        let name = _safeName(f.name, i);
        while (used.has(name.toLowerCase())) name = `${i + 1}-${name}`;
        used.add(name.toLowerCase());
        const rel = path.join(folderRel, name);
        const meta = {
            relativePath: rel, dmID: record.dmID, sender: record.sender || null, senderBoxId: record.senderBoxId || null,
            annotation: record.annotation || null, senderRefNumber: record.senderRefNumber || null,
            recipientRefNumber: record.recipientRefNumber || null, toHands: record.toHands || null,
            deliveryDate: delivery.date, deliveryHow: delivery.how, deliveryExact: delivery.exact,
            statusText: STATUS[delivery.status] || null, mainFile: f.metaType === 'main', receivedAt: new Date().toISOString()
        };
        try { db.insert('isds_files', meta); } catch (e) { /* bez metadat se lhůta počítá z textu */ }
        fs.writeFileSync(path.join(dir, rel), Buffer.from(f.base64, 'base64'));
        const ext = path.extname(name).toLowerCase();
        let processed = null;
        if (DOC_EXTS.includes(ext)) {
            try { processed = await processDoc(path.join(dir, rel), { isds: meta }); }
            catch (e) { processed = { ok: false, reason: e.message }; }
        }
        stored.push({ file: rel, processed: processed && processed.ok === false ? processed.reason : !!DOC_EXTS.includes(ext) });
    }
    return { dmID: record.dmID, folder: folderRel, delivery, files: stored };
}

/** Import ručně staženého .zfo (Datovka, web ISDS). */
async function importZfo(buffer, opts = {}) {
    const xml = extractZfoXml(buffer);
    if (!xml) return { ok: false, reason: 'Soubor .zfo se nepodařilo rozbalit (není to datová zpráva?).' };
    if (/DeliveryInfo|dmEvents/.test(xml) && !/dmFile/.test(xml)) {
        return { ok: false, reason: 'Toto je doručenka (bez příloh). Nahrajte .zfo samotné zprávy.' };
    }
    const msg = parseMessage(xml);
    if (!msg.ok) return msg;
    if (!msg.record.dmID) msg.record.dmID = 'zfo' + Date.now();
    const done = _processedSet();
    if (done.has(String(msg.record.dmID)) && !opts.force) return { ok: true, duplicate: true, dmID: msg.record.dmID };
    const r = await storeMessage({ record: msg.record, files: msg.files, zfo: buffer }, opts);
    _markProcessed(msg.record.dmID);
    try { require('./audit').logEvent('Datová schránka', 'Import .zfo', msg.record.dmID, { sender: msg.record.sender, files: r.files.length, delivery: r.delivery.date }); } catch (e) {}
    return Object.assign({ ok: true }, r);
}

function _processedSet() {
    try { return new Set(((_metaStore().get('isds_state') || [])[0] || {}).processed || []); } catch (e) { return new Set(); }
}
function _state() { try { return (_metaStore().get('isds_state') || [])[0] || null; } catch (e) { return null; } }
function _saveState(patch) {
    const db = _metaStore();
    const cur = _state();
    if (cur) db.update('isds_state', cur.id, patch); else db.insert('isds_state', Object.assign({ processed: [] }, patch));
}
function _markProcessed(dmID) {
    const set = _processedSet(); set.add(String(dmID));
    _saveState({ processed: [...set].slice(-2000) });
}

/**
 * Jedno vyzvednutí schránky. opts.soap (test) nahrazuje síť, opts.now čas.
 * Vrací { ok, checked, downloaded, skipped, errors[] }.
 */
let _running = false;
async function pollOnce(opts = {}) {
    if (_running) return { ok: false, kind: 'busy', reason: 'Stahování z datové schránky už běží.' };
    _running = true;
    try { return await _pollOnce(opts); } finally { _running = false; }
}
async function _pollOnce(opts) {
    const cfg = opts.config || config();
    if (!cfg.login || !cfg.password) return { ok: false, kind: 'not_configured', reason: 'Chybí přihlašovací údaje do datové schránky.' };
    if (!cfg.enabled && !opts.force) return { ok: false, kind: 'disabled', reason: 'Stahování zpráv z datové schránky je vypnuté.' };
    const soap = opts.soap || ((svc, xml) => _soap(`${cfg.base}/DS/${svc}`, xml, cfg));
    const now = opts.now || new Date();
    const st = _state() || {};
    const fromD = st.lastTo ? new Date(new Date(st.lastTo).getTime() - 24 * 3600e3) : new Date(now.getTime() - FIRST_RUN_DAYS * 24 * 3600e3);
    const done = _processedSet();
    const out = { ok: true, checked: 0, downloaded: 0, skipped: 0, errors: [], messages: [] };
    let list;
    try { list = parseList(await soap('dz', buildListRequest({ from: fromD.toISOString(), to: now.toISOString() }))); }
    catch (e) { list = { ok: false, reason: e.message }; }
    if (!list.ok) {
        _saveState({ lastRunAt: now.toISOString(), lastError: list.reason });
        return { ok: false, kind: 'unavailable', reason: list.reason };
    }
    for (const rec of list.records) {
        out.checked++;
        if (done.has(String(rec.dmID))) { out.skipped++; continue; }
        try {
            const signed = parseSigned(await soap('dx', buildDownloadRequest(rec.dmID, true)));
            const msg = parseMessage(await soap('dx', buildDownloadRequest(rec.dmID, false)));
            if (!msg.ok) throw new Error(msg.reason);
            // Čas doručení se po stažení mohl změnit (přihlášení = doručení) → vezmi novější údaje.
            const record = Object.assign({}, rec, Object.fromEntries(Object.entries(msg.record).filter(([, v]) => v)));
            const r = await storeMessage({ record, files: msg.files, zfo: signed.ok ? signed.zfo : null }, opts);
            _markProcessed(rec.dmID);
            out.downloaded++;
            out.messages.push({ dmID: rec.dmID, sender: record.sender, annotation: record.annotation, delivery: r.delivery.date, how: r.delivery.how, files: r.files.length });
            try { require('./audit').logEvent('Datová schránka', 'Stažení doručené zprávy', String(rec.dmID), { sender: record.sender, delivery: r.delivery.date, how: r.delivery.how }); } catch (e) {}
        } catch (e) {
            out.errors.push({ dmID: rec.dmID, error: e.message });
        }
    }
    _saveState({ lastRunAt: now.toISOString(), lastTo: out.errors.length ? (st.lastTo || null) : now.toISOString(), lastError: out.errors.length ? out.errors.map(x => `${x.dmID}: ${x.error}`).join('; ') : null, lastResult: { checked: out.checked, downloaded: out.downloaded, errors: out.errors.length } });
    return out;
}

function status() {
    const c = config(); const s = _state() || {};
    return { configured: !!(c.login && c.password), enabled: c.enabled, base: c.base, lastRunAt: s.lastRunAt || null, lastError: s.lastError || null, lastResult: s.lastResult || null, processedCount: (s.processed || []).length };
}

function setEnabled(on) {
    const db = _metaStore();
    const list = db.get('settings') || [];
    const ex = list.find(x => x.key === 'registry_isds_inbox');
    if (ex) db.update('settings', ex.id, { value: on ? '1' : '0' }); else db.insert('settings', { key: 'registry_isds_inbox', value: on ? '1' : '0' });
}

module.exports = {
    config, isConfigured, status, setEnabled, pollOnce, importZfo, storeMessage, metaForFile,
    buildListRequest, buildDownloadRequest, parseList, parseMessage, parseSigned, extractZfoXml, deliveryOf, pragueDate, STATUS
};
