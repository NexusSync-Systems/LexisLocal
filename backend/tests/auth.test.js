/**
 * Testy ověření API tokenu (backend/lib/auth.js). Vytaženo ze server.js kvůli
 * testovatelnosti. Chování je opt-in (bez API_TOKEN se nevynucuje), ale logika
 * je zamčená testy — příprava na povinný token.
 */

const auth = require('../lib/auth');

const REQ = (over) => Object.assign({ method: 'GET', path: '/api/status', headers: {}, query: {} }, over || {});

describe('isPublicPath', () => {
    test('OPTIONS a statické soubory jsou veřejné', () => {
        expect(auth.isPublicPath('OPTIONS', '/api/status')).toBe(true);
        expect(auth.isPublicPath('GET', '/')).toBe(true);
        expect(auth.isPublicPath('GET', '/index.html')).toBe(true);
        expect(auth.isPublicPath('GET', '/app.js')).toBe(true);
        expect(auth.isPublicPath('GET', '/style.css')).toBe(true);
        expect(auth.isPublicPath('GET', '/favicon.ico')).toBe(true);
    });
    test('API cesty veřejné nejsou', () => {
        expect(auth.isPublicPath('GET', '/api/status')).toBe(false);
        expect(auth.isPublicPath('POST', '/api/email/send')).toBe(false);
        // přípona statického souboru NESMÍ odemknout API (obejití tokenu)
        expect(auth.isPublicPath('GET', '/api/x.js')).toBe(false);
        expect(auth.isPublicPath('DELETE', '/api/agent-knowledge/resersnik/zakon.js')).toBe(false);
        expect(auth.isPublicPath('GET', '/API/spisy/abc.ico')).toBe(false);
    });
});

describe('extractToken', () => {
    test('Bearer hlavička má přednost', () => {
        expect(auth.extractToken(REQ({ headers: { authorization: 'Bearer abc', 'x-api-token': 'xyz' } }))).toBe('abc');
    });
    test('x-api-token hlavička', () => {
        expect(auth.extractToken(REQ({ headers: { 'x-api-token': 'xyz' } }))).toBe('xyz');
    });
    test('token z query se ZÁMĚRNĚ NEpřijímá (bezpečnost)', () => {
        expect(auth.extractToken(REQ({ query: { token: 'qqq' } }))).toBeUndefined();
    });
    test('žádný token → undefined', () => {
        expect(auth.extractToken(REQ())).toBeUndefined();
    });
});

describe('checkAuth', () => {
    test('bez nastaveného API_TOKEN se přístup nevynucuje (opt-in)', () => {
        expect(auth.checkAuth(undefined, REQ()).allowed).toBe(true);
        expect(auth.checkAuth('', REQ()).allowed).toBe(true);
    });

    test('se správným tokenem povoleno', () => {
        expect(auth.checkAuth('secret', REQ({ headers: { 'x-api-token': 'secret' } })).allowed).toBe(true);
        expect(auth.checkAuth('secret', REQ({ headers: { authorization: 'Bearer secret' } })).allowed).toBe(true);
    });

    test('se špatným / chybějícím tokenem zamítnuto', () => {
        expect(auth.checkAuth('secret', REQ({ headers: { 'x-api-token': 'nope' } }))).toEqual({ allowed: false, reason: 'bad-token' });
        expect(auth.checkAuth('secret', REQ()).allowed).toBe(false);
    });

    test('veřejná cesta projde i se špatným tokenem', () => {
        expect(auth.checkAuth('secret', REQ({ path: '/', headers: { 'x-api-token': 'nope' } })).allowed).toBe(true);
        expect(auth.checkAuth('secret', REQ({ method: 'OPTIONS', headers: {} })).allowed).toBe(true);
    });
});
