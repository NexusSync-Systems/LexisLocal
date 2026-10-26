'use strict';
/**
 * fetch-us.js — rozhodnutí Ústavního soudu (dataset CCC + NALUS).
 * Parser CSV musí zvládnout ~1 GB soubor s víceřádkovými poli rozděleného do
 * libovolných kusů; hlavička musí nést zdroj a výhradu „neautentické znění"
 * (podmínka NALUS pro další užití).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const US = require('../scripts/fetch-us');

const META_HEADER = 'doc_id,case_id,case_nr,popular_name,date_decision,year_decision,date_publication,date_submission,type_decision,type_proceedings,importance,applicant,concerned_body,judge_rapporteur_name,judge_rapporteur_id,disputed_act,type_verdict,grounds,concerned_constitutional_acts,concerned_acts,separate_opinion,subject_proceedings,subject_register,note,url_address,formation,length_proceeding,outcome,citations,composition';
const NALEZ = 'ECLI:CZ:US:2023:3.US.2498.23.1,III.ÚS 2498/23,1,Náležité odůvodnění vazby,2023-11-29,2023,2023-12-04,2023-09-20,Nález,O ústavních stížnostech,3,STĚŽOVATEL - FO,NA,Kateřina Ronovská,J:47,rozhodnutí soudu,"c(""vyhověno"", ""odmítnuto pro nepřípustnost"")",merits,"2/1993 Sb./Sb.m.s., čl. 8 odst.1",141/1961 Sb.,NA,NA,"c(""vazba/důvody"", ""odůvodnění"")",NA,https://nalus.usoud.cz:443/Search/GetText.aspx?sz=3-2498-23_1,Third Chamber,70,granted,NA,NA';
const STANOVISKO = 'ECLI:CZ:US:2022:Pl.US-st.57.22.1,NA,NA,Plošné zveřejňování,2022-11-29,2022,2022-12-07,NA,Stanovisko pléna,O zaujetí stanoviska pléna - § 23,1,NA,NA,Pavel Rychetský,J:7,NA,vyhověno,NA,NA,NA,NA,NA,NA,NA,https://nalus.usoud.cz:443/Search/GetText.aspx?sz=St-57-22_1,Plenum,1,granted,NA,NA';
const USNESENI = 'ECLI:CZ:US:2023:Pl.US.43.23.2,Pl.ÚS 43/23,2,NA,2023-12-06,2023,NA,2023-10-09,Usnesení,O ústavních stížnostech,4,NA,NA,Jiří Zemánek,J:35,NA,odmítnuto,admissibility,NA,NA,NA,NA,NA,NA,https://nalus.usoud.cz:443/Search/GetText.aspx?sz=Pl-43-23_2,Plenum,58,rejected,NA,NA';
const LONG = 'Ústavní soud rozhodl v senátu, takto:\n\nÚstavní stížnosti se vyhovuje.\n\nOdůvodnění:\n' + 'Text s ""uvozovkami"", čárkou a řádky.\n'.repeat(20);
const TEXTS = `doc_id,text\nECLI:CZ:US:2023:Pl.US.43.23.2,"krátké"\nECLI:CZ:US:2023:3.US.2498.23.1,"${LONG}"\nECLI:CZ:US:2022:Pl.US-st.57.22.1,"${LONG}"\n`;

describe('CSV parser', () => {
    test('uvozovky, zdvojené uvozovky, čárky a nové řádky v poli; CRLF', () => {
        const rows = US.parseCsv('a,b\r\n"x, y","řádek 1\nřádek 2 ""citace"""\r\n3,\n');
        expect(rows).toEqual([['a', 'b'], ['x, y', 'řádek 1\nřádek 2 "citace"'], ['3', '']]);
    });

    test('výsledek nezávisí na tom, jak je vstup rozsekaný na kusy', () => {
        const src = `h1,h2\n"a ""b"" c",d\n"multi\nline",e\n`;
        const whole = US.parseCsv(src);
        for (let size = 1; size <= 7; size++) {
            const rows = [];
            const p = new US.CsvParser(r => rows.push(r));
            for (let i = 0; i < src.length; i += size) p.push(src.slice(i, i + size));
            p.end();
            expect(rows).toEqual(whole);
        }
    });
});

describe('metadata datasetu', () => {
    const meta = (line) => {
        const [h, r] = US.parseCsv(META_HEADER + '\n' + line + '\n');
        const o = {}; h.forEach((k, i) => { o[k] = r[i]; });
        return US.metaFromRow(o);
    };

    test('nález: sp. zn., datum, R vektory, formace, URL bez :443', () => {
        const m = meta(NALEZ);
        expect(m.spisZn).toBe('III. ÚS 2498/23');
        expect(m.datum).toBe('29.11.2023');
        expect(m.vyrok).toEqual(['vyhověno', 'odmítnuto pro nepřípustnost']);
        expect(m.ustavniPredpisy).toEqual(['Listina základních práv a svobod (2/1993 Sb.), čl. 8 odst.1']);
        expect(m.formace).toBe('III. senát');
        expect(m.url).toBe('https://nalus.usoud.cz/Search/GetText.aspx?sz=3-2498-23_1');
    });

    test('stanovisko pléna bez case_id dostane sp. zn. z ECLI', () => {
        const m = meta(STANOVISKO);
        expect(m.spisZn).toBe('Pl. ÚS-st. 57/22');
        expect(m.poradi).toBe('1');
        expect(US.fileNameFor(m)).toBe('US_Pl._ÚS-st._57_22_1.txt');
    });

    test('filtr: výchozí typy, rok, význam', () => {
        const a = { typy: ['Nález', 'Stanovisko pléna'] };
        expect(US.matches(meta(NALEZ), a)).toBe(true);
        expect(US.matches(meta(USNESENI), a)).toBe(false);
        expect(US.matches(meta(NALEZ), { ...a, odRoku: 2024 })).toBe(false);
        expect(US.matches(meta(NALEZ), { ...a, vyznam: 2 })).toBe(false);
        expect(US.matches(meta(STANOVISKO), { ...a, vyznam: 2 })).toBe(true);
    });

    test('hlavička nese zdroj, výhradu neautentického znění a citaci datasetu', () => {
        const h = US.header(meta(NALEZ));
        expect(h).toMatch(/^Nález Ústavního soudu ze dne 29\.11\.2023, sp\. zn\. III\. ÚS 2498\/23/);
        expect(h).toContain('ECLI: ECLI:CZ:US:2023:3.US.2498.23.1');
        expect(h).toContain('Soudce zpravodaj: Kateřina Ronovská');
        expect(h).toContain('nejde o autentické znění');
        expect(h).toContain('CC BY 4.0');
    });

    test('ECLI ze sp. zn. a z adresy NALUS', () => {
        expect(US.spZnFromEcli('ECLI:CZ:US:2023:4.US.662.23.2')).toEqual({ spisZn: 'IV. ÚS 662/23', poradi: '2' });
        expect(US.spZnFromEcli('ECLI:CZ:US:2002:Pl.US-st.15.02')).toEqual({ spisZn: 'Pl. ÚS-st. 15/02', poradi: '1' });
        expect(US.ecliFromSz('2-1155-26_1', 2026)).toBe('ECLI:CZ:US:2026:2.US.1155.26.1');
        expect(US.ecliFromSz('St-57-22_1', 2022)).toBe('ECLI:CZ:US:2022:Pl.US-st.57.22.1');
        expect(US.ecliFromSz('nesmysl', 2022)).toBe('');
    });
});

describe('import datasetu ze složky', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchus_'));
    const src = path.join(tmp, 'ccc_database', 'csv');
    const out = path.join(tmp, 'out');
    beforeAll(() => {
        fs.mkdirSync(src, { recursive: true });
        fs.writeFileSync(path.join(src, 'ccc_metadata.csv'), [META_HEADER, NALEZ, STANOVISKO, USNESENI].join('\n') + '\n');
        fs.writeFileSync(path.join(src, 'ccc_texts.csv'), TEXTS);
    });
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

    test('uloží nález a stanovisko, usnesení vynechá; druhý běh nic nepřepíše', async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await US.importCcc({ ccc: path.join(tmp, 'ccc_database'), out, typy: ['Nález', 'Stanovisko pléna'] });
            expect(fs.readdirSync(out).sort()).toEqual(['US_III._ÚS_2498_23_1.txt', 'US_Pl._ÚS-st._57_22_1.txt']);
            const t = fs.readFileSync(path.join(out, 'US_III._ÚS_2498_23_1.txt'), 'utf8');
            expect(t).toContain('Text s "uvozovkami", čárkou a řádky.');
            const before = fs.statSync(path.join(out, 'US_III._ÚS_2498_23_1.txt')).mtimeMs;
            await US.importCcc({ ccc: path.join(tmp, 'ccc_database'), out, typy: ['Nález', 'Stanovisko pléna'] });
            expect(fs.statSync(path.join(out, 'US_III._ÚS_2498_23_1.txt')).mtimeMs).toBe(before);
        } finally {
            log.mockRestore();
        }
    });
});

describe('NALUS', () => {
    const HTML = `<html><span id="lblRegistrySign" class="DocRegistrySign">II.ÚS 1155/26 ze dne 31. 8. 2026</span>
<span id="lblPopularName" class="DocPopularName"></span>
<span id="lblDecisionForm" class="DocDecisionForm">USNESENÍ</span>
<td class="DocContent"><table><tr><td style="font-size:10pt;">Ústavní soud rozhodl takto:<br/><br/>Ústavní stížnost se odmítá.<br/>Odůvodnění:</td></tr></table></td>
<input type="submit" name="btnPrint" id="btnPrint" value="Tisk" />
<a href="/Search/GetText.aspx?sz=2-1155-26_1">x</a><a href="GetText.aspx?sz=Pl-5-24_1">y</a><a href="GetText.aspx?sz=2-1155-26_1">dup</a>
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="abc&amp;d" /></html>`;

    test('stránka rozhodnutí → sp. zn., datum, typ, text, ECLI', () => {
        const d = US.parseNalusText(HTML, 'https://nalus.usoud.cz/Search/GetText.aspx?sz=2-1155-26_1');
        expect(d.spisZn).toBe('II. ÚS 1155/26');
        expect(d.datum).toBe('31.08.2026');
        expect(d.typ).toBe('Usnesení');
        expect(d.ecli).toBe('ECLI:CZ:US:2026:2.US.1155.26.1');
        expect(d.text).toContain('Ústavní stížnost se odmítá.');
        expect(d.text).not.toContain('Tisk');
    });

    test('odkazy ve výsledcích bez duplicit; skrytá pole formuláře', () => {
        expect(US.resultLinks(HTML)).toEqual(['2-1155-26_1', 'Pl-5-24_1']);
        expect(US.hiddenFields(HTML).__VIEWSTATE).toBe('abc&d');
    });
});

describe('NALUS — tabulka výsledků', () => {
    const ROW = fs.readFileSync(path.join(__dirname, 'fixtures', 'nalus_result_row.html'), 'utf8');
    const PAGE = `<td>Výsledky 1 - 80 z celkem 665;&nbsp;stránky:</td><table>${ROW}</table>`;

    test('řádek výsledku → metadata pro hlavičku', () => {
        const { total, items } = US.parseResultsPage(PAGE);
        expect(total).toBe(665);
        expect(items).toHaveLength(1);
        const it = items[0];
        expect(it.spisZn).toBe('IV. ÚS 729/23');
        expect(it.sz).toBe('4-729-23_1');
        expect(it.ecli).toBe('ECLI:CZ:US:2024:4.US.729.23.1');
        expect(it.sbnu).toBe('N 3/122 SbNU 34');
        expect(it.soudceZpravodaj).toBe('Daniela Zemanová');
        expect(it.datum).toBe('09.01.2024');
        expect(it.datumVyhlaseni).toBe('17.01.2024');
        expect(it.typ).toBe('Nález');
        expect(it.vyznam).toBe(3);
        expect(it.vyrok).toEqual(['vyhověno']);
        const h = US.header(US.nalusMeta(it, 'https://nalus.usoud.cz/Search/GetText.aspx?sz=' + it.sz));
        expect(h).toContain('Sbírka nálezů a usnesení: N 3/122 SbNU 34');
        expect(h).toContain('nejde o autentické znění');
        expect(h).not.toContain('CC BY'); // z NALUS, ne z datasetu
        expect(US.fileNameFor(it)).toBe('US_IV._ÚS_729_23_1.txt');
    });

    test('sz z NALUS sp. zn. (senát, plénum, stanovisko)', () => {
        expect(US.szFromNalusZn('IV.ÚS 2206/23 #2')).toBe('4-2206-23_2');
        expect(US.szFromNalusZn('Pl.ÚS 5/24 #1')).toBe('Pl-5-24_1');
        expect(US.szFromNalusZn('Pl.ÚS-st. 60/24 #1')).toBe('St-60-24_1');
        expect(US.szFromNalusZn('I. ÚS 12/25')).toBe('1-12-25_1');
        expect(US.szFromNalusZn('nesmysl')).toBe('');
    });
});

describe('NALUS — okrajové případy výsledků', () => {
    const ROW = fs.readFileSync(path.join(__dirname, 'fixtures', 'nalus_result_row.html'), 'utf8')
        .replace('STĚŽOVATEL - FO<br /><br />', 'STĚŽOVATEL - PO<br />STĚŽOVATEL - FO<br /><br />')
        .replace('N 3/122 SbNU 34', '101/2024 Sb.');
    test('víc navrhovatelů se nepřilepí k populárnímu názvu; nález ve Sbírce zákonů', () => {
        const { items } = US.parseResultsPage(`z celkem 1<table>${ROW}</table>`);
        expect(items[0].navrhovatel).toBe('STĚŽOVATEL - PO; STĚŽOVATEL - FO');
        expect(items[0].popularniNazev).toBe('Nárok na náhradu cestovních výdajů a náhradu za promeškaný čas');
        expect(US.header(US.nalusMeta(items[0], 'u'))).toContain('Vyhlášeno ve Sbírce zákonů: 101/2024 Sb.');
    });
});

test('NALUS: řádek výsledku bez tříd u buněk se taky rozpozná', () => {
    const ROW = fs.readFileSync(path.join(__dirname, 'fixtures', 'nalus_result_row.html'), 'utf8')
        .replace(/<td\s+class='resultData[01]'/g, '<td ');
    const { items } = US.parseResultsPage(`z celkem 1<table>${ROW}</table>`);
    expect(items).toHaveLength(1);
    expect(items[0].spisZn).toBe('IV. ÚS 729/23');
});

describe('NALUS: usnesení publikovaná ve Sbírce', () => {
    const U = require('../scripts/fetch-us');
    test('formulář: výchozí nálezy + stanoviska, s --usneseni jen usnesení, --jen-publikovana', () => {
        expect(U.nalusTypeFields({})).toEqual({ 'ctl00$MainContent$nalezy': 'on', 'ctl00$MainContent$stanoviska_plena': 'on' });
        expect(U.nalusTypeFields({ usneseni: true, jenPublikovana: true })).toEqual({ 'ctl00$MainContent$usneseni': 'on', 'ctl00$MainContent$jen_publikovana': 'on' });
    });
    test('přepínače: --usneseni změní filtr typů na Usnesení (pokud --typy neurčí jinak)', () => {
        expect(U.parseArgs(['node', 'x', '--nalus', '--usneseni', '--jen-publikovana', '--od', '01.01.1993']))
            .toMatchObject({ nalus: true, usneseni: true, jenPublikovana: true, typy: ['Usnesení'], od: '01.01.1993' });
        expect(U.parseArgs(['node', 'x', '--nalus', '--usneseni', '--typy', 'Usnesení,Nález']).typy).toEqual(['Usnesení', 'Nález']);
        expect(U.parseArgs(['node', 'x', '--nalus']).typy).toEqual(['Nález', 'Stanovisko pléna']);
    });
});
