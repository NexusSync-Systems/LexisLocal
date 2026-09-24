/**
 * Shardování partitionů — velká báze se rozdělí na víc šifrovaných souborů, aby se
 * serializace nedotkla V8 limitu délky řetězce (Cannot create a string longer than
 * 0x1fffffe8). Ověřuje round-trip přes shardy i úklid nadbytečných shardů po zmenšení.
 *
 * DŮLEŽITÉ: env musí být nastaveno PŘED require('../lib/rag') — SHARD_MAX_CHUNKS i
 * DATA_DIR se čtou při načtení modulu.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `lexis_shard_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;        // → DATA_DIR === WATCH_DIR (viz config.js)
process.env.RAG_SHARD_MAX_CHUNKS = '3';

const rag = require('../lib/rag');

function shardFiles() {
    return fs.readdirSync(tmp).filter(f => /^\.rag_[0-9a-f]+(\.p\d+)?\.json$/.test(f)).sort();
}
function mkChunk(i) {
    return {
        id: `s_${i}`,
        fileName: 'doc.txt',
        text: `chunk ${i}`,
        vector: Array.from({ length: 8 }, (_, k) => (i + 1) * 0.01 + k * 0.001),
        embedded: true,
        chunkIndex: i,
        scope: '_kb_test_shard'
    };
}

describe('shardování partitionů (RAG_SHARD_MAX_CHUNKS=3)', () => {
    afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    test('7 chunků → 3 shardy (shard0 + p1 + p2), load sloučí všechny a rekonstruuje vektory', () => {
        const chunks = Array.from({ length: 7 }, (_, i) => mkChunk(i));
        rag.savePartition('_kb_test_shard', { chunks });

        const files = shardFiles();
        expect(files.filter(f => /\.p\d+\.json$/.test(f))).toHaveLength(2); // p1, p2
        expect(files.some(f => /^\.rag_[0-9a-f]+\.json$/.test(f))).toBe(true); // shard0

        const loaded = rag.loadPartition('_kb_test_shard');
        expect(loaded.chunks).toHaveLength(7);
        // pořadí zachováno, vektory rekonstruované z base64
        const ids = loaded.chunks.map(c => c.id);
        expect(ids).toEqual(['s_0', 's_1', 's_2', 's_3', 's_4', 's_5', 's_6']);
        for (const c of loaded.chunks) {
            expect(c.vector).toHaveLength(8);
            expect(c.vec).toBeUndefined();
        }
        expect(loaded.chunks[3].vector[0]).toBeCloseTo(0.04, 5);
        // meta pole _shards se nesmí protéct do výsledku
        expect(loaded._shards).toBeUndefined();
    });

    test('zmenšení báze na 2 chunky → 1 shard, nadbytečné shardy (p1,p2) se smažou', () => {
        rag.savePartition('_kb_test_shard', { chunks: [mkChunk(0), mkChunk(1)] });
        const files = shardFiles();
        expect(files.filter(f => /\.p\d+\.json$/.test(f))).toHaveLength(0);
        const loaded = rag.loadPartition('_kb_test_shard');
        expect(loaded.chunks).toHaveLength(2);
    });

    test('dedup: duplicitní id se při ukládání zahodí', () => {
        rag.savePartition('_kb_test_shard2', { chunks: [mkChunk(0), mkChunk(0), mkChunk(1)] });
        const loaded = rag.loadPartition('_kb_test_shard2');
        expect(loaded.chunks.map(c => c.id)).toEqual(['s_0', 's_1']);
    });

    test('neexistující partition → prázdné chunks', () => {
        expect(rag.loadPartition('_kb_neexistuje').chunks).toEqual([]);
    });
});
