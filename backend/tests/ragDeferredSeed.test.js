/**
 * Odložené ukládání při skutečném plnění (indexKnowledge) — NOVÁ báze, časovač zapisuje
 * uprostřed nahrávání. Server 24. 10. 2026: z 8813 nahraných paragrafů zůstalo v bázi 7792
 * (dokud nová báze neměla na disku shard 0, loadPartition vracel prázdnou bázi a každé
 * nahrání přepsalo odložený stav jen sebou).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `lexis_defseed_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';
process.env.RAG_SHARD_MAX_CHUNKS = '50';

jest.mock('../lib/ai_provider', () => Object.assign({}, jest.requireActual('../lib/ai_provider'), {
    embeddings: jest.fn(async ({ prompt }) => ({ embedding: [prompt.length % 7, 0.5, -0.25, 1 / 3] }))
}));
const rag = require('../lib/rag');

function fromDisk(scope) {
    const prev = process.env.RAG_PARTITION_CACHE;
    process.env.RAG_PARTITION_CACHE = '0';
    try { return rag.loadPartition(scope); } finally { if (prev == null) delete process.env.RAG_PARTITION_CACHE; else process.env.RAG_PARTITION_CACHE = prev; }
}
const docs = chunks => new Set(chunks.map(c => c.fileName)).size;

afterEach(() => { rag.flushPendingSaves(); delete process.env.RAG_KB_SAVE_DEBOUNCE_MS; delete process.env.RAG_KB_SAVE_MAX_MS; });

test.each([
    ['nová báze, zápisy časovačem během nahrávání', '_kb_defseed_a', 1, 8],
    ['nová báze, bez mezizápisu (jen flush na konci)', '_kb_defseed_b', 60000, 600000],
])('%s: všech 300 dokumentů je v paměti i na disku', async (_n, scope, deb, max) => {
    process.env.RAG_KB_SAVE_DEBOUNCE_MS = String(deb);
    process.env.RAG_KB_SAVE_MAX_MS = String(max);
    for (let i = 0; i < 300; i++) {
        await rag.indexKnowledge(scope, `doc_${i}.txt`, `Paragraf ${i}. Text paragrafu číslo ${i}.`);
        if (i % 25 === 0) await new Promise(r => setTimeout(r, 15)); // časovač stihne zapsat
        expect(docs(rag.loadPartition(scope).chunks)).toBe(i + 1);
    }
    rag.flushPendingSaves();
    expect(docs(fromDisk(scope).chunks)).toBe(300);
});
