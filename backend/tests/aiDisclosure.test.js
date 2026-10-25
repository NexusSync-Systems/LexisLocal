/**
 * Označení výstupů AI (EU AI Act čl. 50): odpovědi API, export .docx, e-mail.
 * Syntetická data.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_aidisc_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

const JSZip = require('jszip');
const A = require('../lib/ai_disclosure');
const D = require('../lib/drafts');

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(tmp + '_key', { recursive: true, force: true }); } catch (e) {} });

test('odpověď agenta nese příznak a jednotný text upozornění', () => {
    expect(A.forResponse()).toEqual({ aiGenerated: true, aiNotice: A.TEXT_NOTICE });
    expect(A.TEXT_NOTICE).toMatch(/umělá inteligence/);
});

test('docProps/custom.xml: vlastnosti AI, escapování', () => {
    const x = A.docxCustomProps({ humanApproved: true, generatedAt: '2026-10-24 <x>' });
    expect(x).toContain('name="AIGenerated"><vt:bool>true</vt:bool>');
    expect(x).toContain('name="AIHumanApproved"><vt:bool>true</vt:bool>');
    expect(x).toContain('name="AIGenerator"><vt:lpwstr>LexisLocal AI</vt:lpwstr>');
    expect(x).toContain('2026-10-24 &lt;x&gt;');
    expect(x).not.toContain('<x>');
});

async function zipOf(d) { return JSZip.loadAsync(await D.exportDocx(d)); }

test('export .docx konceptu od AI obsahuje strojově čitelné označení', async () => {
    const d = D.createDraft({ title: 'Žaloba', text: 'ŽALOBA\n\nŽalobce se domáhá zaplacení 10 000 Kč.', source: { type: 'agent', agentId: 'spisovatel' } }, { userId: 'agent', kind: 'agent', scopes: ['read', 'write'] });
    expect(d.aiGenerated).toBe(true);
    const zip = await zipOf(d);
    const custom = await zip.file('docProps/custom.xml').async('string');
    expect(custom).toContain('name="AIGenerated"><vt:bool>true</vt:bool>');
    expect(custom).toContain('name="AIHumanApproved"><vt:bool>false</vt:bool>');
    expect(await zip.file('[Content_Types].xml').async('string')).toContain('/docProps/custom.xml');
    expect(await zip.file('_rels/.rels').async('string')).toContain('docProps/custom.xml');
});

test('koncept napsaný člověkem se jako AI neoznačuje', async () => {
    const d = D.createDraft({ title: 'Plná moc', text: 'PLNÁ MOC\n\nZmocňuji advokáta.' }, { userId: 'u1', kind: 'user', scopes: ['read', 'write'] });
    expect(d.aiGenerated).toBe(false);
    const zip = await zipOf(d);
    expect(zip.file('docProps/custom.xml')).toBeNull();
});
