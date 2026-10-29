/**
 * model_bench.js — srovnání lokálního modelu s Claude přes Bedrock EU (úkol K7a, 29. 10. 2026).
 * Bedrock se tu nevolá doopravdy (podvržený lib/bedrock.js).
 */
const mockSeen = [];
jest.mock('../lib/bedrock', () => ({
    chat: async (msgs) => {
        mockSeen.push({ model: process.env.BEDROCK_MODEL_ID, msgs });
        const q = msgs[msgs.length - 1].content;
        const content = /pokut/.test(q)
            ? 'Soud může nepřiměřeně vysokou smluvní pokutu na návrh dlužníka snížit (§ 2051 OZ).'
            : 'Obecná promlčecí lhůta je tři roky (§ 629 OZ) a běží ode dne, kdy právo mohlo být uplatněno poprvé.';
        return { message: { content }, usage: { inputTokens: 120, outputTokens: 40 }, stopReason: 'end_turn' };
    }
}));
const seen = mockSeen;
const MB = require('../scripts/model_bench');
const suite = require('../eval/model_bench.json');

describe('model_bench — Bedrock', () => {
    test('rozpozná model bedrock:', () => {
        expect(MB.isBedrock('bedrock:eu.anthropic.claude-sonnet-5-5')).toBe(true);
        expect(MB.isBedrock('qwen2.5:7b')).toBe(false);
    });
    test('úloha přes Bedrock: kontroly, tokeny, model nastaven jen po dobu volání', async () => {
        delete process.env.BEDROCK_MODEL_ID;
        const cases = suite.cases.filter(c => ['resersnik-promlceni', 'resersnik-smluvni-pokuta-moderace'].includes(c.id));
        const run = await MB.benchBedrock('bedrock:eu.anthropic.claude-haiku-5-5', cases, { resersnik: 'Jsi rešeršník.' }, { maxTokens: 500, timeoutS: 60 });
        expect(seen.every(s => s.model === 'eu.anthropic.claude-haiku-5-5')).toBe(true);
        expect(seen[0].msgs[0]).toEqual({ role: 'system', content: 'Jsi rešeršník.' });
        expect(process.env.BEDROCK_MODEL_ID).toBeUndefined();
        expect(run.results.every(r => r.passed === r.total)).toBe(true);
        expect(run.summary).toMatchObject({ inputTokens: 240, outputTokens: 80, cases: 2 });
        expect(MB.toMarkdown([run], { date: 'x', host: 'h', cpus: 1, ramGb: 1, cases: 2, numCtx: 8192 })).toMatch(/vstup 240, výstup 80/);
    });
    test('úloha J1: § 2248 místo § 2051 neprojde', () => {
        const c = suite.cases.find(x => x.id === 'resersnik-smluvni-pokuta-moderace');
        const bad = MB.runChecks(c, 'Soud může pokutu snížit na návrh podle § 2248 OZ.');
        expect(bad.filter(x => !x.pass).map(x => x.name)).toEqual(expect.arrayContaining(['obsahuje: 2051', 'neobsahuje: §\\s*2248']));
    });
});
