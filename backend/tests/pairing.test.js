/**
 * Unit testy LexisLink párování (backend/lib/pairing.js).
 * Bezpečnostní vlastnosti: kód je jednorázový, krátkodobý (TTL) a náhodný;
 * token se do QR nedává. os.networkInterfaces je mockované → deterministické URL.
 * Čas řídíme přes Date.now (modul žádné časovače nespouští).
 */
jest.mock('os', () => ({
  networkInterfaces: jest.fn(() => ({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [
      { family: 'IPv4', address: '192.168.1.5', internal: false },
      { family: 'IPv6', address: 'fe80::1', internal: false },
    ],
    en1: [{ family: 'IPv4', address: '10.0.0.9', internal: false }],
  })),
}));
const pairing = require('../lib/pairing.js');

afterEach(() => { if (Date.now.mockRestore) Date.now.mockRestore(); });

describe('createCode / claim — jednorázový a časově omezený kód', () => {
  test('createCode vrátí kód, ttl v sekundách a expiraci', () => {
    const r = pairing.createCode('secret-token');
    expect(typeof r.code).toBe('string');
    expect(r.code.length).toBeGreaterThan(0);
    expect(r.ttl).toBe(120);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });

  test('claim vymění platný kód za token', () => {
    const { code } = pairing.createCode('tok-A');
    expect(pairing.claim(code)).toBe('tok-A');
  });

  test('kód je JEDNORÁZOVÝ — druhý claim vrátí null', () => {
    const { code } = pairing.createCode('tok-B');
    expect(pairing.claim(code)).toBe('tok-B');
    expect(pairing.claim(code)).toBeNull();
  });

  test('neplatný / prázdný / ne-řetězcový kód → null', () => {
    expect(pairing.claim('neexistuje')).toBeNull();
    expect(pairing.claim('')).toBeNull();
    expect(pairing.claim(null)).toBeNull();
    expect(pairing.claim(12345)).toBeNull();
  });

  test('po vypršení TTL už kód neplatí', () => {
    const t0 = 1_000_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    const { code } = pairing.createCode('tok-C');
    now.mockReturnValue(t0 + pairing.TTL_MS + 1); // posun za expiraci
    expect(pairing.claim(code)).toBeNull();
  });

  test('dva kódy jsou různé (náhodnost)', () => {
    const a = pairing.createCode('t').code;
    const b = pairing.createCode('t').code;
    expect(a).not.toBe(b);
  });

  test('TTL_MS je 2 minuty', () => {
    expect(pairing.TTL_MS).toBe(120 * 1000);
  });
});

describe('lanIPv4 / buildUrls', () => {
  test('lanIPv4 vrací jen externí IPv4 (bez loopbacku a IPv6)', () => {
    expect(pairing.lanIPv4()).toEqual(['192.168.1.5', '10.0.0.9']);
  });

  test('buildUrls sestaví /m?pair=<kód> pro každou LAN IP a zakóduje kód', () => {
    const urls = pairing.buildUrls(4000, 'a b/c');
    expect(urls).toEqual([
      'http://192.168.1.5:4000/m?pair=a%20b%2Fc',
      'http://10.0.0.9:4000/m?pair=a%20b%2Fc',
    ]);
  });
});

describe('buildUrls na HTTPS serveru (test 2. 10. 2026)', () => {
  const pairing = require('../lib/pairing');
  test('https schéma, bez :443 a s adresou panelu jako první', () => {
    const urls = pairing.buildUrls(443, 'abc', { https: true, host: '3.125.157.86' });
    expect(urls[0]).toBe('https://3.125.157.86/m?pair=abc');
    expect(urls.every(u => u.startsWith('https://'))).toBe(true);
    expect(urls.some(u => /:443\//.test(u))).toBe(false);
  });
  test('podezřelý Host se nepoužije', () => {
    const urls = pairing.buildUrls(4000, 'abc', { host: 'evil.com/<script>' });
    expect(urls.some(u => u.includes('evil'))).toBe(false);
  });
});
