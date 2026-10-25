// Prověrka střetu zájmů: deterministická kontrola proti spisové evidenci.
// Sémantické vyhledávání u krátkých jmen nedosáhne prahu → bez této kontroly
// vycházelo „bezpečné“, i když protistrana byla vedena jako náš klient.
jest.mock('../lib/rag', () => ({ searchSimilar: jest.fn().mockResolvedValue([]) }));
const mockSpisy = [];
jest.mock('../lib/spisy', () => ({ listSpisy: () => mockSpisy }));

const db = require('../lib/database');
const C = require('../lib/conflicts');

beforeEach(() => {
    mockSpisy.length = 0;
    mockSpisy.push(
        { id: 's1', spisZn: '12 C 3/2026', nazev: 'Novotná vs. Horák', klient: 'Eva Novotná', klientIco: '', protistrana: 'Petr Horák', stav: 'aktivni' },
        { id: 's2', nazev: 'ACME vymáhání', klient: 'ACME, a. s.', klientIco: '27082440', protistrana: 'Stavby Brno s.r.o.', stav: 'uzavreno' }
    );
    jest.spyOn(db, 'insert').mockImplementation((c, d) => Object.assign({ id: 'x' }, d));
});
afterEach(() => jest.restoreAllMocks());

test('protistrana = náš klient ve spisu → high (bez ohledu na diakritiku)', async () => {
    const r = await C.checkConflict('Nový klient s.r.o.', 'eva novotna');
    expect(r.riskLevel).toBe('high');
    expect(r.conflictsFound[0]).toMatchObject({ type: 'registry_counterparty_was_client', spisId: 's1', role: 'klient' });
});

test('nový klient = dřívější protistrana → high (právní forma se ignoruje)', async () => {
    const r = await C.checkConflict('Stavby Brno, spol. s r.o.', 'Někdo Jiný');
    expect(r.riskLevel).toBe('high');
    expect(r.conflictsFound.some(h => h.type === 'registry_client_was_counterparty' && h.spisId === 's2')).toBe(true);
});

test('stávající klient podle IČO → medium', async () => {
    const r = await C.checkConflict('IČO 27082440', 'Úplně Cizí');
    expect(r.riskLevel).toBe('medium');
    expect(r.conflictsFound[0]).toMatchObject({ type: 'registry_client_existing', spisId: 's2' });
});

test('bez shody → none; jiné jméno se stejným příjmením nestačí na shodu celého jména', async () => {
    const r = await C.checkConflict('Jana Malá', 'Eva Nováková');
    expect(r.riskLevel).toBe('none');
    expect(r.conflictsFound).toHaveLength(0);
});
