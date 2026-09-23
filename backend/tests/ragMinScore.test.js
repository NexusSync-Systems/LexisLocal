/**
 * Testy konfigurovatelného RAG prahu (RAG_MIN_SCORE) — viz lib/model_config.js.
 * Práh se čte z env při require, proto resetModules + nastavení env před require.
 */
'use strict';

describe('RAG_MIN_SCORE (model_config)', () => {
    const OLD = process.env.RAG_MIN_SCORE;
    afterEach(() => {
        if (OLD === undefined) delete process.env.RAG_MIN_SCORE;
        else process.env.RAG_MIN_SCORE = OLD;
        jest.resetModules();
    });

    function load() {
        jest.resetModules();
        return require('../lib/model_config').RAG_MIN_SCORE;
    }

    test('default je 0.60, když env není nastaveno', () => {
        delete process.env.RAG_MIN_SCORE;
        expect(load()).toBeCloseTo(0.60, 10);
    });

    test('env hodnotu v rozsahu 0..1 respektuje', () => {
        process.env.RAG_MIN_SCORE = '0.5';
        expect(load()).toBeCloseTo(0.5, 10);
        process.env.RAG_MIN_SCORE = '0.75';
        expect(load()).toBeCloseTo(0.75, 10);
    });

    test('neplatnou / mimo-rozsah hodnotu ignoruje → 0.60', () => {
        for (const bad of ['abc', '-0.1', '1.5', '', '  ']) {
            process.env.RAG_MIN_SCORE = bad;
            expect(load()).toBeCloseTo(0.60, 10);
        }
    });

    test('krajní hodnoty 0 a 1 jsou platné', () => {
        process.env.RAG_MIN_SCORE = '0';
        expect(load()).toBe(0);
        process.env.RAG_MIN_SCORE = '1';
        expect(load()).toBe(1);
    });
});
