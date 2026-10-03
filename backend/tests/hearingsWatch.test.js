/**
 * Hlídač soudních jednání (2. 10. 2026 — InfoSoud/InfoJednání mimo provoz od 1. 10.):
 *  • výpadek zdroje se eviduje a po prahu advokáta upozorní (jednou), po obnovení uzavře,
 *  • nová jednání se hledají ve VŠECH aktivních spisech se soudem (ne jen ručně zadaná),
 *  • jednání z doručeného předvolání se navrhne ke sledování (k potvrzení),
 *  • tolerantní čtení odpovědi + HTML místo dat = chyba, ne „beze změny“.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_hw_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

const src = require('../lib/court_hearings_source');
const HW = require('../lib/hearings');
const health = require('../lib/hearings_health');
const db = require('../lib/database');
const { extractHearings } = require('../lib/hearing_extract');

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plus = (n, base = new Date()) => { const x = new Date(base); x.setDate(x.getDate() + n); return x; };
const ddmm = d => `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
const okFetch = (udalosti, organizace = 'Okresní soud v Jihlavě') => jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ organizace, udalosti }) }));
const htmlFetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => '<!doctype html><html><body>Stránka nebyla nalezena</body></html>' }));
const downFetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });

const alertsOf = kind => (db.get('alerts') || []).filter(a => a.kind === kind);

describe('court_hearings_source', () => {
    test('parseSpisZn zahodí č. j. za pomlčkou', () => {
        expect(src.parseSpisZn('12 C 45/2026-58')).toEqual({ cisloSenatu: '12', druhVeci: 'C', bcVec: '45', rocnik: '2026' });
        expect(src.parseSpisZn('nesmysl')).toBeNull();
        // Opatrovnický rejstřík s mezerami (InfoJednání ho bere i jako „P A NC“, ověřeno 3. 10. 2026)
        expect(src.parseSpisZn('6 P a Nc 53/2026')).toEqual({ cisloSenatu: '6', druhVeci: 'P a Nc', bcVec: '53', rocnik: '2026' });
    });

    test('normalizeResponse čte skutečnou odpověď InfoJednání (zachyceno 3. 10. 2026)', () => {
        const real = { nadrizenaOrganizace: 'Krajský soud Brno', organizace: 'Okresní soud Jihlava', jednaciSin: null, datum: null, typ: 'SPZN',
            cislo: 6, bcVec: 9207, druh: 'NC', rocnik: 2026, platneK: '2026-10-03T08:16:49+02:00',
            udalosti: [{ cislo: null, bcVec: null, druh: null, rocnik: null, datum: '05.10.2026', cas: '12:45', predmetJednani: null,
                resitel: 'Mgr. X', jednaniZruseno: null, neverejneJednani: null, druhJednani: 'Jednání', vysledek: null, datumZapisuVysledku: null, jednaciSin: 'č. 04 I. podlaží' }] };
        expect(src.normalizeResponse(real)).toEqual({ court: 'Okresní soud Jihlava',
            events: [{ date: '2026-10-05', time: '12:45', room: 'č. 04 I. podlaží', cancelled: false, kind: 'Jednání', result: null }] });
        expect(src.normalizeResponse(Object.assign({}, real, { udalosti: [] })).events).toEqual([]);
    });
    test('normalizeResponse snese různé názvy polí', () => {
        const a = src.normalizeResponse({ udalosti: [{ datum: '15. 10. 2026', cas: '9:00', jednaciSin: '12', jednaciZruseno: 'Ne' }] });
        expect(a.events[0]).toMatchObject({ date: '2026-10-15', time: '09:00', room: '12', cancelled: false });
        const b = src.normalizeResponse([{ date: '2026-10-15T13:30:00', room: '3', cancelled: true }]);
        expect(b.events[0]).toMatchObject({ date: '2026-10-15', time: '13:30', cancelled: true });
        expect(src.normalizeResponse({ neco: 1 })).toBeNull();
    });
    test('HTML místo dat, HTTP chyba i síť → ok:false (nikdy „beze změny“)', async () => {
        const q = { courtCode: 'OSJI', spisZn: '12 C 45/2026' };
        expect(await src.fetchHearings(q, { fetch: htmlFetch })).toMatchObject({ ok: false, kind: 'invalid_response' });
        expect(await src.fetchHearings(q, { fetch: jest.fn(async () => ({ ok: false, status: 503 })) })).toMatchObject({ ok: false, kind: 'unavailable' });
        expect(await src.fetchHearings(q, { fetch: downFetch })).toMatchObject({ ok: false, kind: 'unavailable' });
        expect(await src.fetchHearings({ spisZn: '12 C 45/2026' }, { fetch: okFetch([]) })).toMatchObject({ ok: false, kind: 'not_configured' });
    });
    test('kód soudu: soudKod > ruční mapa > oficiální číselník (i v 6. pádě); nejasné → null', () => {
        expect(src.resolveCourtCode('X1', 'cokoli')).toBe('X1');
        expect(src.resolveCourtCode(null, 'Okresní soud v Jihlavě')).toBe('OSJIMJI');
        expect(src.resolveCourtCode(null, 'Obvodní soud pro Prahu 8')).toBe('OSPHA08');
        expect(src.resolveCourtCode(null, 'Krajský soud v Brně – pobočka v Jihlavě')).toBe('KSJIMBM');
        expect(src.resolveCourtCode(null, 'Okresní soud v Kladně')).toBe('OSSTCKL');
        expect(src.resolveCourtCode(null, 'Okresní soud v Klatovech')).toBe('OSZPCKT');
        expect(src.resolveCourtCode(null, 'Soud v Atlantidě')).toBeNull();
        process.env.LEXIS_COURT_CODES = JSON.stringify({ 'Okresní soud v Jihlavě': 'OSJI' });
        src._resetCourtCodes();
        expect(src.resolveCourtCode(null, 'okresní soud v jihlavě')).toBe('OSJI');
        delete process.env.LEXIS_COURT_CODES; src._resetCourtCodes();
    });
    test('okresní soud: dotaz jako oficiální web (nadřízený KS + okresniSoud); zrušení = jednaniZruseno', async () => {
        expect(src.parentCourtCode('OSJIMJI')).toBe('KSJIMBM');
        expect(src.parentCourtCode('OSPHA08')).toBe('MSPHAAB');
        const f = okFetch([{ datum: '15.10.2026', cas: '09:00', jednaciSin: '12', jednaniZruseno: 'Ano', druhJednani: 'Jednání', vysledek: 'Odročeno' }]);
        const r = await src.fetchHearings({ courtCode: 'OSJIMJI', spisZn: '12 C 45/2026' }, { fetch: f });
        expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ druhOrganizace: 'KSJIMBM', okresniSoud: 'OSJIMJI', cisloSenatu: '12', druhVeci: 'C', bcVec: '45', rocnik: '2026', typHledani: 'SPZN' });
        expect(r.events[0]).toMatchObject({ cancelled: true, kind: 'Jednání', result: 'Odročeno' });
    });
});

describe('výpadek InfoJednání → evidence a upozornění', () => {
    const seed = () => HW.saveMonitoredHearings(tmp, [{
        id: 'h1', title: 'Jednání 12 C 45/2026', courtCode: 'OSJI', courtName: 'Okresní soud v Jihlavě',
        spisovaZnacka: src.parseSpisZn('12 C 45/2026'), dueDate: iso(plus(5)), time: '09:00', status: 'scheduled'
    }]);

    test('selhání nemění stav jednání, zapíše chybu; po 6 h jedno upozornění; obnovení ho uzavře', async () => {
        seed();
        const t0 = new Date();
        await HW.checkAllHearings(tmp, { fetch: htmlFetch, now: t0 });
        let h = HW.loadMonitoredHearings(tmp)[0];
        expect(h.status).toBe('scheduled');
        expect(h.lastCheckError).toMatch(/webovou stránku/);
        expect(health.summary(tmp, t0).status).toBe('degraded');
        expect(alertsOf('hearings_outage').length).toBe(0);

        const t7 = new Date(t0.getTime() + 7 * 3600000);
        await HW.checkAllHearings(tmp, { fetch: downFetch, now: t7 });
        await HW.checkAllHearings(tmp, { fetch: downFetch, now: new Date(t7.getTime() + 3600000) });
        expect(health.summary(tmp, t7).status).toBe('down');
        expect(alertsOf('hearings_outage').length).toBe(1); // jen jedno, ne každou hodinu

        await HW.checkAllHearings(tmp, { fetch: okFetch([{ datum: ddmm(plus(5)), cas: '09:00', jednaciSin: '12' }]), now: new Date(t7.getTime() + 2 * 3600000) });
        expect(health.summary(tmp).status).toBe('ok');
        expect(alertsOf('hearings_outage')[0].status).toBe('resolved');
        expect(alertsOf('hearings_recovered').length).toBe(1);
        h = HW.loadMonitoredHearings(tmp)[0];
        expect(h.lastVerifiedAt).toBeTruthy();
        expect(h.lastCheckError).toBeNull();
    });

    test('přesun jednání → upozornění pro advokáta', async () => {
        seed();
        await HW.checkAllHearings(tmp, { fetch: okFetch([{ datum: ddmm(plus(9)), cas: '10:30', jednaciSin: '3' }]) });
        const h = HW.loadMonitoredHearings(tmp)[0];
        expect(h.dueDate).toBe(iso(plus(9)));
        expect(h.status).toBe('updated');
        expect(alertsOf('hearing_change').some(a => /PŘESUNUTO/.test(a.title))).toBe(true);
    });
});

describe('hledání nových jednání v aktivních spisech', () => {
    const spisy = require('../lib/spisy');
    test('spis se soudKod → nové jednání k potvrzení (bez duplicit); spis bez soudu → nelze hlídat', async () => {
        HW.saveMonitoredHearings(tmp, []);
        const s1 = spisy.createSpis({ spisZn: '7 C 100/2026', klient: 'E2E', odpovednyAdvokat: 'novak', soud: 'Okresní soud v Jihlavě', soudKod: 'OSJI' });
        spisy.createSpis({ spisZn: '8 C 200/2026', klient: 'E2E2' });
        const ev = [{ datum: ddmm(plus(12)), cas: '08:30', jednaciSin: '7' }, { datum: ddmm(plus(-3)), cas: '08:00' }];
        const r1 = await HW.checkSpisy(tmp, { fetch: okFetch(ev) });
        expect(r1.found).toBe(1);
        expect(r1.unmonitorable.map(u => u.spisZn)).toContain('8 C 200/2026');
        const r2 = await HW.checkSpisy(tmp, { fetch: okFetch(ev) });
        expect(r2.found).toBe(0);
        const hs = HW.loadMonitoredHearings(tmp).filter(h => h.spisId === s1.id);
        expect(hs.length).toBe(1);
        expect(hs[0]).toMatchObject({ status: 'needs_review', advokat: 'novak', dueDate: iso(plus(12)), time: '08:30', source: 'infojednani' });
        expect(HW.confirmHearing(tmp, hs[0].id).status).toBe('scheduled');
    });
});

describe('jednání z doručeného předvolání', () => {
    test('rozpozná datum, čas, síň, soud a sp. zn.', () => {
        const r = extractHearings('Okresní soud v Jihlavě, sp. zn. 12 C 45/2026. Soud nařizuje jednání na den 15. 10. 2026 v 9:00 hod. do jednací síně č. 12.');
        expect(r).toEqual([expect.objectContaining({ date: '2026-10-15', time: '09:00', room: '12', court: 'Okresní soud v Jihlavě', spisZn: '12 C 45/2026' })]);
    });
    test('slovní měsíc a krajský soud s pobočkou', () => {
        const r = extractHearings('Krajský soud v Brně – pobočka v Jihlavě, č. j. 23 Co 120/2025-40. Jednání se koná dne 3. listopadu 2026 v 13.30 hodin v jednací síni č. 115.');
        expect(r[0]).toMatchObject({ date: '2026-11-03', time: '13:30', room: '115', spisZn: '23 Co 120/2025' });
        expect(r[0].court).toMatch(/Krajský soud v Brně/);
    });
    test('lhůta bez jednání → nic', () => {
        expect(extractHearings('Vyjádřete se ve lhůtě 10 dnů od doručení.')).toEqual([]);
    });
});

describe('API a připravenost', () => {
    const request = require('supertest');
    const app = require('../server');
    const H = r => r.set('X-API-Token', 'tok-test');
    test('GET /api/calendar/hearings/status a readiness hlásí výpadek', async () => {
        await HW.checkAllHearings(tmp, { fetch: downFetch, now: new Date(Date.now() - 8 * 3600000) });
        HW.saveMonitoredHearings(tmp, [{ id: 'hx', title: 'J', courtCode: 'OSJI', spisovaZnacka: src.parseSpisZn('1 C 1/2026'), dueDate: iso(plus(3)), status: 'scheduled' }]);
        await HW.checkAllHearings(tmp, { fetch: downFetch });
        const st = await H(request(app).get('/api/calendar/hearings/status'));
        expect(st.status).toBe(200);
        expect(st.body.health.status).toBe('down');
        expect(st.body.source.verified).toBe(false);
        const rd = await H(request(app).get('/api/readiness'));
        const c = rd.body.checks.find(x => x.id === 'hlidac_jednani');
        expect(c.status).toBe('fail');
        expect(c.fix).toMatch(/ručně/);
    });
});

describe('konfigurovatelné rozhraní (po ověření skutečného API)', () => {
    afterEach(() => { delete process.env.LEXIS_INFOJEDNANI_METHOD; delete process.env.LEXIS_INFOJEDNANI_BODY_TEMPLATE; delete process.env.LEXIS_INFOJEDNANI_URL; });
    test('GET s šablonou v URL', async () => {
        process.env.LEXIS_INFOJEDNANI_METHOD = 'GET';
        process.env.LEXIS_INFOJEDNANI_URL = 'https://x.test/jednani?soud={courtCode}&spzn={cisloSenatu}%20{druhVeci}%20{bcVec}/{rocnik}';
        const f = okFetch([]);
        await src.fetchHearings({ courtCode: 'K S', spisZn: '12 C 45/2026' }, { fetch: f });
        expect(f.mock.calls[0][0]).toBe('https://x.test/jednani?soud=K%20S&spzn=12%20C%2045/2026');
        expect(f.mock.calls[0][1].method).toBe('GET');
    });
    test('POST s šablonou těla', async () => {
        process.env.LEXIS_INFOJEDNANI_BODY_TEMPLATE = '{"spzn":"{cisloSenatu} {druhVeci} {bcVec}/{rocnik}","soud":"{courtCode}"}';
        const f = okFetch([]);
        await src.fetchHearings({ courtCode: 'OSJI', spisZn: '12 C 45/2026' }, { fetch: f });
        expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ spzn: '12 C 45/2026', soud: 'OSJI' });
    });
});
