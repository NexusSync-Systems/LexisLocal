/**
 * Testy rag_request (../lib/rag_request.js) — překlad ragFilters z requestu.
 * loadInbox z watcheru je mockovaný (caseNumber → soubory spisu).
 */

jest.mock('../lib/watcher', () => ({
    loadInbox: jest.fn()
}));
const { loadInbox } = require('../lib/watcher');
const { resolveRagFilters } = require('../lib/rag_request');

describe('resolveRagFilters', () => {
    afterEach(() => jest.clearAllMocks());

    test('bez ragFilters → null', async () => {
        expect(await resolveRagFilters({})).toBeNull();
        expect(await resolveRagFilters(null)).toBeNull();
    });

    test('fileNames se předají', async () => {
        const r = await resolveRagFilters({ ragFilters: { fileNames: ['a.txt', 'b.txt'] } });
        expect(r.fileNames).toEqual(['a.txt', 'b.txt']);
    });

    test('directory a strict se předají', async () => {
        const r = await resolveRagFilters({ ragFilters: { directory: 'KlientA', strict: true } });
        expect(r.directory).toBe('KlientA');
        expect(r.strict).toBe(true);
    });

    test('caseNumber bez dokumentů v indexu → jen znalostní báze, ne celý archiv spisů', async () => {
        loadInbox.mockResolvedValue({ files: { f3: { caseNumber: 'jiny', relativePath: 'KlientB/x.txt' } } });
        const r = await resolveRagFilters({ ragFilters: { caseNumber: '99 C 9/2026' } });
        expect(r.fileNames).toBeUndefined();
        expect(r.clientAccess).toBe(false);
    });

    test('prázdné ragFilters → null', async () => {
        expect(await resolveRagFilters({ ragFilters: {} })).toBeNull();
    });

    test('caseNumber rozbalí na soubory spisu z inboxu (a sloučí s fileNames bez duplicit)', async () => {
        loadInbox.mockResolvedValue({
            files: {
                f1: { caseNumber: '23 C 1/2026', relativePath: 'KlientA/zaloba.txt' },
                f2: { caseNumber: '23 C 1/2026', fileName: 'vyzva.txt' },
                f3: { caseNumber: 'jiny', relativePath: 'KlientB/x.txt' }
            }
        });
        const r = await resolveRagFilters({ ragFilters: { caseNumber: '23 C 1/2026', fileNames: ['zaloba.txt'] } });
        expect(r.fileNames).toContain('KlientA/zaloba.txt');
        expect(r.fileNames).toContain('vyzva.txt');
        expect(r.fileNames).not.toContain('KlientB/x.txt');
        // 'zaloba.txt' (z fileNames) + 2 ze spisu, bez duplicit
        expect(new Set(r.fileNames).size).toBe(r.fileNames.length);
    });

    test('selhání loadInbox nepoloží celý překlad', async () => {
        loadInbox.mockRejectedValue(new Error('inbox down'));
        const r = await resolveRagFilters({ ragFilters: { caseNumber: 'x', fileNames: ['a.txt'] } });
        expect(r.fileNames).toEqual(['a.txt']); // aspoň to, co přišlo přímo
    });
});
