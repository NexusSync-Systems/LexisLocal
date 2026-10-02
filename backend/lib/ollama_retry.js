/**
 * ollama_retry.js — jeden opakovaný pokus při PŘECHODNÉ chybě spojení s Ollamou.
 *
 * Server test 2. 10. 2026 (souběh 4–8 dotazů): část dotazů skončila výjimkou spojení
 * a agent vrátil „ZADÁNÍ NEBYLO ZPRACOVÁNO“. Krátké přerušení (reset spojení, přetížená
 * fronta, restart služby) nemá znamenat nevyřízené zadání. Chyby, které opakování
 * nevyřeší (model chybí, špatný požadavek), se neopakují.
 */
'use strict';

const TRANSIENT = /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR|socket hang up|other side closed|terminated|server busy|too many requests|503|502/i;

function isTransient(err) {
    if (!err) return false;
    const msg = String(err.message || err) + ' ' + String((err.cause && (err.cause.code || err.cause.message)) || '');
    if (/not found|pull|404|400|invalid/i.test(msg) && !/fetch failed/i.test(msg)) return false;
    return TRANSIENT.test(msg);
}

/** Spustí fn(); při přechodné chybě počká a zkusí to ještě (retries)×. */
async function withRetry(fn, { retries = 1, delayMs = 1500, onRetry } = {}) {
    let attempt = 0;
    for (;;) {
        try { return await fn(); }
        catch (err) {
            if (attempt >= retries || !isTransient(err)) throw err;
            attempt++;
            if (onRetry) { try { onRetry(err, attempt); } catch (e) { /* jen log */ } }
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}

/** Obal klienta: provider.chat s opakováním (pro runToolLoop i přímé volání). */
function retryingProvider(provider, opts) {
    return Object.assign(Object.create(provider), {
        chat: (args) => withRetry(() => provider.chat(args), opts)
    });
}

module.exports = { isTransient, withRetry, retryingProvider };
