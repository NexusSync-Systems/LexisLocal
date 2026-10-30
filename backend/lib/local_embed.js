'use strict';
/**
 * local_embed.js — vyhledávací model (bge-m3, ONNX) přímo v aplikaci, BEZ Ollamy.
 *
 * Režim „jen cloud“ (docs/REZIM_JEN_CLOUD.md): odpovědi dává Claude přes Bedrock v EU, ale text spisů
 * a dokumentů kvůli vyhledávání nikam neodchází — vektory se počítají tady, na CPU, přes
 * @huggingface/transformers (stejná knihovna jako reranker). Volba: AI_EMBED_PROVIDER=onnx.
 *
 * Kompatibilita: bge-m3 jako v Ollamě (CLS pooling, normalizovaný vektor, 1024 rozměrů) — báze zákonů
 * spočítaná Ollamou zůstává použitelná; shodu ověří backend/scripts/embed_compat.js.
 *
 * ENV:
 *  EMBED_ONNX_MODEL       default Xenova/bge-m3
 *  EMBED_ONNX_DTYPE       default fp32 (nejbližší Ollamě; q8 = menší a rychlejší, mírně jiné vektory)
 *  EMBED_ONNX_DIR         složka s již staženým modelem (instalace bez internetu) — pak se nic nestahuje
 *  EMBED_ONNX_MAXCHARS    default 16000 (ořez textu před tokenizací; bge-m3 má strop 8192 tokenů)
 */

const MODEL_ID = process.env.EMBED_ONNX_MODEL || 'Xenova/bge-m3';
const DTYPE = process.env.EMBED_ONNX_DTYPE || 'fp32';
const MAXCHARS = Math.max(500, parseInt(process.env.EMBED_ONNX_MAXCHARS, 10) || 16000);

let _extractor = null;
let _loading = null;
let _queue = Promise.resolve(); // jeden výpočet najednou (paměť CPU)

async function _load(opts) {
    if (_extractor) return _extractor;
    if (_loading) return _loading;
    _loading = (async () => {
        try {
            const tf = (opts && opts.transformers) || await import('@huggingface/transformers');
            if (process.env.EMBED_ONNX_DIR && tf.env) {
                tf.env.localModelPath = process.env.EMBED_ONNX_DIR;
                tf.env.allowRemoteModels = false;
            }
            const ex = await tf.pipeline('feature-extraction', MODEL_ID, { dtype: DTYPE });
            _extractor = ex;
            console.log(`✅ Vyhledávací model ${MODEL_ID} (${DTYPE}) načten v aplikaci (bez Ollamy).`);
            return ex;
        } finally {
            _loading = null;
        }
    })();
    return _loading;
}

/** Vektor jednoho textu ve tvaru jako Ollama: { embedding: number[] }. */
function embeddings(params, opts) {
    const text = String((params && (params.prompt != null ? params.prompt : params.input)) || '').slice(0, MAXCHARS);
    const run = async () => {
        const ex = await _load(opts);
        const out = await ex(text, { pooling: 'cls', normalize: true });
        return { embedding: Array.from(out.data) };
    };
    const p = _queue.then(run, run);
    _queue = p.catch(() => {});
    return p;
}

function _reset() { _extractor = null; _loading = null; _queue = Promise.resolve(); }

module.exports = { embeddings, MODEL_ID, DTYPE, _reset };
