const { loadAgents } = require('../lib/agents');
const { searchSimilar } = require('../lib/rag');
const { checkSubject } = require('../lib/registries');
const ollamaLib = require('ollama');

jest.mock('../lib/agents', () => ({
    loadAgents: jest.fn(),
    // #4: orchestrator nově importuje agentTemperature — mock ho musí poskytnout.
    agentTemperature: (agent, fb) => { const v = agent && agent.temperature; return (typeof v === 'number' && v >= 0 && v <= 1) ? v : fb; }
}));

jest.mock('../lib/rag', () => ({
    searchSimilar: jest.fn()
}));

jest.mock('../lib/registries', () => ({
    checkSubject: jest.fn()
}));

jest.mock('ollama', () => ({
    default: {
        chat: jest.fn()
    },
    chat: jest.fn()
}));

const orchestrator = require('../lib/orchestrator');

describe('ChiefOrchestrator', () => {
    let mockAgents;

    beforeEach(() => {
        jest.clearAllMocks();

        mockAgents = {
            "resersnik": {
                name: "Rešeršník",
                emoji: "🔍",
                role: "Researcher",
                preferredModel: "llama3",
                systemPrompt: "Jsi resersnik.",
                permissions: {}
            },
            "spisovatel": {
                name: "Spisovatel",
                emoji: "✍️",
                role: "Writer",
                preferredModel: "llama3",
                systemPrompt: "Jsi spisovatel.",
                permissions: {}
            }
        };

        loadAgents.mockReturnValue(mockAgents);
    });

    describe('decomposeQuery', () => {
        it('should return default linear plan on parsing failure', async () => {
            ollamaLib.default.chat.mockRejectedValueOnce(new Error('LLM error'));

            const steps = await orchestrator.decomposeQuery('Test prompt', 'llama3');

            expect(steps).toBeInstanceOf(Array);
            expect(steps.length).toBe(3);
            expect(steps[0].agentId).toBe('resersnik');
            expect(steps[1].agentId).toBe('spisovatel');
            expect(steps[2].agentId).toBe('kontrolor');
        });

        it('should return properly parsed JSON array from ollama chat', async () => {
            const mockSteps = [
                { step: 1, agentId: 'resersnik', instruction: 'Do research' },
                { step: 2, agentId: 'spisovatel', instruction: 'Write doc' }
            ];

            ollamaLib.default.chat.mockResolvedValueOnce({
                message: { content: '```json\n' + JSON.stringify(mockSteps) + '\n```' }
            });

            const steps = await orchestrator.decomposeQuery('Test prompt', 'llama3');

            // #1: sanitizeSteps validuje a doplní tier:'advanced' (default).
            expect(steps).toEqual([
                { step: 1, agentId: 'resersnik', instruction: 'Do research', tier: 'advanced' },
                { step: 2, agentId: 'spisovatel', instruction: 'Write doc', tier: 'advanced' }
            ]);
        });
    });

    describe('orchestrate', () => {
        it('should execute successful orchestration process', async () => {
            const mockSteps = [
                { step: 1, agentId: 'resersnik', instruction: 'Do research' }
            ];

            jest.spyOn(orchestrator, 'decomposeQuery').mockResolvedValueOnce(mockSteps);

            ollamaLib.default.chat.mockResolvedValueOnce({
                message: { content: 'Research result' } // Agent output
            });
            ollamaLib.default.chat.mockResolvedValueOnce({
                message: { content: 'Final synthesized response' } // Synthesis output
            });

            const result = await orchestrator.orchestrate('Test prompt');

            expect(result.success).toBe(true);
            expect(result.steps.length).toBe(1);
            expect(result.steps[0].output).toBe('Research result');
            expect(result.finalOutput).toBe('Final synthesized response');
        });

        it('should gracefully skip missing agents', async () => {
            const mockSteps = [
                { step: 1, agentId: 'nonexistent', instruction: 'Do magic' },
                { step: 2, agentId: 'resersnik', instruction: 'Do research' }
            ];

            jest.spyOn(orchestrator, 'decomposeQuery').mockResolvedValueOnce(mockSteps);

            ollamaLib.default.chat.mockResolvedValueOnce({
                message: { content: 'Research result' } // Agent output for resersnik
            });
            ollamaLib.default.chat.mockResolvedValueOnce({
                message: { content: 'Final response' } // Synthesis output
            });

            const result = await orchestrator.orchestrate('Test prompt');

            expect(result.steps.length).toBe(1);
            expect(result.steps[0].agentId).toBe('resersnik');
        });

        it('should handle error during final synthesis', async () => {
            const mockSteps = [
                { step: 1, agentId: 'resersnik', instruction: 'Do research' }
            ];

            jest.spyOn(orchestrator, 'decomposeQuery').mockResolvedValueOnce(mockSteps);

            ollamaLib.default.chat.mockResolvedValueOnce({
                message: { content: 'Research result' } // Agent output
            });
            ollamaLib.default.chat.mockRejectedValueOnce(new Error('Synthesis error'));

            const result = await orchestrator.orchestrate('Test prompt');

            expect(result.success).toBe(true);
            expect(result.finalOutput).toContain('nepodařilo se provést finální syntézu');
            expect(result.finalOutput).toContain('Research result');
        });

        it('should utilize RAG context if agent has read_files permission', async () => {
            mockAgents['resersnik'].permissions = { read_files: true };

            const mockSteps = [
                { step: 1, agentId: 'resersnik', instruction: 'Do research' }
            ];

            jest.spyOn(orchestrator, 'decomposeQuery').mockResolvedValueOnce(mockSteps);

            searchSimilar.mockResolvedValueOnce([
                { score: 0.85, fileName: 'case1.pdf', text: 'Important precedent' }
            ]);

            ollamaLib.default.chat.mockResolvedValue({
                message: { content: 'Agent response' }
            });

            await orchestrator.orchestrate('Test prompt');

            expect(searchSimilar).toHaveBeenCalledWith('Do research', 2, null, { lexicalFallback: true });

            const chatCalls = ollamaLib.default.chat.mock.calls;
            const agentCall = chatCalls[0][0]; // First call options

            expect(agentCall.messages[0].content).toContain('Schválený bezpečný kontext ze spisů');
            expect(agentCall.messages[0].content).toContain('Important precedent');
        });

        it('should utilize Registry context if agent has query_registries permission and ICO is provided', async () => {
            mockAgents['resersnik'].permissions = { query_registries: true };

            const mockSteps = [
                { step: 1, agentId: 'resersnik', instruction: 'Check subject 12345678' }
            ];

            jest.spyOn(orchestrator, 'decomposeQuery').mockResolvedValueOnce(mockSteps);

            checkSubject.mockResolvedValueOnce({
                name: 'Test Company',
                seat: 'Test City',
                inInsolvency: false,
                insolvencyCase: null
            });

            ollamaLib.default.chat.mockResolvedValue({
                message: { content: 'Agent response' }
            });

            await orchestrator.orchestrate('Test prompt');

            expect(checkSubject).toHaveBeenCalledWith('12345678');

            const chatCalls = ollamaLib.default.chat.mock.calls;
            const agentCall = chatCalls[0][0]; // First call options

            expect(agentCall.messages[0].content).toContain('Čerstvá data z registru');
            expect(agentCall.messages[0].content).toContain('Test Company');
        });
    });
});
