/**
 * Unit testy archivačního modulu (backend/lib/archival.js) — Dublin Core XML
 * sidecar pro dlouhodobou archivaci (PDF/A). Hlídá výchozí hodnoty, promítnutí
 * metadat a hlavně BEZPEČNÉ escapování (žádná XML injekce z názvu dokumentu).
 * Bez závislostí, deterministické.
 */
const { generateDublinCoreXml, escapeXml } = require('../lib/archival.js');

describe('escapeXml', () => {
  test('escapuje všech pět speciálních znaků', () => {
    expect(escapeXml(`<>&'"`)).toBe('&lt;&gt;&amp;&apos;&quot;');
  });
  test('ne-řetězec → prázdný řetězec', () => {
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
    expect(escapeXml(42)).toBe('');
  });
});

describe('generateDublinCoreXml — výchozí hodnoty', () => {
  const xml = generateDublinCoreXml();
  test('validní XML hlavička a kořenový prvek s Dublin Core NS', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
  });
  test('doplní rozumné výchozí hodnoty (cs, advokátní tajemství)', () => {
    expect(xml).toContain('<dc:title>Nepojmenovaný dokument</dc:title>');
    expect(xml).toContain('<dc:language>cs</dc:language>');
    expect(xml).toContain('<dc:rights>Důvěrné / Advokátní tajemství</dc:rights>');
  });
  test('identifier je urn:uuid ve výchozím stavu', () => {
    expect(xml).toMatch(/<dc:identifier>urn:uuid:[0-9a-f-]{16,}<\/dc:identifier>/i);
  });
  test('dva výstupy mají různý identifier (náhodné UUID)', () => {
    const a = generateDublinCoreXml().match(/<dc:identifier>([^<]+)</)[1];
    const b = generateDublinCoreXml().match(/<dc:identifier>([^<]+)</)[1];
    expect(a).not.toBe(b);
  });
});

describe('generateDublinCoreXml — promítnutí metadat', () => {
  test('zadaná pole se objeví ve výstupu', () => {
    const xml = generateDublinCoreXml({
      title: 'Žaloba', creator: 'Mgr. Novák', language: 'en', identifier: 'urn:spis:2026/42',
    });
    expect(xml).toContain('<dc:title>Žaloba</dc:title>');
    expect(xml).toContain('<dc:creator>Mgr. Novák</dc:creator>');
    expect(xml).toContain('<dc:language>en</dc:language>');
    expect(xml).toContain('<dc:identifier>urn:spis:2026/42</dc:identifier>');
  });

  test('BEZPEČNOST: název s XML/injekcí se escapuje (žádný syrový tag)', () => {
    const xml = generateDublinCoreXml({ title: '<script>alert(1)</script> & "spis"' });
    expect(xml).toContain('<dc:title>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;spis&quot;</dc:title>');
    expect(xml).not.toContain('<script>');
  });
});
