/**
 * Odložené ukládání znalostních bází (RAG_KB_SAVE_DEBOUNCE_MS).
 *
 * PROČ: hromadné plnění (seed-kb) zapisovalo po každém souboru znovu shard 0 (až 6000
 * kousků s vektory) → ~1 soubor/s a zpomalování. S odložením se zapisuje jednou za
 * okno klidu. Test hlídá: změna je hned vidět v paměti, na disk se dostane po flush
 * (časovač / flushPendingSaves / exit) a výsledek na disku je úplný.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `lexis_defer_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;
process.env.RAG_SHARD_MAX_CHUNKS = '3';

const rag = require('../lib/rag');
const SCOPE = '_kb_defer';

function chunk(i) {
    return { id: `d_${i}`, fileName: `doc_${i}.txt`, text: `kousek ${i}`, vector: [i, 1, 0.5, 0.25], embedded: true, chunkIndex: 0, scope: SCOPE };
}
function loadFromDisk(scope) {
    const prev = process.env.RAG_PARTITION_CACHE;
    process.env.RAG_PARTITION_CACHE = '0';
    try { return rag.loadPartition(scope); }
    finally { if (prev == null) delete process.env.RAG_PARTITION_CACHE; else process.env.RAG_PARTITION_CACHE = prev; }
}
const shardFiles = () => fs.readdirSync(tmp, { recursive: true }).map(String).filter(f => /\.rag_[0-9a-f]+(\.p\d+)?\.json$/.test(f));

afterEach(() => { rag.flushPendingSaves(); delete process.env.RAG_KB_SAVE_DEBOUNCE_MS; delete process.env.RAG_KB_SAVE_MAX_MS; });

test('vypnuto (výchozí): zápis hned', () => {
    rag.savePartition(SCOPE, { chunks: [chunk(1)] });
    expect(loadFromDisk(SCOPE).chunks).toHaveLength(1);
});

test('zapnuto: deset zápisů = žádný zápis na disk, v paměti vše; flush zapíše úplný stav', () => {
    process.env.RAG_KB_SAVE_DEBOUNCE_MS = '60000';
    rag.savePartition(SCOPE, { chunks: [] }); // výchozí stav
    rag.flushPendingSaves();
    const before = loadFromDisk(SCOPE).chunks.length;
    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    let cur = [];
    for (let i = 0; i < 10; i++) {
        cur = rag.loadPartition(SCOPE).chunks.concat([chunk(i)]);
        rag.savePartition(SCOPE, { chunks: cur });
    }
    const shardWrites = writeSpy.mock.calls.filter(c => /\.rag_[0-9a-f]+(\.p\d+)?\.json$/.test(String(c[0]))).length;
    writeSpy.mockRestore();
    expect(shardWrites).toBe(0);
    expect(rag.loadPartition(SCOPE).chunks).toHaveLength(10);   // hned vidět v paměti
    expect(loadFromDisk(SCOPE).chunks).toHaveLength(before);     // disk zatím beze změny
    rag.flushPendingSaves();
    const disk = loadFromDisk(SCOPE).chunks;
    expect(disk).toHaveLength(10);                                // 4 shardy po 3
    expect(disk.map(c => c.id).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `d_${i}`).sort());
    expect(shardFiles().length).toBeGreaterThanOrEqual(4);
});

test('časovač zapíše sám po okně klidu', async () => {
    process.env.RAG_KB_SAVE_DEBOUNCE_MS = '30';
    rag.savePartition('_kb_defer2', { chunks: [chunk(1), chunk(2)] });
    expect(loadFromDisk('_kb_defer2').chunks).toHaveLength(0);
    await new Promise(r => setTimeout(r, 120));
    expect(loadFromDisk('_kb_defer2').chunks).toHaveLength(2);
});

test('jen báze agentů (_kb_*) — spisy se zapisují hned', () => {
    process.env.RAG_KB_SAVE_DEBOUNCE_MS = '60000';
    rag.savePartition('spis_defer', { chunks: [Object.assign(chunk(5), { scope: undefined })] });
    expect(loadFromDisk('spis_defer').chunks).toHaveLength(1);
});
