/**
 * Lhůty v rešerši počítá program: konec lhůty popsaný jako začátek se opraví a chybí-li
 * § 629 nebo 10letá lhůta, doplní se celý výpočet (server test 4. 10. 2026, R1).
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_dlw_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

jest.mock('../lib/ai_provider', () => {
    const actual = jest.requireActual('../lib/ai_provider');
    return Object.assign({}, actual, {
        chat: jest.fn(async () => ({ message: { content: '1. Stručná odpověď: Klientka může náhradu škody vymáhat, musí to udělat v rámci subjektivní lhůty 3 let, která běží od 13. 3. 2028. Soused odpovídá za škodu podle občanského zákoníku.' } }))
    });
});
jest.mock('../lib/rag', () => Object.assign({}, jest.requireActual('../lib/rag'), {
    searchSimilar: jest.fn(async () => []),
    getEmbedding: jest.fn(async () => { throw new Error('offline'); })
}));

const D = require('../lib/date_facts');
const request = require('supertest');
const app = require('../server');
const EMAIL = fs.readFileSync(path.join(__dirname, '..', 'eval', 'server_suite', 'fixtures', 'email_klientky_vytopeni.txt'), 'utf8');
const df = D.buildDateFacts(EMAIL + '\nnáhradu škody', { question: 'do kdy může vymáhat náhradu škody' });

test('„běží od <konec>“ → „běží do“, „počíná běžet od“ → „končí“; jiné věty beze změny', () => {
    expect(D.fixDeadlineWording('Lhůta 3 let, která běží od 13. 3. 2028. Narozena od 13. 3. 2028 ne.', df).text)
        .toBe('Lhůta 3 let, která běží do 13. 3. 2028. Narozena od 13. 3. 2028 ne.');
    expect(D.fixDeadlineWording('Objektivní lhůta počíná běžet od 12. 3. 2035.', df).text).toBe('Objektivní lhůta končí 12. 3. 2035.');
    const ok = 'Promlčecí lhůta: od 12. 3. 2025 do 13. 3. 2028. Lhůta skončí 13. 3. 2028, od 13. 3. 2028 je nárok promlčen.';
    expect(D.fixDeadlineWording(ok, df)).toEqual({ text: ok, fixed: 0 });
});

test('výpočet se doplní, když chybí § 629 nebo 10letá lhůta; když je vše, nedoplní se', () => {
    expect(D.dateFactsAppendix('lhůta končí 13. 3. 2028', df)).toMatch(/§ 629[\s\S]*10 let/);
    expect(D.dateFactsAppendix('končí 13. 3. 2028 (§ 629 odst. 1 OZ), objektivně 12. 3. 2035', df)).toBe('');
});

test('route rešeršníka: oprava „od“ → „do“ a doplněný výpočet s § 629 a 10 lety', async () => {
    const r = await request(app).post('/api/agent/resersnik').set('X-API-Token', 'tok-test').send({
        prompt: 'Klientka se ptá, jestli a do kdy může po sousedovi vymáhat náhradu škody z vytopení bytu. Udělej právní rozbor s paragrafy.', context: EMAIL
    });
    expect(r.status).toBe(200);
    expect(r.body.response).toMatch(/běží do 13\. 3\. 2028/);
    expect(r.body.response).not.toMatch(/běží od 13\. 3\. 2028/);
    expect(r.body.response).toMatch(/629/);
    expect(r.body.response).toMatch(/10 let/);
    expect(r.body.outputGuard.deadlineWordingFixed).toBe(1);
});
