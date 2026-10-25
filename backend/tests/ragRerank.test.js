/**
 * Volitelný reranker RAG (lib/rerank_service.js + rag.searchSimilar opts.rerank) — fáze 2
 * k lib/reranker.js (ONNX v procesu) + varianta přes lokální službu (RAG_RERANK_URL).
 * Mění jen pořadí top-K, `score` zůstává (prahy RAG_MIN_SCORE/0.70 drží význam);
 * vypnutý / chyba / timeout → původní pořadí (fail-open).
 */
const reranker = require('../lib/rerank_service');

const ENV = ['RAG_RERANK', 'RAG_RERANK_URL', 'RAG_RERANK_K', 'RAG_RERANK_WEIGHT', 'RAG_RERANK_TIMEOUT_MS'];
const saved = {};
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const R = (name, score) => ({ fileName: name, text: 'text ' + name, score });

function fakeFetch(scoresByText, { status = 200, delayMs = 0 } = {}) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        if (delayMs) {
            await new Promise((res, rej) => {
                const t = setTimeout(res, delayMs);
                init.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
            });
        }
        const docs = JSON.parse(init.body).documents;
        return {
            ok: status === 200, status,
            json: async () => ({ results: docs.map((d, index) => ({ index, relevance_score: scoresByText[d] })).reverse() }),
        };
    };
    fn.calls = calls;
    return fn;
}

describe('reranker — konfigurace', () => {
    test('výchozí stav vypnuto; zapíná RAG_RERANK=1', () => {
        expect(reranker.rerankEnabled()).toBe(false);
        process.env.RAG_RERANK = '1';
        expect(reranker.rerankEnabled()).toBe(true);
        process.env.RAG_RERANK = '0';
        expect(reranker.rerankEnabled()).toBe(false);
    });
    test('K a váha mají meze a výchozí hodnoty 20 / 0.85', () => {
        expect(reranker.rerankK()).toBe(20);
        expect(reranker.rerankWeight()).toBe(0.85);
        process.env.RAG_RERANK_K = '500'; process.env.RAG_RERANK_WEIGHT = '7';
        expect(reranker.rerankK()).toBe(50);
        expect(reranker.rerankWeight()).toBe(1);
        process.env.RAG_RERANK_K = '0'; process.env.RAG_RERANK_WEIGHT = '-1';
        expect(reranker.rerankK()).toBe(2);
        expect(reranker.rerankWeight()).toBe(0);
    });
});

describe('mixOrder', () => {
    test('β=1 řadí čistě podle rerankeru, score zůstává', () => {
        const top = [R('a', 0.9), R('b', 0.8), R('c', 0.7)];
        const out = reranker.mixOrder(top, [0.1, 5, 2], 1);
        expect(out.map(r => r.fileName)).toEqual(['b', 'c', 'a']);
        expect(out.map(r => r.score)).toEqual([0.8, 0.7, 0.9]);
        expect(out[0].rerankScore).toBe(5);
    });
    test('β=0 zachová původní pořadí', () => {
        const top = [R('a', 0.9), R('b', 0.8), R('c', 0.7)];
        expect(reranker.mixOrder(top, [0, 9, 5], 0).map(r => r.fileName)).toEqual(['a', 'b', 'c']);
    });
    test('chybějící skóre → položka za přeřazenými; vstup se nemutuje', () => {
        const top = [R('a', 0.9), R('b', 0.8), R('c', 0.7)];
        const out = reranker.mixOrder(top, [null, 1, 2], 1);
        expect(out.map(r => r.fileName)).toEqual(['c', 'b', 'a']);
        expect(top[0].rerankScore).toBeUndefined();
    });
});

describe('rerankResults', () => {
    const results = [R('a', 0.9), R('b', 0.8), R('c', 0.7), R('d', 0.6)];

    test('vypnutý → beze změny a bez volání služby', async () => {
        const f = fakeFetch({});
        const out = await reranker.rerankResults('dotaz', results, { fetchImpl: f });
        expect(out).toBe(results);
        expect(f.calls).toHaveLength(0);
    });

    test('přeřadí jen top K, zbytek ponechá; posílá dotaz a texty na /v1/rerank', async () => {
        process.env.RAG_RERANK = '1'; process.env.RAG_RERANK_URL = 'http://127.0.0.1:8081';
        const f = fakeFetch({ 'text a': 0, 'text b': 1, 'text c': 9 });
        const out = await reranker.rerankResults('soused dluží', results, { fetchImpl: f, k: 3, weight: 1 });
        expect(out.map(r => r.fileName)).toEqual(['c', 'b', 'a', 'd']);
        expect(f.calls[0].url).toBe('http://127.0.0.1:8081/v1/rerank');
        expect(f.calls[0].body).toEqual({ query: 'soused dluží', documents: ['text a', 'text b', 'text c'], top_n: 3 });
    });

    test('bez URL → v procesu (lib/reranker.js); jeho fail-open (bez skóre) = původní pořadí', async () => {
        process.env.RAG_RERANK = '1';
        const inProcess = { rerank: async (q, cands) => cands.map(c => ({ ...c, rerankScore: c.text === 'text d' ? 9 : 1 })).reverse() };
        const out = await reranker.rerankResults('q', results, { inProcess, weight: 1 });
        expect(out.map(r => r.fileName)).toEqual(['d', 'a', 'b', 'c']);
        const failing = { rerank: async (q, cands) => cands };
        expect(await reranker.rerankResults('q', results, { inProcess: failing })).toBe(results);
    });

    test('HTTP chyba → původní pořadí (fail-open)', async () => {
        process.env.RAG_RERANK = '1'; process.env.RAG_RERANK_URL = 'http://x';
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const out = await reranker.rerankResults('q', results, { fetchImpl: fakeFetch({}, { status: 500 }) });
        expect(out).toBe(results);
        warn.mockRestore();
    });

    test('timeout → původní pořadí', async () => {
        process.env.RAG_RERANK = '1'; process.env.RAG_RERANK_URL = 'http://x';
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const out = await reranker.rerankResults('q', results, { fetchImpl: fakeFetch({ 'text a': 1 }, { delayMs: 500 }), timeoutMs: 30 });
        expect(out).toBe(results);
        warn.mockRestore();
    });
});
