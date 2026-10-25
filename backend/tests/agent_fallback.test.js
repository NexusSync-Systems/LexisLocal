/**
 * Unit testy poctivé záložní odpovědi (backend/lib/agent_fallback.js).
 * Klíčová zásada: fallback NIKDY nevyrobí falešný právní dokument — vrací jen
 * upozornění, že zadání nebylo zpracováno. Testy hlídají právě tuto anti-fabrikaci.
 * Bez závislostí, deterministické.
 */
const { generateAgentFallback, isFallbackText } = require('../lib/agent_fallback.js');

describe('generateAgentFallback', () => {
  test('známý agent: obsahuje jméno i výrazné upozornění', () => {
    const out = generateAgentFallback('resersnik', 'Najdi judikaturu k výpovědi z nájmu');
    expect(out).toContain('Rešeršník');
    expect(out).toContain('ZADÁNÍ NEBYLO ZPRACOVÁNO');
    expect(out).toMatch(/Ollama/);
    expect(out).toContain('Původní zadání');
  });

  test('anti-fabrikace: výslovně říká, že NEJDE o právní dokument a nic nepřebírat', () => {
    const out = generateAgentFallback('spisovatel', 'Sepiš žalobu');
    expect(out).toMatch(/nejde o právní dokument/i);
    expect(out).toMatch(/nepřebírejte/i);
  });

  test('neznámý agent → obecný název s ID', () => {
    const out = generateAgentFallback('nvm123', 'dotaz');
    expect(out).toContain('Agent nvm123');
    expect(isFallbackText(out)).toBe(true);
  });

  test('prázdné zadání → řádek „Původní zadání" chybí', () => {
    const out = generateAgentFallback('kontrolor', '');
    expect(out).not.toContain('Původní zadání');
  });

  test('dlouhé zadání se ořízne na 200 znaků', () => {
    const long = 'A'.repeat(500);
    const out = generateAgentFallback('stylista', long);
    const m = out.match(/Původní zadání: „(A+)"/);
    expect(m).not.toBeNull();
    expect(m[1].length).toBe(200);
  });
});

describe('isFallbackText — aby se fallback neuložil jako koncept', () => {
  test('rozpozná vlastní fallback výstup', () => {
    expect(isFallbackText(generateAgentFallback('sekretarka', 'x'))).toBe(true);
  });
  test('běžný text není fallback', () => {
    expect(isFallbackText('Vážený soude, podávám tímto žalobu...')).toBe(false);
  });
  test('ne-řetězec → false (nespadne)', () => {
    expect(isFallbackText(null)).toBe(false);
    expect(isFallbackText(undefined)).toBe(false);
    expect(isFallbackText({})).toBe(false);
  });
});
