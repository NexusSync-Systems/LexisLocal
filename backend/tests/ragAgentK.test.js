const { agentRagK } = require('../lib/rag');

describe('agentRagK', () => {
    const orig = process.env.RAG_AGENT_K;
    afterEach(() => { if (orig === undefined) delete process.env.RAG_AGENT_K; else process.env.RAG_AGENT_K = orig; });

    test('výchozí hodnota je 5', () => { delete process.env.RAG_AGENT_K; expect(agentRagK()).toBe(5); });
    test('respektuje RAG_AGENT_K', () => { process.env.RAG_AGENT_K = '3'; expect(agentRagK()).toBe(3); });
    test('nesmyslná hodnota → 5', () => {
        for (const v of ['0', '99', 'abc', '']) { process.env.RAG_AGENT_K = v; expect(agentRagK()).toBe(5); }
    });
});
