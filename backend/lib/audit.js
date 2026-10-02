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

/**
 * Save audit logs (vždy šifrovaně).
 */
function saveAuditLogs(logs) {
    try {
        // Keep logs capped at 1000 items to prevent huge file sizes, ordered from oldest to newest
        const cappedLogs = logs.slice(-1000);
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
        saveAuditLogs([]); // zapíše prázdný (šifrovaný) log
        return true;
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
    return loadAuditLogs()
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

module.exports = {
    loadAuditLogs,
    logEvent,
    getLogsForSpis,
    verifyAuditChain,
    clearAuditLogs
};
