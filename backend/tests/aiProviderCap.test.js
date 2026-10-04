/**
 * Strop délky odpovědi (num_predict) pro Ollamu — runaway generování nesmí držet spojení 300 s.
 */
'use strict';
jest.mock('../lib/ollama_client', () => ({ chat: jest.fn(async (p) => ({ message: { content: 'ok' }, _p: p })) }));
const ollama = require('../lib/ollama_client');
const ai = require('../lib/ai_provider');

afterEach(() => { delete process.env.AGENT_NUM_PREDICT; ollama.chat.mockClear(); });

test('výchozí strop 3072, nastavení env, 0 = bez stropu, hodnota volajícího má přednost', async () => {
    await ai.chat({ model: 'm', messages: [], options: { temperature: 0.1 } });
    expect(ollama.chat.mock.calls[0][0].options).toEqual({ temperature: 0.1, num_predict: 3072 });
    process.env.AGENT_NUM_PREDICT = '1000';
    await ai.chat({ model: 'm', messages: [] });
    expect(ollama.chat.mock.calls[1][0].options.num_predict).toBe(1000);
    process.env.AGENT_NUM_PREDICT = '0';
    await ai.chat({ model: 'm', messages: [] });
    expect(ollama.chat.mock.calls[2][0].options).toBeUndefined();
    delete process.env.AGENT_NUM_PREDICT;
    await ai.chat({ model: 'm', messages: [], options: { num_predict: 50 } });
    expect(ollama.chat.mock.calls[3][0].options.num_predict).toBe(50);
});
