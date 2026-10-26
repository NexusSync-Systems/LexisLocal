'use strict';
const { getText } = require('../scripts/fetch-ns-sbirka');

afterEach(() => { delete global.fetch; delete process.env.FETCH_RETRY_MS; });

test('HTTP 500 → další pokus, pak úspěch', async () => {
    process.env.FETCH_RETRY_MS = '1';
    const codes = [500, 503, 200];
    global.fetch = jest.fn(async () => { const status = codes.shift(); return { status, ok: status === 200, text: async () => 'OK' }; });
    await expect(getText('https://example.test/sitemap_index.xml')).resolves.toBe('OK');
    expect(global.fetch).toHaveBeenCalledTimes(3);
});

test('trvalá 500 → po 3 pokusech chyba; 404 bez opakování', async () => {
    process.env.FETCH_RETRY_MS = '1';
    global.fetch = jest.fn(async () => ({ status: 500, ok: false }));
    await expect(getText('https://example.test/a')).rejects.toThrow(/HTTP 500/);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    global.fetch = jest.fn(async () => ({ status: 404, ok: false }));
    await expect(getText('https://example.test/b')).rejects.toThrow(/HTTP 404/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
});
