/**
 * Unit testy preflight kontroly verze Node.js (backend/lib/node_check.js).
 * nodeStatus čte process.versions.node až při volání → hranice testujeme
 * dočasným přepsáním verze. Kontrola jen VARUJE, nikdy neblokuje. Deterministické.
 */
const nc = require('../lib/node_check.js');

const REAL = process.versions.node;
function setNodeVersion(v) {
  Object.defineProperty(process.versions, 'node', { value: v, configurable: true, writable: true });
}
afterEach(() => setNodeVersion(REAL));

describe('konstanty podporovaného rozpětí', () => {
  test('podporováno 20 (včetně) až 25 (vyjma)', () => {
    expect(nc.MIN_MAJOR).toBe(20);
    expect(nc.MAX_MAJOR_EXCL).toBe(25);
  });
});

describe('nodeStatus — tvar a vyhodnocení', () => {
  test('vrací očekávaná pole', () => {
    const s = nc.nodeStatus();
    expect(s).toMatchObject({ version: process.versions.node, min: 20, maxExcl: 25 });
    expect(typeof s.major).toBe('number');
    expect(typeof s.ok).toBe('boolean');
  });

  test.each([
    ['20.11.0', 20, true],
    ['22.22.2', 22, true],
    ['24.0.0', 24, true],
    ['25.1.0', 25, false],
    ['19.9.0', 19, false],
    ['18.20.0', 18, false],
  ])('verze %s → major %i, ok=%s', (ver, major, ok) => {
    setNodeVersion(ver);
    const s = nc.nodeStatus();
    expect(s.major).toBe(major);
    expect(s.ok).toBe(ok);
  });
});

describe('warnIfUnsupported', () => {
  test('podporovaná verze: žádné varování, vrací status', () => {
    setNodeVersion('22.0.0');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = nc.warnIfUnsupported();
    expect(s.ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('nepodporovaná verze: varuje do konzole a vrací status', () => {
    setNodeVersion('25.3.0');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = nc.warnIfUnsupported('   ');
    expect(s.ok).toBe(false);
    expect(warn).toHaveBeenCalled();
    // hlavní řádek zmiňuje nepodporovanou verzi
    const joined = warn.mock.calls.map(c => c.join(' ')).join('\n');
    expect(joined).toMatch(/Nepodporovaná verze Node\.js/);
    warn.mockRestore();
  });

  test('nikdy nevyhazuje výjimku (jen varuje)', () => {
    setNodeVersion('99.0.0');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => nc.warnIfUnsupported()).not.toThrow();
  });
});
