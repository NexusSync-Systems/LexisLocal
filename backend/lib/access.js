/**
 * access.js — řízení přístupu ke spisu (ACL) a sdílení mezi kolegy.
 *
 * Návaznost na principal.js: identita volajícího = principal { userId, scopes }.
 * Solo režim (výchozí): jeden implicitní uživatel s plnými právy → přístup se
 * NEOMEZUJE, nic se pro dnešního uživatele nemění. Firemní režim (přepínač):
 * přístup ke spisu se vynucuje podle ACL, FAIL-CLOSED — kdo nemá záznam, nevidí.
 *
 * ACL spisu: { owner, readers[], writers[] }
 *   • owner   = vlastník (odpovědný advokát); má vždy plný přístup,
 *   • writers = smí číst i zapisovat (write implikuje read),
 *   • readers = smí jen číst.
 * Sdílení = přidání userId do readers/writers konkrétního spisu (grant/revoke).
 */
'use strict';

const principalLib = require('./principal');
const _nm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function _sameName(a, b) { return !!_nm(a) && _nm(a) === _nm(b); }

// --- Firemní vs. solo režim -------------------------------------------------
// Výchozí = solo (neomezuje). Zapnout přes env LEXIS_FIRM_MODE=1 nebo setFirmMode().
let _firmModeOverride = null;
// Pořadí: přepnutí za běhu (testy) → env LEXIS_FIRM_MODE → uložené nastavení (dashboard).
let _cache = { at: 0, val: false };
function _persisted() {
    const now = Date.now();
    if (now - _cache.at < 2000) return _cache.val;
    let v = false;
    try { v = !!require('./config').readSettings().firmMode; } catch (e) { v = false; }
    _cache = { at: now, val: v };
    return v;
}
function isFirmMode() {
    if (_firmModeOverride !== null) return _firmModeOverride;
    const v = process.env.LEXIS_FIRM_MODE;
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
    return _persisted();
}
function firmModeSource() {
    if (_firmModeOverride !== null) return 'runtime';
    const v = process.env.LEXIS_FIRM_MODE;
    if (v === '1' || v === 'true' || v === '0' || v === 'false') return 'env';
    return 'setting';
}
/** Uloží volbu firemního režimu (dashboard). Env LEXIS_FIRM_MODE má dál přednost. */
function persistFirmMode(enabled) {
    const config = require('./config');
    const st = config.readSettings();
    st.firmMode = !!enabled;
    config.writeSettings(st);
    _cache = { at: 0, val: false };
    return isFirmMode();
}
function setFirmMode(v) { _firmModeOverride = (v == null ? null : !!v); }

// --- ACL --------------------------------------------------------------------
function normalizeAccess(spis) {
    const a = (spis && spis.access) || {};
    return {
        owner: a.owner || (spis && spis.odpovednyAdvokat) || 'local',
        readers: Array.isArray(a.readers) ? a.readers.slice() : [],
        writers: Array.isArray(a.writers) ? a.writers.slice() : []
    };
}

/**
 * Smí principal na spis na dané úrovni? level: 'read' | 'write' | 'admin'.
 * Solo režim → vždy true. Firemní režim → fail-closed dle ACL.
 */
function canAccess(spis, principal, level) {
    if (!isFirmMode()) return true;               // solo: neomezeno
    if (!spis) return false;                       // fail-closed
    if (!principal || !principal.userId) return false;
    if (principalLib.hasScope(principal, 'admin')) return true; // místní správce
    const acl = normalizeAccess(spis);
    const uid = principal.userId;
    if (uid === acl.owner) return true;
    // Starší spisy mají vlastníka jako jméno advokáta (text) — uživatel se stejným jménem je vlastník.
    if (principal.kind === 'user' && principal.name && _sameName(principal.name, acl.owner)) return true;
    if (level === 'read') return acl.readers.indexOf(uid) !== -1 || acl.writers.indexOf(uid) !== -1;
    if (level === 'write') return acl.writers.indexOf(uid) !== -1;
    return false;                                  // 'admin' i cokoli jiného: fail-closed
}

/**
 * Udělení přístupu kolegovi. Vrací nový access objekt (uloží ho volající/spisy.js).
 * write implikuje read (nebude ve writers i readers zároveň). Owner se neduplikuje.
 */
function grant(spis, userId, level) {
    if (!userId) throw new Error('grant: chybí userId příjemce.');
    const acl = normalizeAccess(spis);
    if (userId === acl.owner) return acl;          // owner už má vše
    if (level === 'write') {
        if (acl.writers.indexOf(userId) === -1) acl.writers.push(userId);
        acl.readers = acl.readers.filter(u => u !== userId);
    } else { // 'read'
        if (acl.writers.indexOf(userId) === -1 && acl.readers.indexOf(userId) === -1) {
            acl.readers.push(userId);
        }
    }
    return acl;
}

/** Odebrání přístupu. Owner se odebrat nedá (musí se změnit vlastník zvlášť). */
function revoke(spis, userId) {
    const acl = normalizeAccess(spis);
    if (userId === acl.owner) throw new Error('revoke: nelze odebrat přístup vlastníkovi spisu.');
    acl.readers = acl.readers.filter(u => u !== userId);
    acl.writers = acl.writers.filter(u => u !== userId);
    return acl;
}

module.exports = {
    firmModeSource, persistFirmMode, isFirmMode, setFirmMode, canAccess, grant, revoke, normalizeAccess };
