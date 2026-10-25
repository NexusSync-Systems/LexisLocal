// --- auth — ověření per-request API tokenu (vytaženo ze server.js kvůli testům) ---
// Rozhodovací logika je čistá a bezstavová; middleware v server.js ji jen volá.
// Chování zůstává OPT-IN: když API_TOKEN není nastaven, přístup se nevynucuje
// (backend je stejně vázán jen na loopback). Až bude token povinný, změní se to
// na jednom místě (viz checkAuth) — a otestuje se reálným smoke testem.

'use strict';

// Cesty bez autentizace: statické soubory dashboardu a OPTIONS preflight.
function isPublicPath(method, pathname) {
    if (method === 'OPTIONS') return true;
    if (pathname === '/' || pathname === '/index.html') return true;
    // API NIKDY není veřejné podle přípony — dřív prošlo bez tokenu cokoli končící
    // .js/.css/.ico, např. DELETE /api/agent-knowledge/<agent>/<soubor>.js (nález 2. 10. 2026).
    const p = String(pathname || '').toLowerCase();
    if (p === '/api' || p.startsWith('/api/')) return false;
    return pathname.endsWith('.css') || pathname.endsWith('.js') || pathname.endsWith('.ico');
}

// Vytáhne token z požadavku: JEN z hlaviček (Authorization: Bearer nebo X-API-Token).
// Token v URL (?token=) se ZÁMĚRNĚ nepřijímá — unikal by do logů, historie a Referer.
function extractToken(req) {
    const h = (req && req.headers) || {};
    const authHeader = h['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7);
    if (h['x-api-token']) return h['x-api-token'];
    return undefined; // token v URL se nepřijímá (bezpečnost)
}

// Rozhodne o přístupu. Vrací { allowed, reason }.
//   • veřejná cesta / OPTIONS → povoleno,
//   • API_TOKEN nenastaven → povoleno (opt-in),
//   • token sedí → povoleno, jinak zamítnuto.
function checkAuth(apiToken, req) {
    if (isPublicPath(req.method, req.path)) return { allowed: true, reason: 'public' };
    if (!apiToken) return { allowed: true, reason: 'no-token-configured' };
    return extractToken(req) === apiToken
        ? { allowed: true, reason: 'ok' }
        : { allowed: false, reason: 'bad-token' };
}

module.exports = { isPublicPath, extractToken, checkAuth };
