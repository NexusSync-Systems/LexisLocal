/**
 * B1: ChiefOrchestrator musí per krok obohatit RAG filtry o znalostní bázi agenta
 * (applyAgentScope). Dřív volal searchSimilar s holými ragFilters → agenti v
 * orchestrátoru NEčerpali z vlastní KB (_kb_<id>) ani z judikatury.
 *
 * Vše kolem AI/DB je mockované, test nesahá na žádný model ani na disk.
 * (Proměnné v jest.mock factory musí mít prefix `mock` — hoisting pravidlo.)
 */
'use strict';

const mockPlan = JSON.stringify([
    { step: 1, agentId: 'resersnik', instruction: 'analyzuj nájemní spor', tier: 'advanced' }
]);
const mockSearchSimilar = jest.fn(async () => []);

jest.mock('../lib/ai_provider', () => ({
    chat: jest.fn(async () => ({ message: { content: mockPlan } })),
    embeddings: jest.fn(async () => ({ embedding: [0, 0, 0] }))
}));
jest.mock('../lib/rag', () => ({
    searchSimilar: (...a) => mockSearchSimilar(...a),
    listJudikaturaScopes: jest.fn(() => [])
}));
jest.mock('../lib/agents', () => ({
    loadAgents: jest.fn(() => ({
        resersnik: {
            id: 'resersnik', name: 'Rešeršník', emoji: '📚', role: 'r',
            systemPrompt: 'sp', preferredModel: 'test-model',
            permissions: { read_files: true, query_registries: false, write_desktop: false },
            knowledgeScope: '_kb_resersnik', spisAccess: 'full', useJudikatura: true
        }
    })),
    agentTemperature: (agent, fb) => {
        const v = agent && agent.temperature;
        return (typeof v === 'number' && v >= 0 && v <= 1) ? v : fb;
    }
}));
jest.mock('../lib/database', () => ({ insert: jest.fn(() => ({ id: 'x' })), encryptionKey: null }));
jest.mock('../lib/green_monitor', () => ({ calculateInferenceMetrics: () => ({ energyWh: 0, co2Grams: 0 }) }));
jest.mock('../lib/registries', () => ({ checkSubject: jest.fn(async () => ({})) }));
jest.mock('../lib/anonymizer', () => ({ anonymizeText: (s) => s }));
jest.mock('../lib/citation_verifier', () => ({ verifyCitationsWithSources: jest.fn(async () => null) }));

const ChiefOrchestrator = require('../lib/orchestrator');

describe('B1: per-agent scope v orchestrátoru', () => {
    beforeEach(() => mockSearchSimilar.mockClear());

    test('searchSimilar dostane filtry se znalostní bází agenta (_kb_resersnik)', async () => {
        await ChiefOrchestrator.orchestrate('napiš rozbor', '', 'test-model', null, null);
        expect(mockSearchSimilar).toHaveBeenCalled();
        const filtersArg = mockSearchSimilar.mock.calls[0][2];
        expect(filtersArg).toBeTruthy();
        expect(Array.isArray(filtersArg.scopes)).toBe(true);
        expect(filtersArg.scopes).toContain('_kb_resersnik');
    });

    test('filtry nejsou null — regresní pojistka proti návratu holého ragFilters', async () => {
        await ChiefOrchestrator.orchestrate('napiš rozbor', '', 'test-model', null, null);
        const filtersArg = mockSearchSimilar.mock.calls[0][2];
        expect(filtersArg).not.toBeNull();
    });
});
