/**
 * ai_provider.test.js — ověřuje poskytovatele AI nezávislého na backendu.
 *
 * Testuje, že:
 *   1) VÝCHOZÍ chování (bez env) je Ollama — stávající kód se nesmí rozbít.
 *   2) OpenAI cesta správně mapuje chat i embeddings (mock global.fetch).
 *   3) Anthropic cesta odděluje system od zpráv a skládá text bloky.
 *   4) Anthropic embeddings vyhodí srozumitelnou chybu (API neexistuje).
 *
 * Žádné síťové volání — ollama_client i global.fetch jsou mockované.
 */
'use strict';

// --- Mock Ollama backendu (aby default cesta nešahala na síť) ---------------
jest.mock('../lib/ollama_client', () => ({
    chat: jest.fn(async () => ({ message: { content: 'OLLAMA_CHAT_OK' } })),
    embeddings: jest.fn(async () => ({ embedding: [0.1, 0.2, 0.3] })),
    list: jest.fn(async () => ({ models: [] })),
    pull: jest.fn(async () => ({ status: 'success' }))
}));

const ollamaMock = require('../lib/ollama_client');

// Čistý reset modulu i env mezi testy, ať se provider volí znovu z env.
function freshProvider(env) {
    jest.resetModules();
    // vynuluj relevantní env
    for (const k of [
        'AI_PROVIDER', 'AI_CHAT_PROVIDER', 'AI_EMBED_PROVIDER',
        'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_CHAT_MODEL', 'OPENAI_EMBED_MODEL',
        'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_VERSION', 'ANTHROPIC_MAX_TOKENS'
    ]) {
        delete process.env[k];
    }
    Object.assign(process.env, env || {});
    // re-mock po resetModules
    jest.doMock('../lib/ollama_client', () => ollamaMock);
    return require('../lib/ai_provider');
}

describe('ai_provider — výchozí Ollama', () => {
    beforeEach(() => {
        ollamaMock.chat.mockClear();
        ollamaMock.embeddings.mockClear();
    });

    it('chat bez env jde na Ollama a předá model + options', async () => {
        const ai = freshProvider({});
        const out = await ai.chat({ model: 'llama3', messages: [{ role: 'user', content: 'ahoj' }], options: { temperature: 0.3 } });
        expect(out.message.content).toBe('OLLAMA_CHAT_OK');
        expect(ollamaMock.chat).toHaveBeenCalledTimes(1);
        const passed = ollamaMock.chat.mock.calls[0][0];
        expect(passed.model).toBe('llama3');
        expect(passed.options.temperature).toBe(0.3);
    });

    it('embeddings bez env jde na Ollama', async () => {
        const ai = freshProvider({});
        const out = await ai.embeddings({ model: 'nomic', prompt: 'text' });
        expect(out.embedding).toEqual([0.1, 0.2, 0.3]);
        expect(ollamaMock.embeddings).toHaveBeenCalledTimes(1);
    });

    it('providerInfo hlásí ollama/ollama', () => {
        const ai = freshProvider({});
        expect(ai.providerInfo()).toMatchObject({ chat: 'ollama', embed: 'ollama' });
    });

    it('list/pull jsou průchozí na Ollama', async () => {
        const ai = freshProvider({});
        await ai.list();
        await ai.pull({ model: 'x' });
        expect(ollamaMock.list).toHaveBeenCalled();
        expect(ollamaMock.pull).toHaveBeenCalled();
    });
});

describe('ai_provider — OpenAI', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn();
        global.fetch = fetchMock;
    });
    afterEach(() => { delete global.fetch; });

    it('chat mapuje odpověď choices[0].message.content', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'OPENAI_CHAT' } }] })
        });
        const ai = freshProvider({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
        const out = await ai.chat({ messages: [{ role: 'user', content: 'x' }], options: { temperature: 0.3 } });
        expect(out.message.content).toBe('OPENAI_CHAT');
        // ollama se NESMÍ zavolat
        expect(ollamaMock.chat).not.toHaveBeenCalled();
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        expect(opts.headers['Authorization']).toBe('Bearer sk-test');
        const body = JSON.parse(opts.body);
        expect(body.model).toBe('gpt-4o-mini');
        expect(body.temperature).toBe(0.3);
    });

    it('chat respektuje OPENAI_BASE_URL (kompat. servery) a ořízne koncové lomítko', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'LOCAL' } }] })
        });
        const ai = freshProvider({ AI_CHAT_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://localhost:1234/v1/' });
        await ai.chat({ messages: [] });
        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:1234/v1/chat/completions');
    });

    it('embeddings mapuje data[0].embedding', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: [{ embedding: [1, 2, 3] }] })
        });
        const ai = freshProvider({ AI_EMBED_PROVIDER: 'openai' });
        const out = await ai.embeddings({ prompt: 'věta' });
        expect(out.embedding).toEqual([1, 2, 3]);
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/embeddings');
        expect(JSON.parse(opts.body).model).toBe('text-embedding-3-small');
    });

    it('chat vyhodí chybu při ne-2xx odpovědi', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
        const ai = freshProvider({ AI_PROVIDER: 'openai' });
        await expect(ai.chat({ messages: [] })).rejects.toThrow(/OpenAI chat 401/);
    });
});

describe('ai_provider — Anthropic', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn();
        global.fetch = fetchMock;
    });
    afterEach(() => { delete global.fetch; });

    it('chat odděluje system od zpráv a skládá content bloky', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ content: [{ type: 'text', text: 'ANT_' }, { type: 'text', text: 'HROPIC' }] })
        });
        const ai = freshProvider({ AI_CHAT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'ak-test' });
        const out = await ai.chat({
            messages: [
                { role: 'system', content: 'Jsi asistent.' },
                { role: 'user', content: 'Ahoj' }
            ],
            options: { temperature: 0.2 }
        });
        expect(out.message.content).toBe('ANT_HROPIC');
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        expect(opts.headers['x-api-key']).toBe('ak-test');
        expect(opts.headers['anthropic-version']).toBe('2023-06-01');
        const body = JSON.parse(opts.body);
        expect(body.system).toBe('Jsi asistent.');
        expect(body.messages).toEqual([{ role: 'user', content: 'Ahoj' }]);
        expect(body.max_tokens).toBe(4096);
    });

    it('chat bez ANTHROPIC_API_KEY vyhodí srozumitelnou chybu', async () => {
        const ai = freshProvider({ AI_PROVIDER: 'anthropic' });
        await expect(ai.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/ANTHROPIC_API_KEY/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('embeddings na Anthropic vyhodí chybu (API neexistuje)', async () => {
        const ai = freshProvider({ AI_EMBED_PROVIDER: 'anthropic' });
        await expect(ai.embeddings({ prompt: 'x' })).rejects.toThrow(/embeddings/);
    });
});
