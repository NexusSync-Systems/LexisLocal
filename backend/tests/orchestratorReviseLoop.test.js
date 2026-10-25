/**
 * #3: smyčka kritika→revize v ChiefOrchestrator. Kontrolor oponuje koncept
 * Spisovatele, ten vytvoří jednu revizi; přepínatelné AGENT_REVISE_LOOP.
 * Vše mockované — bez modelu i disku.
 */
'use strict';

const mockPlan = JSON.stringify([
    { step: 1, agentId: 'spisovatel', instruction: 'napiš předžalobní výzvu', tier: 'advanced' }
]);
// chat rozlišuje fázi podle poslední user zprávy → deterministické výstupy.
const mockChat = jest.fn(async ({ messages }) => {
    const last = String(messages[messages.length - 1].content || '');
    if (/Vypiš KONKRÉTNÍ/.test(last)) return { message: { content: mockState.critique } };
    if (/Zapracuj do KONCEPTU/.test(last)) return { message: { content: 'REVIDOVANÝ KONCEPT — opravený text.' } };
    return { message: { content: mockPlan } };
});
const mockState = { critique: '1) Chybí datum splatnosti.\n2) Nejasná výše dluhu.' };

jest.mock('../lib/ai_provider', () => ({
    chat: (...a) => mockChat(...a),
    embeddings: jest.fn(async () => ({ embedding: [0, 0, 0] }))
}));
jest.mock('../lib/rag', () => ({ searchSimilar: jest.fn(async () => []), listJudikaturaScopes: jest.fn(() => []) }));
jest.mock('../lib/agents', () => ({
    loadAgents: jest.fn(() => ({
        spisovatel: { id: 'spisovatel', name: 'Spisovatel', emoji: '📝', systemPrompt: 'sp', preferredModel: 'draft-m',
            permissions: { read_files: true }, knowledgeScope: '_kb_spisovatel', spisAccess: 'full', temperature: 0.2 },
        kontrolor: { id: 'kontrolor', name: 'Kontrolor', emoji: '⚖️', systemPrompt: 'sp', preferredModel: 'review-m',
            permissions: { read_files: true }, knowledgeScope: '_kb_kontrolor', spisAccess: 'full', temperature: 0.1 }
    })),
    agentTemperature: (agent, fb) => { const v = agent && agent.temperature; return (typeof v === 'number' && v >= 0 && v <= 1) ? v : fb; }
}));
jest.mock('../lib/rag_request', () => jest.requireActual('../lib/rag_request'));
jest.mock('../lib/database', () => ({ insert: jest.fn(() => ({ id: 'x' })), encryptionKey: null }));
jest.mock('../lib/green_monitor', () => ({ calculateInferenceMetrics: () => ({ energyWh: 0, co2Grams: 0 }) }));
jest.mock('../lib/registries', () => ({ checkSubject: jest.fn(async () => ({})) }));
jest.mock('../lib/anonymizer', () => ({ anonymizeText: (s) => s }));
jest.mock('../lib/citation_verifier', () => ({ verifyCitationsWithSources: jest.fn(async () => null) }));

const ChiefOrchestrator = require('../lib/orchestrator');

describe('#3 kritika→revize', () => {
    const OLD = process.env.AGENT_REVISE_LOOP;
    beforeEach(() => { mockChat.mockClear(); mockState.critique = '1) Chybí datum splatnosti.\n2) Nejasná výše dluhu.'; });
    afterEach(() => { if (OLD === undefined) delete process.env.AGENT_REVISE_LOOP; else process.env.AGENT_REVISE_LOOP = OLD; });

    test('koncept Spisovatele → Kontrolor oponuje → Spisovatel reviduje', async () => {
        delete process.env.AGENT_REVISE_LOOP;
        const r = await ChiefOrchestrator.orchestrate('napiš výzvu', '', 'test-model', null, null);
        expect(r.revision).toBeTruthy();
        expect(r.revision.critiqued).toBe(true);
        expect(r.revision.revised).toBe(true);
        expect(r.revision.revisedText).toMatch(/REVIDOVANÝ/);
        const ids = r.steps.map(s => `${s.agentId}:${s.step}`);
        expect(ids).toContain('kontrolor:revize-kritika');
        expect(ids).toContain('spisovatel:revize-oprava');
    });

    test("'BEZ VÝHRAD' → žádná revize", async () => {
        delete process.env.AGENT_REVISE_LOOP;
        mockState.critique = 'BEZ VÝHRAD';
        const r = await ChiefOrchestrator.orchestrate('napiš výzvu', '', 'test-model', null, null);
        expect(r.revision.critiqued).toBe(true);
        expect(r.revision.revised).toBe(false);
        expect(r.steps.some(s => s.step === 'revize-oprava')).toBe(false);
    });

    test('AGENT_REVISE_LOOP=0 → smyčka se nespustí', async () => {
        process.env.AGENT_REVISE_LOOP = '0';
        const r = await ChiefOrchestrator.orchestrate('napiš výzvu', '', 'test-model', null, null);
        expect(r.revision).toBeNull();
        expect(r.steps.some(s => String(s.step).startsWith('revize'))).toBe(false);
    });
});
