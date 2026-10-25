/**
 * Kontrola revize konceptu — nálezy živého testu run 6 (5. 10. 2026, syntetická data):
 *  • § 205 odst. 2 písm. g) model připojil k jinému odvolacímu důvodu, než připomínka žádala,
 *  • do odvolání přidal stranu „Výrobce“, která v konceptu nebyla.
 */
'use strict';
const rc = require('../lib/revision_check');

const COMMENT = { text: 'Doplň odvolací důvod nesprávného právního posouzení (§ 205 odst. 2 písm. g) o. s. ř.).' };
const items = rc.commentRefs([COMMENT]);

test('§ u správného obsahu → v pořádku', () => {
    const good = 'ODVOLÁNÍ\nOdvolací důvody: nesprávně zjištěný skutkový stav a nesprávné právní posouzení věci (§ 205 odst. 2 písm. g) o. s. ř.).';
    expect(rc.missingComments(good, items)).toEqual([]);
});

test('§ u jiného důvodu (run 6) → „misplaced“, oprava i pole „Ověřit“', () => {
    const bad = 'ODVOLÁNÍ\nOdvolací důvod:\n1. Nesprávné zjištění skutkového stavy (§ 205 odst. 2 písm. g) o. s. ř.):';
    const miss = rc.missingComments(bad, items);
    expect(miss.map(m => m.reason)).toEqual(['misplaced']);
    expect(rc.retryMessage(miss)).toMatch(/stojí u jiného důvodu/);
    expect(rc.appendix(miss)).toMatch(/\[Ověřit – § 205 je v textu u jiného obsahu/);
});

test('§ chybí úplně → „missing“ a pole „Doplnit“', () => {
    const miss = rc.missingComments('ODVOLÁNÍ\nNesprávné právní posouzení.', items);
    expect(miss.map(m => m.reason)).toEqual(['missing']);
    expect(rc.appendix(miss)).toMatch(/^\n\n\[Doplnit – zapracovat připomínku advokáta/);
});

test('nové strany a jména oproti konceptu → upozornění; známé ne', () => {
    const src = 'ODVOLÁNÍ\nŽalobce Jan Testovací podává odvolání.\n' + COMMENT.text;
    expect(rc.newParties('Žalobce Jan Testovací podává odvolání. Výrobce nedodal zboží.', src)).toEqual(['Výrobce']);
    expect(rc.newParties('Žalobce, zastoupen advokátem Petrem Novákem, podává odvolání.', src)).toEqual(['Petrem Novákem']);
    expect(rc.newParties('Žalobce Jan Testovací podává odvolání proti rozsudku.', src)).toEqual([]);
});
