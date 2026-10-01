/**
 * lib/agent_options.js — společná nastavení volání LLM pro agenty.
 */
'use strict';

// Okno kontextu: bez num_ctx Ollama použije malé výchozí okno a dlouhý vstup TIŠE
// ořízne (test 1. 10. 2026: smlouva se 40 články → model viděl jen čl. 33+).
function agentNumCtx() {
    return Math.max(2048, parseInt(process.env.AGENT_NUM_CTX, 10) || 8192);
}

// Embedding modely nejsou chatovací (bge-m3, nomic-embed-text, mxbai-embed, all-minilm, e5…).
function isEmbeddingModel(name) {
    return /(^|[\/:\-_])(bge|embed|nomic|mxbai|minilm|e5|gte)([\-:._]|$)|embed/i.test(String(name || ''));
}

// Ollama: „model 'x' not found, try pulling it first“ / HTTP 404.
function isModelMissingError(err) {
    const msg = String((err && err.message) || '');
    return (err && (err.status_code === 404 || err.status === 404)) || /model\s+['"]?[^'"]*['"]?\s+not found|not found, try pulling/i.test(msg);
}

module.exports = { agentNumCtx, isEmbeddingModel, isModelMissingError };
