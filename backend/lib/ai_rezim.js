'use strict';
/**
 * ai_rezim.js — režim AI kanceláře, přepínaný správcem v aplikaci (Manažerský přehled → „Režim AI“).
 *
 *   lokalni   — vše na počítači kanceláře (Ollama: odpovědi i vyhledávání)
 *   hybrid    — Claude přes Bedrock EU podle pravidel cloudu, jinak lokální model (docs/BEDROCK_EU.md)
 *   jen-cloud — jen Claude přes Bedrock EU, vyhledávání v aplikaci, bez Ollamy (docs/REZIM_JEN_CLOUD.md)
 *
 * Volba se ukládá do nastavení (lexislocal.settings.json → aiRezim) a při startu má přednost před .env.
 * Přepnutí platí hned (poskytovatelé čtou prostředí při každém volání); restart se doporučuje kvůli
 * kontrolám při startu. Zámky:
 *   LEXIS_PILOT_LOCAL_ONLY=1 / AI_LOCAL_ONLY=1 → povolen jen lokální režim (pojistka mlčenlivosti vyhrává)
 *   LEXIS_AI_REZIM_ZAMEK=1                    → režim určuje jen .env, v aplikaci nejde měnit
 * Každá změna jde do auditu. Přechod do cloudového režimu vyžaduje potvrzení správce (zpracovatelská
 * smlouva s AWS a DPIA) a projde jen s připraveným Bedrockem (EU region a EU profil modelu, přístup k AWS).
 * Návrat na lokální režim je povolen vždy (i bez běžící Ollamy — pak s varováním).
 */

const config = require('./config');

const REZIMY = {
    lokalni: { nazev: 'Lokální', env: { AI_CHAT_PROVIDER: 'ollama', AI_EMBED_PROVIDER: 'ollama', LEXIS_JEN_CLOUD: '' }, cloud: false },
    hybrid: { nazev: 'Hybridní (lokální + Claude EU)', env: { AI_CHAT_PROVIDER: 'bedrock', AI_EMBED_PROVIDER: 'ollama', LEXIS_JEN_CLOUD: '' }, cloud: true },
    'jen-cloud': { nazev: 'Jen cloud (Claude EU, bez lokálního modelu)', env: { AI_CHAT_PROVIDER: 'bedrock', AI_EMBED_PROVIDER: 'onnx', LEXIS_JEN_CLOUD: '1' }, cloud: true }
};

const _truthy = v => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

function zamek() {
    if (_truthy(process.env.LEXIS_PILOT_LOCAL_ONLY) || _truthy(process.env.AI_LOCAL_ONLY)) return { typ: 'jen-lokalne', duvod: 'Pojistka mlčenlivosti (LEXIS_PILOT_LOCAL_ONLY / AI_LOCAL_ONLY) povoluje jen lokální režim.' };
    if (_truthy(process.env.LEXIS_AI_REZIM_ZAMEK)) return { typ: 'env', duvod: 'Režim AI určuje konfigurace serveru (LEXIS_AI_REZIM_ZAMEK) — v aplikaci ho nelze měnit.' };
    return null;
}

/** Režim podle aktuálního prostředí; 'jiny' = kombinace mimo tři režimy (např. ruční nastavení .env). */
function aktualni() {
    const chat = String(process.env.AI_CHAT_PROVIDER || process.env.AI_PROVIDER || 'ollama').toLowerCase();
    const embed = String(process.env.AI_EMBED_PROVIDER || process.env.AI_PROVIDER || 'ollama').toLowerCase();
    const jc = _truthy(process.env.LEXIS_JEN_CLOUD);
    if (jc && chat === 'bedrock' && embed === 'onnx') return 'jen-cloud';
    if (!jc && chat === 'ollama' && embed === 'ollama') return 'lokalni';
    if (!jc && chat === 'bedrock' && embed === 'ollama') return 'hybrid';
    return 'jiny';
}

function _apply(rezim) {
    for (const [k, v] of Object.entries(REZIMY[rezim].env)) {
        if (v) process.env[k] = v; else delete process.env[k];
    }
}

/** Při startu serveru (hned po dotenv): uložená volba správce má přednost před .env, pokud ji nezakazuje zámek. */
function applyPersisted(log) {
    const r = (config.readSettings() || {}).aiRezim;
    const z = zamek();
    if (!r || !REZIMY[r]) return null;
    if (z && !(z.typ === 'jen-lokalne' && r === 'lokalni')) {
        if (log) log(`⚠️ Uložený režim AI „${r}“ se nepoužije: ${z.duvod}`);
        return null;
    }
    _apply(r);
    if (log) log(`🧭 Režim AI: ${REZIMY[r].nazev} (nastaveno správcem v aplikaci)`);
    return r;
}

async function _ollama(fetchImpl) {
    const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const base = /^https?:\/\//.test(host) ? host : 'http://' + host;
    const r = await fetchImpl(base + '/api/tags', { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return ((j && j.models) || []).map(m => String(m.name || m.model || ''));
}

/**
 * Připravenost pro každý režim: { lokalni: { ok, kontroly: [{ nazev, ok, detail }] }, … }.
 * Nikdy nevolá model a nevrací žádné údaje o přístupu k AWS — jen zda existuje.
 */
async function pripravenost(opts) {
    const o = opts || {};
    const fetchImpl = o.fetch || fetch;
    const { CHAT_MODEL, EMBEDDING_MODEL } = require('./model_config');
    const base = n => String(n || '').split(':')[0];
    const k = {};

    let modely = null, ollamaChyba = null;
    try { modely = await _ollama(fetchImpl); } catch (e) { ollamaChyba = e.message; }
    k.ollama = { nazev: 'Ollama běží', ok: !!modely, detail: modely ? `${modely.length} modelů` : `nedostupná (${ollamaChyba})` };
    k.chat = { nazev: `Lokální model ${CHAT_MODEL}`, ok: !!modely && modely.some(m => base(m) === base(CHAT_MODEL)), detail: modely ? '' : 'Ollama nedostupná' };
    k.embed = { nazev: `Vyhledávací model ${EMBEDDING_MODEL} v Ollamě`, ok: !!modely && modely.some(m => base(m) === base(EMBEDDING_MODEL)), detail: modely ? '' : 'Ollama nedostupná' };

    const bedrock = o.bedrock || require('./bedrock');
    const safe = f => { try { return f(); } catch (e) { return null; } }; // region() / modelId() hází, když nejsou v EU
    const reg = safe(() => bedrock.region()), mid = safe(() => bedrock.modelId());
    k.region = { nazev: 'Bedrock: region v EU', ok: /^eu-/.test(String(reg || '')), detail: String(reg || 'nenastaven') };
    k.model = { nazev: 'Bedrock: EU profil modelu', ok: /^eu\./.test(String(mid || '')), detail: String(mid || 'nenastaven') };
    let creds = false, credsDetail = '';
    try { const c = await bedrock.credentialsAsync(); creds = !!(c && c.accessKeyId); if (!creds) credsDetail = 'nenalezen'; }
    catch (e) { credsDetail = String(e.message || e).slice(0, 120); }
    k.aws = { nazev: 'Bedrock: přístup k AWS', ok: creds, detail: creds ? (bedrock.instanceMode && bedrock.instanceMode() ? 'role serveru' : 'nastaven') : credsDetail };

    let onnx = false;
    try { (o.resolve || require.resolve)('@huggingface/transformers'); onnx = true; } catch (e) { /* chybí */ }
    k.onnx = { nazev: 'Vyhledávací model v aplikaci (knihovna)', ok: onnx, detail: onnx ? (process.env.EMBED_ONNX_DIR ? 'model ze složky (offline)' : 'model se při prvním použití stáhne') : 'knihovna @huggingface/transformers chybí' };

    const pick = keys => { const kontroly = keys.map(x => k[x]); return { ok: kontroly.every(c => c.ok), kontroly }; };
    return {
        lokalni: pick(['ollama', 'chat', 'embed']),
        hybrid: pick(['ollama', 'chat', 'embed', 'region', 'model', 'aws']),
        'jen-cloud': pick(['region', 'model', 'aws', 'onnx'])
    };
}

async function stav(opts) {
    const z = zamek();
    const ulozeno = (config.readSettings() || {}).aiRezim || null;
    return {
        aktualni: aktualni(),
        ulozeno,
        zamek: z,
        rezimy: Object.fromEntries(Object.entries(REZIMY).map(([id, r]) => [id, { nazev: r.nazev, cloud: r.cloud }])),
        pripravenost: await pripravenost(opts)
    };
}

/**
 * Přepnutí režimu. { rezim, potvrzeni } → { success, z, na, restartRecommended } nebo vyhodí Error se status.
 * opts.logEvent pro audit (výchozí lib/audit).
 */
async function nastav(body, opts) {
    const o = opts || {};
    const rezim = String((body && body.rezim) || '');
    const err = (status, msg) => Object.assign(new Error(msg), { status });
    if (!REZIMY[rezim]) throw err(400, `Neznámý režim „${rezim}“ (lokalni, hybrid, jen-cloud).`);
    const z = zamek();
    if (z && !(z.typ === 'jen-lokalne' && rezim === 'lokalni')) throw err(409, z.duvod);
    if (REZIMY[rezim].cloud && body.potvrzeni !== true) {
        throw err(400, 'Pro cloudový režim potvrďte, že kancelář má zpracovatelskou smlouvu s AWS a DPIA pro cloudovou AI.');
    }
    const p = (await pripravenost(o))[rezim];
    const chybi = p.kontroly.filter(c => !c.ok).map(c => c.nazev + (c.detail ? ` (${c.detail})` : '')).join('; ');
    // Do cloudu jen s připraveným Bedrockem. Návrat na lokální je vždy povolen (bezpečný směr) — jen s varováním.
    if (!p.ok && REZIMY[rezim].cloud) throw err(409, 'Režim není připravený: ' + chybi);
    const z0 = aktualni();
    _apply(rezim);
    const s = config.readSettings() || {};
    s.aiRezim = rezim;
    config.writeSettings(s);
    const log = o.logEvent || require('./audit').logEvent;
    try { log('Nastavení', 'Režim AI', `${z0} → ${rezim}`, { z: z0, na: rezim, potvrzeniCloud: !!body.potvrzeni, kdo: o.kdo || null }); } catch (e) { /* audit best-effort */ }
    return { success: true, z: z0, na: rezim, restartRecommended: true, varovani: p.ok ? null : 'Lokální AI zatím nefunguje: ' + chybi };
}

module.exports = { REZIMY, zamek, aktualni, applyPersisted, pripravenost, stav, nastav };
