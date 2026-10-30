/**
 * local_embed.js — vyhledávací model v aplikaci (režim jen cloud, bez Ollamy). Transformers podvržené.
 */
const LE = require('../lib/local_embed');

function fakeTf(calls) {
    return {
        env: {},
        pipeline: async (task, model, opts) => {
            calls.push({ task, model, opts });
            return async (text, o) => { calls.push({ text, o }); return { data: Float32Array.from([0.6, 0.8]) }; };
        }
    };
}

describe('local_embed', () => {
    beforeEach(() => LE._reset());
    test('bge-m3: CLS pooling + normalizace, tvar jako Ollama, model se načte jednou', async () => {
        const calls = [];
        const tf = fakeTf(calls);
        const r = await LE.embeddings({ prompt: 'Smluvní pokuta' }, { transformers: tf });
        await LE.embeddings({ input: 'Druhý text' }, { transformers: tf });
        expect(r.embedding.map(x => Math.round(x * 10) / 10)).toEqual([0.6, 0.8]);
        expect(calls.filter(c => c.task).length).toBe(1);
        expect(calls[0]).toMatchObject({ task: 'feature-extraction', model: 'Xenova/bge-m3', opts: { dtype: 'fp32' } });
        expect(calls[1]).toMatchObject({ text: 'Smluvní pokuta', o: { pooling: 'cls', normalize: true } });
        expect(calls[2].text).toBe('Druhý text');
    });
    test('ai_provider: AI_EMBED_PROVIDER=onnx volá model v aplikaci, ne Ollamu', async () => {
        jest.resetModules();
        jest.doMock('../lib/local_embed', () => ({ embeddings: jest.fn(async () => ({ embedding: [1, 0] })), MODEL_ID: 'x' }));
        jest.doMock('../lib/ollama_client', () => ({ embeddings: jest.fn(async () => { throw new Error('Ollama se volat nemá'); }), chat: jest.fn() }));
        const prev = process.env.AI_EMBED_PROVIDER; process.env.AI_EMBED_PROVIDER = 'onnx';
        try {
            const ai = require('../lib/ai_provider');
            expect(await ai.embeddings({ model: 'bge-m3', prompt: 'x' })).toEqual({ embedding: [1, 0] });
        } finally { if (prev === undefined) delete process.env.AI_EMBED_PROVIDER; else process.env.AI_EMBED_PROVIDER = prev; jest.dontMock('../lib/local_embed'); jest.dontMock('../lib/ollama_client'); }
    });
});
