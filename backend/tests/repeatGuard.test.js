'use strict';
const { collapseRepeats } = require('../lib/repeat_guard');

test('J1 (server 25. 10.): opakované řádky v oddílu se odstraní, první výskyt zůstane', () => {
    const t = [
        '5. Doporučený postup:',
        '- Získat všechny relevantní informace o smluvním dohodnutí.',
        '- Získat zprávy o výsledcích vyšetřování, pokud jsou dostupné.',
        '- Získat zprávy o finančním stavu strany.',
        '- Získat zprávy o výsledcích vyšetřování, pokud jsou dostupné.',
        '- Získat zprávy o výsledcích vyšetřování, pokud jsou dostupné.',
        '',
        '6. Co ještě ověřit:',
        '- Zda byla smluvní pokuta ujednána v přítomnosti zástupce.',
        '- Zda byla smluvní pokuta ujednána v přítomnosti zástupce.',
        '- Zda byla smluvní pokuta ujednána v přítomnosti zástupce.'
    ].join('\n');
    const r = collapseRepeats(t);
    expect(r.removed).toBe(4);
    expect(r.text.match(/výsledcích vyšetřování/g)).toHaveLength(1);
    expect(r.text.match(/přítomnosti zástupce/g)).toHaveLength(1);
    expect(r.text).toMatch(/finančním stavu/);
});

test('stejný řádek v jiném oddílu, krátké řádky, kód a text bez opakování zůstanou', () => {
    const t = '3. Právní úprava:\n- § 2051 zákona č. 89/2012 Sb.\n\n4. Lhůty a data:\n- § 2051 zákona č. 89/2012 Sb.\n- Ano.\n- Ano.\n```\nx = 1 opakovaný řádek kódu\nx = 1 opakovaný řádek kódu\n```';
    const r = collapseRepeats(t);
    expect(r.removed).toBe(0);
    expect(r.text).toBe(t);
    expect(collapseRepeats('')).toEqual({ text: '', removed: 0 });
});

test('liší se jen odrážkou / tečkou na konci → také opakování', () => {
    const r = collapseRepeats('Doporučení:\n- Ověřit doručení rozsudku.\n• ověřit doručení rozsudku\n2) Ověřit doručení rozsudku;');
    expect(r.removed).toBe(2);
});
