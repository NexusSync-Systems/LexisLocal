/**
 * Oslovení počítá program (serverový test 3. 10. 2026, W1: „Vážená Ing. Tomáš Horák!“).
 */
'use strict';
const S = require('../lib/cz_salutation');

test.each([
    ['Ing. Tomáš Horák', 'Vážený pane inženýre,'],
    ['Eva Novotná', 'Vážená paní Novotná,'],
    ['JUDr. Jana Malá', 'Vážená paní doktorko,'],
    ['prof. Ing. Karel Dvořák, CSc.', 'Vážený pane profesore,'],
    ['Mgr. Lucie Veselá', 'Vážená paní magistro,'],
    ['Bc. Petr Svoboda', 'Vážený pane Svobodo,'],
    ['Jan Novák', 'Vážený pane Nováku,'],
    ['Karel Beneš', 'Vážený pane Beneši,'],
    ['Josef Vaněk', 'Vážený pane Vaňku,'],
    ['Jiří Hájek', 'Vážený pane Hájku,'],
    ['Tomáš Kovář', 'Vážený pane Kováři,'],
    ['Michal Černý', 'Vážený pane Černý,'],
    ['Martin Petr', 'Vážený pane Petře,'],
    ['Pavel Havel', 'Vážený pane,'],
    ['Marie Smith', 'Vážená paní Smith,']
])('%s → %s', (name, want) => {
    expect(S.salutation(name)).toBe(want);
});

test('oprava oslovení v textu: jméno v oslovení, pole „Oslovení:“, plurál zůstává', () => {
    const r = S.fixSalutations('Vážená Ing. Tomáš Horák!\n\nOslovení: [OSOBA_1]\n\nVážení,', { addressee: 'Ing. Tomáš Horák' });
    expect(r.text).toBe('Vážený pane inženýre,\n\nVážený pane inženýre,\n\nVážení,');
    expect(r.fixed).toHaveLength(2);
});

test('rod podle adresáta z hlavičky dopisu; správné oslovení se nemění', () => {
    const t = 'Adresát: Eva Novotná\nJihlava\n\nVážený pane,\n\ntext';
    expect(S.fixSalutations(t).text).toMatch(/^Vážená paní Novotná,$/m);
    const ok = 'Adresát: Jan Novák\n\nVážený pane Nováku,\ntext';
    expect(S.fixSalutations(ok).fixed).toHaveLength(0);
    expect(S.fixSalutations('Vážený soude,\ntext', { addressee: 'Eva Novotná' }).fixed).toHaveLength(0);
});
