'use strict';
const J = require('../lib/judikatura_cite');

test('sp. zn. z názvu souboru (NS, ÚS, NSS)', () => {
    expect(J.spznFromFileName('NS_22207_31_Cdo_2273_2022.txt')).toBe('31 Cdo 2273/2022');
    expect(J.spznFromFileName('NS_7846_29_NSCR_103_2015.txt')).toBe('29 NSČR 103/2015');
    expect(J.spznFromFileName('NS_7741_Tpjn_300_2017.txt')).toBe('Tpjn 300/2017');
    expect(J.spznFromFileName('NS_12360_I._ÚS_597_92.txt')).toBe('I. ÚS 597/92');
    expect(J.spznFromFileName('US_II._ÚS_3335_11_1.txt')).toBe('II. ÚS 3335/11');
    expect(J.spznFromFileName('US_Pl._ÚS_20_21_1.txt')).toBe('Pl. ÚS 20/21');
    expect(J.spznFromFileName('NSS_4414_2023_8_As_29_2021-36.txt')).toBe('8 As 29/2021-36');
    expect(J.spznFromFileName('NSS_483_2005_Konf_80_2003-8.txt')).toBe('Konf 80/2003-8');
    expect(J.spznFromFileName('OZ 89-2012 § 2051.txt')).toBeNull();
});

test('hlavička pasáže má přednost (přesná diakritika)', () => {
    const m = { fileName: 'NS_7846_29_NSCR_103_2015.txt', text: 'Usnesení … Soud: Nejvyšší soud\nSp. zn.: 29 NSČR 103/2015\nDatum vydání: 28.11.2017' };
    expect(J.label(m)).toBe('Nejvyšší soud, sp. zn. 29 NSČR 103/2015');
    // text pasáže bývá spojený mezerami (bez \n)
    expect(J.cite({ fileName: 'US_II._ÚS_3335_11_1.txt', text: 'Nález … Sp. zn.: II. ÚS 3335/11 Datum vydání: 23.08.2012' }).spzn).toBe('II. ÚS 3335/11');
});

test('section: jen judikatura, bez duplicit, bez těch, které odpověď už cituje', () => {
    const ms = [
        { fileName: 'OZ 89-2012 § 2051.txt', text: '§ 2051' },
        { fileName: 'NS_22207_31_Cdo_2273_2022.txt', text: 'x' },
        { fileName: 'NS_22207_31_Cdo_2273_2022.txt', text: 'y' },
        { fileName: 'US_II._ÚS_3335_11_1.txt', text: 'z' }
    ];
    const s = J.section(ms, 'Podle nálezu sp. zn. II.ÚS 3335/11 …');
    expect(s).toMatch(/Nejvyšší soud, sp\. zn\. 31 Cdo 2273\/2022/);
    expect(s).not.toMatch(/3335\/11/);
    expect(s.match(/31 Cdo/g)).toHaveLength(1);
    expect(J.section([{ fileName: 'OZ 89-2012 § 1.txt' }], '')).toBe('');
});
