/**
 * Dotaz asistenta ke spisu (K-pilot 30. 10. 2026): spis se pozná i z ragFilters.caseNumber (asistent „Ke spisu“)
 * a z contextFileName (kontrola smlouvy / odpověď na e-mail z dokumentu spisu); úseky z cizích spisů
 * při zapnutém cloudu do dotazu nejdou.
 */
'use strict';
const path = require('path'), os = require('os'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `lexis_test_spisctx_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

const decisions = [];
const seen = [];
jest.mock('../lib/ai_provider', () => {
    const actual = jest.requireActual('../lib/ai_provider');
    return Object.assign({}, actual, {
        providerInfo: jest.fn(() => ({ chat: 'bedrock', embed: 'ollama', localOnly: false, compliant: true })),
        chat: jest.fn(async ({ messages }) => {
            decisions.push(require('../lib/cloud_policy').rozhodni('bedrock'));
            seen.push(messages.map(m => m.content).join('\n'));
            return { message: { content: 'Odpověď.' } };
        })
    });
});
jest.mock('../lib/rag', () => Object.assign({}, jest.requireActual('../lib/rag'), {
    searchSimilar: jest.fn(async () => [
        { fileName: 'zaloba_b.pdf', scope: null, score: 0.9, text: 'Žaloba ve věci 12 C 2/2026.' },
        { fileName: 'cizi_spis.pdf', scope: null, score: 0.85, text: 'CIZI_SPIS_TEXT' },
        { fileName: 'OZ 89-2012 § 2051.txt', scope: '_kb_resersnik', score: 0.8, text: '§ 2051 Snížení smluvní pokuty.' }
    ]),
    getEmbedding: jest.fn(async () => { throw new Error('offline'); })
}));

const request = require('supertest');
const app = require('../server');
const db = require('../lib/database');
const spisy = require('../lib/spisy');
const H = (r) => r.set('X-API-Token', 'tok-test');

let sB;
beforeEach(() => {
    decisions.length = 0; seen.length = 0;
    db.set('spisy', []); db.set('spis_events', []);
    sB = spisy.createSpis({ spisZn: '12 C 2/2026', nazev: 'Spor' });
    spisy.createSpis({ spisZn: '7 C 7/2026', nazev: 'Jiný klient' });
    db.set('inbox_files', [
        { id: 'f1', fileName: 'zaloba_b.pdf', relativePath: 'zaloba_b.pdf', caseNumber: '12 C 2/2026' },
        { id: 'f2', fileName: 'cizi_spis.pdf', relativePath: 'cizi_spis.pdf', caseNumber: '7 C 7/2026' },
        { id: 'f3', fileName: 'smlouva_b.pdf', relativePath: 'smlouva_b.pdf', caseNumber: '12 C 2/2026' }
    ]);
});

test('ragFilters.caseNumber určí spis dotazu; úsek cizího spisu vypadne', async () => {
    const r = await H(request(app).post('/api/agent/resersnik')).send({ prompt: 'Shrň stav věci.', ragFilters: { caseNumber: '12 C 2/2026' } });
    expect([200, 403]).toContain(r.status); // bez souhlasu klienta se v cloudu odmítne — podstatný je důvod
    const d = decisions[0] || (r.body && r.body.cloudPolicy);
    const duvod = JSON.stringify(r.body);
    expect(duvod).not.toMatch(/7 C 7\/2026/);          // cizí spis v důvodech není
    expect(duvod).not.toMatch(/nezařazen|neznámého původu/);
    if (seen[0]) expect(seen[0]).not.toMatch(/CIZI_SPIS_TEXT/);
    if (d && d.spisy) expect(d.spisy.map(s => s.spisZn)).toEqual(['12 C 2/2026']);
});

test('se souhlasem klienta jde dotaz ke spisu do cloudu', async () => {
    const P = require('../lib/cloud_policy');
    P.udelSouhlas(sB.id, { typ: 'spis', principal: { userId: 'u1', name: 'JUDr. A', kind: 'user', scopes: ['read', 'write', 'approve'] }, poznamka: 'písemně' });
    const r = await H(request(app).post('/api/agent/resersnik')).send({ prompt: 'Shrň stav věci.', ragFilters: { caseNumber: '12 C 2/2026' } });
    expect(r.status).toBe(200);
    expect(decisions[0]).toMatchObject({ allowed: true, code: 'spis' });
    expect(seen[0]).not.toMatch(/CIZI_SPIS_TEXT/);
});

test('kontrola smlouvy z dokumentu spisu: spis podle contextFileName, ne „neznámý původ“', async () => {
    const P = require('../lib/cloud_policy');
    P.udelSouhlas(sB.id, { typ: 'spis', principal: { userId: 'u1', name: 'JUDr. A', kind: 'user', scopes: ['read', 'write', 'approve'] }, poznamka: 'písemně' });
    const r = await H(request(app).post('/api/agent/kontrolor')).send({ prompt: 'Zkontroluj smlouvu.', context: 'Smlouva o dílo …', contextFileName: 'smlouva_b.pdf' });
    expect(r.status).toBe(200);
    expect(decisions[0]).toMatchObject({ allowed: true, code: 'spis' });
});

test('kontext bez spisu zůstává neznámého původu (bez souhlasu nikam)', async () => {
    const r = await H(request(app).post('/api/agent/kontrolor')).send({ prompt: 'Zkontroluj smlouvu.', context: 'Smlouva o dílo …', contextFileName: 'neexistuje.pdf' });
    expect(JSON.stringify(r.body) + JSON.stringify(decisions)).toMatch(/není zařazený ve spisu/);
});
