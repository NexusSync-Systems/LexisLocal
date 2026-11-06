/**
 * Spouštěč úloh musí brát kód z kopie mimo projekt (poslední bod review 2).
 * Testuje jen pravidla, nic nespouští.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sestav } = require('../scripts/task-runner.js');
const kopie = require('../scripts/runner-kopie.js');

describe('kam se spouští kód', () => {
    test('git úlohy čtou živý projekt, ostatní běží v kopii', () => {
        expect(sestav({ uloha: 'git_stav' }).kde).toBe('zivy');
        expect(sestav({ uloha: 'git_log', parametry: { n: 3 } }).kde).toBe('zivy');
        expect(sestav({ uloha: 'testy' }).kde).toBeUndefined();
        expect(sestav({ uloha: 'spis_eval' }).kde).toBeUndefined();
    });

    test('user data serverového testu se bere z repozitáře, ne z absolutní cesty', () => {
        const a = sestav({ uloha: 'aws_spust_test', parametry: { profil: 'kancelar-3h' } }).args;
        expect(a).toContain('file://scripts/aws/bootstrap-kancelar-3h.sh');
    });

    test('neznámá úloha se odmítne', () => {
        expect(() => sestav({ uloha: 'neexistuje' })).toThrow(/neznámá úloha/);
    });
});

describe('kopie pro spouštěč', () => {
    test('leží mimo projekt', () => {
        // Běží-li testy samy z kopie, je kopie.ZIVY ta kopie — živý projekt je pak v manifestu.
        const m = kopie.nactiManifest(kopie.ZIVY);
        const zivy = path.resolve(m && m.zivyKoren ? m.zivyKoren : kopie.ZIVY);
        expect(path.resolve(kopie.KOPIE)).not.toBe(zivy);
        expect(path.resolve(kopie.KOPIE).startsWith(zivy + path.sep)).toBe(false);
    });

    test('sdílené jsou jen složky s daty a výstupy, ne s kódem', () => {
        expect(kopie.SDILENE).toContain('scratch');          // fronta, logy, stav, výsledky
        for (const s of kopie.SDILENE) {
            expect(s).not.toMatch(/^(backend|scripts|node_modules|electron|setup\.js)/);
            expect(s).not.toContain('..');
        }
    });

    test('nemaže složku, která není kopie spouštěče', () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-kopie-'));
        try {
            expect(() => kopie.smaz(d)).toThrow(/není kopie spouštěče/);
            expect(fs.existsSync(d)).toBe(true);
        } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('odmítne kopii uvnitř projektu', () => {
        expect(() => kopie.smaz(path.join(kopie.ZIVY, 'scratch', 'kopie'))).toThrow(/uvnitř projektu/);
        expect(() => kopie.smaz(kopie.ZIVY)).toThrow(/sám projekt/);
    });
});
