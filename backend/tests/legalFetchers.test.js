'use strict';
const ES = require('../scripts/fetch-esbirka');
const NS = require('../scripts/fetch-ns-sbirka');
const { renderDoc } = require('../scripts/split-zakon');

describe('fetch-esbirka', () => {
    test('staleUrl kóduje celou cestu a hlídá formát', () => {
        expect(ES.staleUrl('89/2012', '2026-10-14')).toBe('%2Fsb%2F2012%2F89%2F2026-10-14');
        expect(() => ES.staleUrl('89-2012', '2026-10-14')).toThrow();
        expect(() => ES.staleUrl('89/2012', '14. 10. 2026')).toThrow();
    });

    test('xhtml → text (tagy, entity, mezery)', () => {
        expect(ES.xhtmlToText('<p>(1) Právo se <var>promlčí</var>&nbsp;za&#160;3 roky&hellip;</p><p>(2) Dál</p>')).toBe('(1) Právo se promlčí za 3 roky…\n(2) Dál');
    });

    test('fragmenty → paragrafy podle kotvy #par_N, se strukturou a nadpisem', () => {
        const frags = [
            { kodTypuFragmentu: 'Cast', hloubka: 1, staleUrl: '/sb/2012/89#cast_1', xhtml: 'ČÁST PRVNÍ OBECNÁ ČÁST' },
            { kodTypuFragmentu: 'Hlava', hloubka: 2, staleUrl: '/sb/2012/89#cast_1-hlava_5', xhtml: 'HLAVA V Promlčení' },
            { kodTypuFragmentu: 'Paragraf', staleUrl: '/sb/2012/89/2026-10-14#par_629', xhtml: '§ 629 Promlčecí lhůty' },
            { kodTypuFragmentu: 'Odstavec_Dc', staleUrl: '/sb/2012/89/2026-10-14#par_629-odst_1', xhtml: '<p>(1) Promlčecí lhůta trvá tři roky.</p>' },
            { kodTypuFragmentu: 'Odstavec_Dc', staleUrl: '/sb/2012/89/2026-10-14#par_629-odst_2', xhtml: '(2) Majetkové právo se promlčí nejpozději uplynutím deseti let.' },
            { kodTypuFragmentu: 'Paragraf', staleUrl: '/sb/2012/89/2026-10-14#par_630', xhtml: '§ 630' },
            { kodTypuFragmentu: 'Odstavec_Dc', staleUrl: '/sb/2012/89/2026-10-14#par_630-odst_1', xhtml: '(1) Strany si mohou ujednat kratší nebo delší promlčecí lhůtu.' },
            { kodTypuFragmentu: 'Pismeno_Lb', staleUrl: '/sb/2012/89/2026-10-14#par_630-odst_1-pism_a', xhtml: 'a) nejméně však jeden rok,' },
            { kodTypuFragmentu: 'PrilohaVlozena', staleUrl: '/sb/2012/89#priloha_1', xhtml: 'Příloha — nebrat' }
        ];
        const p = ES.fragmentsToParagraphs(frags);
        expect(p.map(x => x.num)).toEqual(['629', '630']);
        expect(p[0].title).toBe('Promlčecí lhůty');
        expect(p[0].struct).toBe('ČÁST PRVNÍ OBECNÁ ČÁST › HLAVA V Promlčení');
        expect(p[0].text).toBe('(1) Promlčecí lhůta trvá tři roky.\n(2) Majetkové právo se promlčí nejpozději uplynutím deseti let.');
        expect(p[1].title).toBe('');
        expect(p[1].text).toContain('a) nejméně však jeden rok,');
        const doc = renderDoc({ cislo: '89/2012', nazev: 'občanský zákoník', zneni: '2026-10-14' }, [p[0]]);
        expect(doc).toMatch(/^Zákon č\. 89\/2012 Sb\., občanský zákoník \(znění ke dni 2026-10-14\)\n§ 629 — Promlčecí lhůty/);
        expect(doc).toContain('Citace: § 629 zákona č. 89/2012 Sb.');
    });

    test('sada advokat: jednoznačné zkratky i čísla', () => {
        const p = ES.PRESETS.advokat;
        expect(new Set(p.map(x => x[0])).size).toBe(p.length);
        expect(new Set(p.map(x => x[1])).size).toBe(p.length);
        p.forEach(([, c]) => expect(c).toMatch(/^\d{1,4}\/\d{4}$/));
    });
});

describe('fetch-ns-sbirka', () => {
    const html = `<html><head><title>x</title></head><body>
<h1>Rozsudek Nejvyššího soudu ze dne 10. 6. 2025, sp. zn. 31 Cdo 1434/2025, ECLI:CZ:NS:2025:31.CDO.1434.2025.1</h1>
<p>Číslo: 45</p>
<table>
<tr><td>Právní věta:</td><td><p>Průtahy v řízení zakládají nárok na zadostiučinění.</p></td></tr>
<tr><td>Soud:</td><td>Nejvyšší soud</td></tr>
<tr><td>Datum rozhodnutí:</td><td>10.06.2025</td></tr>
<tr><td>Spisová značka:</td><td>31 Cdo 1434/2025</td></tr>
<tr><td>Číslo rozhodnutí:</td><td>45</td></tr>
<tr><td>Rok:</td><td>2026</td></tr>
<tr><td>Sešit:</td><td>6</td></tr>
<tr><td>Typ rozhodnutí:</td><td>Rozsudek</td></tr>
<tr><td>Heslo:</td><td><a>Odpovědnost státu za újmu</a><br><a>Průtahy v řízení</a></td></tr>
<tr><td>Předpisy:</td><td>§ 31a předpisu č. 82/1998 Sb.</td></tr>
<tr><td>Druh:</td><td>Rozhodnutí ve věcech civilních</td></tr>
<tr><td colspan="2"><p><b>I. Dosavadní průběh řízení</b></p><p>1. Žalobkyně se domáhala ${'zadostiučinění '.repeat(60)}</p></td></tr>
</table></body></html>`;

    test('parseDecision: metadata z tabulky, ECLI z nadpisu, sbírkový text', () => {
        const d = NS.parseDecision(html);
        expect(d.spisZn).toBe('31 Cdo 1434/2025');
        expect(d.ecli).toBe('ECLI:CZ:NS:2025:31.CDO.1434.2025.1');
        expect(d.pravniVeta).toBe('Průtahy v řízení zakládají nárok na zadostiučinění.');
        expect(d.heslo).toBe('Odpovědnost státu za újmu\nPrůtahy v řízení');
        expect(d.druh).toBe('Rozhodnutí ve věcech civilních');
        expect(d.text).toMatch(/^I\. Dosavadní průběh řízení\n1\. Žalobkyně/);
        const h = NS.header(d, 'https://sbirka.nsoud.cz/sbirka/25584/');
        expect(h).toContain('Sp. zn.: 31 Cdo 1434/2025');
        expect(h).toContain('Sbírka soudních rozhodnutí a stanovisek: č. 45/2026, sešit 6');
        expect(h).toContain('Klíčová slova: Odpovědnost státu za újmu, Průtahy v řízení');
        expect(h).toContain('Právní věta:\nPrůtahy v řízení');
    });

    test('filtry a sitemap', () => {
        const d = NS.parseDecision(html);
        expect(NS.matches(d, { odRoku: 2026, druh: 'civilní', keyword: 'průtahy' })).toBe(true);
        expect(NS.matches(d, { odRoku: 2027 })).toBe(false);
        expect(NS.matches(d, { druh: 'trestní' })).toBe(false);
        expect(NS.sitemapLocs('<urlset><url><loc>https://sbirka.nsoud.cz/sbirka/25584/</loc></url><url><loc> https://x/y </loc></url></urlset>'))
            .toEqual(['https://sbirka.nsoud.cz/sbirka/25584/', 'https://x/y']);
    });
});
