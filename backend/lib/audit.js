const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tamper-evident řetěz: každý záznam nese hash předchozího (jako transparency_logs
// v database.js). Dodatečná změna/smazání záznamu poruší řetěz a jde poznat.
const AUDIT_GENESIS = 'genesis_lexis_audit_ledger';
function _hashEntry(e, prevHash) {
    const c = {
        timestamp: e.timestamp,
        user: e.user,
        operation: e.operation,
        target: e.target,
        spisId: e.spisId || null,
        details: e.details || {}
    };
    // actor (kdo úkon provedl) je v řetězci jen u záznamů, které ho mají → staré záznamy dál sedí.
    if (e.actor) c.actor = e.actor;
    const canonical = JSON.stringify(c);
    return crypto.createHash('sha256').update(String(prevHash) + canonical).digest('hex');
}

// Save the audit log inside the watched dir as a hidden file for resilience and cloud syncing
const { WATCH_DIR, dataPath } = require('./config'); // jeden zdroj pravdy, viz lib/config.js
const secureCrypto = require('./secure_crypto'); // audit log je compliance artefakt → šifrovaný (GCM)
const AUDIT_LOG_FILE = dataPath('.audit_log.json'); // technická data mimo spisovnu (DATA_DIR)

// Klíč se řeší přes secure_crypto (stejný jako DB, mimo WATCH_DIR). Líně, aby se
// nezakládal soubor klíče při pouhém importu modulu.
let _auditKey = null;
function getKey() {
    if (!_auditKey) _auditKey = secureCrypto.resolveKey();
    return _auditKey;
}

/**
 * Load all audit logs (šifrované GCM; legacy plaintext se stále přečte a přemigruje).
 */
function loadAuditLogs() {
    try {
        if (!fs.existsSync(AUDIT_LOG_FILE)) {
            return [];
        }
        const raw = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        // Legacy: soubor je přímo pole záznamů v plaintextu.
        if (Array.isArray(parsed)) return parsed;
        // Nový formát: šifrovaný payload { v, iv, tag, data }.
        return JSON.parse(secureCrypto.decrypt(getKey(), parsed));
    } catch (e) {
        console.error("❌ Nepodařilo se načíst auditní log:", e.message);
        return [];
    }
}

function _logCap() {
    const n = parseInt(process.env.AUDIT_LOG_CAP, 10);
    return Number.isFinite(n) && n >= 10 ? n : 1000;
}
function _archiveDir() { return dataPath('.audit_archiv'); }

// Zapíše záznamy jako samostatný šifrovaný segment archivu. Vyhodí při chybě —
// saveAuditLogs pak NEořízne aktivní log (raději větší soubor než ztráta historie).
function _archiveSegment(entries, prefix) {
    if (!entries || !entries.length) return null;
    const dir = _archiveDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = `${prefix}_${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(3).toString('hex')}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify(secureCrypto.encrypt(getKey(), JSON.stringify(entries))), 'utf-8');
    _archiveCache = null;
    return name;
}

// Archivní segmenty jsou neměnné → cache podle seznamu souborů.
let _archiveCache = null;
function loadArchivedLogs() {
    const dir = _archiveDir();
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /\.json$/.test(n)).sort(); } catch (e) { return []; }
    const key = names.join('|');
    if (_archiveCache && _archiveCache.key === key) return _archiveCache.logs;
    const out = [];
    for (const n of names) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8'));
            const arr = Array.isArray(parsed) ? parsed : JSON.parse(secureCrypto.decrypt(getKey(), parsed));
            if (Array.isArray(arr)) arr.forEach(e => out.push(Object.assign({}, e, { archived: n })));
        } catch (e) {
            console.error(`❌ Audit: archivní segment ${n} nelze přečíst:`, e.message);
        }
    }
    _archiveCache = { key, logs: out };
    return out;
}

/** Celá historie: archiv + aktivní log, bez duplicit (podle id), od nejstaršího. */
function loadAllAuditLogs() {
    const seen = new Set();
    const all = [];
    for (const e of loadArchivedLogs().concat(loadAuditLogs())) {
        if (!e) continue;
        const k = e.id || (e.timestamp + '|' + e.hash);
        if (seen.has(k)) continue;
        seen.add(k);
        all.push(e);
    }
    return all.sort((x, y) => String(x.timestamp || '').localeCompare(String(y.timestamp || '')));
}

/**
 * Save audit logs (vždy šifrovaně).
 */
function saveAuditLogs(logs) {
    try {
        // Aktivní log drží posledních AUDIT_LOG_CAP (1000) záznamů. Nález 14. 10. 2026:
        // starší se dřív TIŠE zahazovaly (slice(-1000)) → historie spisu mizela. Teď se
        // přebytek odloží do šifrovaného archivního segmentu (.audit_archiv/rollover_*.json)
        // a getLogsForSpis/export ho čtou dál. Segmenty jsou souvislé → řetěz hashů pokračuje.
        // Odkládá se po dávkách (cap + 20 %), ne po jednom záznamu → málo velkých segmentů.
        const cap = _logCap();
        let cappedLogs = logs;
        if (logs.length > cap + Math.max(50, Math.floor(cap / 5))) {
            try {
                _archiveSegment(logs.slice(0, logs.length - cap), 'rollover');
                cappedLogs = logs.slice(-cap);
            } catch (archErr) {
                console.error('❌ Audit: archivace přebytku selhala, aktivní log se neořezává:', archErr.message);
            }
        }
        const payload = JSON.stringify(secureCrypto.encrypt(getKey(), JSON.stringify(cappedLogs)));
        fs.writeFileSync(AUDIT_LOG_FILE, payload, 'utf-8');
    } catch (e) {
        console.error("❌ Nepodařilo se uložit auditní log:", e.message);
    }
}

/**
 * Log a new audit event
 * @param {string} user - e.g. "LexisEditor" or "LexisLocal Dashboard"
 * @param {string} operation - e.g. "OCR", "RAG Search", "AI Agent (Rešeršník)", "Swarm Debata"
 * @param {string} target - e.g. "spis_sp_zn_12C.txt"
 * @param {object} details - e.g. { characters: 1200, durationMs: 450, model: "llama3" }
 */
function logEvent(user, operation, target, details = {}) {
    try {
        const logs = loadAuditLogs();
        const last = logs.length ? logs[logs.length - 1] : null;
        const prevHash = (last && last.hash) ? last.hash : AUDIT_GENESIS;
        const newEvent = {
            id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
            timestamp: new Date().toISOString(),
            user: user || 'Systém',
            operation: operation,
            target: target || 'Všeobecné',
            // spisId povýšen na top-level → auditní stopu lze filtrovat na jeden spis.
            spisId: (details && details.spisId) || null,
            details: details
        };
        // Skutečný člověk/zařízení za úkonem (z kontextu HTTP požadavku); mimo požadavek nic.
        try {
            const actor = require('./request_context').currentActor();
            if (actor) newEvent.actor = actor;
        } catch (e) { /* kontext nedostupný */ }
        newEvent.prevHash = prevHash;
        newEvent.hash = _hashEntry(newEvent, prevHash);
        logs.push(newEvent);
        saveAuditLogs(logs);
        console.log(`📜 Audit: Zaznamenán úkon [${operation}] pro [${target}]`);
    } catch (e) {
        console.error("❌ Chyba logování:", e.message);
    }
}

/**
 * Vyčistí auditní log (zapíše prázdné pole). Používá stejnou cestu jako zápis,
 * takže se nikdy nesmaže jiný soubor kvůli odlišnému výpočtu WATCH_DIR.
 */
function clearAuditLogs() {
    try {
        // Auditní log je compliance artefakt — před vyprázdněním se celý (šifrovaný)
        // soubor odloží do archivu, nic se nemaže natrvalo (UX kontrola 5. 10. 2026).
        let archive = null;
        if (fs.existsSync(AUDIT_LOG_FILE)) {
            const dir = dataPath('.audit_archiv');
            fs.mkdirSync(dir, { recursive: true });
            archive = path.join(dir, `audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
            fs.copyFileSync(AUDIT_LOG_FILE, archive);
            _archiveCache = null;
        }
        saveAuditLogs([]); // zapíše prázdný (šifrovaný) log
        return archive ? path.basename(archive) : true;
    } catch (e) {
        console.error("❌ Nepodařilo se vyčistit auditní log:", e.message);
        return false;
    }
}

/**
 * Auditní stopa JEDNOHO spisu. Bere top-level spisId (nové záznamy) a pro
 * zpětnou kompatibilitu i details.spisId (starší záznamy). Seřazeno od nejstaršího.
 */
function getLogsForSpis(spisId) {
    if (!spisId) return [];
    return loadAllAuditLogs()
        .filter(e => e && (e.spisId === spisId || (e.details && e.details.spisId === spisId)))
        .sort((x, y) => String(x.timestamp || '').localeCompare(String(y.timestamp || '')));
}

/**
 * Ověří integritu auditního řetězu. Detekuje změnu obsahu záznamu (nesedí hash)
 * i porušení návaznosti (nesedí prevHash). Odolné vůči ořezu logu na 1000 položek:
 * první zachovaný záznam se bere jako kotva (jeho prevHash může mířit na ořezanou
 * historii). Starší záznamy bez hashe (legacy) se počítají zvlášť, nezpůsobí chybu.
 * @returns { ok, checked, legacy, total, brokenAt?, reason? }
 */
function verifyAuditChain() {
    const logs = loadAuditLogs();
    let expectedPrev = null;
    let checked = 0, legacy = 0;
    for (let i = 0; i < logs.length; i++) {
        const e = logs[i];
        if (!e || !e.hash) { legacy++; continue; }
        const recomputed = _hashEntry(e, e.prevHash);
        if (recomputed !== e.hash) {
            return { ok: false, brokenAt: i, id: e.id || null, reason: 'content-tampered', checked, legacy };
        }
        if (expectedPrev !== null && e.prevHash !== expectedPrev) {
            return { ok: false, brokenAt: i, id: e.id || null, reason: 'chain-broken', checked, legacy };
        }
        expectedPrev = e.hash;
        checked++;
    }
    return { ok: true, checked, legacy, total: logs.length };
}

// --- Auditní stopa ČTENÍ (kdo spis/dokument otevřel, stáhl, použil v agentovi) -----
// Čtení je častější než zápisy — stejný uživatel + spis + úkon se zapíše nejvýš jednou
// za okno AUDIT_READ_WINDOW_MIN (výchozí 15 min), jinak by log (celý šifrovaně
// přepisovaný) rychle bobtnal. Výchozí: zapnuto ve firemním režimu; AUDIT_READS=1/0
// vynutí zapnutí/vypnutí (např. i pro solo).
const _readSeen = new Map();

function _readWindowMs() {
    const m = parseFloat(process.env.AUDIT_READ_WINDOW_MIN);
    return (Number.isFinite(m) && m >= 0 ? m : 15) * 60000;
}

function readLoggingEnabled() {
    if (process.env.AUDIT_READS === '0') return false;
    if (process.env.AUDIT_READS === '1') return true;
    try { return require('./access').isFirmMode(); } catch (e) { return false; }
}

/** Zaznamená čtení (deduplikovaně). Vrací true, když se záznam zapsal. */
function logRead(operation, target, spisId, details = {}) {
    if (!readLoggingEnabled()) return false;
    let actor = null;
    try { actor = require('./request_context').currentActor(); } catch (e) { /* mimo požadavek */ }
    const who = actor ? `${actor.kind}:${actor.id}` : 'system';
    const key = `${who}|${spisId || target}|${operation}`;
    const now = Date.now();
    const win = _readWindowMs();
    const last = _readSeen.get(key);
    if (last !== undefined && now - last < win) return false;
    _readSeen.set(key, now);
    if (_readSeen.size > 5000) {
        for (const [k, t] of _readSeen) { if (now - t >= win) _readSeen.delete(k); }
    }
    logEvent((actor && actor.name) || 'Systém', operation, target, Object.assign({}, details, { spisId: spisId || null, access: 'read' }));
    return true;
}

function _resetReadDedup() { _readSeen.clear(); }

module.exports = {
    loadAllAuditLogs,
    loadArchivedLogs,
    logRead,
    readLoggingEnabled,
    _resetReadDedup,
    loadAuditLogs,
    logEvent,
    getLogsForSpis,
    verifyAuditChain,
    clearAuditLogs
};
