/**
 * dedupeKbResults — z jednoho souboru znalostní báze (např. „§ 204“) jen 1 úsek,
 * klientské spisy (scope null) beze změny. Chrání top-k před zdvojeným paragrafem.
 */
const { dedupeKbResults } = require('../lib/rag');

describe('dedupeKbResults', () => {
    test('ponechá nejlepší úsek z každého KB souboru, spisy nededuplikuje', () => {
        const input = [
            { scope: '_kb_resersnik', fileName: 'OSŘ § 0204.txt', score: 0.9 },
            { scope: '_kb_resersnik', fileName: 'OSŘ § 0204.txt', score: 0.8 },
            { scope: null, fileName: 'spis/smlouva.pdf', score: 0.7 },
            { scope: null, fileName: 'spis/smlouva.pdf', score: 0.6 },
            { scope: '_kb_resersnik', fileName: 'OSŘ § 0201.txt', score: 0.5 },
        ];
        const out = dedupeKbResults(input);
        expect(out.map(r => `${r.fileName}@${r.score}`)).toEqual([
            'OSŘ § 0204.txt@0.9', 'spis/smlouva.pdf@0.7', 'spis/smlouva.pdf@0.6', 'OSŘ § 0201.txt@0.5',
        ]);
    });

    test('stejný název souboru v různých bázích se nededuplikuje', () => {
        const out = dedupeKbResults([
            { scope: '_kb_a', fileName: 'x.txt', score: 0.9 },
            { scope: '_kb_b', fileName: 'x.txt', score: 0.8 },
        ]);
        expect(out).toHaveLength(2);
    });
});
