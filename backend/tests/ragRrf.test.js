/**
 * RRF (Reciprocal Rank Fusion) nad výsledky RAG — kombinuje sémantický a lexikální
 * žebříček. Ověřuje, že silný zásah v KTERÉMKOLIV žebříčku táhne dokument nahoru
 * (robustní default, který neregresuje jako čisté přeřazení).
 */
'use strict';
const rag = require('../lib/rag');

describe('applyRrf — fúze sémantického a lexikálního pořadí', () => {
    test('dokument silný v obou žebříčcích vyhraje', () => {
        const res = [
            { fileName: 'A', semantic: 0.9, lexical: 0.9 },
            { fileName: 'B', semantic: 0.5, lexical: 0.5 },
            { fileName: 'C', semantic: 0.1, lexical: 0.1 },
        ];
        rag.applyRrf(res, 60);
        res.sort((a, b) => b.score - a.score);
        expect(res[0].fileName).toBe('A');
        expect(res.every(r => r.method === 'rrf')).toBe(true);
    });

    test('silný lexikální zásah vytáhne dokument slabý v sémantice do horní části', () => {
        // D je v sémantice poslední, ale lexikálně první → RRF ho vytáhne nahoru (nad F/G),
        // i když #1 zůstane E (silné v sémantice i druhé v lexu).
        const res = [
            { fileName: 'E', semantic: 0.80, lexical: 0.30 },
            { fileName: 'F', semantic: 0.78, lexical: 0.28 },
            { fileName: 'G', semantic: 0.76, lexical: 0.26 },
            { fileName: 'D', semantic: 0.20, lexical: 0.99 },
        ];
        rag.applyRrf(res, 1);
        const order = [...res].sort((a, b) => b.score - a.score).map(r => r.fileName);
        // D vytažen do top 2 (z posledního místa v sémantice), nad průměrné F/G
        expect(order.indexOf('D')).toBeLessThanOrEqual(1);
        expect(order.indexOf('D')).toBeLessThan(order.indexOf('F'));
        expect(order.indexOf('D')).toBeLessThan(order.indexOf('G'));
    });

    test('nemění počet výsledků a nastaví skóre všem', () => {
        const res = [
            { fileName: 'X', semantic: 0.4, lexical: 0.2 },
            { fileName: 'Y', semantic: 0.2, lexical: 0.4 },
        ];
        rag.applyRrf(res, 60);
        expect(res).toHaveLength(2);
        expect(res.every(r => typeof r.score === 'number' && r.score > 0)).toBe(true);
    });

    test('konsenzus (silný v obou) přebije dominanci v jediné dimenzi', () => {
        // Právě tohle je smysl RRF: dokument dobrý v OBOU žebříčcích má vyhrát nad
        // dokumentem, který je špička jen v jednom (a proto se čisté přeřazení mýlí).
        const res = [
            { fileName: 'both', semantic: 0.80, lexical: 0.80 },     // sem #2, lex #1
            { fileName: 'semOnly', semantic: 0.90, lexical: 0.10 },  // sem #1, lex #3 (poslední)
            { fileName: 'd1', semantic: 0.70, lexical: 0.70 },       // sem #3, lex #2
        ];
        rag.applyRrf(res, 1);
        const order = [...res].sort((a, b) => b.score - a.score).map(r => r.fileName);
        expect(order[0]).toBe('both');
    });
});
