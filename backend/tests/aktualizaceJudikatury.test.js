'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const A = require('../scripts/aktualizace-judikatury');
const R = require('../scripts/task-runner');

test('datum pro NALUS a zdroje (pevné skripty a složky)', () => {
    expect(A.ddmmyyyy(new Date(2026, 9, 5))).toBe('05.10.2026');
    const o = { od: '01.09.2026', odRoku: 2025 };
    expect(A.ZDROJE.map(z => z.dir)).toEqual(['judikatura-us', 'judikatura-nss', 'judikatura-ns']);
    expect(A.ZDROJE[0].args(o)).toEqual(['backend/scripts/fetch-us.js', '--nalus', '--od', '01.09.2026', '--out', './judikatura-us']);
    expect(A.ZDROJE[2].args(o)).toContain('--by-druh');
});

test('listTxt: rekurzivně, relativní cesty, jen .txt', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_akt_'));
    fs.mkdirSync(path.join(d, 'Stanoviska'));
    fs.writeFileSync(path.join(d, 'Stanoviska', 'NS_1_a.txt'), 'x');
    fs.writeFileSync(path.join(d, 'NS_2_b.txt'), 'x');
    fs.writeFileSync(path.join(d, 'pozn.md'), 'x');
    expect([...A.listTxt(d)].sort()).toEqual(['NS_2_b.txt', path.join('Stanoviska', 'NS_1_a.txt')].sort());
    expect(A.listTxt(path.join(d, 'neni')).size).toBe(0);
    fs.rmSync(d, { recursive: true, force: true });
});

test('úloha spouštěče: počet dní v rozsahu, přepínač bez nahrání', () => {
    expect(R.sestav({ uloha: 'aktualizace_judikatury' }).args).toEqual(['backend/scripts/aktualizace-judikatury.js', '--dni', '60']);
    expect(R.sestav({ uloha: 'aktualizace_judikatury', parametry: { dni: 35, bezNahrani: true } }).args).toEqual(['backend/scripts/aktualizace-judikatury.js', '--dni', '35', '--bez-nahrani']);
    expect(() => R.sestav({ uloha: 'aktualizace_judikatury', parametry: { dni: '30; rm -rf' } })).toThrow();
});
