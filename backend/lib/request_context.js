'use strict';
/**
 * request_context.js — kdo právě volá (principal) dostupný hluboko v kódu bez
 * protahování `req` (audit, koncepty, agenti). Nastavuje middleware authenticate
 * v server.js přes AsyncLocalStorage; mimo HTTP požadavek (watcher, cron) je prázdný.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function run(ctx, fn) { return als.run(ctx || {}, fn); }
function current() { return als.getStore() || null; }
function currentPrincipal() { const c = current(); return (c && c.principal) || null; }

/** Krátký popis aktéra pro audit: { id, name, kind, device } nebo null. */
function currentActor() {
    const p = currentPrincipal();
    if (!p) return null;
    const a = { id: p.userId, name: p.name, kind: p.kind };
    if (p.deviceLabel) a.device = p.deviceLabel;
    return a;
}

module.exports = { run, current, currentPrincipal, currentActor };
