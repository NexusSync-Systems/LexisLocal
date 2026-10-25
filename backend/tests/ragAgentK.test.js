const { agentRagK } = require('../lib/rag');

describe('agentRagK', () => {
    const orig = process.env.RAG_AGENT_K;
    afterEach(() => { if (orig === undefined) delete process.env.RAG_AGENT_K; else process.env.RAG_AGENT_K = orig; });

    test('výchozí hodnota je 4 (bez rerankeru)', () => { delete process.env.RAG_AGENT_K; delete process.env.RAG_RERANK; expect(agentRagK()).toBe(4); });
    test('se zapnutým rerankerem je výchozí 5', () => { delete process.env.RAG_AGENT_K; const o = process.env.RAG_RERANK; process.env.RAG_RERANK = '1'; try { expect(agentRagK()).toBe(5); } finally { if (o === undefined) delete process.env.RAG_RERANK; else process.env.RAG_RERANK = o; } });
    test('respektuje RAG_AGENT_K', () => { process.env.RAG_AGENT_K = '5'; expect(agentRagK()).toBe(5); });
    test('nesmyslná hodnota → 3', () => {
        delete process.env.RAG_RERANK; for (const v of ['0', '99', 'abc', '']) { process.env.RAG_AGENT_K = v; expect(agentRagK()).toBe(4); }
    });
});
