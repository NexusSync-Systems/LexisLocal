/**
 * Kompaktní podoba velkých partitionů v paměti (texty v UTF-8 bufferu, vektory Int8).
 *
 * PROČ TENHLE TEST EXISTUJE
 * Báze rešeršníka (297 tis. kousků) zabírala RSS ~8 GB a Mac ji odkládal do swapu.
 * Kompaktní podoba ji zmenšuje zhruba na třetinu, ale mění vnitřní tvar kousku:
 * `text` je getter a `vector` je Int8Array se škálou. Test hlídá, že navenek se nic
 * nezmění — text, pořadí hledání, zápis na disk i přírůstkové ukládání.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `lexis_compact_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;
process.env.RAG_SHARD_MAX_CHUNKS = '40';
process.env.RAG_COMPACT_MIN = '10';
process.env.RAG_HYBRID = '0';

let mockSeed = 7;
const mockRnd = () => { mockSeed = (mockSeed * 1103515245 + 12345) & 0x7fffffff; return mockSeed / 0x7fffffff; };
const mockVec = (d = 64) => { const v = Array.from({ length: d }, () => mockRnd() - 0.5); const n = Math.hypot(...v); return v.map(x => x / n); };
jest.mock('../lib/ai_provider', () => ({ embeddings: jest.fn(async () => ({ embedding: mockVec() })), chat: jest.fn() }));

const rag = require('../lib/rag');
const SCOPE = '_kb_compact';
const TEXTY = ['Žalobce se domáhá náhrady škody — § 2910 občanského zákoníku.', 'Nájemné a výpověď nájmu bytu; „uvozovky" a € symbol.', 'Krátký'];
const orig = [];
for (let i = 0; i < 100; i++) {
    orig.push({ id: `c${i}`, fileName: i % 10 === 0 ? `OZ 89-2012 § ${i}.txt` : `NS_${i}_x.txt`, text: `${TEXTY[i % 3]} (${i})`, vector: mockVec(), embedded: true, chunkIndex: 0, totalChunks: 1, scope: SCOPE });
}
function fromDisk() {
    rag._resetPartitionCache();
    process.env.RAG_PARTITION_CACHE = '0';
    try { return rag.loadPartition(SCOPE); } finally { delete process.env.RAG_PARTITION_CACHE; }
}

beforeAll(() => { rag.savePartition(SCOPE, { chunks: orig }); rag._resetPartitionCache(); });
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

test('po načtení: texty stejné, vektory Int8 se škálou, hodnoty blízko originálu', () => {
    const p = rag.loadPartition(SCOPE);
    expect(p.chunks).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
        const c = p.chunks[i];
        expect(c.text).toBe(orig[i].text);
        expect(c.vector).toBeInstanceOf(Int8Array);
        const fv = rag.floatVector(c);
        const max = Math.max(...orig[i].vector.map(Math.abs));
        for (let j = 0; j < fv.length; j++) expect(Math.abs(fv[j] - orig[i].vector[j])).toBeLessThanOrEqual(max / 254 + 1e-6);
        expect(Object.keys(c)).not.toContain('text'); // text není vlastní klíč — je v bufferu
    }
});

test('kosinová podobnost s Int8 dává prakticky stejné pořadí jako float', () => {
    const p = rag.loadPartition(SCOPE);
    let shoda = 0;
    for (let q = 0; q < 20; q++) {
        const qv = mockVec();
        const top = list => list.map((v, i) => [rag.cosineSimilarity(qv, v), i]).sort((a, b) => b[0] - a[0]).slice(0, 5).map(x => x[1]);
        const a = top(orig.map(c => c.vector)), b = top(p.chunks.map(c => c.vector));
        if (a[0] === b[0]) shoda++;
    }
    expect(shoda).toBeGreaterThanOrEqual(19);
});

test('zápis na disk z kompaktní podoby: plný text a float vektory', () => {
    const p = rag.loadPartition(SCOPE);
    p.chunks[5].text = 'Přepsaný text kousku 5.';      // setter
    rag.savePartition(SCOPE, { chunks: p.chunks });
    const d = fromDisk();
    expect(d.chunks[5].text).toBe('Přepsaný text kousku 5.');
    expect(d.chunks[6].text).toBe(orig[6].text);
    const v = rag.floatVector(d.chunks[6]);
    expect(Math.abs(v[0] - orig[6].vector[0])).toBeLessThan(0.02);
    expect(d.chunks.every(c => c.vecScale === undefined || c.vector instanceof Int8Array)).toBe(true);
});

test('přírůstkový zápis: nezměněné kompaktní shardy se nepřepisují', () => {
    rag._resetPartitionCache();
    const p = rag.loadPartition(SCOPE);
    const spy = jest.spyOn(fs, 'writeFileSync');
    try {
        p.chunks.push({ id: 'nove', fileName: 'NS_nove.txt', text: 'Nový kousek', vector: mockVec(), embedded: true, scope: SCOPE });
        rag.savePartition(SCOPE, { chunks: p.chunks });
        const zapsane = spy.mock.calls.map(c => path.basename(String(c[0]))).filter(f => /^\.rag_/.test(f));
        expect(zapsane.length).toBeLessThanOrEqual(2); // poslední shard + shard 0, ne všechny tři
    } finally { spy.mockRestore(); }
});

test('hledání (čistá sémantika, pool) vrací texty a kompaktní kousky fungují', async () => {
    rag._resetPartitionCache();
    const r = await rag.searchSimilar('cokoli', 5, { scopes: [SCOPE], clientAccess: false }, { hybridPool: 20 });
    expect(r).toHaveLength(5);
    expect(r.every(x => typeof x.text === 'string' && x.text.length > 0)).toBe(true);
});

test('RAG_VEC_INT8=0 → Float32 v souvislém bloku', () => {
    process.env.RAG_VEC_INT8 = '0';
    try {
        rag._resetPartitionCache();
        const p = rag.loadPartition(SCOPE);
        expect(p.chunks[1].vector).toBeInstanceOf(Float32Array);
        expect(p.chunks[1].vector.buffer).toBe(p.chunks[2].vector.buffer); // jeden blok na shard
    } finally { delete process.env.RAG_VEC_INT8; }
});

test('malá partition (pod RAG_COMPACT_MIN) zůstává v běžné podobě', () => {
    rag.savePartition('_kb_male', { chunks: orig.slice(0, 5) });
    rag._resetPartitionCache();
    const p = rag.loadPartition('_kb_male');
    expect(Object.keys(p.chunks[0])).toContain('text');
    expect(p.chunks[0].vector).toBeInstanceOf(Float32Array);
});

test('předehřátí po startu načte registrované báze; RAG_WARMUP=0 vypne', async () => {
    await rag.indexKnowledge('_kb_warm', 'a.txt', 'Text pro předehřátí báze.');
    rag._resetPartitionCache();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
        const r = await rag.warmKnowledgeBases({ delayMs: 0 });
        expect(r.scopes.find(s => s.scope === '_kb_warm').chunks).toBe(1);
        process.env.RAG_WARMUP = '0';
        expect(await rag.warmKnowledgeBases({ delayMs: 0 })).toEqual({ skipped: true });
    } finally { delete process.env.RAG_WARMUP; log.mockRestore(); }
});
