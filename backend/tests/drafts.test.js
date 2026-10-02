/**
 * Sdílené koncepty (webový LexisEditor Lite): verze, souběh, zámek, schválení,
 * export .docx se spec, napojení agentů (automatický koncept, revize podle připomínek).
 * Vše na syntetických datech.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_drafts_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

const mockSeen = [];
let mockReply = 'ŽALOBA\n\nOkresní soud v Testově\n\nŽalobce [OSOBA_1] se domáhá zaplacení **10 000 Kč**.\n- smlouva ze dne 1. 1. 2026\n- faktura č. 1';
jest.mock('../lib/ai_provider', () => {
    const actual = jest.requireActual('../lib/ai_provider');
    return Object.assign({}, actual, {
        chat: jest.fn(async ({ messages }) => { mockSeen.push(messages); return { message: { content: mockReply } }; })
    });
});
jest.mock('../lib/rag', () => Object.assign({}, jest.requireActual('../lib/rag'), {
    searchSimilar: jest.fn(async () => []),
    getEmbedding: jest.fn(async () => { throw new Error('offline'); })
}));

const request = require('supertest');
const JSZip = require('jszip');
const app = require('../server');
const D = require('../lib/drafts');
const H = (r) => r.set('X-API-Token', 'tok-test');

describe('spec: převod a validace', () => {
    test('markdown z modelu → bloky (titulek, nadpis, tučně, seznamy, tabulka)', () => {
        const s = D.textToSpec('PLNÁ MOC\n\n## Zmocnitel\nJan **Testovací**\n1. první\n2. druhý\n| a | b |\n|---|---|\n| 1 | 2 |');
        expect(s.blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'PLNÁ MOC', bold: true }], align: 'center' });
        expect(s.blocks[1]).toEqual({ type: 'heading', level: 2, text: 'Zmocnitel' });
        expect(s.blocks[2].runs).toEqual([{ text: 'Jan ' }, { text: 'Testovací', bold: true }]);
        expect(s.blocks[3]).toEqual({ type: 'list', ordered: true, items: ['první', 'druhý'] });
        expect(s.blocks[4]).toEqual({ type: 'table', cells: [['a', 'b'], ['1', '2']] });
    });
    test('validace zahodí neznámé bloky, HTML hlavičku a nebezpečné odkazy', () => {
        const s = D.validateSpec({ letterheadHtml: '<img src=x onerror=alert(1)>', blocks: [
            { type: 'html', html: '<script>x</script>' },
            { type: 'paragraph', runs: [{ text: 'klik', link: 'javascript:alert(1)' }, { text: 'ok', link: 'https://example.cz' }] },
            { type: 'heading', level: 9, text: 'x', id: '"><img>' }
        ] });
        expect(s.letterheadHtml).toBeUndefined();
        expect(s.blocks).toHaveLength(2);
        expect(s.blocks[0].runs[0].link).toBeUndefined();
        expect(s.blocks[0].runs[1].link).toBe('https://example.cz');
        expect(s.blocks[1]).toEqual({ type: 'heading', level: 2, text: 'x' });
        expect(() => D.validateSpec({ nope: 1 })).toThrow();
    });
    test('HTML pro export je escapované', () => {
        expect(D.specToHtml({ blocks: [{ type: 'paragraph', text: '<script>alert(1)</script>' }] })).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    });
});

describe('API /api/drafts', () => {
    let id;
    test('založení, detail, seznam', async () => {
        const c = await H(request(app).post('/api/drafts')).send({ title: 'Výzva k plnění', text: 'Vážený pane,\nvyzýváme Vás k úhradě.' });
        expect(c.status).toBe(201);
        id = c.body.id;
        expect(c.body).toMatchObject({ title: 'Výzva k plnění', status: 'koncept', version: 1, aiGenerated: false });
        const g = await H(request(app).get('/api/drafts/' + id));
        expect(g.body.spec.blocks).toHaveLength(2);
        const l = await H(request(app).get('/api/drafts'));
        expect(l.body.drafts.map(d => d.id)).toContain(id);
        expect((await request(app).get('/api/drafts')).status).toBe(401);
    });

    test('uložení verze; souběžná úprava se starou verzí → 409, nic se nepřepíše', async () => {
        const spec = { blocks: [{ type: 'paragraph', text: 'Vážený pane,' }, { type: 'paragraph', text: 'vyzýváme Vás k úhradě do 15 dnů.' }] };
        const s1 = await H(request(app).put('/api/drafts/' + id)).send({ spec, baseVersion: 1, note: 'lhůta' });
        expect(s1.status).toBe(200);
        expect(s1.body.version).toBe(2);
        const s2 = await H(request(app).put('/api/drafts/' + id)).send({ spec: { blocks: [{ type: 'paragraph', text: 'jiná úprava' }] }, baseVersion: 1 });
        expect(s2.status).toBe(409);
        expect(s2.body).toMatchObject({ code: 'conflict', currentVersion: 2 });
        const g = await H(request(app).get('/api/drafts/' + id));
        expect(D.specToText(g.body.spec)).toMatch(/15 dnů/);
        expect(g.body.versions.map(v => v.v)).toEqual([1, 2]);
        const v1 = await H(request(app).get(`/api/drafts/${id}/versions/1`));
        expect(D.specToText(v1.body.spec)).not.toMatch(/15 dnů/);
        expect((await H(request(app).put('/api/drafts/' + id)).send({ spec })).status).toBe(400); // bez baseVersion
    });

    test('schválení → jen pro čtení; do spisu jen schválený; vrácení do konceptu', async () => {
        const st = await H(request(app).post(`/api/drafts/${id}/status`)).send({ status: 'schvaleno' });
        expect(st.body).toMatchObject({ status: 'schvaleno' });
        expect(st.body.approvedBy.userId).toBe('local');
        const s = await H(request(app).put('/api/drafts/' + id)).send({ text: 'změna', baseVersion: 2 });
        expect(s.status).toBe(409);
        expect(s.body.code).toBe('approved');
        const back = await H(request(app).post(`/api/drafts/${id}/status`)).send({ status: 'koncept' });
        expect(back.body.approvedBy).toBeNull();
    });

    test('export .docx nese LexisEditor spec (otevře se v editoru bez ztráty)', async () => {
        const r = await H(request(app).get(`/api/drafts/${id}/export.docx`)).buffer(true).parse((res, cb) => {
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        expect(r.status).toBe(200);
        expect(r.headers['content-disposition']).toMatch(/\.docx"/);
        const zip = await JSZip.loadAsync(r.body);
        const xml = await zip.file('customXml/item1.xml').async('string');
        const spec = require('../lib/lexis-spec').parseLexisSpecXml(xml);
        expect(spec.title).toBeUndefined(); // název nepatří do textu dokumentu (zdvojení v editoru)
        expect(spec.blocks[1].text).toMatch(/15 dnů/);
        const docXml = await zip.file('word/document.xml').async('string');
        expect(docXml).toMatch(/15 dnů/);
    });

    test('připomínky a jejich vyřešení', async () => {
        const c = await H(request(app).post(`/api/drafts/${id}/comments`)).send({ text: 'Doplnit číslo účtu.' });
        expect(c.status).toBe(201);
        const r = await H(request(app).post(`/api/drafts/${id}/comments/${c.body.id}/resolve`));
        expect(r.body.resolved).toBe(true);
    });

    test('zámek: agent do zamčeného konceptu nezapíše; agent neschválí, nesmaže, nezamyká', async () => {
        const agent = { userId: 'agent:spisovatel', name: 'Spisovatel', kind: 'agent', scopes: ['read', 'write'] };
        const lk = await H(request(app).post(`/api/drafts/${id}/lock`));
        expect(lk.status).toBe(200);
        const cur = (await H(request(app).get('/api/drafts/' + id))).body.version;
        expect(() => D.saveVersion(id, { text: 'Úprava agentem, která je dost dlouhá.', baseVersion: cur }, agent)).toThrow(/upravuje/);
        // agent přes /api/agent s draftId taky narazí na zámek — výsledek se neuloží, nic se nepřepíše
        const viaRoute = await H(request(app).post('/api/agent/spisovatel')).send({ prompt: 'Uprav.', draftId: id });
        expect(viaRoute.status).toBe(423); // model se ani nevolá
        await H(request(app).delete(`/api/drafts/${id}/lock`));
        const ok = D.saveVersion(id, { text: 'Úprava agentem, která je dost dlouhá.', baseVersion: cur }, agent);
        expect(ok.draft).toMatchObject({ status: 'ke_kontrole', aiGenerated: true });
        expect(() => D.setStatus(id, 'schvaleno', agent)).toThrow(/advokát/);
        expect(() => D.deleteDraft(id, agent)).toThrow();
        expect(() => D.acquireLock(id, agent)).toThrow();
        expect(D.checkAccess({ kind: 'agent', scopes: ['read'] }, null, 'write')).toMatchObject({ status: 403 });
        // per-agent token dnes API brána nepouští vůbec (jen hlavní token) — beze změny
        const tok = require('../lib/agent_tokens').createToken('test-agent', ['read', 'write']);
        expect((await request(app).get('/api/drafts').set('X-API-Token', tok)).status).toBe(401);
    });

    test('uložení do spisu: neschválený 409, schválený se uloží jako .docx', async () => {
        const spis = require('../lib/spisy').createSpis({ nazev: 'Testovací spis', spisZn: '99 C 1/2026' });
        const c = await H(request(app).post('/api/drafts')).send({ title: 'Do spisu', spisId: spis.id, text: 'Text konceptu pro spis.' });
        expect((await H(request(app).post(`/api/drafts/${c.body.id}/file`))).status).toBe(409);
        await H(request(app).post(`/api/drafts/${c.body.id}/status`)).send({ status: 'schvaleno' });
        const f = await H(request(app).post(`/api/drafts/${c.body.id}/file`));
        expect(f.status).toBe(201);
        expect(f.body.savedPath).toMatch(/\.docx$/);
        expect(fs.existsSync(f.body.savedPath)).toBe(true);
    });

    test('smazání', async () => {
        expect((await H(request(app).delete('/api/drafts/' + id))).status).toBe(200);
        expect((await H(request(app).get('/api/drafts/' + id))).status).toBe(404);
    });
});

describe('agenti a koncepty', () => {
    test("saveDraft:'auto' — Spisovatel uloží koncept ke kontrole se skutečným jménem", async () => {
        const r = await H(request(app).post('/api/agent/spisovatel')).send({
            prompt: 'Sepiš žalobu.', context: 'Klient: Jan Testovací, Okružní 5, Testov.', saveDraft: 'auto', draftTitle: 'Žaloba — test'
        });
        expect(r.status).toBe(200);
        expect(r.body.draft).toMatchObject({ created: true, status: 'ke_kontrole', version: 1 });
        const d = (await H(request(app).get('/api/drafts/' + r.body.draft.id))).body;
        expect(d).toMatchObject({ title: 'Žaloba — test', aiGenerated: true, lastKind: 'ai' });
        expect(d.source).toMatchObject({ type: 'agent', agentId: 'spisovatel' });
        const text = D.specToText(d.spec);
        expect(text).toMatch(/Žalobce Jan Testovací/);
        expect(text).not.toMatch(/⚠️/); // upozornění kontroly nejsou v textu dokumentu
    });

    test("saveDraft:'auto' u agenta, který dokumenty nepíše (Rešeršník) → bez konceptu; bez saveDraft (LexisEditor) → bez konceptu", async () => {
        const a = await H(request(app).post('/api/agent/resersnik')).send({ prompt: 'Najdi judikaturu.', saveDraft: 'auto' });
        expect(a.body.draft).toBeNull();
        const b = await H(request(app).post('/api/agent/spisovatel')).send({ prompt: 'Sepiš žalobu.' });
        expect(b.body.draft).toBeNull();
    });

    test('revize podle připomínek: agent dostane znění + připomínky, vznikne nová verze; RČ z konceptu se zachová', async () => {
        const c = await H(request(app).post('/api/drafts')).send({ title: 'Plná moc', text: 'PLNÁ MOC\nZmocnitel: Jan Testovací, nar. 800101/1234\nZmocňuji advokáta k zastupování.' });
        await H(request(app).post(`/api/drafts/${c.body.id}/comments`)).send({ text: 'Doplň, že jde i o zastupování v odvolacím řízení.' });
        mockReply = 'PLNÁ MOC\nZmocnitel: [OSOBA_1], nar. [RČ_1]\nZmocňuji advokáta k zastupování včetně odvolacího řízení.';
        const r = await H(request(app).post('/api/agent/spisovatel')).send({ prompt: 'Zapracuj připomínky.', draftId: c.body.id });
        expect(r.status).toBe(200);
        expect(r.body.draft).toMatchObject({ created: false, version: 2, status: 'ke_kontrole' });
        const sent = JSON.stringify(mockSeen[mockSeen.length - 1]);
        expect(sent).toMatch(/odvolacím řízení/); // připomínka šla modelu
        expect(sent).not.toMatch(/800101\/1234/);   // RČ modelu jen jako symbol
        const d = (await H(request(app).get('/api/drafts/' + c.body.id))).body;
        const text = D.specToText(d.spec);
        expect(text).toMatch(/nar\. 800101\/1234/);
        expect(text).toMatch(/odvolacího řízení/);
        expect(d.versions[1]).toMatchObject({ kind: 'ai' });
    });

    test('revize schváleného konceptu agentem je odmítnuta', async () => {
        const c = await H(request(app).post('/api/drafts')).send({ title: 'Hotovo', text: 'Schválený text konceptu.' });
        await H(request(app).post(`/api/drafts/${c.body.id}/status`)).send({ status: 'schvaleno' });
        const r = await H(request(app).post('/api/agent/spisovatel')).send({ prompt: 'Uprav.', draftId: c.body.id });
        expect(r.status).toBe(409);
    });

    test('odmítnutí pro nedostatek podkladů se jako koncept neukládá', () => {
        expect(D.saveAgentOutput({ text: 'Nedostatek podkladů ze spisů pro bezpečné vypracování.', agentId: 'spisovatel' })).toEqual({ skipped: 'not-a-document' });
    });

    test('nástroje agentů: list_drafts / get_draft (jen čtení)', async () => {
        const tools = require('../lib/agent_tools');
        const c = D.createDraft({ title: 'Pro nástroj', text: 'Text pro nástroj agenta.' }, { userId: 'local', name: 'Místní uživatel' });
        const names = tools.toolsForAgent({ permissions: { read_files: true } }).map(t => t.function.name);
        expect(names).toEqual(expect.arrayContaining(['list_drafts', 'get_draft']));
        const exec = tools.executeTool || tools.runTool;
        if (exec) {
            const g = await exec('get_draft', { id: c.id }, { permissions: { read_files: true } }, {});
            expect(JSON.stringify(g)).toMatch(/Text pro nástroj/);
        }
    });

    test('schválením se u záznamu v transparency ledgeru nastaví humanApproved (řetězec zůstane platný)', async () => {
        mockReply = 'SMLOUVA O DÍLO\nSmluvní strany se dohodly na provedení díla.';
        const r = await H(request(app).post('/api/agent/spisovatel')).send({ prompt: 'Sepiš smlouvu.', saveDraft: true });
        const tid = r.body.transparencyId;
        await H(request(app).post(`/api/drafts/${r.body.draft.id}/status`)).send({ status: 'schvaleno' });
        const db = require('../lib/database');
        const rec = db.get('transparency_logs').find(x => x.id === tid);
        expect(rec.humanApproved).toBe(true);
        expect(db.verifyLedger().valid).toBe(true);
    });
});
