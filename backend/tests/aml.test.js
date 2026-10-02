/**
 * Testy AML modulu (backend/lib/aml.js) — identifikace klienta, ověření v
 * registrech (demo fixtures ARES/ISIR v test režimu), lokální PEP/sankční
 * screening a klasifikace rizika. Bez sítě: použito jen fixture IČO 12345678.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const tempWatchDir = path.join(os.tmpdir(), `lexis_test_aml_${Date.now()}`);
if (!fs.existsSync(tempWatchDir)) fs.mkdirSync(tempWatchDir, { recursive: true });
process.env.WATCH_DIR = tempWatchDir;
process.env.LEXIS_DEMO = '1'; // aktivuje fixtures i mimo NODE_ENV=test

const db = require('../lib/database');
const spisy = require('../lib/spisy');
const aml = require('../lib/aml');

function seed() {
    db.set('spisy', []);
    db.set('spis_events', []);
    db.set('aml_checks', []);
    db.set('aml_watchlist', []);
}

afterAll(() => {
    if (fs.existsSync(tempWatchDir)) fs.rmSync(tempWatchDir, { recursive: true, force: true });
});

beforeEach(seed);

describe('identify — PO s ověřením v registrech', () => {
    test('insolventní PO (fixture IČO) → riziko high a záznam do spisu', async () => {
        const spis = spisy.createSpis({ spisZn: '10 C 1/2026' });
        const rec = await aml.identify({ typ: 'PO', jmeno: 'Úpadce s.r.o.', ico: '12345678', spisId: spis.id, provedl: 'Advokát' });
        expect(rec.registry).toBeTruthy();
        expect(rec.registry.inInsolvency).toBe(true);
        expect(rec.risk).toBe('high');
        expect(rec.needsManualScreening).toBe(true);
        expect(rec.factors.some(f => f.code === 'insolvence')).toBe(true);
        expect(spisy.getEvents(spis.id).some(e => e.type === 'aml')).toBe(true);
        expect(rec.factors.some(f => f.code === 'nazev_nesouhlasi')).toBe(false);
    });

    test('název neodpovídá subjektu s daným IČO → faktor nazev_nesouhlasi', async () => {
        const rec = await aml.identify({ typ: 'PO', jmeno: 'ACME Testovací a.s.', ico: '12345678', provedl: 'Advokát' });
        const f = rec.factors.find(x => x.code === 'nazev_nesouhlasi');
        expect(f).toBeTruthy();
        expect(f.detail).toContain('Úpadce');
    });

    test('jiný zápis právní formy / diakritiky není nesoulad', async () => {
        const rec = await aml.identify({ typ: 'PO', jmeno: 'UPADCE, spol. s r. o.', ico: '12345678' });
        expect(rec.factors.some(x => x.code === 'nazev_nesouhlasi')).toBe(false);
    });
});

describe('identify — FO a úplnost identifikace', () => {
    test('FO bez RČ i adresy → riziko medium (neúplná identifikace)', async () => {
        const rec = await aml.identify({ typ: 'FO', jmeno: 'Jan Testovací' });
        expect(rec.risk).toBe('medium');
        expect(rec.factors.some(f => f.code === 'identifikace_neuplna')).toBe(true);
    });

    test('FO s adresou a bez rizik → riziko low', async () => {
        const rec = await aml.identify({ typ: 'FO', jmeno: 'Klidný Klient', adresa: 'Praha 1' });
        expect(rec.risk).toBe('low');
    });

    test('chybějící jméno → chyba', async () => {
        await expect(aml.identify({ typ: 'FO' })).rejects.toThrow();
    });
});

describe('lokální PEP/sankční screening', () => {
    test('shoda se seznamem → riziko high (pep/sankce)', async () => {
        aml.addWatch({ name: 'Jan Novák', type: 'PEP' });
        const rec = await aml.identify({ typ: 'FO', jmeno: 'JUDr. Jan Novák', adresa: 'Brno' });
        expect(rec.risk).toBe('high');
        expect(rec.watchlistHits.length).toBeGreaterThan(0);
        expect(rec.factors.some(f => f.code === 'pep_shoda' || f.code === 'sankcni_shoda')).toBe(true);
    });

    test('addWatch bez jména vyhodí chybu', () => {
        expect(() => aml.addWatch({})).toThrow();
    });
});

describe('listChecks', () => {
    test('filtruje podle spisId', async () => {
        const spis = spisy.createSpis({ spisZn: '10 C 2/2026' });
        await aml.identify({ typ: 'FO', jmeno: 'A', adresa: 'x', spisId: spis.id });
        await aml.identify({ typ: 'FO', jmeno: 'B', adresa: 'y' });
        expect(aml.listChecks({ spisId: spis.id })).toHaveLength(1);
        expect(aml.listChecks()).toHaveLength(2);
    });
});
