/**
 * ISIR — insolvenční řízení podle spisové značky (lib/isir_cases.js).
 * Síť je vždy injektovaná (opts.post); struktura odpovědi odpovídá skutečnému
 * dotazu na WS ISIR ověřenému 3. 10. 2026 (údaje jsou smyšlené).
 */
const mockDb = { spisy: [], alerts: [], updates: [] };
jest.mock('../lib/database', () => ({
    get: (c) => mockDb[c] || [],
    insert: (c, item) => { mockDb[c].push(item); return item; },
    update: (c, id, u) => { mockDb.updates.push({ c, id, u }); const s = (mockDb[c] || []).find(x => x.id === id); if (s) Object.assign(s, u); }
}));
jest.mock('../lib/spisy', () => ({ listSpisy: () => mockDb.spisy }));

const isir = require('../lib/isir_cases');

function resp(records, stav = '') {
    const data = records.map(r => `<data><ic>${r.ic || ''}</ic><cisloSenatu>${r.senat}</cisloSenatu><druhVec>INS</druhVec>` +
        `<bcVec>${r.bc}</bcVec><rocnik>${r.rok}</rocnik><nazevOrganizace>${r.firma || ''}</nazevOrganizace>` +
        `<mesto>Brno</mesto><druhStavKonkursu>${r.stav}</druhStavKonkursu>` +
        `<urlDetailRizeni>https://isir.justice.cz/isir/ueu/evidence_upadcu_detail.do?id=abc</urlDetailRizeni>` +
        `<dalsiDluznikVRizeni>${r.dalsi ? 'T' : 'F'}</dalsiDluznikVRizeni>` +
        `<datumPmZahajeniUpadku>2026-03-19Z</datumPmZahajeniUpadku></data>`).join('');
    return '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
        `<ns2:getIsirWsCuzkDataResponse xmlns:ns2="http://isirws.cca.cz/types/">${data}` +
        `<stav><pocetVysledku>${records.length}</pocetVysledku><relevanceVysledku>3</relevanceVysledku>` +
        `<casSynchronizace>2026-10-03T15:00:00</casSynchronizace>${stav}</stav>` +
        '</ns2:getIsirWsCuzkDataResponse></soap:Body></soap:Envelope>';
}
const postOf = (xml) => { const fn = jest.fn(() => Promise.resolve(xml)); return fn; };

beforeEach(() => { mockDb.spisy = []; mockDb.alerts = []; mockDb.updates = []; });

describe('parseInsZn / formatInsZn / insKey', () => {
    test.each([
        ['KSBR 56 INS 1000/2026', { soud: 'KSBR', cisloSenatu: '56', bcVec: '1000', rocnik: '2026' }],
        ['56 INS 1000 / 2026', { soud: null, cisloSenatu: '56', bcVec: '1000', rocnik: '2026' }],
        ['INS 1000/2026', { soud: null, cisloSenatu: null, bcVec: '1000', rocnik: '2026' }],
        ['msph 98 ins 12/2025-A-5', { soud: 'MSPH', cisloSenatu: '98', bcVec: '12', rocnik: '2025' }]
    ])('%s', (zn, exp) => { expect(isir.parseInsZn(zn)).toEqual(exp); });

    test('neinsolvenční sp. zn. → null', () => {
        expect(isir.parseInsZn('6 P a Nc 53/2026')).toBeNull();
        expect(isir.parseInsZn('')).toBeNull();
    });
    test('formát a klíč', () => {
        expect(isir.formatInsZn(isir.parseInsZn('KSBR 56 INS 1000/2026'))).toBe('KSBR 56 INS 1000/2026');
        expect(isir.insKey('KSBR 56 INS 1000/2026')).toBe(isir.insKey('INS 1000/2026'));
    });
});

describe('buildRequest', () => {
    test('posílá jen sp. zn. (druh, číslo, ročník)', () => {
        const x = isir.buildRequest({ bcVec: '1000', rocnik: '2026' });
        expect(x).toContain('<druhVec>INS</druhVec><bcVec>1000</bcVec><rocnik>2026</rocnik>');
        expect(x).not.toMatch(/<ic>|<rc>|nazevOsoby/);
    });
});

describe('fetchInsCase', () => {
    test('nalezené řízení', async () => {
        const post = postOf(resp([{ senat: 56, bc: 1000, rok: 2026, stav: 'ODDLUŽENÍ', firma: 'Test s.r.o.', ic: '12345678' }]));
        const r = await isir.fetchInsCase('KSBR 56 INS 1000/2026', { post });
        expect(r.ok).toBe(true);
        expect(r.cases).toHaveLength(1);
        expect(r.cases[0]).toMatchObject({ spisZn: '56 INS 1000/2026', stav: 'ODDLUŽENÍ', zahajeni: '2026-03-19', dalsiDluznik: false });
        expect(r.syncedAt).toBe('2026-10-03T15:00:00');
        expect(post.mock.calls[0][0]).toContain('<bcVec>1000</bcVec>');
    });
    test('filtr podle senátu', async () => {
        const post = postOf(resp([{ senat: 56, bc: 1, rok: 2026, stav: 'KONKURS' }, { senat: 12, bc: 1, rok: 2026, stav: 'ÚPADEK' }]));
        const r = await isir.fetchInsCase('56 INS 1/2026', { post });
        expect(r.cases.map(c => c.cisloSenatu)).toEqual(['56']);
    });
    test('WS2 = nenalezeno, není chyba', async () => {
        const r = await isir.fetchInsCase('INS 9999999/2026', { post: postOf(resp([], '<kodChyby>WS2</kodChyby><textChyby>Nenalezeno</textChyby>')) });
        expect(r).toMatchObject({ ok: true, empty: true, cases: [] });
    });
    test('WS4 = zastaralá data → chyba stale', async () => {
        const r = await isir.fetchInsCase('INS 1/2026', { post: postOf(resp([], '<kodChyby>WS4</kodChyby><textChyby>Data nejsou aktuální</textChyby>')) });
        expect(r).toMatchObject({ ok: false, kind: 'stale' });
    });
    test('výpadek sítě / HTML místo SOAP', async () => {
        const r1 = await isir.fetchInsCase('INS 1/2026', { post: () => Promise.reject(new Error('ECONNREFUSED')) });
        expect(r1).toMatchObject({ ok: false, kind: 'unavailable' });
        const r2 = await isir.fetchInsCase('INS 1/2026', { post: postOf('<html>Maintenance</html>') });
        expect(r2).toMatchObject({ ok: false, kind: 'invalid_response' });
    });
    test('špatná sp. zn. → bez dotazu', async () => {
        const post = jest.fn();
        const r = await isir.fetchInsCase('Nc 5/2026', { post });
        expect(r.ok).toBe(false);
        expect(post).not.toHaveBeenCalled();
    });
});

describe('checkInsolvencySpisy — hlídač', () => {
    const now = new Date('2026-10-03T16:00:00Z');
    test('první kontrola uloží stav bez upozornění, změna stavu → upozornění', async () => {
        mockDb.spisy = [
            { id: 's1', spisZn: 'KSBR 56 INS 1000/2026', stav: 'aktivni', odpovednyAdvokat: 'adv1' },
            { id: 's2', spisZn: '6 P a Nc 53/2026', stav: 'aktivni' },
            { id: 's3', spisZn: 'KSBR 56 INS 1/2026', stav: 'archiv' }
        ];
        let stav = 'MORATORIUM';
        const post = jest.fn(() => Promise.resolve(resp([{ senat: 56, bc: 1000, rok: 2026, stav }])));

        const r1 = await isir.checkInsolvencySpisy({ post, now });
        expect(r1).toEqual({ checked: 1, changed: 0, failed: 0 });
        expect(mockDb.spisy[0].isirStav).toBe('MORATORIUM');
        expect(mockDb.alerts).toHaveLength(0);

        stav = 'ÚPADEK';
        const r2 = await isir.checkInsolvencySpisy({ post, now });
        expect(r2.changed).toBe(1);
        expect(mockDb.alerts[0]).toMatchObject({ kind: 'isir_change', advokat: 'adv1' });
        expect(mockDb.alerts[0].title).toContain('MORATORIUM → ÚPADEK');
        expect(post).toHaveBeenCalledTimes(2);
    });
    test('výpadek ISIR stav nemění a upozornění nezakládá', async () => {
        mockDb.spisy = [{ id: 's1', spisZn: 'INS 1000/2026', stav: 'aktivni', isirStav: 'KONKURS' }];
        const r = await isir.checkInsolvencySpisy({ post: () => Promise.reject(new Error('timeout')), now });
        expect(r.failed).toBe(1);
        expect(mockDb.spisy[0].isirStav).toBe('KONKURS');
        expect(mockDb.spisy[0].isirError).toMatch(/nedostupný/);
        expect(mockDb.alerts).toHaveLength(0);
    });
    test('pole insZn má přednost (spis vedený pod jinou sp. zn.)', async () => {
        mockDb.spisy = [{ id: 's1', spisZn: '12 C 5/2026', insZn: 'KSOS 8 INS 77/2026', stav: 'aktivni' }];
        const post = jest.fn(() => Promise.resolve(resp([{ senat: 8, bc: 77, rok: 2026, stav: 'KONKURS' }])));
        await isir.checkInsolvencySpisy({ post, now });
        expect(post.mock.calls[0][0]).toContain('<bcVec>77</bcVec>');
        expect(mockDb.spisy[0].isirStav).toBe('KONKURS');
    });
});
