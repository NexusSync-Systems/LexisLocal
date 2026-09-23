'use strict';
/**
 * agent_router.js — deterministický (offline) router intentů (#1).
 *
 * Proč: dekompozice v orchestrátoru spoléhá na to, že 3B model vrátí platné JSON
 * pole kroků. Na malém modelu to selhává překvapivě často → dřív se použil SLEPÝ
 * lineární plán (rešeršník→spisovatel→kontrolor) bez ohledu na skutečný záměr.
 *
 * Tento modul:
 *   • sanitizeSteps() — očistí a zvaliduje kroky z LLM (zahodí neznámé agenty,
 *     doplní pole, ořízne na 1..4) → LLM výstup se dá bezpečně použít,
 *   • routeByIntent() — když LLM selže, odvodí kroky z KLÍČOVÝCH SLOV zadání
 *     (deterministicky, bez modelu), takže fallback respektuje záměr.
 *
 * Bez závislostí, čistý → plně testovatelné.
 */

const KNOWN_AGENTS = ['resersnik', 'stylista', 'kontrolor', 'sekretarka', 'spisovatel'];
const MAX_STEPS = 4;

function _deaccent(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Rozlišující klíčová slova (deakcentovaná) pro jednotlivé záměry.
const INTENT = {
    kontrola:  ['zkontroluj', 'kontrol', 'rizik', 'oponentur', 'oponuj', 'slaba mist', 'slabin', 'revizi', 'zreviduj', 'protiargument', 'vady'],
    styl:      ['styl', 'prepis', 'preformuluj', 'uprav ton', 'ton ', 'formulac', 'ucesat', 'elegant', 'srozumiteln'],
    sekretar:  ['termin', 'schuzk', 'kalendar', 'e-mail', 'email', 'organizuj', 'shrn ukol', 'ukoly', 'lustr', 'ico', 'naplanuj'],
    reserse:   ['reserse', 'reserš', 'judikat', 'zakon', 'ustanoveni', 'pravni opor', 'precedent', 'paragraf', '§', 'najdi pravni'],
    draft:     ['zalob', 'smlouv', 'podani', 'vyzv', 'odvolani', 'sepiš', 'sepis', 'napiš', 'napis', 'vypracuj', 'koncept', 'navrh smlouvy', 'dohod', 'plnou moc', 'dokument']
};

function _has(hay, kws) { return kws.some(k => hay.indexOf(_deaccent(k)) >= 0); }

/**
 * Očistí kroky z LLM: nechá jen validní (známý agentId + instruction), doplní
 * step/tier, ořízne na MAX_STEPS. Vrací [] když nezůstane nic použitelného.
 */
function sanitizeSteps(steps) {
    if (!Array.isArray(steps)) return [];
    const out = [];
    for (const s of steps) {
        if (!s || typeof s !== 'object') continue;
        const agentId = String(s.agentId || '').trim();
        const instruction = String(s.instruction || '').trim();
        if (!KNOWN_AGENTS.includes(agentId) || !instruction) continue;
        out.push({
            step: out.length + 1,
            agentId,
            instruction,
            tier: (s.tier === 'light' || s.tier === 'advanced') ? s.tier : 'advanced'
        });
        if (out.length >= MAX_STEPS) break;
    }
    return out;
}

/**
 * Deterministický plán z klíčových slov zadání. Vrací pole kroků nebo null
 * (žádný jasný záměr → ať volající použije obecný fallback).
 */
function routeByIntent(prompt) {
    const p = _deaccent(prompt);
    if (!p.trim()) return null;

    const isDraft = _has(p, INTENT.draft);
    const isReserse = _has(p, INTENT.reserse);
    const isKontrola = _has(p, INTENT.kontrola);
    const isStyl = _has(p, INTENT.styl);
    const isSekretar = _has(p, INTENT.sekretar);

    // Tvorba dokumentu → rešerše opory + sepsání (kontrolu doplní revizní smyčka).
    if (isDraft) {
        return sanitizeSteps([
            { agentId: 'resersnik', instruction: `Najdi právní oporu (zákon/judikaturu) pro: ${prompt}`, tier: 'advanced' },
            { agentId: 'spisovatel', instruction: `Sestav dokument dle zadání a nalezené opory: ${prompt}`, tier: 'advanced' }
        ]);
    }
    // Samostatná kontrola/oponentura.
    if (isKontrola) return sanitizeSteps([{ agentId: 'kontrolor', instruction: prompt, tier: 'advanced' }]);
    // Stylistika.
    if (isStyl) return sanitizeSteps([{ agentId: 'stylista', instruction: prompt, tier: 'light' }]);
    // Sekretariát/organizace.
    if (isSekretar) return sanitizeSteps([{ agentId: 'sekretarka', instruction: prompt, tier: 'light' }]);
    // Čistá rešerše.
    if (isReserse) return sanitizeSteps([{ agentId: 'resersnik', instruction: prompt, tier: 'advanced' }]);

    return null;
}

module.exports = { routeByIntent, sanitizeSteps, KNOWN_AGENTS, MAX_STEPS };
