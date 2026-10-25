/**
 * Znalostní báze (_kb_*) má vlastní, větší kousky (RAG_KB_CHUNK_MAX_CHARS, výchozí 2000) —
 * měření 11. 10. 2026: zákony rozsekané na 700 znaků se hledají hůř (66 % vs. 69 % na 1. místě).
 * Klientské spisy zůstávají na RAG_CHUNK_MAX_CHARS (700).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `lexis_kbchunk_${Date.now()}`);
if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;

const rag = require('../lib/rag');

// ~1500 znaků: odstavce po ~300 znacích (jako dlouhý paragraf zákona).
const ODST = 'Ujednají-li strany pro případ porušení smluvené povinnosti smluvní pokutu v určité výši nebo způsob, ' +
    'jak se výše smluvní pokuty určí, může věřitel požadovat smluvní pokutu bez zřetele k tomu, zda mu porušením ' +
    'utvrzené povinnosti vznikla škoda, a to v plné výši.';
const PARAGRAF = ['Zákon č. 89/2012 Sb., občanský zákoník', '§ 2048 — Smluvní pokuta']
    .concat([1, 2, 3, 4, 5].map(i => `(${i}) ${ODST}`)).join('\n');

describe('kousky znalostní báze', () => {
    const OLD = process.env.RAG_KB_CHUNK_MAX_CHARS;
    afterEach(() => { if (OLD === undefined) delete process.env.RAG_KB_CHUNK_MAX_CHARS; else process.env.RAG_KB_CHUNK_MAX_CHARS = OLD; });
    afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    test('výchozí 2000, laditelné env, spodní mez 200', () => {
        delete process.env.RAG_KB_CHUNK_MAX_CHARS;
        expect(rag.kbChunkMaxChars()).toBe(2000);
        process.env.RAG_KB_CHUNK_MAX_CHARS = '1200';
        expect(rag.kbChunkMaxChars()).toBe(1200);
        process.env.RAG_KB_CHUNK_MAX_CHARS = '50';
        expect(rag.kbChunkMaxChars()).toBe(200);
        process.env.RAG_KB_CHUNK_MAX_CHARS = 'x';
        expect(rag.kbChunkMaxChars()).toBe(2000);
    });

    test('paragraf ~1500 znaků: v bázi 1 kousek, obecné dělení (700) víc kousků', async () => {
        delete process.env.RAG_KB_CHUNK_MAX_CHARS;
        expect(PARAGRAF.length).toBeGreaterThan(1200);
        expect(PARAGRAF.length).toBeLessThan(2000);
        expect(rag.chunkText(PARAGRAF).length).toBeGreaterThan(1);
        const r = await rag.indexKnowledge('_kb_test', 'OZ § 2048.txt', PARAGRAF);
        expect(r.indexed).toBe(1);
        const ch = rag.loadPartition('_kb_test').chunks.filter(c => c.fileName === 'OZ § 2048.txt');
        expect(ch).toHaveLength(1);
        expect(ch[0].text).toContain('§ 2048');
        expect(ch[0].text).toContain('(5)');
    });

    test('RAG_KB_CHUNK_MAX_CHARS=700 vrací dřívější chování', async () => {
        process.env.RAG_KB_CHUNK_MAX_CHARS = '700';
        const r = await rag.indexKnowledge('_kb_test', 'OZ § 2048b.txt', PARAGRAF);
        expect(r.indexed).toBe(rag.chunkText(PARAGRAF).length);
    });
});
