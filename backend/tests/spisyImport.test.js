/**
 * Import stávajících spisů z CSV (lib/spisy_import.js, POST /api/spisy/import).
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.API_TOKEN = 'tok-imp';
process.env.WATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_imp_'));
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_imp_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_imp_data_'));
delete process.env.LEXIS_FIRM_MODE;

const request = require('supertest');
const app = require('../server');
const imp = require('../lib/spisy_import');
const H = r => r.set('X-API-Token', 'tok-imp');

const CSV = '﻿Spisová značka;Název;Klient;Protistrana;Soud;Advokát;Insolvence;Barva\n' +
    '12 C 45/2026;Alfa vs. Beta;Alfa Test s.r.o.;Beta Test s.r.o.;Okresní soud v Jihlavě;Mgr. Test;;modrá\n' +
    '"8 Cm 3/2026";"Smlouva; dodávka ""A""";Gama a.s.;;Krajský soud v Brně;Mgr. Test;KSBR 56 INS 1000/2026;\n' +
    '12 C 45/2026;Duplicita;;;;;;\n' +
    ';;Bez značky;;;;;\n' +
    '3 C 1/2026;Špatná insolvence;;;;;nevím;\n';

describe('rozbor CSV', () => {
    test('středník, uvozovky, BOM a hlavička česky', () => {
        const rows = imp.parseCsv(CSV);
        expect(rows[2][1]).toBe('Smlouva; dodávka "A"');
        const { map, unknown } = imp.mapHeader(rows[0]);
        expect(Object.keys(map)).toEqual(expect.arrayContaining(['spisZn', 'nazev', 'klient', 'protistrana', 'soud', 'odpovednyAdvokat', 'insZn']));
        expect(unknown).toEqual(['Barva']);
    });
    test('čárka a tabulátor', () => {
        expect(imp.detectDelimiter('a,b,c')).toBe(',');
        expect(imp.detectDelimiter('a\tb\tc')).toBe('\t');
    });
});

describe('import přes API', () => {
    test('náhled nic nezaloží', async () => {
        const r = await H(request(app).post('/api/spisy/import')).send({ csv: CSV, dryRun: true });
        expect(r.status).toBe(200);
        expect(r.body.summary).toMatchObject({ total: 5, nove: 3, duplicita: 1, chyba: 1, upozorneni: 1 });
        const list = await H(request(app).get('/api/spisy'));
        expect(list.body.spisy.length).toBe(0);
    });
    test('import založí spisy, insZn a soud; podruhé jen „existuje“', async () => {
        const r = await H(request(app).post('/api/spisy/import')).send({ csv: CSV });
        expect(r.body.summary.nove).toBe(3);
        const list = (await H(request(app).get('/api/spisy'))).body.spisy;
        const s = list.find(x => x.spisZn === '8 Cm 3/2026');
        expect(s).toMatchObject({ nazev: 'Smlouva; dodávka "A"', soud: 'Krajský soud v Brně', insZn: 'KSBR 56 INS 1000/2026' });
        expect(list.find(x => x.spisZn === '3 C 1/2026').insZn).toBeFalsy();
        const again = await H(request(app).post('/api/spisy/import')).send({ csv: CSV });
        expect(again.body.summary).toMatchObject({ nove: 0, existuje: 3 });
    });
    test('bez sloupce sp. zn. i názvu → 400 s vysvětlením', async () => {
        const r = await H(request(app).post('/api/spisy/import')).send({ csv: 'Barva;Tvar\nmodrá;kulatý\n' });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/Spisová značka/);
    });
});
