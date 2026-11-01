'use strict';
// Noční test 31. 10. 2026: po restartu dotaz agenta načetl velkou bázi synchronně (dřív, než ji
// stihlo předehřátí) a server minutu neodpovídal. Vyhledávání teď čte partitiony asynchronně
// po shardech a souběžné dotazy sdílejí jedno načtení.
const fs = require('fs');
const path = require('path');
const os = require('os');

jest.mock('ollama', () => ({ embeddings: jest.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }), chat: jest.fn() }));

const tmp = path.join(os.tmpdir(), `lexis_loadshared_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;
process.env.RAG_SHARD_MAX_CHUNKS = '3';
process.env.RAG_RERANK = '0';

const rag = require('../lib/rag');
const SCOPE = '_kb_loadshared';
const mk = i => ({ id: `s_${i}`, fileName: `OZ 89-2012 § ${i}.txt`, text: `zákon ${i}`, vector: [0.1, 0.2, 0.3 + i / 100], embedded: true, chunkIndex: 0, scope: SCOPE });

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('vyhledávání v bázi na studené cache pouští mezi shardy jiné požadavky', async () => {
    rag.savePartition(SCOPE, { chunks: Array.from({ length: 15 }, (_, i) => mk(i)) }); // 5 shardů
    rag._resetPartitionCache();
    let tiky = 0, hotovo = false;
    const tik = () => { tiky++; if (!hotovo && tiky < 200) setImmediate(tik); };
    setImmediate(tik);
    const tikyPred = tiky;
    const res = await rag.searchSimilar('dotaz', 5, { scopes: [SCOPE], clientAccess: false });
    hotovo = true;
    expect(res.length).toBeGreaterThan(0);
    expect(tiky - tikyPred).toBeGreaterThanOrEqual(4); // přestávky po shardech 1–4
});

test('dva souběžné dotazy na studenou bázi: jedno čtení shardu 0', async () => {
    rag._resetPartitionCache();
    const spy = jest.spyOn(fs, 'readFileSync');
    const [a, b] = await Promise.all([
        rag.searchSimilar('dotaz', 3, { scopes: [SCOPE], clientAccess: false }),
        rag.searchSimilar('dotaz', 3, { scopes: [SCOPE], clientAccess: false })
    ]);
    const shard0 = spy.mock.calls.filter(c => /^\.rag_[0-9a-f]+\.json$/.test(path.basename(String(c[0])))).length;
    spy.mockRestore();
    expect(shard0).toBe(1);
    expect(a.map(r => r.id || r.fileName)).toEqual(b.map(r => r.id || r.fileName));
});
