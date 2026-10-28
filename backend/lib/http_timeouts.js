'use strict';
/**
 * Časové limity spojení HTTP(S) serveru.
 *
 * Node má výchozí keepAliveTimeout 5 s — stejně jako klient Node (globalAgent, keep-alive od v19)
 * drží volné spojení 5 s. Když je server chvíli vytížený (příjem a vytěžení dokumentů), zavře
 * „nečinné“ spojení ve chvíli, kdy ho klient právě znovu použil → ECONNRESET.
 * Zátěžový den 27. 10. 2026 (10 lidí): 6 z 12 773 požadavků.
 * Server proto drží spojení déle než klienti (prohlížeč, editor, skripty) → spojení zavírá klient.
 *
 * HTTP_KEEPALIVE_TIMEOUT_MS (výchozí 65 000, rozsah 5 000–600 000); headersTimeout musí být větší.
 */
function keepAliveMs(env = process.env) {
    const v = parseInt(env.HTTP_KEEPALIVE_TIMEOUT_MS || '', 10);
    if (!Number.isFinite(v)) return 65000;
    return Math.min(600000, Math.max(5000, v));
}

function applyHttpTimeouts(server, env = process.env) {
    if (!server) return server;
    const ka = keepAliveMs(env);
    server.keepAliveTimeout = ka;
    server.headersTimeout = ka + 1000;
    return server;
}

module.exports = { applyHttpTimeouts, keepAliveMs };
