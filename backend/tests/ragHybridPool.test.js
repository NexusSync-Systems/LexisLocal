/**
 * Hybridní vyhledávání s poolem kandidátů (RAG_HYBRID_POOL).
 *
 * PROČ TENHLE TEST EXISTUJE
 * S judikaturou NS/ÚS/NSS má báze rešeršníka ~300 tis. kousků. Lexikální složka hybridu
 * tokenizuje text každého kousku (~0,06 ms) → 10–20 s na dotaz agenta. Teď se lexikální
 * skóre počítá jen pro N nejlepších kandidátů podle sémantiky. Test hlídá, že pool
 * nemění pořadí špičky a že lexikální skóre se mimo pool opravdu nepočítá.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `lexis_pool_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;
process.env.RAG_HYBRID = '1';
process.env.RAG_HYBRID_ALPHA = '0.8';
// Testovací kousky nejsou judikatura (= „zákony"), vlastní pool zákonů by je přidal všechny.
process.env.RAG_HYBRID_POOL_LAWS = '0';

// Deterministický „embedding": vektor podle výskytu několika klíčových slov.
const mockSlova = ['promlčení', 'lhůta', 'škoda', 'nájem', 'byt', 'daň', 'clo', 'výpověď'];
function mockVec(text) {
    const t = String(text).toLowerCase();
    return mockSlova.map(w => (t.includes(w) ? 1 : 0) + 0.01);
}
jest.mock('../lib/ai_provider', () => ({
    embeddings: jest.fn(async ({ prompt }) => ({ embedding: mockVec(prompt) })),
    chat: jest.fn(),
}));

const rag = require('../lib/rag');
const SCOPE = '_kb_pool';

function chunk(i, text) {
    return { id: `p${i}`, fileName: `doc_${i}.txt`, text, vector: mockVec(text), embedded: true, chunkIndex: 0, totalChunks: 1, scope: SCOPE };
}

beforeAll(() => {
    const texty = [
        'Promlčení: obecná promlčecí lhůta je tříletá, škoda se promlčí.',
        'Nájem bytu a výpověď nájmu bytu.',
        'Clo a daň z přidané hodnoty.',
        'Promlčecí lhůta u nájmu.',
    ];
    const chunks = [];
    for (let i = 0; i < 300; i++) chunks.push(chunk(i, texty[i % texty.length] + ` Varianta ${i}.`));
    rag.savePartition(SCOPE, { chunks });
});
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

const FILTERS = { scopes: [SCOPE], clientAccess: false };

test('pool dává stejnou špičku jako výpočet přes celou bázi', async () => {
    const q = 'Jak dlouhá je promlčecí lhůta u náhrady škody?';
    const full = await rag.searchSimilar(q, 10, FILTERS, { hybridPool: 0 });
    const pooled = await rag.searchSimilar(q, 10, FILTERS, { hybridPool: 50 });
    expect(pooled.map(r => r.fileName)).toEqual(full.map(r => r.fileName));
    expect(pooled.map(r => r.score)).toEqual(full.map(r => r.score));
    expect(pooled[0].method).toBe('hybrid');
});

test('lexikální skóre se počítá jen pro pool, ne pro celou bázi', async () => {
    const spy = jest.spyOn(String.prototype, 'normalize');
    try {
        spy.mockClear();
        await rag.searchSimilar('nájem bytu výpověď', 5, FILTERS, { hybridPool: 20 });
        const pooledCalls = spy.mock.calls.length;
        spy.mockClear();
        await rag.searchSimilar('nájem bytu výpověď', 5, FILTERS, { hybridPool: 0 });
        const fullCalls = spy.mock.calls.length;
        // _deaccent volá normalize jednou na text: pool 20 (+ dotaz) vs. 300 kousků.
        expect(pooledCalls).toBeLessThanOrEqual(25);
        expect(fullCalls).toBeGreaterThanOrEqual(300);
    } finally {
        spy.mockRestore();
    }
});

test('kbFilter omezí kandidáty (měření „jen zákony")', async () => {
    const r = await rag.searchSimilar('clo daň', 50, FILTERS, { kbFilter: c => /Clo/.test(c.text) });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every(x => /Clo/.test(x.text))).toBe(true);
});

describe('zákony vs. judikatura ve výsledcích agenta', () => {
    const law = (n, score) => ({ fileName: `OZ 89-2012 § ${n}.txt`, scope: '_kb_resersnik', score });
    const jud = (n, score) => ({ fileName: `NS_${n}_21_Cdo_1_2020.txt`, scope: '_kb_resersnik', score });

    test('rozpozná judikaturu podle názvu i scope', () => {
        expect(rag.isJudikaturaChunk(jud(1))).toBe(true);
        expect(rag.isJudikaturaChunk({ fileName: 'US_I._ÚS_1_23_1.txt', scope: '_kb_resersnik' })).toBe(true);
        expect(rag.isJudikaturaChunk({ fileName: 'NSS_1_2003_x.txt', scope: '_kb_resersnik' })).toBe(true);
        expect(rag.isJudikaturaChunk({ fileName: 'cokoli.txt', scope: '_kb_obor_pracovni_pravo' })).toBe(true);
        expect(rag.isJudikaturaChunk(law('0629'))).toBe(false);
        expect(rag.isJudikaturaChunk({ fileName: 'NS_klient.txt', scope: null })).toBe(false); // klientský spis
    });

    test('k=3: dva paragrafy a jedno rozhodnutí, pořadí podle skóre', () => {
        const sorted = [jud(1, 0.9), jud(2, 0.8), jud(3, 0.7), law('0629', 0.6), law('0619', 0.5), jud(4, 0.4)];
        const out = rag.mixKbResults(sorted, 3, 0.6).slice(0, 3);
        expect(out.map(r => r.fileName)).toEqual(['NS_1_21_Cdo_1_2020.txt', 'OZ 89-2012 § 0629.txt', 'OZ 89-2012 § 0619.txt']);
    });

    test('chybí-li zákony nebo judikatura, nic se nemění', () => {
        const jen = [jud(1, 0.9), jud(2, 0.8), jud(3, 0.7), jud(4, 0.6)];
        expect(rag.mixKbResults(jen, 3, 0.6)).toBe(jen);
        const zakony = [law('1', 0.9), law('2', 0.8), law('3', 0.7), law('4', 0.6)];
        expect(rag.mixKbResults(zakony, 3, 0.6)).toBe(zakony);
    });

    test('málo judikatury → místa doplní zákony; share 0 = vypnuto', () => {
        const sorted = [law('1', 0.9), law('2', 0.8), law('3', 0.7), law('4', 0.6), jud(1, 0.1)];
        expect(rag.mixKbResults(sorted, 3, 0.6).slice(0, 3).map(r => r.fileName)).toEqual([
            'OZ 89-2012 § 1.txt', 'OZ 89-2012 § 2.txt', 'NS_1_21_Cdo_1_2020.txt',
        ]);
        expect(rag.mixKbResults(sorted, 3, 0)).toBe(sorted);
    });
});
