'use strict';
/**
 * users.js — uživatelé kanceláře (per-user identita).
 *
 * Každý člověk má vlastní účet s rolí a JEDEN NEBO VÍC tokenů — jeden na zařízení
 * (LexisEditor, telefon, prohlížeč). Zařízení jde zrušit samostatně (ztracený telefon),
 * aniž by se odhlásila ostatní. Tokeny se ukládají jen jako SHA-256 hash (jsou
 * vysoko-entropické náhodné → hash bez soli stačí), mimo WATCH_DIR
 * (secure_crypto.resolveKeyDir()), stejně jako tokeny agentů.
 *
 * Role → oprávnění (scopes):
 *   spravce    read, write, approve, admin   (správa uživatelů, nastavení serveru)
 *   advokat    read, write, approve          (smí schvalovat výstupy / koncepty)
 *   koncipient read, write                   (připravuje, schvaluje advokát)
 *   asistent   read, write
 *   ctenar     read                          (jen nahlížení)
 *
 * Uživatel se nemaže, jen deaktivuje — jméno musí zůstat dohledatelné v auditu.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const secureCrypto = require('./secure_crypto');

const ROLES = {
    spravce: { label: 'Správce', scopes: ['read', 'write', 'approve', 'admin'] },
    advokat: { label: 'Advokát', scopes: ['read', 'write', 'approve'] },
    koncipient: { label: 'Koncipient', scopes: ['read', 'write'] },
    asistent: { label: 'Asistent/ka', scopes: ['read', 'write'] },
    ctenar: { label: 'Jen čtení', scopes: ['read'] }
};
const TOKEN_PREFIX = 'llu_';
const MAX_DEVICES = 20;
const LAST_USED_PERSIST_MS = 5 * 60 * 1000;

function usersFile() { return path.join(secureCrypto.resolveKeyDir(), 'users.json'); }

let _cache = null;
function loadRaw() {
    if (_cache) return _cache;
    try {
        const f = usersFile();
        if (fs.existsSync(f)) {
            const data = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (Array.isArray(data)) { _cache = data; return _cache; }
        }
    } catch (e) {
        console.error('⚠️ Nelze načíst users.json:', e.message);
    }
    _cache = [];
    return _cache;
}
function saveRaw(list) {
    const dir = secureCrypto.resolveKeyDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = usersFile();
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, f);
    _cache = list;
}
function _resetCache() { _cache = null; }

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const _norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

class UserError extends Error {
    constructor(msg, status) { super(msg); this.status = status || 400; }
}

function _cleanName(name) {
    const n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim();
    if (n.length < 2) throw new UserError('Jméno uživatele je povinné (aspoň 2 znaky).');
    if (n.length > 80) throw new UserError('Jméno je příliš dlouhé (max. 80 znaků).');
    return n;
}
function _cleanLabel(label) {
    return String(label || 'Zařízení').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Zařízení';
}
function _checkRole(role) {
    if (!ROLES[role]) throw new UserError('Neznámá role. Povolené: ' + Object.keys(ROLES).join(', ') + '.');
    return role;
}

/** Veřejný pohled (bez hashů). */
function view(u) {
    if (!u) return null;
    return {
        id: u.id, name: u.name, role: u.role, roleLabel: (ROLES[u.role] || {}).label || u.role,
        scopes: scopesOf(u), disabled: !!u.disabled, createdAt: u.createdAt, createdBy: u.createdBy || null,
        devices: (u.tokens || []).map(t => ({ id: t.id, label: t.label, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null }))
    };
}
function scopesOf(u) { return ((ROLES[u && u.role] || {}).scopes || []).slice(); }

function listUsers() { return loadRaw().map(view); }
function getUser(id) { return view(loadRaw().find(u => u.id === id)); }

function _newToken() { return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex'); }
function _addDevice(u, label) {
    if ((u.tokens || []).length >= MAX_DEVICES) throw new UserError(`Uživatel má už ${MAX_DEVICES} zařízení — nejdřív nějaké zrušte.`, 409);
    const token = _newToken();
    const dev = { id: 'dev_' + crypto.randomBytes(4).toString('hex'), label: _cleanLabel(label), hash: sha256(token), createdAt: new Date().toISOString() };
    u.tokens = (u.tokens || []).concat(dev);
    return { token, device: { id: dev.id, label: dev.label, createdAt: dev.createdAt } };
}

/** Založí uživatele + první zařízení. Vrací { user, token, device } — token jen teď. */
function createUser({ name, role, deviceLabel } = {}, by) {
    const n = _cleanName(name);
    _checkRole(role || '');
    const list = loadRaw().slice();
    if (list.some(u => _norm(u.name) === _norm(n))) {
        throw new UserError(`Uživatel „${n}“ už existuje — v auditu by nešlo rozlišit, kdo co udělal.`, 409);
    }
    const u = { id: 'u_' + crypto.randomBytes(5).toString('hex'), name: n, role, disabled: false, createdAt: new Date().toISOString(), createdBy: by || null, tokens: [] };
    const { token, device } = _addDevice(u, deviceLabel || 'První zařízení');
    list.push(u);
    saveRaw(list);
    return { user: view(u), token, device };
}

function updateUser(id, patch = {}) {
    const list = loadRaw().slice();
    const u = list.find(x => x.id === id);
    if (!u) throw new UserError('Uživatel nenalezen.', 404);
    if (patch.name != null) {
        const n = _cleanName(patch.name);
        if (list.some(x => x.id !== id && _norm(x.name) === _norm(n))) throw new UserError(`Jméno „${n}“ už má jiný uživatel.`, 409);
        u.name = n;
    }
    if (patch.role != null) {
        _checkRole(patch.role);
        if (u.role === 'spravce' && patch.role !== 'spravce' && !u.disabled && _activeAdmins(list).length <= 1) {
            // Hlavní API token zůstává vždy jako záchrana, ale poslední správcovský ÚČET nesmí zmizet omylem.
            throw new UserError('Toto je poslední aktivní správce — nejdřív jmenujte jiného.', 409);
        }
        u.role = patch.role;
    }
    if (patch.disabled != null) {
        if (patch.disabled && u.role === 'spravce' && !u.disabled && _activeAdmins(list).length <= 1) {
            throw new UserError('Toto je poslední aktivní správce — nejdřív jmenujte jiného.', 409);
        }
        u.disabled = !!patch.disabled;
        if (u.disabled) u.tokens = []; // deaktivace = okamžité odhlášení všech zařízení
    }
    saveRaw(list);
    return view(u);
}
function _activeAdmins(list) { return list.filter(u => u.role === 'spravce' && !u.disabled); }

/** Nové zařízení (token) pro uživatele. Vrací { token, device } — token jen teď. */
function addDevice(id, label) {
    const list = loadRaw().slice();
    const u = list.find(x => x.id === id);
    if (!u) throw new UserError('Uživatel nenalezen.', 404);
    if (u.disabled) throw new UserError('Uživatel je deaktivovaný.', 409);
    const r = _addDevice(u, label);
    saveRaw(list);
    return r;
}

function revokeDevice(id, deviceId) {
    const list = loadRaw().slice();
    const u = list.find(x => x.id === id);
    if (!u) throw new UserError('Uživatel nenalezen.', 404);
    const before = (u.tokens || []).length;
    u.tokens = (u.tokens || []).filter(t => t.id !== deviceId);
    if (u.tokens.length === before) throw new UserError('Zařízení nenalezeno.', 404);
    saveRaw(list);
    return view(u);
}

/**
 * Ověří token → { user, deviceId } nebo null. Konstantní čas porovnání hashe.
 * lastUsedAt se drží v paměti a na disk se propisuje nejvýš jednou za 5 min.
 */
function verifyToken(token) {
    if (!token || typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
    const h = sha256(token);
    const list = loadRaw();
    for (const u of list) {
        if (u.disabled) continue;
        for (const t of (u.tokens || [])) {
            if (t.hash && secureCrypto.timingSafeEqualStr(h, t.hash)) {
                const now = Date.now();
                const prev = t.lastUsedAt ? Date.parse(t.lastUsedAt) : 0;
                t.lastUsedAt = new Date(now).toISOString();
                if (now - prev > LAST_USED_PERSIST_MS) { try { saveRaw(list); } catch (e) { /* best-effort */ } }
                return { user: u, deviceId: t.id, deviceLabel: t.label };
            }
        }
    }
    return null;
}

module.exports = {
    ROLES, TOKEN_PREFIX, UserError,
    listUsers, getUser, createUser, updateUser, addDevice, revokeDevice, verifyToken, scopesOf, view,
    _resetCache
};
