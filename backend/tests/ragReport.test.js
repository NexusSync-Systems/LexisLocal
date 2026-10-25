/**
 * #8: buildRagReport — agregace využití RAG z transparency_logs. Čistá funkce.
 */
'use strict';
const { buildRagReport } = require('../lib/rag_report');

const logs = [
    { agentId: 'resersnik', agentName: 'Rešeršník', model: 'qwen2.5:3b', ragSources: [{ fileName: 'a' }, { fileName: 'b' }], timestamp: '2026-09-20T10:00:00Z' },
    { agentId: 'resersnik', agentName: 'Rešeršník', model: 'qwen2.5:3b', ragSources: [], timestamp: '2026-09-21T10:00:00Z' },
    { agentId: 'stylista', agentName: 'Stylista', model: 'qwen2.5:3b (Simulovaný)', ragSources: [], timestamp: '2026-09-21T11:00:00Z' },
    { agentId: 'resersnik', agentName: 'Rešeršník', model: 'qwen2.5:3b', ragSources: [{ fileName: 'c' }], timestamp: '2026-09-22T10:00:00Z' }
];

describe('#8 buildRagReport', () => {
    test('per-agent hit-rate, průměr zdrojů a simulované volání', () => {
        const r = buildRagReport(logs);
        expect(r.totalCalls).toBe(4);
        const res = r.agents.find(a => a.agentId === 'resersnik');
        expect(res.calls).toBe(3);
        expect(res.callsWithRag).toBe(2);
        expect(res.ragHitRatePct).toBeCloseTo(66.7, 1);
        expect(res.avgSourcesPerCall).toBeCloseTo(1, 5); // (2+0+1)/3
        expect(res.totalSources).toBe(3);
        const sty = r.agents.find(a => a.agentId === 'stylista');
        expect(sty.simulatedCalls).toBe(1);
        expect(sty.simulatedRatePct).toBe(100);
    });

    test('agenti seřazeni dle počtu volání sestupně', () => {
        const r = buildRagReport(logs);
        expect(r.agents[0].agentId).toBe('resersnik');
    });

    test('overall souhrn', () => {
        const r = buildRagReport(logs);
        expect(r.overall.callsWithRag).toBe(2);
        expect(r.overall.ragHitRatePct).toBe(50);
        expect(r.overall.simulatedCalls).toBe(1);
    });

    test('sinceMs filtruje starší záznamy', () => {
        const r = buildRagReport(logs, { sinceMs: Date.parse('2026-09-22T00:00:00Z') });
        expect(r.totalCalls).toBe(1);
        expect(r.agents[0].agentId).toBe('resersnik');
    });

    test('prázdný / nevalidní vstup → nulový report bez pádu', () => {
        expect(buildRagReport(null).totalCalls).toBe(0);
        expect(buildRagReport([{ foo: 1 }, null]).totalCalls).toBe(1);
    });
});
