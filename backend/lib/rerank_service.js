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
 *                                Limit volání: BEDROCK_RERANK_RPM (výchozí 3 = kvóta nového účtu), čekání na volný slot
 *                                nejvýš BEDROCK_RERANK_MAX_WAIT_MS (výchozí 3000 — asistent jinak hledá bez přeřazení),
 *                                po 429 až BEDROCK_RERANK_RETRIES opakování (výchozí 2); výsledky 10 min v cache.
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
const stats = { bedrockOk: 0, bedrockChyba: 0, bedrockOdepreno: 0, bedrockLimit: 0, bedrockCache: 0, bedrockOpakovani: 0, posledniChyba: null }; // pro měření a diagnostiku
// Denní počítadla pro Manažerský přehled (od startu serveru; generálka 2. 11. 2026: ze zkráceného logu se nedalo
// zjistit, kolik hledání se kvůli kvótě obešlo bez přeřazení).
const _den = { datum: null, prerazeno: 0, zCache: 0, limit: 0, chyba: 0, odepreno: 0 };
function _dnes(k) {
    const d = new Date().toISOString().slice(0, 10);
    if (_den.datum !== d) Object.assign(_den, { datum: d, prerazeno: 0, zCache: 0, limit: 0, chyba: 0, odepreno: 0 });
    _den[k]++;
}
/** Přehled pro Manažerský přehled: null, když přeřazení přes Bedrock není zapnuté. */
function prehledPrerazeni() {
    if (!rerankEnabled() || rerankProvider() !== 'bedrock') return null;
    const d = new Date().toISOString().slice(0, 10);
    const dnes = _den.datum === d ? Object.assign({}, _den) : { datum: d, prerazeno: 0, zCache: 0, limit: 0, chyba: 0, odepreno: 0 };
    delete dnes.datum;
    return {
        model: bedrockRerankModel(), limitZaMinutu: bedrockRpm(), datum: d, dnes,
        odStartu: { prerazeno: stats.bedrockOk, zCache: stats.bedrockCache, limit: stats.bedrockLimit, chyba: stats.bedrockChyba, odepreno: stats.bedrockOdepreno, opakovani: stats.bedrockOpakovani },
        posledniChyba: stats.posledniChyba
    };
}
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
// --- Limit volání a cache (1. 11. 2026: nový účet má kvótu Cohere Rerank 3/min, Amazon Rerank 2/min) ---
function bedrockRpm() { const v = parseInt(process.env.BEDROCK_RERANK_RPM, 10); return v > 0 ? v : 3; }
function bedrockMaxWaitMs(opts) {
    if (opts && Number.isFinite(opts.maxWaitMs)) return opts.maxWaitMs;
    const v = parseInt(process.env.BEDROCK_RERANK_MAX_WAIT_MS, 10); return v >= 0 ? v : 3000; // asistent nečeká dlouho
}
function bedrockRetries() { const v = parseInt(process.env.BEDROCK_RERANK_RETRIES, 10); return v >= 0 ? v : 2; }
const _calls = new Map();          // model → časy volání za poslední minutu
let _limQueue = Promise.resolve(); // přidělování slotů po jednom
const _sleep = ms => new Promise(r => setTimeout(r, ms));

/** Počká na volný slot v limitu volání za minutu; když by čekání přesáhlo deadline, vyhodí { limit: true }. */
function _acquire(model, deadline, opts) {
    const now = (opts && opts.now) || Date.now, sleep = (opts && opts.sleep) || _sleep, rpm = bedrockRpm();
    const run = async () => {
        for (;;) {
            const arr = (_calls.get(model) || []).filter(t => now() - t < 60000);
            _calls.set(model, arr);
            if (arr.length < rpm) { arr.push(now()); return; }
            const wait = arr[0] + 60000 - now() + 50;
            if (now() + wait > deadline) throw Object.assign(new Error(`limit ${rpm} volání/min`), { limit: true });
            await sleep(wait);
        }
    };
    const p = _limQueue.then(run, run);
    _limQueue = p.catch(() => {});
    return p;
}

const _cache = new Map(); // klíč → { t, scores }; stejný dotaz nad stejnými pasážemi se neplatí znovu
const CACHE_TTL = 10 * 60 * 1000, CACHE_MAX = 500;
function _cacheKey(model, query, docs) {
    return require('crypto').createHash('sha256').update(model + '\u0000' + query + '\u0000' + docs.join('\u0001')).digest('hex');
}

/**
 * Skóre pasáží báze z Bedrock Rerank (brána pravidel cloudu, cache, limit volání, opakování po 429).
 * `items` musí být jen veřejné pasáže báze (scope _kb_*). Vrací pole skóre, nebo null (nepoužito / chyba → původní pořadí).
 */
async function bedrockScores(query, items, opts) {
    opts = opts || {};
    const kb = (items || []).filter(_isKb);
    if (kb.length !== (items || []).length) throw new Error('do Bedrocku smí jen pasáže báze (_kb_*)');
    if (kb.length < 2) return null;
    const gate = opts.gate ? opts.gate() : bedrockGate();
    if (!gate.ok) { stats.bedrockOdepreno++; _dnes('odepreno'); _warn(`Bedrock nepoužit (${gate.duvod})`, true); return null; }
    const model = bedrockRerankModel();
    const docs = kb.map(r => String(r.text || '').slice(0, 4000));
    const key = _cacheKey(model, String(query), docs);
    const hit = _cache.get(key);
    const now = opts.now || Date.now, sleep = opts.sleep || _sleep;
    if (hit && now() - hit.t < CACHE_TTL) { stats.bedrockCache++; _dnes('zCache'); return hit.scores; }
    const deadline = now() + bedrockMaxWaitMs(opts);
    for (let pokus = 0; ; pokus++) {
        try {
            await _acquire(model, deadline, opts);
        } catch (e) {
            stats.bedrockLimit++; _dnes('limit'); _warn(`Bedrock Rerank: ${e.message}`, true); return null;
        }
        try {
            const scores = await scoreViaBedrock(query, docs, opts);
            stats.bedrockOk++; _dnes('prerazeno');
            _cache.set(key, { t: now(), scores });
            if (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
            return scores;
        } catch (e) {
            const msg = String((e && e.message) || e);
            const throttled = / 429[: ]|ThrottlingException|Too many|rate is too high/i.test(msg);
            if (throttled && pokus < bedrockRetries()) {
                const wait = Math.min(1000 * Math.pow(2, pokus), Math.max(0, deadline - now()));
                if (wait > 0 || deadline - now() > 0) { stats.bedrockOpakovani++; await sleep(wait); continue; }
            }
            stats.bedrockChyba++; _dnes('chyba'); stats.posledniChyba = msg.slice(0, 200);
            throw e;
        }
    }
}

/**
 * Přeřadí v `top` jen položky, které mají skóre v `scoreOf` (Map položka → skóre); ostatní (úseky ze spisů)
 * zůstanou na svých místech. Vrací nové pole.
 */
function applyScores(top, scoreOf, weight) {
    const slots = [], kb = [];
    top.forEach((r, i) => { if (scoreOf.has(r)) { slots.push(i); kb.push(r); } });
    if (kb.length < 2) return top.slice();
    const ordered = mixOrder(kb, kb.map(r => scoreOf.get(r)), weight != null ? weight : rerankWeight());
    const out = top.slice();
    slots.forEach((pos, j) => { out[pos] = ordered[j]; });
    return out;
}

/** Jedno volání pro víc skupin najednou (zákony + judikatura): Map položka → skóre, nebo null. */
async function bedrockScoresMap(query, items, opts) {
    const kb = (items || []).filter(_isKb);
    const scores = await bedrockScores(query, kb, opts);
    if (!scores || !scores.some(x => x != null)) return null;
    const m = new Map();
    kb.forEach((r, i) => { if (scores[i] != null) m.set(r, scores[i]); });
    return m;
}

/**
 * Bedrock: přeřadí jen veřejné pasáže báze; úseky ze spisů zůstanou na svých místech a do AWS nejdou.
 */
async function _rerankBedrock(query, top, opts) {
    const m = await bedrockScoresMap(query, top.filter(_isKb), opts);
    return m ? applyScores(top, m, opts.weight) : null;
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

module.exports = { rerankEnabled, rerankK, rerankWeight, rerankTimeoutMs, rerankProvider, bedrockRerankModel, bedrockGate, mixOrder, scoreViaService, scoreInProcess, scoreViaBedrock, bedrockScores, bedrockScoresMap, applyScores, bedrockRpm, rerankResults, stats, prehledPrerazeni, _resetBedrock: () => { _calls.clear(); _cache.clear(); _limQueue = Promise.resolve(); _den.datum = null; } };
