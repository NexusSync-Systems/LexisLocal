'use strict';
/**
 * model_config.js — jednotný zdroj výchozích názvů AI modelů.
 *
 * Dříve byl chat model natvrdo "llama3" na ~12 místech (orchestrator, agenti,
 * routy). Nyní je jediný přepínač:
 *   CHAT_MODEL       — výchozí/fallback chat model (default 'llama3')
 *   EMBEDDING_MODEL  — model pro sémantické embeddingy (default 'nomic-embed-text')
 *
 * Bez nastavení env proměnných se chování nemění (zůstává llama3 / nomic-embed-text).
 * setup.js nabídne dle RAM lehčí model a zapíše CHAT_MODEL do .env.
 */

const CHAT_MODEL = process.env.CHAT_MODEL || 'llama3';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';

// Minimální kosinové skóre, aby RAG pasáž prošla jako „vysoká shoda". Dřív
// zadrátováno na 0.70 na třech místech (agent/agentSwarm/orchestrator). Na
// nomic-embed-text nad českým právním textem je 0.70 rizikově vysoko (relevantní
// judikát se často zastaví na 0.55–0.65 a vypadne). Laditelné env RAG_MIN_SCORE,
// default 0.60; mimo rozsah 0..1 → fallback 0.60.
const RAG_MIN_SCORE = (() => {
    const v = parseFloat(process.env.RAG_MIN_SCORE);
    return (Number.isFinite(v) && v >= 0 && v <= 1) ? v : 0.60;
})();

module.exports = { CHAT_MODEL, EMBEDDING_MODEL, RAG_MIN_SCORE };
