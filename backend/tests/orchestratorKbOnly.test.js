/**
 * #7: agent BEZ přístupu ke klientským spisům, ale s vlastní znalostní bází, smí
 * v orchestrátoru retrievovat — čte JEN svou KB (clientAccess:false).
 * Zároveň ověří #4: krok jede na teplotě agenta.
 */
'use strict';

const mockPlan = JSON.stringify([
    { step: 1, agentId: 'stylista', instruction: 'uprav styl textu', tier: 'light' }
]);
const mockSearchSimilar = jest.fn(async () => []);
const mockChat = jest.fn(async () => ({ message: { content: mockPlan } }));

jest.mock('../lib/ai_provider', () => ({
    chat: (...a) => mockChat(...a),
    embeddings: jest.fn(async () => ({ embedding: [0, 0, 0] }))
}));
jest.mock('../lib/rag', () => ({
    searchSimilar: (...a) => mockSearchSimilar(...a),
    listJudikaturaScopes: jest.fn(() => [])
}));
jest.mock('../lib/agents', () => ({
    loadAgents: jest.fn(() => ({
        stylista: {
            id: 'stylista', name: 'Stylista', emoji: '✍️', role: 'styl',
            systemPrompt: 'sp', preferredModel: 'test-model', temperature: 0.5,
            permissions: { read_files: false, query_registries: false, write_desktop: false },
            knowledgeScope: '_kb_stylista', spisAccess: 'none', useJudikatura: false
        }
    })),
    // helper musí zůstat funkční (orchestrator ho importuje):
    agentTemperature: (agent, fb) => {
        const v = agent && agent.temperature;
        return (typeof v === 'number' && v >= 0 && v <= 1) ? v : fb;
    }
}));
jest.mock('../lib/rag_request', () => {
    const actual = jest.requireActual('../lib/rag_request');
    return actual; // applyAgentScope skutečný — chceme reálné chování scope
});
jest.mock('../lib/database', () => ({ insert: jest.fn(() => ({ id: 'x' })), encryptionKey: null }));
jest.mock('../lib/green_monitor', () => ({ calculateInferenceMetrics: () => ({ energyWh: 0, co2Grams: 0 }) }));
jest.mock('../lib/registries', () => ({ checkSubject: jest.fn(async () => ({})) }));
jest.mock('../lib/anonymizer', () => ({ anonymizeText: (s) => s }));
jest.mock('../lib/citation_verifier', () => ({ verifyCitationsWithSources: jest.fn(async () => null) }));

const ChiefOrchestrator = require('../lib/orchestrator');

describe('#7 KB-only retrieval + #4 teplota kroku', () => {
    beforeEach(() => { mockSearchSimilar.mockClear(); mockChat.mockClear(); });

    test('agent bez read_files, ale s KB, retrievuje jen ze své báze', async () => {
        await ChiefOrchestrator.orchestrate('uprav styl', '', 'test-model', null, null);
        expect(mockSearchSimilar).toHaveBeenCalled();
        const f = mockSearchSimilar.mock.calls[0][2];
        expect(f).toBeTruthy();
        expect(f.scopes).toContain('_kb_stylista');
        expect(f.clientAccess).toBe(false); // nečte klientské spisy
    });

    test('krok jede na teplotě agenta (0.5)', async () => {
        await ChiefOrchestrator.orchestrate('uprav styl', '', 'test-model', null, null);
        const usedTemps = mockChat.mock.calls
            .map(c => c[0] && c[0].options && c[0].options.temperature)
            .filter(t => typeof t === 'number');
        expect(usedTemps).toContain(0.5);
    });
});
