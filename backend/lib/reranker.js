'use strict';
/**
 * reranker.js — cross-encoder reranker (bge-reranker-v2-m3, ONNX) přes @huggingface/transformers.
 *
 * Bi-encoder (bge-m3) umí říct „tohle je o náhradě škody", ale neoddělí KTERÝ z tisíce
 * podobných judikátů je ten pravý (viz eval: správný dokument skóruje dobře, ale je
 * zahrabaný). Cross-encoder skóruje přímo dvojici (dotaz × dokument) a tohle řeší.
 *
 * Vlastnosti:
 *  - LÍNÉ načtení: model se stáhne/načte až při prvním volání (a jen když je potřeba).
 *  - FAIL-OPEN: když model chybí / selže, vrátí vstup v původním pořadí (nikdy neshodí RAG).
 *  - CommonJS-friendly: @huggingface/transformers je ESM → načítá se přes dynamický import().
 *
 * ENV:
 *  RAG_RERANK=1            zapne reranking v searchSimilar (tenhle modul funguje i bez toho)
 *  RAG_RERANK_MODEL        default onnx-community/bge-reranker-v2-m3-ONNX
 *  RAG_RERANK_DTYPE        default q8 (int8 — úspora paměti; alt. fp32/fp16/q4)
 *  RAG_RERANK_BATCH        default 16 (kolik párů na jeden forward pass)
 *  RAG_RERANK_MAXLEN       default 512 (ořez tokenů na pár)
 */

const MODEL_ID = process.env.RAG_RERANK_MODEL || 'onnx-community/bge-reranker-v2-m3-ONNX';
const DTYPE = process.env.RAG_RERANK_DTYPE || 'q8';
const BATCH = Math.max(1, parseInt(process.env.RAG_RERANK_BATCH, 10) || 16);
const MAXLEN = Math.max(64, parseInt(process.env.RAG_RERANK_MAXLEN, 10) || 512);

let _pipe = null;      // { tokenizer, model }
let _loading = null;   // rozpracované načítání (deduplikace paralelních volání)
let _disabled = false; // po neúspěchu už nezkoušej znovu

async function _load() {
    if (_pipe) return _pipe;
    if (_disabled) return null;
    if (_loading) return _loading;
    _loading = (async () => {
        try {
            const tf = await import('@huggingface/transformers');
            const { AutoTokenizer, AutoModelForSequenceClassification } = tf;
            const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
            const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: DTYPE });
            _pipe = { tokenizer, model };
            console.log(`✅ RAG rerank: ${MODEL_ID} (dtype ${DTYPE}) načten.`);
            return _pipe;
        } catch (e) {
            _disabled = true;
            console.warn(`⚠️ RAG rerank: model se nepodařilo načíst (${e && e.message}). ` +
                `Reranking VYPNUT (fail-open, zůstává embedding pořadí). ` +
                `Nainstalováno @huggingface/transformers? Je síť na HF hub?`);
            return null;
        } finally {
            _loading = null;
        }
    })();
    return _loading;
}

/**
 * Přeřadí kandidáty podle cross-encoder relevance k dotazu.
 * @param {string} query
 * @param {Array<{text:string}>} candidates  kandidáti (typicky výstup rag.searchSimilar)
 * @param {object} [opts]  { topK, batchSize, maxLength }
 * @returns {Promise<Array>} NOVÉ pole týchž objektů + `rerankScore`, seřazené sestupně.
 *          Při nedostupnosti modelu vrací kandidáty v PŮVODNÍM pořadí (fail-open).
 */
async function rerank(query, candidates, opts = {}) {
    const items = Array.isArray(candidates) ? candidates : [];
    if (!query || !String(query).trim() || items.length === 0) return items;

    const pipe = await _load();
    if (!pipe) return items; // fail-open
    const { tokenizer, model } = pipe;

    const q = String(query);
    const docs = items.map(c => String((c && c.text) || ''));
    const batchSize = Math.max(1, opts.batchSize || BATCH);
    const maxLength = Math.max(64, opts.maxLength || MAXLEN);
    const scores = new Array(items.length).fill(0);

    try {
        for (let start = 0; start < docs.length; start += batchSize) {
            const batch = docs.slice(start, start + batchSize);
            const inputs = tokenizer(new Array(batch.length).fill(q),
                { text_pair: batch, padding: true, truncation: true, max_length: maxLength });
            const { logits } = await model(inputs);
            const rows = logits.sigmoid().tolist();
            for (let j = 0; j < rows.length; j++) {
                const v = Array.isArray(rows[j]) ? rows[j][0] : rows[j];
                scores[start + j] = (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
            }
        }
    } catch (e) {
        console.warn(`⚠️ RAG rerank: skórování selhalo (${e && e.message}) — původní pořadí.`);
        return items;
    }

    const out = items.map((c, i) => Object.assign({}, c, { rerankScore: scores[i] }));
    out.sort((a, b) => (b.rerankScore - a.rerankScore));
    const topK = Number.isInteger(opts.topK) && opts.topK > 0 ? opts.topK : out.length;
    return out.slice(0, topK);
}

/** Je reranking zapnutý v konfiguraci? (searchSimilar se podle toho řídí) */
function isEnabled() { return String(process.env.RAG_RERANK || '') === '1'; }

/** Jen pro testy/diagnostiku: je model načtený? */
function _isLoaded() { return !!_pipe; }

module.exports = { rerank, isEnabled, _load, _isLoaded, MODEL_ID, DTYPE };
