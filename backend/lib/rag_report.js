'use strict';
/**
 * rag_report.js — přehled reálného využití RAG po agentech (#8).
 *
 * Čte transparency ledger (transparency_logs), kam každé volání agenta zapisuje
 * `ragSources` (pasáže, které RAG dodal). Spočítá per-agent, jak často agent
 * skutečně dostal aspoň jednu RAG pasáž → tvrdá data pro rozhodnutí „kde se RAG
 * vyplatí" (viz AGENTS_RAG_STRATEGIE.md). Zároveň hlásí podíl volání, která
 * spadla na simulovaný fallback (model = „… (Simulovaný)") — signál chybějícího
 * modelu (viz model_preflight.js).
 *
 * Jádro `buildRagReport()` je čistá funkce nad polem logů (bez DB) → testovatelné.
 */

function _isSimulated(model) { return /\(Simulovan/i.test(String(model || '')); }

/**
 * @param {Array} logs - záznamy transparency_logs ({ agentId, agentName, model, ragSources:[] })
 * @param {Object} [opts] - { sinceMs } volitelně jen novější než timestamp
 * @returns {Object} přehled { generatedAt, totalCalls, overall, agents:[...] }
 */
function buildRagReport(logs, opts) {
    opts = opts || {};
    const since = opts.sinceMs ? Number(opts.sinceMs) : null;
    const rows = Array.isArray(logs) ? logs : [];

    const byAgent = new Map();
    let totalCalls = 0, totalWithRag = 0, totalSources = 0, totalSimulated = 0;

    for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        if (since) { const t = Date.parse(r.timestamp || ''); if (Number.isFinite(t) && t < since) continue; }
        const id = r.agentId || 'neznámý';
        const sources = Array.isArray(r.ragSources) ? r.ragSources.length : 0;
        const withRag = sources > 0 ? 1 : 0;
        const simulated = _isSimulated(r.model) ? 1 : 0;

        let a = byAgent.get(id);
        if (!a) { a = { agentId: id, agentName: r.agentName || id, calls: 0, callsWithRag: 0, totalSources: 0, simulatedCalls: 0 }; byAgent.set(id, a); }
        if (r.agentName) a.agentName = r.agentName;
        a.calls += 1; a.callsWithRag += withRag; a.totalSources += sources; a.simulatedCalls += simulated;

        totalCalls += 1; totalWithRag += withRag; totalSources += sources; totalSimulated += simulated;
    }

    const pct = (n, d) => d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
    const round2 = x => Math.round(x * 100) / 100;

    const agents = [...byAgent.values()].map(a => ({
        agentId: a.agentId,
        agentName: a.agentName,
        calls: a.calls,
        callsWithRag: a.callsWithRag,
        ragHitRatePct: pct(a.callsWithRag, a.calls),
        avgSourcesPerCall: round2(a.calls ? a.totalSources / a.calls : 0),
        totalSources: a.totalSources,
        simulatedCalls: a.simulatedCalls,
        simulatedRatePct: pct(a.simulatedCalls, a.calls)
    })).sort((x, y) => y.calls - x.calls);

    return {
        generatedAt: new Date().toISOString(),
        totalCalls,
        overall: {
            callsWithRag: totalWithRag,
            ragHitRatePct: pct(totalWithRag, totalCalls),
            avgSourcesPerCall: round2(totalCalls ? totalSources / totalCalls : 0),
            simulatedCalls: totalSimulated,
            simulatedRatePct: pct(totalSimulated, totalCalls)
        },
        agents
    };
}

module.exports = { buildRagReport };
