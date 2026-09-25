/**
 * Testy re-embeddingu znalostních bází agentů (reindexKnowledge / reindexAllKnowledge).
 * Embeddings jsou MOCKOVANÉ (žádná síť) — vracejí řízený vektor, aby šlo ověřit, že
 * reindex přepíše staré vektory novými (klíčové po změně embedding modelu).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `lexis_kbre_${Date.now()}`);
if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;

// Mock AI providera: embeddings vrací aktuální global.__vec (chat nepoužíváme).
global.__vec = [1, 1, 1];
jest.mock('../lib/ai_provider', () => ({
    embeddings: jest.fn(async () => ({ embedding: global.__vec })),
    chat: jest.fn()
}));

const rag = require('../lib/rag');

describe('reindexKnowledge / reindexAllKnowledge', () => {
    afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    test('re-embedduje existující chunky NOVÝM vektorem (po změně modelu)', async () => {
        global.__vec = [1, 1, 1];
        await rag.indexKnowledge('_kb_reindex', 'doc.txt', 'Text do znalostní báze.');
        let part = rag.loadPartition('_kb_reindex');
        expect(part.chunks.length).toBeGreaterThan(0);
        expect(part.chunks[0].vector).toEqual([1, 1, 1]);

        // „změna embedding modelu" → jiný vektor
        global.__vec = [2, 2, 2];
        const res = await rag.reindexKnowledge('_kb_reindex');
        expect(res.embedded).toBe(part.chunks.length);

        part = rag.loadPartition('_kb_reindex');
        expect(part.chunks.every(c => JSON.stringify(c.vector) === JSON.stringify([2, 2, 2]))).toBe(true);
        expect(part.chunks.every(c => c.embedded === true)).toBe(true);
        // text a počet chunků se nemění
        expect(part.chunks[0].text).toContain('znalostní báze');
    });

    test('prázdný scope → nic k re-embeddingu', async () => {
        const res = await rag.reindexKnowledge('_kb_neexistuje');
        expect(res).toEqual({ scope: '_kb_neexistuje', chunks: 0, embedded: 0, reused: 0 });
    });

    test('reindexAllKnowledge projde registrované báze', async () => {
        global.__vec = [3, 3, 3];
        await rag.indexKnowledge('_kb_alpha', 'a.txt', 'Alfa text.');
        await rag.indexKnowledge('_kb_beta', 'b.txt', 'Beta text.');
        const results = await rag.reindexAllKnowledge();
        const scopes = results.map(r => r.scope);
        expect(scopes).toEqual(expect.arrayContaining(['_kb_alpha', '_kb_beta']));
        // po reindexu mají báze nový vektor
        expect(rag.loadPartition('_kb_alpha').chunks.every(c => JSON.stringify(c.vector) === JSON.stringify([3, 3, 3]))).toBe(true);
    });
});
