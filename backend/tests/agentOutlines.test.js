/**
 * Body 2 a 6 vylepšení agentů bez většího modelu:
 *  2) dlouhá smlouva po částech (lib/chunked_review.js),
 *  6) pevná osnova odpovědi + teplota podle typu úkolu, dvojjazyčná odpověď,
 *     dopis protistraně bez citlivých údajů (lib/agent_outlines.js),
 *  + promlčení peněžité pohledávky z anglického dopisu (lib/date_facts.js).
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_outlines_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-out';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

let mockReply = 'OK';
const mockCalls = [];
jest.mock('../lib/ai_provider', () => {
    const actual = jest.requireActual('../lib/ai_provider');
    return Object.assign({}, actual, {
        chat: jest.fn(async (args) => {
            mockCalls.push(args);
            const sys = args.messages.map(m => m.content).join('\n');
            if (/Procházíš DLOUHOU smlouvu/.test(sys)) {
                return { message: { content: /Článek 31/.test(args.messages[1].content) ? '- čl. 31.3: pokuta 5 000 000 Kč → nepřiměřená (§ 2051 OZ)' : 'Bez rizik.' } };
            }
            return { message: { content: mockReply } };
        })
    });
});
jest.mock('../lib/rag', () => Object.assign({}, jest.requireActual('../lib/rag'), {
    searchSimilar: jest.fn(async () => []),
    getEmbedding: jest.fn(async () => { throw new Error('offline'); })
}));

const request = require('supertest');
const app = require('../server');
const { taskProfile, redactForOpponent } = require('../lib/agent_outlines');
const { splitByArticles, reviewInChunks } = require('../lib/chunked_review');
const { buildDateFacts, debtLimitationFacts } = require('../lib/date_facts');
const { extractTextFromFile } = require('../lib/ocr');
const FX = path.join(__dirname, '..', 'eval', 'server_suite', 'fixtures');
const H = (r) => r.set('X-API-Token', 'tok-out');

describe('6) osnova a teplota podle typu úkolu', () => {
    test.each([
        ['kontrolor', 'Zkontroluj kupní smlouvu a vypiš rizika.', 'contract_review', 0.1],
        ['resersnik', 'Klientka se ptá, do kdy může vymáhat škodu.', 'legal_analysis', 0.1],
        ['stylista', 'Oprav gramatiku a stylistiku, zachovej význam: "…"', 'proofread', 0.1],
        ['spisovatel', 'Napiš stručný dopis protistraně (povinnému) s výzvou k zaplacení.', 'opponent_letter', null],
        ['sekretarka', 'Do kdy musíme podat odpor?', 'secretary', 0.1],
        ['stylista', 'Napiš klientce srozumitelnou odpověď pro laika.', 'general', null]
    ])('%s: „%s“ → %s', (agentId, prompt, kind, temp) => {
        const p = taskProfile({ agentId, prompt, context: '' });
        expect(p.kind).toBe(kind);
        expect(p.temperature).toBe(temp);
    });

    test('anglický podklad nebo požadavek → dvojjazyčná odpověď', () => {
        const letter = fs.readFileSync(path.join(FX, 'dopis_anglicky_klient.txt'), 'utf8');
        expect(taskProfile({ agentId: 'resersnik', prompt: 'Odpověz na otázky.', context: letter }).bilingual).toBe(true);
        expect(taskProfile({ agentId: 'resersnik', prompt: 'Odpověz česky, pak krátce anglicky.', context: '' }).bilingual).toBe(true);
        expect(taskProfile({ agentId: 'resersnik', prompt: 'Odpověz.', context: 'Dobrý den, posílám smlouvu k posouzení a prosím o radu.' }).bilingual).toBe(false);
    });

    test('dopis protistraně: RČ, účet klientky a diagnóza z podkladů se nahradí', () => {
        const src = fs.readFileSync(path.join(FX, 'podklady_klienta_OSOBNI_UDAJE.txt'), 'utf8');
        const r = redactForOpponent('Dlužíte 27 000 Kč. Dcera má astma. Plaťte na 123456789/0800. Klientka r. č. 855712/1234.', src);
        expect(r.text).not.toMatch(/855712|123456789|astma/);
        expect(r.text).toMatch(/27 000 Kč/);
        expect(r.removed).toEqual(expect.arrayContaining(['rodné číslo', 'číslo účtu klienta', 'zdravotní údaj']));
    });

    test('route: osnova jde modelu jako samostatná zpráva a teplota se sníží', async () => {
        mockReply = 'Opravený text: …';
        await H(request(app).post('/api/agent/stylista')).send({ prompt: 'Oprav gramatiku a stylistiku, zachovej význam: "jsme nucený"' }).expect(200);
        const call = mockCalls[mockCalls.length - 1];
        expect(call.messages.some(m => m.role === 'system' && /OSNOVA ODPOVĚDI/.test(m.content) && /jsme nuceni/.test(m.content))).toBe(true);
        expect(call.options.temperature).toBeLessThanOrEqual(0.1);
    });

    test('route: dopis protistraně — citlivé údaje odstraněny a advokát je upozorněn', async () => {
        mockReply = 'Výzva: dlužíte 27 000 Kč na výživném. Dcera má astma. Plaťte na účet 123456789/0800.';
        const r = await H(request(app).post('/api/agent/spisovatel')).send({
            prompt: 'Napiš stručný dopis protistraně (povinnému) s výzvou k zaplacení dlužného výživného.',
            context: fs.readFileSync(path.join(FX, 'podklady_klienta_OSOBNI_UDAJE.txt'), 'utf8')
        });
        expect(r.status).toBe(200);
        expect(r.body.response).not.toMatch(/855712|123456789|astma/);
        expect(r.body.response).toMatch(/27 000/);
        expect(r.body.response).toMatch(/Z dopisu protistraně odstraněno/);
    });
});

describe('lhůty: promlčení peněžité pohledávky', () => {
    test('anglický dopis: splatnost 15 July 2026 → 3 roky, 15. 7. 2029 je neděle → 16. 7. 2029', () => {
        const letter = fs.readFileSync(path.join(FX, 'dopis_anglicky_klient.txt'), 'utf8');
        const q = 'Odpověz na jeho tři otázky (česky, pak krátce anglicky pro klienta).';
        const df = buildDateFacts(q + '\n' + letter, { question: q });
        expect(df.limitation).toMatchObject({ kind: 'debt', event: '2026-07-15', subjectiveEnd: '2029-07-16' });
        expect(df.text).toMatch(/16 July 2029/);
        expect(df.text).toMatch(/§ 629/);
    });
    test('česká splatnost faktury', () => {
        expect(debtLimitationFacts('Faktura č. 12 splatná dne 31. 1. 2026 nebyla uhrazena.').subjectiveEnd).toBe('2029-01-31');
    });
    test('bez pohledávky nic', () => {
        expect(debtLimitationFacts('Smlouva o dílo, předání 30. 11. 2026.')).toBeNull();
    });
});

describe('2) dlouhá smlouva po částech', () => {
    test('dělení po článcích nepřekročí limit a nerozbije článek', () => {
        const text = Array.from({ length: 40 }, (_, i) => `Článek ${i + 1}\n\n${i + 1}.1 ` + 'Text ustanovení. '.repeat(30)).join('\n\n');
        const parts = splitByArticles(text, 4000);
        expect(parts.length).toBeGreaterThan(3);
        expect(parts.every(p => p.length <= 4000)).toBe(true);
        expect(parts.join('\n')).toContain('Článek 40');
        expect(parts.every(p => /^\s*Článek \d+/.test(p))).toBe(true);
    });

    test('reviewInChunks posbírá nálezy jen z částí, kde něco je', async () => {
        const text = (await extractTextFromFile(path.join(FX, 'ramcova_smlouva_IT_DLOUHA.docx'))).text;
        const llm = { chat: jest.fn(async ({ messages }) => ({ message: { content: /Článek 31/.test(messages[1].content) ? '- čl. 31.1: zdravotní data třetím osobám (GDPR čl. 9)' : 'Bez rizik.' } })) };
        const r = await reviewInChunks({ llm, model: 'm', text, prompt: 'Najdi rizika.', numCtx: 4096 });
        expect(r.chunks).toBeGreaterThanOrEqual(2);
        expect(llm.chat).toHaveBeenCalledTimes(r.chunks);
        expect(r.notes).toMatch(/čl\. 31\.1/);
        expect(r.notes).not.toMatch(/Bez rizik/);
    });

    test('route: dlouhá smlouva u Kontrolora → po částech, finální odpověď z dílčích nálezů', async () => {
        const text = (await extractTextFromFile(path.join(FX, 'ramcova_smlouva_IT_DLOUHA.docx'))).text;
        const prev = process.env.AGENT_NUM_CTX;
        process.env.AGENT_NUM_CTX = '4096';
        mockCalls.length = 0;
        mockReply = 'Nejzávažnější riziko: čl. 31.3 pokuta 5 000 000 Kč.';
        const r = await H(request(app).post('/api/agent/kontrolor')).send({ prompt: 'Projdi celou smlouvu a najdi 3 nejzávažnější rizika.', context: text });
        if (prev === undefined) delete process.env.AGENT_NUM_CTX; else process.env.AGENT_NUM_CTX = prev;
        expect(r.status).toBe(200);
        expect(r.body.outputGuard.chunkedReview.chunks).toBeGreaterThanOrEqual(2);
        expect(mockCalls.length).toBe(r.body.outputGuard.chunkedReview.chunks + 1);
        const final = mockCalls[mockCalls.length - 1].messages.map(m => m.content).join('\n');
        expect(final).toMatch(/prošel po \d+ částech/);
        expect(final).toMatch(/čl\. 31\.3: pokuta 5 000 000 Kč/);
        expect(final.length).toBeLessThan(text.length);
    });
});
