/**
 * Unit testy registrových konektorů (backend/lib/registries.js).
 * Síť je vždy injektovaná (opts.fetchUrl) nebo nekonfigurovaná → žádné reálné
 * volání. Databáze je mockovaná, konfigurace jde přes proměnné prostředí.
 * Ověřuje sestavení SOAP/HTTP dotazů, parsování odpovědí a fail-closed chování.
 */
jest.mock('../lib/database', () => ({ get: () => [], insert: () => {}, update: () => {} }));
const reg = require('../lib/registries.js');

// Přepínání ISDS/registrové konfigurace přes env — čistě mezi testy.
const ISDS_ENV = ['ISDS_LOGIN', 'ISDS_PASSWORD', 'ISDS_WS_URL',
  'CEE_API_URL', 'CEE_API_KEY', 'KATASTR_API_URL', 'KATASTR_API_KEY', 'DPH_WS_URL'];
beforeEach(() => ISDS_ENV.forEach(k => { delete process.env[k]; }));
afterAll(() => ISDS_ENV.forEach(k => { delete process.env[k]; }));

// Injektovatelný fetch, který vrátí danou odpověď a zaznamená volání.
function fakeFetch(response) {
  const calls = [];
  const fn = (url, options) => { calls.push({ url, options }); return Promise.resolve(response); };
  fn.calls = calls;
  return fn;
}
function throwingFetch(message) {
  return () => Promise.reject(new Error(message));
}

describe('findDataBox — ISDS vyhledání schránky dle IČO', () => {
  test('neplatná délka IČO → nedostupné s vysvětlením', async () => {
    const r = await reg.findDataBox('123');
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/8 číslic/);
  });

  test('bez přihlašovacích údajů → configured:false a čestné vysvětlení', async () => {
    const r = await reg.findDataBox('27074358');
    expect(r).toMatchObject({ available: false, configured: false });
    expect(r.reason).toMatch(/přihlašovací údaje do ISDS/);
  });

  test('jedna schránka → found:true a správně sestavený autentizovaný POST', async () => {
    process.env.ISDS_LOGIN = 'user1';
    process.env.ISDS_PASSWORD = 'pass1';
    const xml = '<E><dbStatusCode>0000</dbStatusCode><dbStatusMessage>OK</dbStatusMessage>' +
      '<dbOwnerInfo><dbID>abc12de</dbID><firmName>Firma a.s.</firmName></dbOwnerInfo></E>';
    const f = fakeFetch(xml);
    const r = await reg.findDataBox('270 743 58', { fetchUrl: f });
    expect(r).toMatchObject({ available: true, found: true, dataBoxId: 'abc12de', subjectName: 'Firma a.s.', statusCode: '0000' });
    // request: POST, Basic auth, prázdná SOAPAction, delší timeout, IČO očištěné v těle
    const call = f.calls[0];
    expect(call.options.method).toBe('POST');
    expect(call.options.headers.Authorization).toBe('Basic ' + Buffer.from('user1:pass1').toString('base64'));
    expect(call.options.headers.SOAPAction).toBe('');
    expect(call.options.timeout).toBe(15000);
    expect(call.options.body).toContain('<p:ic>27074358</p:ic>');
  });

  test('více shod → ambiguous s kandidáty (fail-closed)', async () => {
    process.env.ISDS_LOGIN = 'u'; process.env.ISDS_PASSWORD = 'p';
    const xml = '<E><dbStatusCode>0000</dbStatusCode>' +
      '<dbOwnerInfo><dbID>id1aaaa</dbID></dbOwnerInfo>' +
      '<dbOwnerInfo><dbID>id2bbbb</dbID></dbOwnerInfo></E>';
    const r = await reg.findDataBox('27074358', { fetchUrl: fakeFetch(xml) });
    expect(r).toMatchObject({ available: true, found: false, ambiguous: true });
    expect(r.candidates).toEqual(['id1aaaa', 'id2bbbb']);
  });

  test('chybový stav ISDS bez schránky → předá status výš', async () => {
    process.env.ISDS_LOGIN = 'u'; process.env.ISDS_PASSWORD = 'p';
    const xml = '<E><dbStatusCode>1004</dbStatusCode><dbStatusMessage>Chyba</dbStatusMessage></E>';
    const r = await reg.findDataBox('27074358', { fetchUrl: fakeFetch(xml) });
    expect(r).toMatchObject({ available: true, found: false, statusCode: '1004' });
    expect(r.error).toMatch(/ISDS status 1004/);
  });

  test('selhání sítě → available:false s chybou (nikdy nefabrikuje)', async () => {
    process.env.ISDS_LOGIN = 'u'; process.env.ISDS_PASSWORD = 'p';
    const r = await reg.findDataBox('27074358', { fetchUrl: throwingFetch('ECONNRESET') });
    expect(r).toMatchObject({ available: false, configured: true });
    expect(r.error).toMatch(/Dotaz do ISDS selhal.*ECONNRESET/);
  });
});

describe('isIsdsConfigured', () => {
  test('bez údajů false, s údaji true', () => {
    expect(reg.isIsdsConfigured()).toBe(false);
    process.env.ISDS_LOGIN = 'a'; process.env.ISDS_PASSWORD = 'b';
    expect(reg.isIsdsConfigured()).toBe(true);
  });
});

describe('checkVatReliability — nespolehlivý plátce DPH', () => {
  test('neplatné DIČ → nedostupné', async () => {
    const r = await reg.checkVatReliability('CZ12');
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/DIČ/);
  });

  test('nespolehlivý plátce ANO → unreliable:true a očištěné DIČ v těle', async () => {
    const xml = '<E><StatusNespolehlivyPlatceResponse><statusPlatceDPH nespolehlivyPlatce="ANO" dic="27074358"/></StatusNespolehlivyPlatceResponse></E>';
    const f = fakeFetch(xml);
    const r = await reg.checkVatReliability('CZ27074358', { fetchUrl: f });
    expect(r).toMatchObject({ available: true, isVatPayer: true, unreliable: true, raw: 'ANO' });
    expect(f.calls[0].options.body).toContain('<new:dic>27074358</new:dic>');
  });

  test('spolehlivý plátce NE → unreliable:false', async () => {
    const xml = '<E><x nespolehlivyPlatce="NE"/></E>';
    const r = await reg.checkVatReliability('27074358', { fetchUrl: fakeFetch(xml) });
    expect(r).toMatchObject({ available: true, isVatPayer: true, unreliable: false });
  });

  test('NENALEZEN → není plátce, unreliable null', async () => {
    const xml = '<E><x nespolehlivyPlatce="NENALEZEN"/></E>';
    const r = await reg.checkVatReliability('27074358', { fetchUrl: fakeFetch(xml) });
    expect(r).toMatchObject({ available: true, isVatPayer: false, unreliable: null });
  });

  test('bez atributu → poznámka ze statusText', async () => {
    const xml = '<E><statusText>Chybný formát dotazu</statusText></E>';
    const r = await reg.checkVatReliability('27074358', { fetchUrl: fakeFetch(xml) });
    expect(r).toMatchObject({ available: true, isVatPayer: false, unreliable: null });
    expect(r.note).toMatch(/Chybný formát/);
  });

  test('selhání sítě → available:false', async () => {
    const r = await reg.checkVatReliability('27074358', { fetchUrl: throwingFetch('timeout') });
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/registru DPH selhal/);
  });
});

describe('checkAresStatutory — statutární orgán z ARES VR', () => {
  test('demo fixtura pod jestem (12345678) → simulovaný jednatel', async () => {
    const r = await reg.checkAresStatutory('12345678');
    expect(r).toMatchObject({ available: true, simulated: true });
    expect(r.members[0]).toMatchObject({ prijmeni: 'Novák', funkce: 'jednatel' });
  });

  test('neplatná délka IČO → nedostupné', async () => {
    const r = await reg.checkAresStatutory('123');
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/8 číslic/);
  });

  test('reálný dotaz: rekurzivně vytáhne členy i způsob jednání', async () => {
    const json = JSON.stringify({
      statutarniOrgan: {
        clenoveOrganu: [
          { fyzickaOsoba: { jmeno: 'Petr', prijmeni: 'Svoboda' }, clenstvi: { funkce: { nazev: 'předseda představenstva' } } },
        ],
        zpusobJednani: 'Za společnost jedná předseda samostatně.',
      },
    });
    const r = await reg.checkAresStatutory('27074358', { fetchUrl: fakeFetch(json) });
    expect(r.available).toBe(true);
    expect(r.members).toEqual([{ jmeno: 'Petr', prijmeni: 'Svoboda', funkce: 'předseda představenstva' }]);
    expect(r.zpusobJednani).toContain('Za společnost jedná předseda samostatně.');
  });

  test('selhání sítě → available:false s chybou', async () => {
    const r = await reg.checkAresStatutory('27074358', { fetchUrl: throwingFetch('DNS') });
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/ARES VR selhal/);
  });
});

describe('CEE a Katastr — bez konfigurace nevrací žádná data', () => {
  test('CEE nekonfigurováno → configured:false a důvod', async () => {
    const r = await reg.checkCee('27074358');
    expect(r).toMatchObject({ available: false, configured: false });
    expect(r.reason).toMatch(/Exekutorské komory/);
  });
  test('Katastr nekonfigurováno → configured:false a důvod', async () => {
    const r = await reg.checkKatastr('27074358');
    expect(r).toMatchObject({ available: false, configured: false });
    expect(r.reason).toMatch(/ČÚZK/);
  });
});

describe('checkSubject — validace vstupu', () => {
  test('IČO jiné než 8 číslic → chyba bez volání registrů', async () => {
    const r = await reg.checkSubject('123');
    expect(r.error).toMatch(/8 číslic/);
  });
});

describe('getRegistryConfig — nikdy nevrací celý klíč/heslo', () => {
  test('vrací URL a jen příznaky hasKey/hasPassword', () => {
    process.env.CEE_API_URL = 'https://cee.example/{ico}';
    process.env.CEE_API_KEY = 'tajny-klic';
    process.env.ISDS_LOGIN = 'lawyer';
    process.env.ISDS_PASSWORD = 'secret';
    const c = reg.getRegistryConfig();
    expect(c.cee.url).toBe('https://cee.example/{ico}');
    expect(c.cee.hasKey).toBe(true);
    expect(c.isds.login).toBe('lawyer');
    expect(c.isds.hasPassword).toBe(true);
    // heslo ani klíč se ven nedostanou
    expect(JSON.stringify(c)).not.toContain('secret');
    expect(JSON.stringify(c)).not.toContain('tajny-klic');
    expect(c.isds).not.toHaveProperty('password');
  });
});
