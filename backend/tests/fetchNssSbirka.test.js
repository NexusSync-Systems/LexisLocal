'use strict';
/**
 * fetch-nss-sbirka.js — Sbírka rozhodnutí NSS. HTML odpovídá sbirka.nssoud.cz (10/2026):
 * popisky ve výpisu čísla jsou odsazené tabulátory a odkazové „linkla" jsou <div> uprostřed věty.
 */
const N = require('../scripts/fetch-nss-sbirka');

const ISSUE = `<div class="list-item">
\t\t\t\t
<h3>
\t<a
\thref="/cz/cla-vraceni-cla.p5193.html"
\t>
\t\t<span class="num-tag">
\t\t\t4757/2026\t\t</span>

\t\tCla: vrácení cla z vadného zboží;
\t</a>
</h3>

<p class="props">
\tDatum: <span>11.05.2026</span> &#183;
\tSbírkové č.: <span>4757/2026</span> &#183;
\tSp. zn.: <span>54 Af 5/2024 - 65</span> &#183;
\tTyp: <span>Rozsudek (SJS)</span> &#183;
\tAutor: <span>Krajský soud v Praze</span> &#183;
\tVydání: <span>9/2026</span> &#183; Strana: <span>334</span> &#183;
\tVztah k předpisu: <span>586/1992 Sb.: §7 odst.9; JUD32372CZ Pl. ÚS 15/01; </span>
</p></div>`;

const DECISION = `<div id="x"><div CLASS="jud">
<?links creator="linker v.1.0.0"?>
<div CLASS="pravni-veta-nadpis">Cla: vrácení cla</div>
<div CLASS="predpisy"><div CLASS="p">k čl. 118 celního <div CLASS="linkla">kodexu</div> Unie</div>
</div>
<div CLASS="pravni-veta">I. Článek 118 celního <div CLASS="linkla">kodexu</div> neztotožňuje odmítnutí zboží.</div>
<div CLASS="pravni-veta">II. Dovozce může požádat o uskladnění.</div>
<div CLASS="p">(Podle rozsudku Krajského soudu v Praze ze dne 11. 5. 2026, čj. 54 Af 5/2024-65)</div>
<div CLASS="vec"><div CLASS="tucne">Věc: </div>Společnost proti Generálnímu ředitelství cel o vrácení cla.</div>
<div CLASS="p">${'Odůvodnění rozsudku. '.repeat(20)}</div>
</div><hr style="x"><aside>menu</aside></div>`;

describe('fetch-nss-sbirka', () => {
    test('archiv → čísla Sbírky chronologicky, bez ročníků a duplicit', () => {
        const html = '<a href="/cz/2015-7-8">7-8</a><a href="/cz/2015">2015</a><a href="/cz/2003-1">1</a><a href="/cz/2015-10">10</a><a href="/cz/2003-1">dup</a><a href="/cz/archiv">x</a>';
        expect(N.issueUrls(html)).toEqual([
            'https://sbirka.nssoud.cz/cz/2003-1', 'https://sbirka.nssoud.cz/cz/2015-7-8', 'https://sbirka.nssoud.cz/cz/2015-10',
        ]);
    });

    test('výpis čísla → metadata rozhodnutí (odsazené popisky)', () => {
        const [d] = N.parseIssue(ISSUE);
        expect(d).toMatchObject({
            id: '5193', nadpis: 'Cla: vrácení cla z vadného zboží', datum: '11.05.2026', cislo: '4757/2026',
            spisZn: '54 Af 5/2024 - 65', typ: 'Rozsudek (SJS)', autor: 'Krajský soud v Praze', vydani: '9/2026', strana: '334',
        });
        expect(N.splitPredpisy(d.predpisy)).toEqual({ predpisy: ['586/1992 Sb.: §7 odst.9'], judikatura: ['Pl. ÚS 15/01'] });
        expect(N.fileNameFor(d)).toBe('NSS_4757_2026_54_Af_5_2024-65.txt');
        expect(N.prefixFor(d)).toBe('NSS_4757_2026_');
    });

    test('rozhodnutí → právní věta a text; „linkla" nerozbije větu', () => {
        const dec = N.parseDecision(DECISION);
        expect(dec.pravniVeta).toBe('I. Článek 118 celního kodexu neztotožňuje odmítnutí zboží.\nII. Dovozce může požádat o uskladnění.');
        expect(dec.predpisyK).toBe('k čl. 118 celního kodexu Unie');
        expect(dec.text).toMatch(/^\(Podle rozsudku Krajského soudu v Praze/);
        expect(dec.text).toContain('Věc:');
        expect(dec.text).not.toContain('menu');
        expect(dec.text).not.toContain('linker');
    });

    test('hlavička: soud z autora, citační sp. zn., Sbírka, právní věta', () => {
        const [d] = N.parseIssue(ISSUE);
        const h = N.header(d, N.parseDecision(DECISION));
        expect(h).toMatch(/^Rozsudek – Krajský soud v Praze ze dne 11\.05\.2026, sp\. zn\. 54 Af 5\/2024-65 \(Sb\. NSS č\. 4757\/2026\)/);
        expect(h).toContain('Sbírka rozhodnutí NSS: č. 4757/2026, vydání 9/2026, s. 334');
        expect(h).toContain('Související judikatura: Pl. ÚS 15/01');
        expect(h).toContain('Právní věta:\nI. Článek 118');
        const nss = N.header({ ...d, autor: 'Nejvyšší správní soud - rozšířený senát', typ: 'Usnesení (SJSd)' }, null);
        expect(nss).toContain('Soud: Nejvyšší správní soud\nRozhodl: rozšířený senát');
        expect(nss).toMatch(/^Usnesení – Nejvyšší správní soud/);
    });
});
