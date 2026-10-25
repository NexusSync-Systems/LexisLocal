/**
 * Kompaktní úložiště vektorů (base64 Float32) + dedup + zpětná kompatibilita čtení.
 * Řeší V8 limit délky řetězce u velkých partitionů (bge-m3 1024-dim).
 */
'use strict';
const rag = require('../lib/rag');

describe('kompaktní vektory (base64 Float32)', () => {
    test('round-trip zachová hodnoty (Float32 přesnost) a je výrazně kratší', () => {
        const vec = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.5);
        const b64 = rag.vecToBase64(vec);
        expect(typeof b64).toBe('string');
        const back = rag.base64ToVec(b64);
        expect(back).toHaveLength(1024);
        for (let i = 0; i < 1024; i++) expect(back[i]).toBeCloseTo(vec[i], 5);
        // base64 Float32 musí být kratší než JSON pole čísel
        expect(b64.length).toBeLessThan(JSON.stringify(vec).length);
    });

    test('null / prázdný vektor → null (neembedovaný chunk)', () => {
        expect(rag.vecToBase64(null)).toBeNull();
        expect(rag.vecToBase64([])).toBeNull();
        expect(rag.base64ToVec(null)).toBeNull();
        expect(rag.base64ToVec('')).toBeNull();
    });
});

describe('encode/decode chunku na disk', () => {
    test('encode nahradí vector→vec (base64), decode ho rekonstruuje', () => {
        const chunk = { id: 'c1', fileName: 'a.txt', text: 't', vector: [0.1, 0.2, 0.3], embedded: true, chunkIndex: 0 };
        const enc = rag.encodeChunkForDisk(chunk);
        expect(enc.vector).toBeUndefined();
        expect(typeof enc.vec).toBe('string');
        expect(enc.text).toBe('t');
        expect(enc.embedded).toBe(true);
        const dec = rag.decodeChunkFromDisk(enc);
        expect(dec.vec).toBeUndefined();
        expect(dec.vector).toHaveLength(3);
        expect(dec.vector[0]).toBeCloseTo(0.1, 5);
    });

    test('starý formát (vector pole, žádné vec) projde čtením beze změny', () => {
        const old = { id: 'c2', fileName: 'b.txt', vector: [1, 2, 3], text: 'x' };
        const dec = rag.decodeChunkFromDisk(old);
        expect(dec.vector).toEqual([1, 2, 3]);
        expect(dec.vec).toBeUndefined();
    });

    test('chunk bez vektoru (null) → bez pole vec', () => {
        const enc = rag.encodeChunkForDisk({ id: 'c3', fileName: 'c.txt', vector: null, embedded: false });
        expect(enc.vec).toBeUndefined();
        expect(enc.embedded).toBe(false);
    });
});

describe('dedup chunků', () => {
    test('zahodí duplicitní id', () => {
        const out = rag.dedupChunks([
            { id: 'a', fileName: 'f', chunkIndex: 0 },
            { id: 'a', fileName: 'f', chunkIndex: 0 },
            { id: 'b', fileName: 'f', chunkIndex: 1 }
        ]);
        expect(out.map(c => c.id)).toEqual(['a', 'b']);
    });
    test('bez id dedup dle fileName#chunkIndex', () => {
        const out = rag.dedupChunks([
            { fileName: 'f', chunkIndex: 0 },
            { fileName: 'f', chunkIndex: 0 },
            { fileName: 'f', chunkIndex: 1 }
        ]);
        expect(out).toHaveLength(2);
    });
});
