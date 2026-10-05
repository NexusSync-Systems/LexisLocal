/**
 * Kontrola doložek — nálezy živého testu run 6 (5. 10. 2026, syntetická smlouva):
 *  • „Čl. VII / 1. …“ se označovalo „bod 1“ místo čl. VII,
 *  • „uhradí předem v plné výši (100 % ceny)“ (obrácené pořadí) se nenašlo,
 *  • rozhodčí doložku stačilo zmínit — debata ji přitom chybně označila za možná platnou.
 */
'use strict';
const cs = require('../lib/clause_scan');

const SMLOUVA = 'SMLOUVA O DÍLO (syntetická)\nObjednatel: Petra Testovací, spotřebitel.\nZhotovitel: Stavby Test s.r.o.\nČl. I\n1. Zhotovitel provede rekonstrukci koupelny.\nČl. II\n1. Cena díla činí 180 000 Kč a objednatel ji uhradí předem v plné výši (100 % ceny).\nČl. VII\n1. Veškeré spory z této smlouvy rozhodne s konečnou platností rozhodce jmenovaný zhotovitelem.\nČl. VIII\n1. Smlouva nabývá účinnosti podpisem obou stran.';

test('článek s číslovanými odstavci → „čl. VII odst. 1“, ne „bod 1“', () => {
    const f = cs.scanContract(SMLOUVA);
    expect(f.find(x => x.id === 'rozhodci').article).toBe('čl. VII odst. 1');
    expect(cs.missingAppendix('', f).text).toMatch(/Čl\. VII odst\. 1 – Rozhodčí doložka/);
});

test('záloha 100 % i v pořadí „předem v plné výši (100 % ceny)“', () => {
    const z = cs.scanContract(SMLOUVA).find(x => x.id === 'zaloha_100');
    expect(z).toBeTruthy();
    expect(z).toMatchObject({ article: 'čl. II odst. 1', detail: '100 % ceny' });
});

test('bez čísla článku zůstává „bod N“', () => {
    expect(cs.segment('1. Veškeré spory rozhodne rozhodce.')[0].article).toBe('bod 1');
});

test('rozhodčí doložka: zmínka bez závěru o neplatnosti nestačí → program doplní', () => {
    const f = cs.scanContract(SMLOUVA).filter(x => x.id === 'rozhodci');
    const wrong = 'Rozhodčí doložka: zkontrolujte, zda byla spotřebitelka o rozhodčí smlouvě informována a souhlasila s ní.';
    const apx = cs.missingAppendix(wrong, f);
    expect(apx.missing).toEqual(['rozhodci']);
    expect(apx.text).toMatch(/u spotřebitele neplatná — § 3 odst\. 6 zák\. č\. 216\/1994 Sb\./);
    const right = 'Rozhodčí doložka v čl. VII je u spotřebitele neplatná (§ 3 odst. 6 zákona č. 216/1994 Sb.).';
    expect(cs.missingAppendix(right, f).missing).toEqual([]);
});
