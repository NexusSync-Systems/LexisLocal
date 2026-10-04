/**
 * Výzva k úhradě: model vrátí JSON, dopis sestaví program (lib/demand_letter.js) a
 * route ho použije; když JSON nepřijde, pokračuje se volným textem.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_demand_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

const mockCalls = [];
let mockReplies = [];
jest.mock('../lib/ai_provider', () => {
    const actual = jest.requireActual('../lib/ai_provider');
    return Object.assign({}, actual, {
        chat: jest.fn(async (args) => {
            mockCalls.push(args);
            const r = mockReplies.length ? mockReplies.shift() : 'nic';
            if (r instanceof Error) throw r;
            return { message: { content: r } };
        })
    });
});
jest.mock('../lib/rag', () => Object.assign({}, jest.requireActual('../lib/rag'), {
    searchSimilar: jest.fn(async () => []),
    getEmbedding: jest.fn(async () => { throw new Error('offline'); })
}));

const D = require('../lib/demand_letter');
const request = require('supertest');
const app = require('../server');
const H = (r) => r.set('X-API-Token', 'tok-test');
const EMAIL = fs.readFileSync(path.join(__dirname, '..', 'eval', 'server_suite', 'fixtures', 'email_klientky_vytopeni.txt'), 'utf8');

describe('rozpoznání a sestavení', () => {
    test('co je výzva k úhradě a co ne', () => {
        expect(D.isDemandLetter('Napiš předžalobní výzvu sousedovi klientky k úhradě škody.')).toBe(true);
        expect(D.isDemandLetter('Napiš stručný dopis protistraně (povinnému) s výzvou k zaplacení dlužného výživného.')).toBe(true);
        expect(D.isDemandLetter('Připrav procesní plnou moc pro klientku Evu Novotnou.')).toBe(false);
        expect(D.isDemandLetter('Napiš žalobu o zaplacení 50 000 Kč.')).toBe(false);
    });
    test('chybějící údaje jsou vždy [Doplnit – …], oslovení podle adresáta', () => {
        const r = D.renderLetter({ typ: 'předžalobní výzva', odesilatel: { jmeno: 'Eva Novotná' }, adresat: { jmeno: 'Ing. Tomáš Horák', adresa: null },
            misto: 'Jihlava', vec: 'Předžalobní výzva k úhradě náhrady škody', skutkovy_stav: 'Dne 12. 3. 2025 jste vytopil byt naší klientky.', castka: '86 000 Kč', lhuta: null },
            { today: new Date(2026, 9, 4) });
        expect(r.text).toMatch(/^Vážený pane inženýre,$/m);
        expect(r.text).toMatch(/V Jihlavě dne 4\. 10\. 2026/);
        expect(r.text).toMatch(/\[Doplnit – adresa adresáta\]/);
        expect(r.text).toMatch(/86 000 Kč do 15 dnů/);
        expect(r.text).toMatch(/\[Doplnit – číslo účtu pro platbu\]/);
        expect(r.text).toMatch(/§ 142a/);
        expect(r.text).toMatch(/naší klientky \(Eva Novotná\)/);
        expect(r.missing).toEqual(expect.arrayContaining(['adresa adresáta', 'číslo účtu pro platbu']));
    });
    test('JSON i v bloku ```json s textem okolo', () => {
        expect(D.parseLetterJson('Zde:\n```json\n{"vec":"X","skutkovy_stav":"Y"}\n```')).toMatchObject({ vec: 'X' });
        expect(D.parseLetterJson('Vážený pane, …')).toBeNull();
    });
});

describe('route /api/agent/spisovatel', () => {
    beforeEach(() => { mockCalls.length = 0; mockReplies = []; });

    test('W1: dopis sestaví program, jméno a oslovení z podkladů, model nevidí jméno', async () => {
        mockReplies = [JSON.stringify({
            typ: 'předžalobní výzva', odesilatel: { jmeno: '[OSOBA_2]', adresa: null },
            adresat: { jmeno: '[OSOBA_1]', adresa: 'Lazebnická 14, byt č. 9, Jihlava', pohlavi: null }, misto: 'Jihlava',
            vec: 'Předžalobní výzva k úhradě náhrady škody', skutkovy_stav: 'Dne 12. 3. 2025 došlo z Vašeho bytu k vytopení bytu naší klientky. Škoda činí celkem 86 000 Kč.',
            pravni_duvod: 'Odpovídáte za škodu podle občanského zákoníku.', castka: '86 000 Kč', lhuta: null, platebni_udaje: null, nasledky: null, chybejici: []
        })];
        const r = await H(request(app).post('/api/agent/spisovatel')).send({
            prompt: 'Napiš předžalobní výzvu sousedovi klientky k úhradě škody. Údaje, které nemáš, nevymýšlej.', context: EMAIL
        });
        expect(r.status).toBe(200);
        expect(mockCalls[0].format).toBeTruthy();
        expect(JSON.stringify(mockCalls[0].messages)).not.toMatch(/Horák/);
        expect(r.body.response).toMatch(/Adresát:\nIng\. Tomáš Horák/);
        expect(r.body.response).toMatch(/^Vážený pane inženýre,$/m);
        expect(r.body.response).toMatch(/86 000 Kč/);
        expect(r.body.response).toMatch(/\[Doplnit/);
        expect(r.body.response).toMatch(/dn/);
        expect(r.body.outputGuard.selfCheck.structuredLetter).toBe(true);
        expect(mockCalls).toHaveLength(1); // nic k opravě → žádný druhý dotaz
    });

    test('chybí částka v JSON → jedna oprava modelem', async () => {
        const base = { typ: 'předžalobní výzva', odesilatel: { jmeno: '[OSOBA_2]' }, adresat: { jmeno: '[OSOBA_1]' }, vec: 'Výzva', skutkovy_stav: 'Vytopení bytu naší klientky dne 12. 3. 2025.', lhuta: null };
        mockReplies = [JSON.stringify({ ...base, castka: null }), JSON.stringify({ ...base, castka: '86 000 Kč' })];
        const r = await H(request(app).post('/api/agent/spisovatel')).send({ prompt: 'Napiš předžalobní výzvu sousedovi klientky k úhradě škody.', context: EMAIL });
        expect(mockCalls).toHaveLength(2);
        expect(JSON.stringify(mockCalls[1].messages)).toMatch(/chybí celková požadovaná částka/);
        expect(r.body.response).toMatch(/86 000 Kč/);
        expect(r.body.outputGuard.selfCheck).toMatchObject({ retried: true, remaining: [] });
    });

    test('model nevrátí JSON → volný text bez pokynu k JSON, oslovení opraví program', async () => {
        const free = 'Adresát: [OSOBA_1]\n\nVážená [OSOBA_1]!\n\nDne 12. 3. 2025 jste vytopil byt naší klientky. Vyzýváme Vás k úhradě 86 000 Kč do 15 dnů od doručení na účet [Doplnit – číslo účtu]. Jinak podáme žalobu.\n\nS pozdravem\n[Doplnit – podpis advokáta]';
        mockReplies = ['Tohle není JSON.', free];
        const r = await H(request(app).post('/api/agent/spisovatel')).send({ prompt: 'Napiš předžalobní výzvu sousedovi klientky k úhradě škody.', context: EMAIL });
        expect(r.status).toBe(200);
        expect(mockCalls).toHaveLength(2);
        expect(mockCalls[1].format).toBeUndefined();
        expect(JSON.stringify(mockCalls[1].messages)).not.toMatch(/Vrať POUZE JSON/);
        expect(r.body.response).toMatch(/^Vážený pane inženýre,$/m);
        expect(r.body.response).not.toMatch(/Vážená Ing/);
    });

    test('AGENT_STRUCTURED_LETTERS=0 vypne JSON režim', async () => {
        process.env.AGENT_STRUCTURED_LETTERS = '0';
        mockReplies = ['Vážený pane inženýre,\n\nvyzýváme Vás k úhradě 86 000 Kč do 15 dnů na účet [Doplnit – číslo účtu]. Jinak podáme žalobu u soudu, včetně nákladů řízení a úroků z prodlení.'];
        try {
            await H(request(app).post('/api/agent/spisovatel')).send({ prompt: 'Napiš předžalobní výzvu sousedovi klientky k úhradě škody.', context: EMAIL });
            expect(mockCalls[0].format).toBeUndefined();
        } finally { delete process.env.AGENT_STRUCTURED_LETTERS; }
    });
});
