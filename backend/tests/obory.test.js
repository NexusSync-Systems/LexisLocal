/**
 * Unit testy kanonické taxonomie oborů (backend/lib/obory.js).
 * Ověřuje odvození slugu (musí se trefit do partition scope RAG), integritu
 * taxonomie, vyhledávací funkce a odvození labelu pro ruční obor.
 * Bez závislostí, deterministické, běží v CI.
 */
const obory = require('../lib/obory.js');

describe('oborSlug — deakcent a normalizace', () => {
  test('deakcentuje a spojuje mezery podtržítkem', () => {
    expect(obory.oborSlug('Nemovitosti a nájemní právo')).toBe('nemovitosti_a_najemni_pravo');
    expect(obory.oborSlug('Občanské právo')).toBe('obcanske_pravo');
  });
  test('null/undefined/prázdné → prázdný řetězec', () => {
    expect(obory.oborSlug(null)).toBe('');
    expect(obory.oborSlug(undefined)).toBe('');
    expect(obory.oborSlug('')).toBe('');
  });
  test('ořízne úvodní/koncová podtržítka a interpunkci', () => {
    expect(obory.oborSlug('  Daňové & finanční právo!  ')).toBe('danove_financni_pravo');
  });
  test('omezí délku na 48 znaků', () => {
    const long = 'a'.repeat(80);
    expect(obory.oborSlug(long).length).toBe(48);
  });
  test('idempotence: slug ze slugu je totožný', () => {
    const s = obory.oborSlug('Rodinné právo');
    expect(obory.oborSlug(s)).toBe(s);
  });
});

describe('OBORY — integrita taxonomie', () => {
  test('obsahuje 15 oborů', () => {
    expect(obory.OBORY).toHaveLength(15);
  });
  test('každý obor má konzistentní slug, scope a keywordText', () => {
    obory.OBORY.forEach(o => {
      expect(o.slug).toBe(obory.oborSlug(o.label));
      expect(o.scope).toBe('_kb_obor_' + o.slug);
      expect(Array.isArray(o.keywords)).toBe(true);
      expect(o.keywords.length).toBeGreaterThan(0);
      expect(o.keywordText).toContain(o.label);
    });
  });
  test('slugy jsou jedinečné', () => {
    const slugs = obory.allSlugs();
    expect(new Set(slugs).size).toBe(slugs.length);
  });
  test('položky taxonomie jsou zmrazené (neměnné za běhu)', () => {
    const o = obory.OBORY[0];
    expect(Object.isFrozen(o)).toBe(true);
    expect(Object.isFrozen(o.keywords)).toBe(true);
    const before = o.label;
    try { o.label = 'HACK'; } catch (e) { /* strict mode může házet */ }
    expect(o.label).toBe(before);
  });
});

describe('vyhledávání', () => {
  test('bySlug najde obor a pro neznámý vrátí null', () => {
    expect(obory.bySlug('rodinne_pravo').label).toBe('Rodinné právo');
    expect(obory.bySlug('neexistuje')).toBeNull();
    expect(obory.bySlug(null)).toBeNull();
  });
  test('byScope zvládne plný scope i holý slug', () => {
    expect(obory.byScope('_kb_obor_trestni_pravo').label).toBe('Trestní právo');
    expect(obory.byScope('trestni_pravo').label).toBe('Trestní právo');
    expect(obory.byScope('_kb_obor_nesmysl')).toBeNull();
  });
  test('scopeOf odvodí scope z labelu i slugu', () => {
    expect(obory.scopeOf('Dědické právo')).toBe('_kb_obor_dedicke_pravo');
    expect(obory.scopeOf('')).toBeNull();
  });
  test('allScopes odpovídá allSlugs s prefixem', () => {
    const scopes = obory.allScopes();
    const slugs = obory.allSlugs();
    expect(scopes).toEqual(slugs.map(s => '_kb_obor_' + s));
  });
});

describe('labelForScope — čitelný název i pro ruční obor', () => {
  test('známý scope → oficiální label', () => {
    expect(obory.labelForScope('_kb_obor_pracovni_pravo')).toBe('Pracovní právo');
  });
  test('neznámý scope → titulkovaný název ze slugu', () => {
    expect(obory.labelForScope('_kb_obor_mezinarodni_arbitraz')).toBe('Mezinarodni Arbitraz');
  });
  test('holý slug bez prefixu se také zpracuje', () => {
    expect(obory.labelForScope('sportovni_pravo')).toBe('Sportovni Pravo');
  });
});
