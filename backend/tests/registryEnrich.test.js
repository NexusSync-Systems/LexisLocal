/** Test 2. 10. 2026: IČO žalobce se z ARES zapsalo do „žalovaného“, při výpadku ARES i text chyby. */
'use strict';
const { enrichPartiesWithRegistry: f } = require('../lib/registries');

test('výpadek ARES: strany se nemění (žádný chybový text v účastnících)', () => {
    const r = f({ plaintiff: 'Stavby Novák s.r.o.', defendant: 'žalovaný' }, { aresOk: false, name: 'ARES nedostupný / Selhal dotaz', ico: '87654321', seat: 'Adresa nezjištěna' });
    expect(r).toEqual({ plaintiff: 'Stavby Novák s.r.o.', defendant: 'žalovaný' });
});
test('IČO patří žalobci → doplní se k žalobci, žalovaný zůstane', () => {
    const r = f({ plaintiff: 'Stavby Novák s.r.o.', defendant: 'Petr Malý' }, { aresOk: true, name: 'Stavby Novák s.r.o.', ico: '87654321', seat: 'Brno' });
    expect(r.plaintiff).toBe('Stavby Novák s.r.o. (IČO: 87654321, sídlo: Brno)');
    expect(r.defendant).toBe('Petr Malý');
});
test('shoda jen s žalovaným (tolerance čárek a právní formy) → doplní k žalovanému', () => {
    const r = f({ plaintiff: 'Jan Novák', defendant: 'ACME a.s.' }, { aresOk: true, name: 'ACME, a.s.', ico: '11111111', seat: 'Praha' });
    expect(r.defendant).toMatch(/ACME a\.s\. \(IČO: 11111111/);
});
test('subjekt neodpovídá žádné straně → beze změny; IČO už uvedené se neduplikuje', () => {
    expect(f({ plaintiff: 'A', defendant: 'B' }, { aresOk: true, name: 'Cizí firma s.r.o.', ico: '1', seat: 'x' })).toEqual({ plaintiff: 'A', defendant: 'B' });
    const r = f({ plaintiff: 'Stavby Novák s.r.o., IČO 87654321', defendant: 'X' }, { aresOk: true, name: 'Stavby Novák s.r.o.', ico: '87654321', seat: 'Brno' });
    expect(r.plaintiff).toBe('Stavby Novák s.r.o., IČO 87654321');
});
