'use strict';
/**
 * model_preflight.js — startovní kontrola dostupnosti AI modelů (#6).
 *
 * Problém: role-modely (CHAT/FAST/DRAFT/REVIEW + EMBEDDING) se berou z env, ale
 * když daný model NENÍ v Ollamě stažený, volání selže a agent tiše spadne na
 * „simulovaný fallback" (agent_fallback.js). Uživatel to nepozná.
 *
 * Řešení: při startu (a na /api/system/health) porovnat požadované modely se
 * seznamem dostupných (`ollama list`) a HLASITĚ varovat u chybějících — vč.
 * návrhu dostupné náhrady. Záměrně NEMUTUJE konfiguraci (auto-remap by byl
 * překvapivý); jen upozorní, ať degradace není neviditelná.
 *
 * Jádro `analyzePreflight()` je čistá deterministická funkce (bez sítě) → plně
 * pokrytá testy. `preflightModels()` obstará síťový list přes ai_provider.
 */

const aiProvider = require('./ai_provider');

function _norm(n) { return String(n == null ? '' : n).trim(); }
function _base(n) { const s = _norm(n); const i = s.indexOf(':'); return i >= 0 ? s.slice(0, i) : s; }

// Je požadovaný model přítomen v seznamu dostupných?
//   • wanted S TAGEM (qwen2.5:3b) → vyžaduje PŘESNOU shodu (3b ≠ 7b),
//   • wanted BEZ TAGU (llama3)    → stačí shoda základu (llama3 == llama3:latest / llama3:8b).
function isModelPresent(wanted, available) {
    const w = _norm(wanted);
    if (!w) return true; // prázdné = default knihovny, neřešíme
    const set = (available || []).map(_norm);
    if (set.includes(w)) return true;
    if (w.indexOf(':') >= 0) return false; // explicitní tag → jen přesná shoda
    return set.some(a => _base(a) === w);
}

// Rozliší „embedding" model podle názvu (heuristika) — ať ho nenabízíme jako chat náhradu.
function _looksLikeEmbed(name) { return /embed|bge|e5|gte|nomic/i.test(_norm(name)); }

// Role → env proměnná + typ (chat|embed). REVIEW/DRAFT/FAST padají na CHAT_MODEL.
function rolesFromEnv(env) {
    env = env || process.env;
    const chat = env.CHAT_MODEL || 'llama3';
    return [
        { key: 'CHAT_MODEL',      type: 'chat',  wanted: chat },
        { key: 'FAST_MODEL',      type: 'chat',  wanted: env.FAST_MODEL || chat },
        { key: 'DRAFT_MODEL',     type: 'chat',  wanted: env.DRAFT_MODEL || chat },
        { key: 'REVIEW_MODEL',    type: 'chat',  wanted: env.REVIEW_MODEL || env.DRAFT_MODEL || chat },
        { key: 'EMBEDDING_MODEL', type: 'embed', wanted: env.EMBEDDING_MODEL || 'nomic-embed-text' }
    ];
}

/**
 * Čisté jádro: porovná požadované role s dostupnými modely.
 * @returns { available, roles:[{key,type,wanted,present}], missing:[...], suggestions:{chat,embed}, warnings:[...] }
 */
function analyzePreflight(roles, available) {
    available = Array.isArray(available) ? available.map(_norm).filter(Boolean) : [];
    const chatCandidates = available.filter(m => !_looksLikeEmbed(m));
    const embedCandidates = available.filter(_looksLikeEmbed);

    const resolved = roles.map(r => ({ ...r, present: isModelPresent(r.wanted, available) }));
    const missing = resolved.filter(r => !r.present);

    // Deduplikace požadovaných modelů (často je všech 5 stejných) pro čitelné varování.
    const warnings = [];
    const missingByModel = {};
    for (const r of missing) {
        (missingByModel[r.wanted] = missingByModel[r.wanted] || []).push(r.key);
    }
    for (const model of Object.keys(missingByModel)) {
        const keys = missingByModel[model].join(', ');
        const isEmbed = _looksLikeEmbed(model);
        const cands = isEmbed ? embedCandidates : chatCandidates;
        const hint = cands.length
            ? ` Dostupná náhrada: ${cands.slice(0, 3).join(', ')} — nastav v .env, nebo stáhni: ollama pull ${model}`
            : ` Žádný dostupný ${isEmbed ? 'embedding' : 'chat'} model — stáhni: ollama pull ${model}`;
        warnings.push(`⚠️ Model „${model}" (${keys}) není v Ollamě → agenti spadnou na simulovaný fallback.${hint}`);
    }
    if (!available.length) {
        warnings.unshift('⚠️ Ollama nevrátila žádné modely (neběží, nebo je prázdná). AI poběží jen v simulovaném fallbacku.');
    }

    return {
        available,
        roles: resolved,
        missing,
        suggestions: { chat: chatCandidates, embed: embedCandidates },
        warnings,
        ok: missing.length === 0 && available.length > 0
    };
}

/**
 * Síťová varianta: zjistí dostupné modely (ollama list) a zaloguje varování.
 * Best-effort — nikdy nevyhazuje (start serveru nesmí spadnout kvůli preflightu).
 * Přeskočí se, když chat i embed jedou přes cloud (modely spravuje poskytovatel).
 */
async function preflightModels(opts) {
    opts = opts || {};
    const logger = opts.logger || console;
    let info = { chat: 'ollama', embed: 'ollama' };
    try { if (typeof aiProvider.providerInfo === 'function') info = aiProvider.providerInfo(); } catch (e) {}
    if (info.chat !== 'ollama' && info.embed !== 'ollama') {
        return null; // vše přes cloud → lokální preflight nedává smysl
    }

    let available = [];
    try {
        if (typeof aiProvider.list === 'function') {
            const r = await aiProvider.list();
            const arr = (r && Array.isArray(r.models)) ? r.models : (Array.isArray(r) ? r : []);
            available = arr.map(m => (m && (m.name || m.model)) || m).filter(Boolean);
        } else {
            logger.warn('⚠️ Preflight modelů: poskytovatel neumí výpis modelů — přeskočeno.');
            return null;
        }
    } catch (e) {
        logger.warn('⚠️ Preflight modelů: nepodařilo se získat seznam z Ollamy (' + e.message + ').');
        return null;
    }

    const report = analyzePreflight(rolesFromEnv(), available);
    if (report.warnings.length) {
        for (const w of report.warnings) logger.warn(w);
    } else {
        logger.log('✅ Preflight modelů: všechny role-modely jsou v Ollamě dostupné.');
    }
    return report;
}

module.exports = { analyzePreflight, isModelPresent, rolesFromEnv, preflightModels };
