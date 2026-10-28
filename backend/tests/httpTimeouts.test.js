/**
 * Spojení serveru: keep-alive delší než u klientů (zátěžový den 27. 10. 2026 — ECONNRESET při vytížení).
 */
const http = require('http');
const { applyHttpTimeouts, keepAliveMs } = require('../lib/http_timeouts');

describe('http_timeouts', () => {
    test('výchozí 65 s, headersTimeout větší', () => {
        const s = applyHttpTimeouts(http.createServer(), {});
        expect(s.keepAliveTimeout).toBe(65000);
        expect(s.headersTimeout).toBe(66000);
    });
    test('nastavení z prostředí a meze', () => {
        expect(keepAliveMs({ HTTP_KEEPALIVE_TIMEOUT_MS: '30000' })).toBe(30000);
        expect(keepAliveMs({ HTTP_KEEPALIVE_TIMEOUT_MS: '100' })).toBe(5000);
        expect(keepAliveMs({ HTTP_KEEPALIVE_TIMEOUT_MS: '9999999' })).toBe(600000);
        expect(keepAliveMs({ HTTP_KEEPALIVE_TIMEOUT_MS: 'abc' })).toBe(65000);
    });
    test('volné spojení vydrží déle než 5 s výchozího Node', async () => {
        const srv = applyHttpTimeouts(http.createServer((req, res) => res.end('ok')), { HTTP_KEEPALIVE_TIMEOUT_MS: '65000' });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        const agent = new http.Agent({ keepAlive: true });
        const get = () => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: srv.address().port, agent }, r => { r.resume(); r.on('end', () => res(r.headers.connection)); }).on('error', rej));
        expect(await get()).toBe('keep-alive');
        agent.destroy();
        await new Promise(r => srv.close(r));
    });
    test('null server nevadí', () => { expect(applyHttpTimeouts(null)).toBeNull(); });
});
