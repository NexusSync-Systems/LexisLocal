/**
 * Interní tool-registry pro roj (agent_tools.js) — Fáze 1, READ-ONLY.
 * Testuje permission gating, exec, bounded tool-loop a fallback. Bez Ollamy:
 * provider je mock, který vrací tool_calls a pak finální text.
 */
'use strict';
const os = require('os'), fs = require('fs'), path = require('path');
process.env.WATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_at_'));
// Hermetické testy: registry ani watcher nesmí sáhnout na síť/disk.
jest.mock('../lib/registries', () => ({ checkSubject: async (ico) => ({ ico, name: 'TEST s.r.o.', active: true }) }));
jest.mock('../lib/watcher', () => ({ loadInbox: async () => ({ files: {} }) }));
const tools = require('../lib/agent_tools');

const agentRW = { id: 'resersnik', permissions: { read_files: true, query_registries: true, manage_calendar: false, write_desktop: false } };
const agentNone = { id: 'stylista', permissions: { read_files: false, query_registries: false } };

describe('toolsForAgent — per-agent allow-list', () => {
    test('agent s read_files+query_registries dostane search_rag, get_document, check_registry', () => {
        const names = tools.toolsForAgent(agentRW).map(t => t.function.name).sort();
        expect(names).toEqual(['check_registry', 'get_document', 'search_rag']);
    });
    test('agent bez oprávnění nedostane žádný tool', () => {
        expect(tools.toolsForAgent(agentNone)).toEqual([]);
    });
    test('read_files bez query_registries → bez check_registry', () => {
        const a = { permissions: { read_files: true, query_registries: false } };
        const names = tools.toolsForAgent(a).map(t => t.function.name).sort();
        expect(names).toEqual(['get_document', 'search_rag']);
    });
    test('definice mají JSON schema (ollama formát)', () => {
        const t = tools.toolsForAgent(agentRW)[0];
        expect(t.type).toBe('function');
        expect(t.function.parameters.type).toBe('object');
    });
});

describe('execTool — běhová permission-brána', () => {
    test('odmítne tool, na který agent nemá právo', async () => {
        const r = await tools.execTool(agentNone, 'search_rag', { query: 'x' }, {});
        expect(r.error).toMatch(/oprávnění/);
    });
    test('odmítne neznámý tool', async () => {
        const r = await tools.execTool(agentRW, 'delete_everything', {}, {});
        expect(r.error).toMatch(/Neznámý/);
    });
    test('check_registry validuje IČO (8 číslic)', async () => {
        const r = await tools.execTool(agentRW, 'check_registry', { ico: '123' }, {});
        expect(r.error).toMatch(/8 číslic/);
    });
    test('audit callback dostane záznam o volání', async () => {
        const seen = [];
        await tools.execTool(agentRW, 'check_registry', { ico: 'abc' }, { audit: e => seen.push(e) });
        expect(seen).toHaveLength(1);
        expect(seen[0].tool).toBe('check_registry');
    });
});

// Mock provider: skript odpovědí. Každé volání vezme další prvek fronty.
function mockProvider(responses) {
    let i = 0;
    const calls = [];
    return {
        chat: async (params) => {
            calls.push(params);
            const r = responses[Math.min(i, responses.length - 1)];
            i++;
            return r;
        },
        _calls: calls
    };
}
const toolCall = (name, args) => ({ message: { tool_calls: [{ function: { name, arguments: args } }] } });
const finalMsg = (content) => ({ message: { content } });

describe('runToolLoop — bounded loop + fallback', () => {
    test('agent bez toolů → jedno bez-toolové volání, žádné tools v params', async () => {
        const p = mockProvider([finalMsg('odpověď bez nástrojů')]);
        const out = await tools.runToolLoop({ provider: p, model: 'm', messages: [{ role: 'user', content: 'q' }], agent: agentNone });
        expect(out.content).toBe('odpověď bez nástrojů');
        expect(out.toolCalls).toHaveLength(0);
        expect(p._calls[0].tools).toBeUndefined();
    });

    test('model zavolá tool, pak dá finální odpověď', async () => {
        const p = mockProvider([
            toolCall('check_registry', { ico: '27074358' }),
            finalMsg('hotovo s nástrojem')
        ]);
        const out = await tools.runToolLoop({ provider: p, model: 'm', messages: [{ role: 'user', content: 'ověř IČO' }], agent: agentRW });
        expect(out.content).toBe('hotovo s nástrojem');
        expect(out.toolCalls.map(c => c.name)).toEqual(['check_registry']);
        // druhé volání modelu už dostalo tool zprávu v messages
        const secondMsgs = p._calls[1].messages;
        expect(secondMsgs.some(m => m.role === 'tool')).toBe(true);
    });

    test('string argumenty (JSON) se rozparsují', async () => {
        const p = mockProvider([
            toolCall('check_registry', '{"ico":"123"}'),
            finalMsg('konec')
        ]);
        const out = await tools.runToolLoop({ provider: p, model: 'm', messages: [], agent: agentRW });
        expect(out.toolCalls[0].args).toEqual({ ico: '123' });
    });

    test('bounded: model pořád volá tool → po MAX iteracích vynutí finální odpověď', async () => {
        process.env.AGENT_TOOLS_MAX_ITERS = '2';
        // vždy vrací tool_call; poslední (bez toolů) volání vrátí text
        const p = mockProvider([
            toolCall('check_registry', { ico: '1' }),
            toolCall('check_registry', { ico: '2' }),
            finalMsg('vynucený závěr')
        ]);
        const out = await tools.runToolLoop({ provider: p, model: 'm', messages: [], agent: agentRW });
        expect(out.iters).toBe(2);
        expect(out.content).toBe('vynucený závěr');
        // poslední volání proběhlo BEZ tools (vynucený závěr)
        expect(p._calls[p._calls.length - 1].tools).toBeUndefined();
        delete process.env.AGENT_TOOLS_MAX_ITERS;
    });

    test('nepovolený tool ve smyčce → do modelu jde chybová tool zpráva, ne pád', async () => {
        const p = mockProvider([
            toolCall('add_calendar_event', { title: 'x' }), // není v registru → error
            finalMsg('pokračuji')
        ]);
        const out = await tools.runToolLoop({ provider: p, model: 'm', messages: [], agent: agentRW });
        expect(out.content).toBe('pokračuji');
        const toolMsg = p._calls[1].messages.find(m => m.role === 'tool');
        expect(toolMsg.content).toMatch(/Neznámý|oprávnění/);
    });
});

describe('enabled/maxIters — env přepínače', () => {
    test('AGENT_TOOLS default vyp', () => {
        delete process.env.AGENT_TOOLS;
        expect(tools.enabled()).toBe(false);
    });
    test('AGENT_TOOLS=1 zapne', () => {
        process.env.AGENT_TOOLS = '1';
        expect(tools.enabled()).toBe(true);
        delete process.env.AGENT_TOOLS;
    });
});
