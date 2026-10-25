/**
 * Přírůstkový zápis partitionů a cache v paměti.
 *
 * PROČ TENHLE TEST EXISTUJE
 * Nahrávání judikatury NS (~9 800 rozhodnutí, ~130 tis. kousků) trvalo dny a server
 * padal na „heap out of memory": každý nahraný dokument znovu dešifroval, zakódoval
 * a přepsal CELOU partition. Teď se přepisují jen změněné shardy (+ shard 0 s meta)
 * a dešifrovaná partition zůstává v paměti. Test hlídá obě úspory i to hlavní:
 * že výsledek na disku je pořád úplný a správný (čtení bez cache to ověří).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `lexis_incr_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;
process.env.RAG_SHARD_MAX_CHUNKS = '3';

const rag = require('../lib/rag');
const SCOPE = '_kb_incr';

function mkChunk(i, val) {
    return {
        id: `c_${i}`,
        fileName: `doc_${Math.floor(i / 2)}.txt`,
        text: `kousek ${i}`,
        vector: Array.from({ length: 4 }, (_, k) => (val != null ? val : i) + k * 0.25),
        embedded: true,
        chunkIndex: i % 2,
        scope: SCOPE
    };
}
function shardWrites(spy) {
    return spy.mock.calls
        .map(c => path.basename(String(c[0])))
        .filter(f => /^\.rag_[0-9a-f]+(\.p\d+)?\.json$/.test(f));
}
/** Načtení přímo z disku, bez cache — kontrola, že zápis je úplný. */
function loadFromDisk(scope) {
    const prev = process.env.RAG_PARTITION_CACHE;
    process.env.RAG_PARTITION_CACHE = '0';
    try { return rag.loadPartition(scope); }
    finally { if (prev == null) delete process.env.RAG_PARTITION_CACHE; else process.env.RAG_PARTITION_CACHE = prev; }
}

describe('přírůstkový zápis partitionů (RAG_SHARD_MAX_CHUNKS=3)', () => {
    let writeSpy;
    beforeEach(() => {
        rag._resetPartitionCache();
        writeSpy = jest.spyOn(fs, 'writeFileSync');
    });
    afterEach(() => writeSpy.mockRestore());
    afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    test('přidání dokumentu přepíše jen poslední shard a shard 0, ne celou partition', () => {
        const chunks = Array.from({ length: 7 }, (_, i) => mkChunk(i)); // shardy: 3 + 3 + 1
        rag.savePartition(SCOPE, { chunks });
        expect(shardWrites(writeSpy)).toHaveLength(3);
        writeSpy.mockClear();

        // Stejný postup jako indexKnowledge: načíst, odfiltrovat, přidat na konec, uložit.
        const part = rag.loadPartition(SCOPE);
        const kept = part.chunks.filter(c => c.fileName !== 'doc_99.txt');
        kept.push(mkChunk(7));
        rag.savePartition(SCOPE, { chunks: kept });

        const written = shardWrites(writeSpy);
        expect(written).toHaveLength(2);
        expect(written.some(f => /\.p2\.json$/.test(f))).toBe(true);
        expect(written.some(f => /^\.rag_[0-9a-f]+\.json$/.test(f))).toBe(true);
        expect(written.some(f => /\.p1\.json$/.test(f))).toBe(false);

        const disk = loadFromDisk(SCOPE);
        expect(disk.chunks.map(c => c.id)).toEqual(['c_0', 'c_1', 'c_2', 'c_3', 'c_4', 'c_5', 'c_6', 'c_7']);
    });

    test('přibude-li shard, přepíše se jen nový shard a shard 0 (ne celá báze)', () => {
        const chunks = Array.from({ length: 9 }, (_, i) => mkChunk(100 + i)); // 3 plné shardy
        rag.savePartition(SCOPE, { chunks });
        writeSpy.mockClear();
        const kept = rag.loadPartition(SCOPE).chunks;
        kept.push(mkChunk(200));                                               // → 4. shard
        rag.savePartition(SCOPE, { chunks: kept });
        const written = shardWrites(writeSpy).sort();
        expect(written).toHaveLength(2);
        expect(written.some(f => /\.p3\.json$/.test(f))).toBe(true);
        expect(written.some(f => /^\.rag_[0-9a-f]+\.json$/.test(f))).toBe(true);
        expect(loadFromDisk(SCOPE).chunks).toHaveLength(10);
    });

    test('loadPartitionAsync: stejný výsledek jako loadPartition a mezi shardy pustí jiné úlohy', async () => {
        rag.savePartition(SCOPE, { chunks: Array.from({ length: 10 }, (_, i) => mkChunk(300 + i)) }); // 4 shardy
        rag._resetPartitionCache();
        let tiky = 0;
        const tik = () => { tiky++; if (tiky < 50) setImmediate(tik); };
        setImmediate(tik);
        const a = await rag.loadPartitionAsync(SCOPE);
        const tikyBehemNacteni = tiky;
        rag._resetPartitionCache();
        const b = rag.loadPartition(SCOPE);
        expect(a.chunks.map(c => c.id)).toEqual(b.chunks.map(c => c.id));
        expect(tikyBehemNacteni).toBeGreaterThanOrEqual(3); // 3 přestávky (po shardech 1–3)
    });

    test('uložení beze změny nezapíše nic', () => {
        rag.savePartition(SCOPE, { chunks: Array.from({ length: 5 }, (_, i) => mkChunk(i)) });
        writeSpy.mockClear();
        const part = rag.loadPartition(SCOPE);
        rag.savePartition(SCOPE, { chunks: part.chunks });
        expect(shardWrites(writeSpy)).toHaveLength(0);
    });

    test('změna vektoru uvnitř (reindex) přepíše dotčený shard a shard 0', () => {
        rag.savePartition(SCOPE, { chunks: Array.from({ length: 7 }, (_, i) => mkChunk(i)) });
        writeSpy.mockClear();
        const part = rag.loadPartition(SCOPE);
        part.chunks[4].vector = Float32Array.from([9, 9, 9, 9]); // shard p1
        rag.savePartition(SCOPE, { chunks: part.chunks });

        const written = shardWrites(writeSpy);
        expect(written.some(f => /\.p1\.json$/.test(f))).toBe(true);
        expect(written.some(f => /\.p2\.json$/.test(f))).toBe(false);
        expect(Array.from(loadFromDisk(SCOPE).chunks[4].vector)).toEqual([9, 9, 9, 9]);
    });

    test('smazání dokumentu uprostřed posune shardy — přepíšou se, výsledek je úplný', () => {
        rag.savePartition(SCOPE, { chunks: Array.from({ length: 7 }, (_, i) => mkChunk(i)) });
        const part = rag.loadPartition(SCOPE);
        rag.savePartition(SCOPE, { chunks: part.chunks.filter(c => c.fileName !== 'doc_1.txt') });
        expect(loadFromDisk(SCOPE).chunks.map(c => c.id)).toEqual(['c_0', 'c_1', 'c_4', 'c_5', 'c_6']);
    });

    test('po restartu (prázdná cache) se stav shardů obnoví z načtení — opět jen 2 zápisy', () => {
        rag.savePartition(SCOPE, { chunks: Array.from({ length: 7 }, (_, i) => mkChunk(i)) });
        rag._resetPartitionCache(); // jako nový proces
        writeSpy.mockClear();

        const part = rag.loadPartition(SCOPE);
        part.chunks.push(mkChunk(7));
        rag.savePartition(SCOPE, { chunks: part.chunks });
        expect(shardWrites(writeSpy)).toHaveLength(2);
        expect(loadFromDisk(SCOPE).chunks).toHaveLength(8);
    });

    test('zápis jiným procesem zneplatní cache — nečte se zastaralá data', () => {
        rag.savePartition(SCOPE, { chunks: [mkChunk(0), mkChunk(1)] });
        expect(rag.loadPartition(SCOPE).chunks).toHaveLength(2);

        // „Jiný proces" (např. scripts/reindex-kb.js) zapíše bez naší cache.
        const prev = process.env.RAG_PARTITION_CACHE;
        process.env.RAG_PARTITION_CACHE = '0';
        rag.savePartition(SCOPE, { chunks: [mkChunk(0), mkChunk(1), mkChunk(2), mkChunk(3)] });
        if (prev == null) delete process.env.RAG_PARTITION_CACHE; else process.env.RAG_PARTITION_CACHE = prev;

        expect(rag.loadPartition(SCOPE).chunks.map(c => c.id)).toEqual(['c_0', 'c_1', 'c_2', 'c_3']);
        // …a následný přírůstkový zápis nesmí vycházet ze starého stavu shardů.
        const part = rag.loadPartition(SCOPE);
        part.chunks.push(mkChunk(4));
        rag.savePartition(SCOPE, { chunks: part.chunks });
        expect(loadFromDisk(SCOPE).chunks.map(c => c.id)).toEqual(['c_0', 'c_1', 'c_2', 'c_3', 'c_4']);
    });
});

describe('cache partitionů v paměti', () => {
    beforeEach(() => rag._resetPartitionCache());

    test('opakované načtení nečte ani nedešifruje soubory', () => {
        rag.savePartition(SCOPE, { chunks: Array.from({ length: 7 }, (_, i) => mkChunk(i)) });
        rag._resetPartitionCache();
        rag.loadPartition(SCOPE); // první čtení z disku
        const readSpy = jest.spyOn(fs, 'readFileSync');
        try {
            const again = rag.loadPartition(SCOPE);
            expect(again.chunks).toHaveLength(7);
            const shardReads = readSpy.mock.calls.filter(c => /\.rag_[0-9a-f]+/.test(String(c[0])));
            expect(shardReads).toHaveLength(0);
        } finally {
            readSpy.mockRestore();
        }
    });

    test('volající dostane kopii pole — filtr ani push nezmění cache', () => {
        rag.savePartition(SCOPE, { chunks: [mkChunk(0), mkChunk(1), mkChunk(2)] });
        const a = rag.loadPartition(SCOPE);
        a.chunks.length = 0;
        a.chunks.push(mkChunk(9));
        expect(rag.loadPartition(SCOPE).chunks.map(c => c.id)).toEqual(['c_0', 'c_1', 'c_2']);
    });

    test('RAG_PARTITION_CACHE=0 vypne cache i přírůstkový zápis (staré chování)', () => {
        process.env.RAG_PARTITION_CACHE = '0';
        try {
            rag.savePartition(SCOPE, { chunks: Array.from({ length: 7 }, (_, i) => mkChunk(i)) });
            const spy = jest.spyOn(fs, 'writeFileSync');
            try {
                const part = rag.loadPartition(SCOPE);
                rag.savePartition(SCOPE, { chunks: part.chunks });
                expect(shardWrites(spy)).toHaveLength(3);
            } finally { spy.mockRestore(); }
        } finally {
            delete process.env.RAG_PARTITION_CACHE;
        }
    });
});

describe('vektory v paměti jako Float32Array', () => {
    beforeEach(() => rag._resetPartitionCache());

    test('načtené vektory jsou Float32Array a kosinová podobnost funguje beze změny', () => {
        rag.savePartition(SCOPE, { chunks: [mkChunk(0, 1)] });
        rag._resetPartitionCache();
        const v = rag.loadPartition(SCOPE).chunks[0].vector;
        expect(v).toBeInstanceOf(Float32Array);
        expect(rag.isVector(v)).toBe(true);
        expect(rag.cosineSimilarity(v, [1, 1.25, 1.5, 1.75])).toBeCloseTo(1, 5);
    });

    test('isVector: pole i typované pole ano; null, prázdné a DataView ne', () => {
        expect(rag.isVector([1, 2])).toBe(true);
        expect(rag.isVector(new Float32Array([1]))).toBe(true);
        expect(rag.isVector(null)).toBe(false);
        expect(rag.isVector([])).toBe(false);
        expect(rag.isVector(new DataView(new ArrayBuffer(4)))).toBe(false);
    });

    test('base64 round-trip z Float32Array i z pole dává totéž', () => {
        const a = rag.vecToBase64([0.5, -1, 2]);
        const b = rag.vecToBase64(Float32Array.from([0.5, -1, 2]));
        expect(a).toBe(b);
        expect(Array.from(rag.base64ToVec(a))).toEqual([0.5, -1, 2]);
    });
});
