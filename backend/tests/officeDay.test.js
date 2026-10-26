/**
 * Nálezy simulace „den v kanceláři“ (backend/scripts/office_day.js, 26. 10. 2026):
 *  1) sp. zn. s rejstříkem o více slovech („19 P a Nc 57/2026“) se nerozpoznala → dokument bez spisu,
 *  2) nahrání přes API + hlídání složky zpracovalo tentýž dokument dvakrát (2× AI, 2× indexace),
 * a pomocné funkce samotné simulace. Data jsou smyšlená.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_officeday_'));
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_officeday_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_officeday_data_'));
process.env.OLLAMA_HOST = 'http://127.0.0.1:9'; // AI nedostupná → rychlé selhání vytěžení, jede deterministická cesta
delete process.env.LEXIS_FIRM_MODE;

jest.mock('../lib/rag', () => {
    const actual = jest.requireActual('../lib/rag');
    return Object.assign({}, actual, { indexDocument: jest.fn(async () => ({ chunks: 1 })), deleteDocumentIndex: jest.fn(async () => {}) });
});

const { findCaseNumber } = require('../lib/case_number');

describe('sp. zn. v textu (lib/case_number.js)', () => {
    test.each([
        ['Okresní soud v Jihlavě\nSp. zn. 19 P a Nc 57/2026\nUSNESENÍ', '19 P a Nc 57/2026'],
        ['Sp. zn.: 12 C 45/2026', '12 C 45/2026'],
        ['č. j. 31 Cdo 2707/2007-120', '31 Cdo 2707/2007'],
        ['spisová značka 8 Cmo 14 / 2025', '8 Cmo 14/2025'],
        ['Krajský soud v Brně, KSBR 56 INS 1000/2026', '56 INS 1000/2026'],
        ['sp.zn. 4 Tdo 12/2024', '4 Tdo 12/2024'],
        ['bez označení: věc 23 EC 120/2026 u soudu', '23 EC 120/2026']
    ])('%s', (text, exp) => { expect(findCaseNumber(text)).toBe(exp); });

    test('zákon ani paragraf není sp. zn.; označená má přednost před první zmínkou', () => {
        expect(findCaseNumber('Podle § 2051 zákona č. 89/2012 Sb. a § 204 o. s. ř.')).toBe('');
        expect(findCaseNumber('Viz rozsudek 33 Cdo 1/2020. Sp. zn. 19 P a Nc 57/2026')).toBe('19 P a Nc 57/2026');
    });
});

describe('dokument se zpracuje jen jednou (upload + hlídání složky)', () => {
    test('dvě souběžná volání processDocument = jedno zpracování a jeden záznam', async () => {
        const rag = require('../lib/rag');
        const w = require('../lib/watcher');
        const f = path.join(tmp, 'usneseni_P_a_Nc.txt');
        fs.writeFileSync(f, 'Okresní soud v Jihlavě\nSp. zn. 19 P a Nc 57/2026\nUSNESENÍ\nVyzývá se navrhovatel, aby do 10 dnů ode dne doručení doplnil návrh.\n');
        const p1 = w.processDocument(f);
        const p2 = w.processDocument(f);
        expect(p2).toBe(p1);
        await Promise.all([p1, p2]);
        await new Promise(r => setTimeout(r, 1500)); // případné „add“ z chokidaru
        const calls = rag.indexDocument.mock.calls.filter(c => String(c[0] || '').includes('usneseni_P_a_Nc') || JSON.stringify(c).includes('usneseni_P_a_Nc'));
        expect(calls.length).toBe(1);
        const inbox = await w.loadInbox();
        const items = Object.values(inbox.files || {}).filter(x => /usneseni_P_a_Nc/.test(x.fileName || x.relativePath || ''));
        expect(items.length).toBe(1);
        expect(items[0].caseNumber).toBe('19 P a Nc 57/2026');
        // po dokončení se dá soubor zpracovat znovu (ruční „znovu zpracovat“)
        await w.processDocument(f);
        expect(rag.indexDocument.mock.calls.filter(c => JSON.stringify(c).includes('usneseni_P_a_Nc')).length).toBe(2);
    }, 60000);
});

describe('office_day.js — pomocné funkce', () => {
    const od = require('../scripts/office_day');
    test('argumenty a zkrácený běh', () => {
        const o = od.parseArgs(['--base', 'https://x/', '--hours', '3', '--restart-cmd', 'systemctl restart lexislocal']);
        expect(o).toMatchObject({ base: 'https://x', hours: 3, restartCmd: 'systemctl restart lexislocal', firm: true });
        const s = od.parseArgs(['--base', 'http://y', '--smoke']);
        expect(s.smoke).toBe(true); expect(s.hours).toBeCloseTo(1 / 3); expect(s.maxOnboarding).toBe(30);
    });
    test('deterministický plán: stejný seed = stejné časy, ranní špička', () => {
        const a = od.schedule(10, od.rng(1)), b = od.schedule(10, od.rng(1));
        expect(a).toEqual(b);
        const rano = a.filter(m => m < 60).length, poledne = a.filter(m => m >= 240 && m < 300).length;
        expect(rano).toBeGreaterThan(poledne);
    });
    test('hodnocení odpovědi podle sady (must / anyOf / mustNot)', () => {
        const c = { must: ['2051'], anyOf: ['Cdo'], mustNot: ['bez rizik'] };
        expect(od.scoreCase(c, '§ 2051 OZ, 31 Cdo 2707/2007').pass).toBe(true);
        const r = od.scoreCase(c, '§ 2248 OZ, smlouva je bez rizik');
        expect(r.pass).toBe(false); expect(r.miss.length).toBe(2); expect(r.hit).toEqual(['bez rizik']);
        expect(od.pctl([5, 1, 3, 2, 4], 50)).toBe(3);
    });
    test('datová sada: manifest odpovídá souborům', () => {
        const ds = path.join(__dirname, '..', 'eval', 'office_day', 'dataset-v1.tar.gz');
        if (!fs.existsSync(ds)) return; // sada se generuje skriptem; v repozitáři je jako archiv
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_ds_'));
        require('child_process').execSync(`tar -xzf ${JSON.stringify(ds)} -C ${JSON.stringify(dir)}`);
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        expect(m.spisy.length).toBeGreaterThanOrEqual(100);
        for (const d of m.dokumenty) expect(fs.existsSync(path.join(dir, d.file))).toBe(true);
        expect(m.kancelar.uzivatele.map(u => u.role).sort()).toEqual(['advokat', 'advokat', 'advokat', 'asistent', 'koncipient']);
    });
});
