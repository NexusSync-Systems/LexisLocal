/**
 * Reranker v RAG (searchSimilar opts.rerank) — VOLITELNÝ, ve výchozím stavu VYPNUTÝ.
 *
 * Měření 10. 10. 2026 (training/embed/rerank_eval.py, zlatá sada 124 ručních dotazů, model
 * vyhledávání mix-0.3): přeřazení top 20 rerankerem BAAI/bge-reranker-v2-m3 a smíchání
 * 0,85 × reranker + 0,15 × hybrid zvedlo „správný § na 1. místě“ ze 70 % na 77 %
 * (dotazy klientů 60 → 72 %). Na GPU ~0,2 s na dotaz, na samotném CPU (torch fp32) ~19 s.
 *
 * Dva způsoby běhu (oba lokální, nic neodchází mimo stroj):
 *   1) RAG_RERANK_URL nastavené → samostatná služba se stejným API jako llama.cpp
 *      `llama-server --reranking`: POST {URL}/v1/rerank {query, documents[], top_n}
 *      → {results: [{index, relevance_score}]}. Viz scripts/rerank_server.py (CUDA / Apple MPS / CPU).
 *   2) bez URL → v procesu přes lib/reranker.js (ONNX q8, @huggingface/transformers; CPU).
 *
 * Env:
 *   RAG_RERANK=1                 zapne,
 *   RAG_RERANK_URL               např. http://127.0.0.1:8081 (jinak způsob 2),
 *   RAG_RERANK_K=20              kolik nejlepších výsledků přeřadit (2–50),
 *   RAG_RERANK_WEIGHT=0.85       podíl rerankeru ve smíchaném pořadí (0–1; 1 = jen reranker),
 *   RAG_RERANK_TIMEOUT_MS=4000   služba: po vypršení / chybě se vrátí původní pořadí (fail-open).
 *   RAG_RERANK_PROVIDER=bedrock  3) přeřazení přes Amazon Bedrock Rerank v EU (režim jen cloud, pilot na Macu
 *                                bez GPU). BEDROCK_RERANK_MODEL (výchozí cohere.rerank-v3-5:0; nebo amazon.rerank-v1:0),
 *                                region z BEDROCK_REGION (jen eu-*), BEDROCK_RERANK_USD (odhad ceny jednoho volání).
 *                                Do AWS jde jen dotaz a VEŘEJNÉ pasáže báze (scope _kb_*), nikdy úseky ze spisů,
 *                                a jen když pravidla cloudu (lib/cloud_policy.js) dotaz do Bedrocku pustí.
 *                                Jinak / při chybě původní pořadí (fail-open).
 *
 * Skóre výsledků (`score`) se NEMĚNÍ — prahy (RAG_MIN_SCORE, 0.70 v conflicts) drží význam.
 * Mění se jen pořadí; skóre rerankeru je v `rerankScore`.
 */

function _on(v) {
    return ['1', 'true', 'yes', 'on'].includes(String(v == null ? '' : v).trim().toLowerCase());
}
function rerankUrl() { return String(process.env.RAG_RERANK_URL || '').trim().replace(/\/+$/, ''); }
function rerankEnabled() { return _on(process.env.RAG_RERANK); }
function rerankK() {
    const k = parseInt(process.env.RAG_RERANK_K, 10);
    return Number.isFinite(k) ? Math.min(50, Math.max(2, k)) : 20;
}
function rerankWeight() {
    const w = parseFloat(process.env.RAG_RERANK_WEIGHT);
    return Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.85;
}
function rerankTimeoutMs() {
    const t = parseInt(process.env.RAG_RERANK_TIMEOUT_MS, 10);
    return Number.isFinite(t) && t > 0 ? t : 4000;
}

function _minmax(xs) {
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return hi > lo ? xs.map(x => (x - lo) / (hi - lo)) : xs.map(() => 0);
}

/**
 * Čistá funkce: přeřadí `top` podle β × minmax(rerank) + (1 − β) × minmax(score).
 * `scores[i]` patří k `top[i]`; chybějící (null/NaN) skóre → položka zůstane za přeřazenými
 * v původním pořadí. Vrací NOVÉ pole; položky dostanou `rerankScore`. Shodu řeší původní pořadí.
 */
function mixOrder(top, scores, beta) {
    const val = i => (scores[i] == null ? NaN : Number(scores[i]));
    const ok = top.map((r, i) => ({ r, i, s: val(i) })).filter(x => Number.isFinite(x.s));
    const missing = top.filter((r, i) => !Number.isFinite(val(i)));
    if (ok.length === 0) return top.slice();
    const rn = _minmax(ok.map(x => x.s));
    const hn = _minmax(ok.map(x => Number(x.r.score) || 0));
    const mixed = ok.map((x, j) => ({ ...x, m: beta * rn[j] + (1 - beta) * hn[j] }));
    mixed.sort((a, b) => (b.m - a.m) || (a.i - b.i));
    return mixed.map(x => ({ ...x.r, rerankScore: x.s })).concat(missing);
}

let _lastWarn = 0, _lastInfo = 0;
function _warn(msg, info) {
    const now = Date.now();
    if (info) { if (now - _lastInfo > 600000) { _lastInfo = now; console.log(`ℹ️ RAG reranker: ${msg} — původní pořadí.`); } return; }
    if (now - _lastWarn > 60000) { _lastWarn = now; console.warn(`⚠️ RAG reranker: ${msg} — používám původní pořadí.`); }
}

/** Služba rerankeru (způsob 1). Vrací pole skóre (délky documents) nebo vyhodí chybu. */
async function scoreViaService(query, documents, { url = rerankUrl(), timeoutMs = rerankTimeoutMs(), fetchImpl } = {}) {
    const f = fetchImpl || globalThis.fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await f(url + '/v1/rerank', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, documents, top_n: documents.length }),
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data && data.results) ? data.results : null;
        if (!list) throw new Error('neočekávaná odpověď (chybí results)');
        const out = new Array(documents.length).fill(null);
        for (const it of list) {
            const i = Number(it && it.index);
            const s = Number(it && (it.relevance_score != null ? it.relevance_score : it.score));
            if (Number.isInteger(i) && i >= 0 && i < out.length && Number.isFinite(s)) out[i] = s;
        }
        return out;
    } finally {
        clearTimeout(timer);
    }
}

/** V procesu přes lib/reranker.js (způsob 2; ONNX, fail-open → samé null). */
async function scoreInProcess(query, documents, { inProcess } = {}) {
    const impl = inProcess || require('./reranker');
    const ranked = await impl.rerank(query, documents.map((text, __i) => ({ text, __i })), {});
    const out = new Array(documents.length).fill(null);
    for (const r of ranked || []) {
        if (r && Number.isInteger(r.__i) && Number.isFinite(Number(r.rerankScore))) out[r.__i] = Number(r.rerankScore);
    }
    return out;
}

function rerankProvider() { return String(process.env.RAG_RERANK_PROVIDER || '').trim().toLowerCase(); }
function bedrockRerankModel() { return String(process.env.BEDROCK_RERANK_MODEL || 'cohere.rerank-v3-5:0').trim(); }
const stats = { bedrockOk: 0, bedrockChyba: 0, bedrockOdepreno: 0, posledniChyba: null }; // pro měření a diagnostiku
const _isKb = r => !!(r && typeof r.scope === 'string' && r.scope.indexOf('_kb_') === 0);

/**
 * Smí dotaz do Bedrocku? Stejná pravidla jako odpověď Clauda (spis se souhlasem / veřejný dotaz,
 * cloud zapnutý). Vrací { ok, duvod }.
 */
function bedrockGate() {
    try {
        const cp = require('./cloud_policy');
        if (!cp.stavKancelare().cloudAktivni) return { ok: false, duvod: 'cloud v kanceláři vypnutý' };
        const d = cp.rozhodni('bedrock');
        return d.allowed ? { ok: true } : { ok: false, duvod: 'pravidla cloudu: ' + d.code };
    } catch (e) {
        return { ok: false, duvod: e.message };
    }
}

/** Amazon Bedrock Rerank (bedrock-agent-runtime /rerank, SigV4). Vrací pole skóre délky documents. */
async function scoreViaBedrock(query, documents, { timeoutMs = rerankTimeoutMs(), fetchImpl, bedrock: bImpl } = {}) {
    const b = bImpl || require('./bedrock');
    const reg = b.region(); // zámek na EU (vyhodí mimo eu-*)
    const creds = await b.credentialsAsync();
    const host = `bedrock-agent-runtime.${reg}.amazonaws.com`;
    const body = JSON.stringify({
        queries: [{ type: 'TEXT', textQuery: { text: String(query).slice(0, 2000) } }],
        sources: documents.map(t => ({ type: 'INLINE', inlineDocumentSource: { type: 'TEXT', textDocument: { text: String(t).slice(0, 4000) } } })),
        rerankingConfiguration: { type: 'BEDROCK_RERANKING_MODEL', bedrockRerankingConfiguration: {
            numberOfResults: documents.length,
            modelConfiguration: { modelArn: `arn:aws:bedrock:${reg}::foundation-model/${bedrockRerankModel()}` } } }
    });
    const sg = b.sign({ method: 'POST', host, pathSegments: ['rerank'], headers: { 'content-type': 'application/json' }, body, service: 'bedrock', region: reg, creds });
    const f = fetchImpl || globalThis.fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await f(`https://${host}${sg.path}`, { method: 'POST', headers: sg.headers, body, signal: ctrl.signal });
        if (!res.ok) throw new Error(`Bedrock Rerank ${res.status}: ${String(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        const out = new Array(documents.length).fill(null);
        for (const it of (data && data.results) || []) {
            const i = Number(it && it.index), sc = Number(it && it.relevanceScore);
            if (Number.isInteger(i) && i >= 0 && i < out.length && Number.isFinite(sc)) out[i] = sc;
        }
        try {
            const usd = parseFloat(process.env.BEDROCK_RERANK_USD);
            require('./cloud_policy').pridejNaklady({ inputTokens: 0, outputTokens: 0, odhadUsd: Number.isFinite(usd) ? usd : 0.002 });
        } catch (e) { /* náklady best-effort */ }
        return out;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Bedrock: přeřadí jen veřejné pasáže báze; úseky ze spisů zůstanou na svých místech a do AWS nejdou.
 */
async function _rerankBedrock(query, top, opts) {
    const gate = opts.gate ? opts.gate() : bedrockGate();
    if (!gate.ok) { stats.bedrockOdepreno++; _warn(`Bedrock nepoužit (${gate.duvod})`, true); return null; }
    const slots = [], kb = [];
    top.forEach((r, i) => { if (_isKb(r)) { slots.push(i); kb.push(r); } });
    if (kb.length < 2) return null;
    let scores;
    try { scores = await scoreViaBedrock(query, kb.map(r => String(r.text || '')), opts); stats.bedrockOk++; }
    catch (e) { stats.bedrockChyba++; stats.posledniChyba = String((e && e.message) || e).slice(0, 200); throw e; }
    if (!scores.some(x => x != null)) return null;
    const ordered = mixOrder(kb, scores, opts.weight != null ? opts.weight : rerankWeight());
    const out = top.slice();
    slots.forEach((pos, j) => { out[pos] = ordered[j]; });
    return out;
}

/**
 * Přeřadí prvních K výsledků (už seřazených a případně deduplikovaných). Zbytek pole zůstává.
 * Vypnutý reranker / chyba / timeout → `results` beze změny (fail-open).
 */
async function rerankResults(query, results, opts = {}) {
    if (!Array.isArray(results) || results.length < 2) return results;
    if (!opts.force && !rerankEnabled()) return results;
    const k = opts.k || rerankK();
    const top = results.slice(0, k);
    const rest = results.slice(k);
    const docs = top.map(r => String(r.text || ''));
    try {
        if ((opts.provider || rerankProvider()) === 'bedrock') {
            const out = await _rerankBedrock(query, top, opts);
            return out ? out.concat(rest) : results;
        }
        const url = opts.url != null ? opts.url : rerankUrl();
        const scores = url ? await scoreViaService(query, docs, { ...opts, url }) : await scoreInProcess(query, docs, opts);
        if (!scores.some(s => s != null)) return results;
        return mixOrder(top, scores, opts.weight != null ? opts.weight : rerankWeight()).concat(rest);
    } catch (e) {
        _warn(e && e.name === 'AbortError' ? `timeout ${opts.timeoutMs || rerankTimeoutMs()} ms` : (e && e.message) || String(e));
        return results;
    }
}

module.exports = { rerankEnabled, rerankK, rerankWeight, rerankTimeoutMs, rerankProvider, bedrockRerankModel, bedrockGate, mixOrder, scoreViaService, scoreInProcess, scoreViaBedrock, rerankResults, stats };
