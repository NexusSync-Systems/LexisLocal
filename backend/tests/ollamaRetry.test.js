const { isTransient, withRetry, retryingProvider } = require('../lib/ollama_retry');

test('přechodné chyby se rozpoznají, chybějící model ne', () => {
    expect(isTransient(new Error('fetch failed'))).toBe(true);
    const e = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' };
    expect(isTransient(e)).toBe(true);
    expect(isTransient(new Error('model "qwen9" not found, try pulling it first'))).toBe(false);
    expect(isTransient(new Error('invalid options'))).toBe(false);
});

test('jeden opakovaný pokus při přechodné chybě → úspěch', async () => {
    let n = 0;
    const p = retryingProvider({ chat: async () => { n++; if (n === 1) throw new Error('fetch failed'); return { message: { content: 'OK' } }; } }, { delayMs: 1 });
    await expect(p.chat({})).resolves.toEqual({ message: { content: 'OK' } });
    expect(n).toBe(2);
});

test('trvalá chyba se neopakuje; opakovaná přechodná se vzdá po 1 pokusu', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error('model not found'); }, { delayMs: 1 })).rejects.toThrow('not found');
    expect(n).toBe(1);
    n = 0;
    await expect(withRetry(async () => { n++; throw new Error('fetch failed'); }, { delayMs: 1 })).rejects.toThrow('fetch failed');
    expect(n).toBe(2);
});
