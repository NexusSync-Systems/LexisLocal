'use strict';
/**
 * codexis.js — volitelný konektor na CODEXIS AI (Atlas consulting) přes jejich REST API.
 *
 * K čemu: kancelář, která má VLASTNÍ licenci CODEXIS AI, se může z LexisLocalu zeptat
 * jejich agenta s přístupem k databázi CODEXIS (komentáře, judikatura). Každý dotaz čerpá
 * kredity z licence kanceláře. API dává přístup k agentovi, ne k databázi (žádné hromadné
 * stahování obsahu).
 *
 * Mlčenlivost (fail-closed):
 *   • výchozí VYPNUTO; zapíná správce (klíč + přepínač), v lokálním režimu
 *     (LEXIS_PILOT_LOCAL_ONLY / AI_LOCAL_ONLY) zakázáno úplně,
 *   • ven jde JEN rešeršní otázka bez příloh, osobní údaje se před odesláním odstraní
 *     (agent_tools._stripPII), klientské dokumenty se NIKDY neposílají,
 *   • každý dotaz se zapíše do auditu (kdo, kdy, délka a začátek otázky po očištění).
 *   Pozor: CODEXIS AI podle svých stránek využívá i externí OpenAI API → dotaz opouští EU
 *   provozovatele; proto jen obecné právní otázky.
 *
 * Klíč: soubor `codexis_api_key` ve složce klíčů (mimo data, práva 0600), nebo $CODEXIS_API_KEY.
 * API (codexis.ai/…/integrace/api/endpointy): base https://vm.codexis.ai, hlavička X-Api-Key;
 *   GET /api/v1/vm → {status: RUNNING|STOPPED|STARTING|STOPPING}; POST /api/v1/vm/start;
 *   POST /api/v1/chats {input} → {id, chatId, status: in_progress|completed, text, parts};
 *   GET /api/v1/chats/{chatId}/messages/{id} → totéž (dotazujeme, dokud není completed).
 */
const fs = require('fs');
const path = require('path');

const BASE = (process.env.CODEXIS_BASE_URL || 'https://vm.codexis.ai').replace(/\/+$/, '');

let _fetch = (...a) => globalThis.fetch(...a);
let _sleep = (ms) => new Promise(r => setTimeout(r, ms));
function _setForTests({ fetch, sleep } = {}) { if (fetch) _fetch = fetch; if (sleep) _sleep = sleep; }

function _keyFile() { return path.join(require('./secure_crypto').resolveKeyDir(), 'codexis_api_key'); }

function getKey() {
    if (process.env.CODEXIS_API_KEY) return String(process.env.CODEXIS_API_KEY).trim() || null;
    try { const k = fs.readFileSync(_keyFile(), 'utf8').trim(); return k || null; } catch (e) { return null; }
}

/** Uloží klíč (prázdný = smaže obsah). Nikdy se nevrací zpět přes API. */
function setKey(key) {
    const file = _keyFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, String(key || '').trim(), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (e) { /* best-effort */ }
    fs.renameSync(tmp, file);
}

function _localOnly() {
    try { return !!require('./ai_provider').assertLocalCompliance().localOnly; } catch (e) { return false; }
}

function _settingEnabled() {
    try { return require('./config').readSettings().codexisEnabled === true; } catch (e) { return false; }
}

function status() {
    const configured = !!getKey();
    const localOnly = _localOnly();
    const switchOn = _settingEnabled();
    return { configured, switchOn, localOnly, enabled: configured && switchOn && !localOnly };
}
function isEnabled() { return status().enabled; }

function setEnabled(on) {
    const config = require('./config');
    const s = config.readSettings();
    s.codexisEnabled = !!on;
    config.writeSettings(s);
}

async function _call(method, p, body, key) {
    const headers = { 'X-Api-Key': key, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
        const res = await _fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (!res.ok) {
            const msg = res.status === 401 ? 'neplatný klíč nebo licence CODEXIS AI'
                : (data && (data.message || data.error)) || `HTTP ${res.status}`;
            const err = new Error(msg); err.status = res.status; throw err;
        }
        return data || {};
    } finally { clearTimeout(t); }
}

async function _ensureVm(key, deadline) {
    let st = (await _call('GET', '/api/v1/vm', null, key)).status;
    if (st === 'RUNNING') return;
    if (st === 'STOPPED') await _call('POST', '/api/v1/vm/start', {}, key);
    while (Date.now() < deadline) {
        await _sleep(3000);
        st = (await _call('GET', '/api/v1/vm', null, key)).status;
        if (st === 'RUNNING') return;
    }
    throw new Error('virtuální stroj CODEXIS AI se nespustil včas');
}

/** Citace z `parts` (best-effort — schéma částí není plně zdokumentované). */
function _citations(parts) {
    const out = [];
    (Array.isArray(parts) ? parts : []).forEach(p => {
        const c = p && (p.citation || p.source || p.reference);
        const label = (c && (c.title || c.label || c.name)) || (p && p.type === 'citation' && (p.title || p.text));
        if (label) out.push(String(label).slice(0, 200));
    });
    return [...new Set(out)].slice(0, 20);
}

/**
 * Položí rešeršní otázku. Vrací { source:'codexis', text, citations, chatId } nebo { error }.
 * opts.timeoutMs (výchozí 120 s), opts.agentId (volitelně agent CODEXIS).
 */
async function ask(question, opts = {}) {
    if (!isEnabled()) return { error: status().localOnly ? 'Lokální režim (mlčenlivost): CODEXIS AI je zakázané.' : 'CODEXIS AI není zapnuté nebo chybí klíč.' };
    const { _stripPII } = require('./agent_tools');
    const q = _stripPII(String(question == null ? '' : question).trim()).slice(0, 4000);
    if (!q) return { error: 'Prázdný dotaz.' };
    const key = getKey();
    const deadline = Date.now() + (Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000);
    try {
        require('./audit').logEvent('CODEXIS AI', 'Externí rešeršní dotaz (CODEXIS AI)', 'codexis.ai',
            { delka: q.length, zacatek: q.slice(0, 120), zdroj: opts.via || 'api' });
    } catch (e) { /* audit nesmí shodit dotaz */ }
    try {
        await _ensureVm(key, deadline);
        const body = { input: q };
        if (opts.agentId) body.agentId = String(opts.agentId);
        let m = await _call('POST', '/api/v1/chats', body, key);
        while (m.status !== 'completed') {
            if (Date.now() >= deadline) return { error: 'CODEXIS AI neodpovědělo včas.', chatId: m.chatId };
            await _sleep(2000);
            m = await _call('GET', `/api/v1/chats/${encodeURIComponent(m.chatId)}/messages/${encodeURIComponent(m.id)}`, null, key);
        }
        return { source: 'codexis', text: String(m.text || '').slice(0, 8000), citations: _citations(m.parts), chatId: m.chatId };
    } catch (e) {
        return { error: 'CODEXIS AI: ' + (e && e.message) };
    }
}

/** Ověření klíče/licence bez čerpání kreditů (jen stav virtuálního stroje). */
async function check() {
    const key = getKey();
    if (!key) return { ok: false, error: 'Chybí klíč.' };
    try { const v = await _call('GET', '/api/v1/vm', null, key); return { ok: true, vm: v.status || null }; }
    catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { ask, check, status, isEnabled, setEnabled, getKey, setKey, _setForTests, _citations };
