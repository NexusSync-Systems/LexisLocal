'use strict';
// Bezpečnostní revize 2. 11. 2026 (skupina „před pilotem“): přílohy e-mailu, nahrání souboru, nástroj get_document.
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('přílohy e-mailu jen z evidovaných dokumentů ve spisovně', () => {
    const { overPrilohy } = require('../lib/email_attachments');
    let spisovna, venku, inbox;
    beforeAll(() => {
        spisovna = fs.mkdtempSync(path.join(os.tmpdir(), 'priloha-spisovna-'));
        venku = fs.mkdtempSync(path.join(os.tmpdir(), 'priloha-venku-'));
        fs.writeFileSync(path.join(spisovna, 'smlouva.pdf'), 'x');
        fs.writeFileSync(path.join(spisovna, 'cizi.pdf'), 'x');
        fs.writeFileSync(path.join(spisovna, '.lexis.db'), 'x');
        fs.writeFileSync(path.join(venku, 'lexis.key'), 'tajne');
        inbox = { files: {
            'smlouva.pdf': { filePath: path.join(spisovna, 'smlouva.pdf'), caseNumber: '1 C 1/2026' },
            'cizi.pdf': { filePath: path.join(spisovna, 'cizi.pdf'), caseNumber: '2 C 2/2026' },
            'klic': { filePath: path.join(venku, 'lexis.key') },
            '.lexis.db': { filePath: path.join(spisovna, '.lexis.db') }
        } };
    });
    const acl = { canAccessFile: f => f.caseNumber !== '2 C 2/2026' };
    const o = () => ({ inbox, ingestDir: spisovna, fileAcl: acl });

    test('dokument spisu podle názvu i cesty projde', async () => {
        const r = await overPrilohy(['smlouva.pdf', path.join(spisovna, 'smlouva.pdf')], {}, o());
        expect(r).toEqual([fs.realpathSync(path.join(spisovna, 'smlouva.pdf')), fs.realpathSync(path.join(spisovna, 'smlouva.pdf'))]);
    });
    test('libovolná cesta na disku (klíč) → odmítnuto', async () => {
        await expect(overPrilohy([path.join(venku, 'lexis.key')], {}, o())).rejects.toMatchObject({ code: 'ATTACHMENT_FORBIDDEN' });
        await expect(overPrilohy(['klic'], {}, o())).rejects.toThrow(/neleží ve spisovně/);
        await expect(overPrilohy(['/etc/passwd'], {}, o())).rejects.toThrow(/není dokument evidovaný/);
    });
    test('interní soubor a dokument cizího spisu → odmítnuto', async () => {
        await expect(overPrilohy(['.lexis.db'], {}, o())).rejects.toThrow(/interní soubor/);
        await expect(overPrilohy(['cizi.pdf'], {}, o())).rejects.toThrow(/nemáte přístup/);
    });
    test('bez příloh nic', async () => { expect(await overPrilohy(undefined, {}, o())).toEqual([]); });
});

describe('nahrání souboru: žádné interní soubory, žádný přepis', () => {
    const { safePathInWatchDir, volnaCesta } = require('../lib/pathsafe');
    test('název začínající tečkou se odmítne', () => {
        expect(() => safePathInWatchDir('.lexis.db')).toThrow(/tečkou/);
        expect(() => safePathInWatchDir('../../.audit_log.json')).toThrow(/tečkou/);
    });
    test('existující dokument dostane volné jméno', () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'volna-'));
        fs.writeFileSync(path.join(d, 'zaloba.pdf'), 'a');
        fs.writeFileSync(path.join(d, 'zaloba (2).pdf'), 'b');
        expect(volnaCesta(path.join(d, 'zaloba.pdf'))).toBe(path.join(d, 'zaloba (3).pdf'));
        expect(volnaCesta(path.join(d, 'nova.pdf'))).toBe(path.join(d, 'nova.pdf'));
    });
});

describe('nástroj agenta get_document respektuje přístup', () => {
    test('agent bez přístupu ke spisům a cizí dokument → chyba, nic se nečte', async () => {
        jest.resetModules();
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'getdoc-'));
        fs.writeFileSync(path.join(d, 'a.txt'), 'OBSAH SPISU');
        jest.doMock('../lib/watcher', () => ({ loadInbox: async () => ({ files: { 'a.txt': { filePath: path.join(d, 'a.txt'), caseNumber: '9 C 9/2026' } } }) }));
        let povolit = false;
        jest.doMock('../lib/file_acl', () => ({ canAccessFile: () => povolit, spisForFileName: () => null }));
        try {
            const tools = require('../lib/agent_tools');
            const run = async (ctx) => tools.TOOLS.get_document.impl({ fileName: 'a.txt' }, ctx);
            expect(await run({ ragFilters: { clientAccess: false } })).toMatchObject({ error: expect.stringMatching(/nemá přístup/) });
            expect(await run({})).toMatchObject({ error: expect.stringMatching(/nemáte přístup/) });
            povolit = true;
            expect(await run({})).toMatchObject({ content: 'OBSAH SPISU' });
        } finally { jest.dontMock('../lib/watcher'); jest.dontMock('../lib/file_acl'); }
    });
});
