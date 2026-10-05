/**
 * Spisová značka bez čísla listu (test datové schránky 5. 10. 2026: zpráva soudu s č. j.
 * „12 C 45/2026-30“ založila spis „12 C 45/2026-30“ vedle spisu „12 C 45/2026“).
 */
'use strict';
const os = require('os'); const path = require('path'); const fs = require('fs');
const tmp = path.join(os.tmpdir(), `lexis_test_folio_${Date.now()}`); fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp; process.env.LEXIS_KEY_DIR = tmp + '_key';
const S = require('../lib/spisy');

test.each([
    ['12 C 45/2026-30', '12 C 45/2026'],
    ['21 Co 123/2025 - 45', '21 Co 123/2025'],
    ['12 C 45/2026', '12 C 45/2026'],
    ['KSBR 39 INS 1234/2026', 'KSBR 39 INS 1234/2026'],
    ['Neznámá sp. zn.', 'Neznámá sp. zn.']
])('%s → %s', (zn, want) => expect(S.stripFolio(zn)).toBe(want));

test('spis „12 C 45/2026“ se najde i podle č. j. s číslem listu', () => {
    const sp = S.createSpis({ spisZn: '12 C 45/2026', klient: 'Test' });
    expect(S.findByCase('12 C 45/2026-30').id).toBe(sp.id);
});
