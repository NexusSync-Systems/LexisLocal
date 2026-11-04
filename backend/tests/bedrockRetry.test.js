'use strict';
const ENV = { BEDROCK_REGION: 'eu-central-1', BEDROCK_MODEL_ID: 'eu.anthropic.claude-sonnet-4-6', AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S' };
beforeEach(() => { Object.assign(process.env, ENV); jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }); });
afterEach(() => { jest.useRealTimers(); delete global.fetch; for (const k of Object.keys(ENV)) delete process.env[k]; });
const ok = () => ({ ok: true, status: 200, json: async () => ({ output: { message: { content: [{ text: 'OK' }] } } }), text: async () => '' });
const run = async (p) => { const pr = p.catch(e => e); for (let i = 0; i < 20; i++) { await Promise.resolve(); jest.advanceTimersByTime(5000); await new Promise(r => setImmediate(r)); } return pr; };

test('429 a přerušené spojení se zopakují, pak projde', async () => {
    global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'ThrottlingException' })
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(ok());
    const r = await run(require('../lib/bedrock').chat([{ role: 'user', content: 'x' }]));
    expect(r.message.content).toBe('OK');
    expect(global.fetch).toHaveBeenCalledTimes(3);
});
test('časový limit (abort) se neopakuje; 403 také ne', async () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    global.fetch = jest.fn().mockRejectedValueOnce(abort);
    const e = await run(require('../lib/bedrock').chat([{ role: 'user', content: 'x' }]));
    expect(String(e.message)).toMatch(/aborted/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'AccessDenied' });
    const e2 = await run(require('../lib/bedrock').chat([{ role: 'user', content: 'x' }]));
    expect(String(e2.message)).toMatch(/Bedrock 403/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
});
