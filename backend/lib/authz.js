'use strict';
/**
 * authz.js — oprávnění podle role (nad autentizací v lib/auth.js).
 *
 * Platí pro principaly druhu 'user' (uživatelé kanceláře). Hlavní API token
 * a solo režim mají plná práva (scope admin) → chování se pro ně nemění.
 *
 *   • čtení (GET/HEAD)  → scope read
 *   • zápis (ostatní)   → scope write
 *   • správa serveru    → scope admin (uživatelé, export dat, klíče, nastavení,
 *                          e-mailový účet, stahování modelů, skartace, mazání auditu …)
 */
const principalLib = require('./principal');

// [metoda | '*', prefix cesty] — co smí jen správce.
const ADMIN_RULES = [
    ['*', '/api/users'],
    ['*', '/api/system/export'],
    ['*', '/api/system/rotate-key'],
    ['*', '/api/email/settings'],
    ['POST', '/api/settings'],
    ['POST', '/api/registries/config'],
    ['POST', '/api/models/pull'],
    ['POST', '/api/watcher/toggle'],
    ['POST', '/api/audit/clear'],
    ['POST', '/api/skartace/protokol'],
    ['POST', '/api/agents'],
    ['DELETE', '/api/agents'],
    ['POST', '/api/agent-tokens'],
    ['DELETE', '/api/agent-tokens']
];

function _matches(prefix, p) { return p === prefix || p.startsWith(prefix + '/'); }

/** Jaký scope cesta vyžaduje: 'admin' | 'write' | 'read' | null (mimo API). */
function requiredScope(method, pathname) {
    const p = String(pathname || '').toLowerCase().replace(/\/+$/, '') || '/';
    if (!(p === '/api' || p.startsWith('/api/'))) return null;
    const m = String(method || 'GET').toUpperCase();
    for (const [rm, prefix] of ADMIN_RULES) {
        if ((rm === '*' || rm === m) && _matches(prefix, p)) return 'admin';
    }
    return (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') ? 'read' : 'write';
}

/** { allowed, scope } pro daný principal a požadavek. */
function authorize(principal, method, pathname) {
    const scope = requiredScope(method, pathname);
    if (!scope) return { allowed: true, scope: null };
    if (!principal || principal.kind !== 'user') return { allowed: true, scope }; // jen uživatelé se omezují zde
    const lp = String(pathname || '').toLowerCase().replace(/\/+$/, '');
    // Vlastní identita a párování VLASTNÍHO zařízení smí každý přihlášený (i „jen čtení“).
    if (_matches('/api/me', lp) || lp === '/api/pair/new') return { allowed: true, scope };
    return { allowed: principalLib.hasScope(principal, scope), scope };
}

const SCOPE_MSG = {
    admin: 'Tuto akci smí provést jen správce kanceláře.',
    write: 'Vaše role má přístup jen pro čtení.',
    read: 'Nemáte oprávnění ke čtení.'
};

module.exports = { requiredScope, authorize, ADMIN_RULES, SCOPE_MSG };
