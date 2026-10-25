/**
 * Unit testy automatické detekce oboru (backend/lib/obor_detect.js).
 * Modul kombinuje lexikální skóre (klíčová slova z obory.js) a volitelnou
 * sémantiku (centroidy z RAG). RAG je celý mockovaný → deterministické, offline.
 * Ověřuje: prázdný/nekandidátní vstup → null, čistě lexikální i hybridní režim,
 * prahování jistoty (min. skóre + náskok), příznaky degraded/method a filtr scope.
 */
jest.mock('../lib/rag', () => ({
  listJudikaturaScopes: jest.fn(() => []),
  partitionStat: jest.fn(() => ({ mtimeMs: 1, size: 10 })),
  loadPartition: jest.fn(() => ({ chunks: [] })),
  getEmbedding: jest.fn(async () => null),
  lexicalScore: jest.fn(() => 0),
  cosineSimilarity: jest.fn(() => 0.3),
}));
const rag = require('../lib/rag');
const { detectObor, clearCentroidCache } = require('../lib/obor_detect.js');

const NEMOV = '_kb_obor_nemovitosti_a_najemni_pravo';
const PRACE = '_kb_obor_pracovni_pravo';
const TREST = '_kb_obor_trestni_pravo';

beforeEach(() => {
  jest.clearAllMocks();
  clearCentroidCache();
  // výchozí: tři oborové scopy s daty, žádná sémantika, nulové lexikální skóre
  rag.listJudikaturaScopes.mockReturnValue([NEMOV, PRACE, TREST]);
  rag.getEmbedding.mockRejectedValue(new Error('model nedostupný'));
  rag.lexicalScore.mockReturnValue(0);
  rag.partitionStat.mockReturnValue({ mtimeMs: 1, size: 10 });
  rag.loadPartition.mockReturnValue({ chunks: [] });
});

describe('vstupní podmínky → null', () => {
  test('prázdný dotaz → null', async () => {
    expect(await detectObor('')).toBeNull();
    expect(await detectObor('   ')).toBeNull();
    expect(await detectObor(null)).toBeNull();
  });
  test('žádná oborová data (prázdný registr) → null', async () => {
    rag.listJudikaturaScopes.mockReturnValue([]);
    expect(await detectObor('výpověď z nájmu bytu')).toBeNull();
  });
});

describe('čistě lexikální režim (model nedostupný)', () => {
  test('vybere obor podle klíčových slov, confident a degraded', async () => {
    // vysoké lexikální skóre jen pro obor, jehož klíčová slova obsahují „nájem"
    rag.lexicalScore.mockImplementation((q, kw) => (/nájem/.test(kw) ? 0.5 : 0.02));
    const r = await detectObor('výpověď z nájmu bytu');
    expect(r.slug).toBe('nemovitosti_a_najemni_pravo');
    expect(r.scope).toBe(NEMOV);
    expect(r.method).toBe('lexical');
    expect(r.degraded).toBe(true);          // qv chybí
    expect(r.confident).toBe(true);         // 0.5 ≥ MIN_LEX i náskok ≥ MARGIN
    expect(r.ranked[0].score).toBeGreaterThan(r.ranked[1].score);
  });

  test('malý náskok #1 nad #2 → confident:false (fail-safe na celoplošné hledání)', async () => {
    rag.lexicalScore.mockImplementation((q, kw) => (/nájem/.test(kw) ? 0.10 : (/výpověď|zaměstnan/.test(kw) ? 0.09 : 0.0)));
    const r = await detectObor('ukončení pracovního poměru výpovědí');
    expect(r.margin).toBeLessThan(0.03);
    expect(r.confident).toBe(false);
  });

  test('skóre pod prahem → confident:false i při dostatečném náskoku', async () => {
    rag.lexicalScore.mockImplementation((q, kw) => (/nájem/.test(kw) ? 0.04 : 0.0));
    const r = await detectObor('nějaký neurčitý dotaz');
    expect(r.margin).toBeGreaterThanOrEqual(0.03);
    expect(r.score).toBeLessThan(0.06);     // pod MIN_LEX
    expect(r.confident).toBe(false);
  });
});

describe('hybridní režim (sémantika + lexikální)', () => {
  beforeEach(() => {
    rag.getEmbedding.mockResolvedValue([1, 0, 0]);          // dotazový vektor
    rag.loadPartition.mockReturnValue({ chunks: [{ vector: [1, 2, 3] }, { vector: [3, 2, 1] }] });
    rag.cosineSimilarity.mockReturnValue(0.3);
  });

  test('method = semantic+lexical, práh MIN_SEM, degraded:false', async () => {
    rag.lexicalScore.mockImplementation((q, kw) => (/nájem/.test(kw) ? 0.5 : 0.05));
    const r = await detectObor('spor o nájemné a výpověď z nájmu');
    expect(r.method).toBe('semantic+lexical');
    expect(r.degraded).toBe(false);
    expect(r.slug).toBe('nemovitosti_a_najemni_pravo');
    expect(r.confident).toBe(true);
    // skóre = SEM_WEIGHT*sem + LEX_WEIGHT*lex; ranked nese obě složky
    expect(r.ranked[0].sem).toBeGreaterThan(0);
    expect(r.ranked[0].lex).toBeGreaterThan(0);
  });

  test('vektor dotazu je, ale partition nemá vektory → spadne zpět na lexical', async () => {
    rag.loadPartition.mockReturnValue({ chunks: [] });      // žádné centroidy
    rag.lexicalScore.mockImplementation((q, kw) => (/nájem/.test(kw) ? 0.5 : 0.05));
    const r = await detectObor('výpověď z nájmu');
    expect(r.method).toBe('lexical');       // hasSem=false pro všechny
    expect(r.degraded).toBe(false);         // qv přesto existuje
  });
});

describe('kandidáti a žebříček', () => {
  test('filtruje jen _kb_obor_* scopy (ostatní ignoruje)', async () => {
    rag.listJudikaturaScopes.mockReturnValue([TREST, 'nonobor_scope', NEMOV]);
    rag.lexicalScore.mockReturnValue(0.1);
    const r = await detectObor('cokoliv');
    const slugs = r.ranked.map(x => x.slug);
    expect(slugs).toEqual(expect.arrayContaining(['trestni_pravo', 'nemovitosti_a_najemni_pravo']));
    expect(r.ranked.some(x => /nonobor/.test(x.scope))).toBe(false);
    expect(r.ranked).toHaveLength(2);
  });

  test('ranked je oříznutý na 5 kandidátů', async () => {
    rag.listJudikaturaScopes.mockReturnValue([
      '_kb_obor_obcanske_pravo', NEMOV, '_kb_obor_rodinne_pravo', '_kb_obor_dedicke_pravo',
      PRACE, '_kb_obor_obchodni_a_korporatni_pravo', TREST,
    ]);
    rag.lexicalScore.mockReturnValue(0.1);
    const r = await detectObor('obecný právní dotaz');
    expect(r.ranked).toHaveLength(5);
  });
});

describe('clearCentroidCache', () => {
  test('je exportovaná a nevyhazuje', () => {
    expect(typeof clearCentroidCache).toBe('function');
    expect(() => clearCentroidCache()).not.toThrow();
  });
});
