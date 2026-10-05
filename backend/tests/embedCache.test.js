/**
 * Cache vektorů (lib/embed_cache.js) — zrychlení plnění báze na testovacím serveru.
 * Vypnutá bez EMBED_CACHE_FILE; se souborem vrací stejné vektory (float32) bez volání modelu.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `lexis_test_embcache_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

let mockCalls = 0;
jest.mock('../lib/ai_provider', () => Object.assign({}, jest.requireActual('../lib/ai_provider'), {
    embeddings: jest.fn(async ({ prompt }) => { mockCalls++; return { embedding: [prompt.length, 0.5, -0.25, 1 / 3] }; })
}));

const ec = require('../lib/embed_cache');
const rag = require('../lib/rag');

afterEach(() => { delete process.env.EMBED_CACHE_FILE; ec._reset(); });

test('bez EMBED_CACHE_FILE vypnutá — model se volá pokaždé, nic se neukládá', async () => {
    mockCalls = 0;
    await rag.getEmbedding('§ 2165 OZ');
    await rag.getEmbedding('§ 2165 OZ');
    expect(mockCalls).toBe(2);
    expect(ec.stats().enabled).toBe(false);
});

test('se souborem: druhé volání z cache, přežije restart (nové načtení ze souboru)', async () => {
    const f = path.join(tmp, 'cache', 'emb.jsonl');
    process.env.EMBED_CACHE_FILE = f;
    mockCalls = 0;
    const v1 = await rag.getEmbedding('Rozhodčí doložka ve spotřebitelské smlouvě');
    const v2 = await rag.getEmbedding('Rozhodčí doložka ve spotřebitelské smlouvě');
    expect(mockCalls).toBe(1);
    expect(v2[0]).toBe(v1[0]);
    expect(v2[3]).toBeCloseTo(1 / 3, 6); // float32 — rozdíl jen v řádu 1e-8
    expect(fs.readFileSync(f, 'utf8').trim().split('\n')).toHaveLength(1);

    ec._reset(); // jako nový proces
    mockCalls = 0;
    await rag.getEmbedding('Rozhodčí doložka ve spotřebitelské smlouvě');
    expect(mockCalls).toBe(0);
    expect(ec.stats()).toMatchObject({ loaded: 1, hits: 1 });
});

test('klíč závisí na modelu i textu; poškozený řádek se přeskočí', () => {
    expect(ec.keyOf('bge-m3', 'a')).not.toBe(ec.keyOf('nomic', 'a'));
    const f = path.join(tmp, 'broken.jsonl');
    fs.writeFileSync(f, 'nesmysl\n' + JSON.stringify({ k: ec.keyOf('m', 't'), v: ec.encode([1, 2]) }) + '\n');
    process.env.EMBED_CACHE_FILE = f;
    expect(ec.get('m', 't')).toEqual([1, 2]);
});
