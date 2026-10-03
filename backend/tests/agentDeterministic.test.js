/**
 * Deterministická podpora agentů (server test 2. 10. 2026, qwen2.5:7b):
 *  1) kontrola rizikových doložek ve smlouvě (lib/clause_scan.js),
 *  3) lhůty — promlčení náhrady škody a rozpor dat doručení (lib/date_facts.js),
 *  4) oprava názvu zákona u správného čísla (lib/output_guard.js fixLawNames),
 * a jejich zapojení do /api/agent (co model vynechá, doplní program pod odpověď).
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_agentdet_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-det';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

let mockReply = '';
const mockSeen = [];
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
jest.mock('../lib/kb_law_index', () => ({
    getKbLawIndex: () => ({ '89/2012': new Set(['1023', '629', '620', '2910', '2254']) }),
    indexFromTexts: () => ({}), _reset: () => {}
}));

const request = require('supertest');
const app = require('../server');
const clause = require('../lib/clause_scan');
const { buildDateFacts, dateFactsAppendix } = require('../lib/date_facts');
const { fixLawNames } = require('../lib/output_guard');
const { extractTextFromFile } = require('../lib/ocr');

const FX = path.join(__dirname, '..', 'eval', 'server_suite', 'fixtures');
const ids = (arr) => arr.map(f => f.id).sort();

describe('1) kontrola doložek', () => {
    test('smlouva o dílo (spotřebitel): záloha, cena +30 %, rozhodčí doložka, záruka 6 měsíců, pokuty 0,01 % vs 0,5 %', async () => {
        const t = (await extractTextFromFile(path.join(FX, 'smlouva_o_dilo_Novotna_Novak.docx'))).text;
        const f = clause.scanContract(t);
        expect(ids(f)).toEqual(expect.arrayContaining(['zaloha_100', 'jednostranna_cena', 'rozhodci', 'zaruka_kratka', 'pokuty_nerovnovaha', 'vzdani_vad']));
        expect(f.find(x => x.id === 'jednostranna_cena').detail).toMatch(/30 %/);
        expect(f.find(x => x.id === 'rozhodci').article).toBe('čl. VII');
        expect(f.find(x => x.id === 'pokuty_nerovnovaha').detail).toMatch(/0,01 %.*0,5 %/);
    });

    test('nájemní smlouva (PDF se zalomenými řádky): kauce 6×, zvířata, vstup bez ohlášení, výpověď', async () => {
        const t = (await extractTextFromFile(path.join(FX, 'najemni_smlouva_Kovar_Maly.pdf'))).text;
        expect(ids(clause.scanContract(t))).toEqual(expect.arrayContaining(['kauce', 'zvirata', 'vstup_bez_ohlaseni', 'vypoved_bez_duvodu']));
    });

    test('kupní smlouva na auto: vady, odstoupení, tachometr', () => {
        const t = fs.readFileSync(path.join(FX, 'kupni_smlouva_auto_INJEKCE.txt'), 'utf8');
        expect(ids(clause.scanContract(t))).toEqual(expect.arrayContaining(['vzdani_vad', 'bez_odstoupeni', 'tachometr']));
    });

    test('dlouhá IT smlouva: čl. 31 — zdravotní data, prodloužení o 10 let, pokuta 5 000 000 Kč', async () => {
        const t = (await extractTextFromFile(path.join(FX, 'ramcova_smlouva_IT_DLOUHA.docx'))).text;
        const f = clause.scanContract(t);
        expect(f.find(x => x.id === 'zdravotni_data').article).toBe('čl. 31.1');
        expect(f.find(x => x.id === 'automaticke_prodlouzeni').detail).toMatch(/10 let/);
        expect(f.find(x => x.id === 'vysoka_pokuta').detail).toMatch(/5 000 000/);
    });

    test('vyvážená smlouva: žádné falešné nálezy', () => {
        const fair = [
            'SMLOUVA O DÍLO', 'Čl. I Smluvní strany', 'Zhotovitel: Firma s.r.o.; Objednatel: Jana Nová (spotřebitel).',
            'Čl. II Cena', 'Cena díla je 100 000 Kč. Objednatel uhradí zálohu 30 % ceny po zahájení prací, zbytek po předání.',
            'Čl. III Smluvní pokuty', 'Za prodlení zhotovitele i objednatele činí smluvní pokuta 0,05 % denně z dlužné částky.',
            'Čl. IV Vady', 'Zhotovitel poskytuje záruku za jakost 24 měsíců od předání. Vady lze uplatnit písemně.',
            'Čl. V Spory', 'Spory rozhodují obecné soudy České republiky.'
        ].join('\n');
        expect(clause.scanContract(fair)).toEqual([]);
    });

    test('e-mail ani dopis nejsou smlouva → nic se nekontroluje', () => {
        expect(clause.scanContract(fs.readFileSync(path.join(FX, 'email_klientky_vytopeni.txt'), 'utf8'))).toEqual([]);
    });

    test('doplnění pod odpověď: jen co model nezmínil (vč. hodnoty a §)', () => {
        const f = [{ id: 'z', label: 'Záruka', law: '§ 2165 OZ', detail: '6 měsíců', keys: /z[aá]ruk/i }];
        expect(clause.missingAppendix('Záruka 6 měsíců odporuje § 2165 OZ.', f).missing).toEqual([]);
        expect(clause.missingAppendix('Záruka je krátká.', f).missing).toEqual(['z']);
    });
});

describe('3) lhůty', () => {
    const email = () => fs.readFileSync(path.join(FX, 'email_klientky_vytopeni.txt'), 'utf8');

    test('promlčení náhrady škody: 3 roky od 12. 3. 2025 → 13. 3. 2028 (12. 3. je neděle), 10 let → 12. 3. 2035', () => {
        const q = 'Do kdy může klientka vymáhat náhradu škody?';
        const df = buildDateFacts(q + '\n' + email(), { question: q });
        expect(df.limitation.event).toBe('2025-03-12');
        expect(df.limitation.subjectiveEnd).toBe('2028-03-13');
        expect(df.limitation.objectiveEnd).toBe('2035-03-12');
        expect(df.text).toMatch(/§ 629 odst\. 1/);
        expect(df.text).toMatch(/§ 620/);
    });

    test('datum z hlavičky e-mailu („Datum: 29. 9. 2026“) se za škodní událost nebere', () => {
        const q = 'vymáhat škodu?';
        expect(buildDateFacts(q + '\n' + email(), { question: q }).limitation.event).not.toBe('2026-09-29');
    });

    test('bez otázky na škodu/promlčení se promlčení nepočítá', () => {
        const q = 'Shrň e-mail.';
        const df = buildDateFacts(q + '\n' + email(), { question: q });
        expect(df && df.limitation).toBeFalsy();
    });

    test('rozpor dat doručení: doplní se jen, když ho model nezmíní', () => {
        const t = fs.readFileSync(path.join(FX, 'prijemka_rozpory_data.txt'), 'utf8');
        const df = buildDateFacts('Do kdy podat odpor?\n' + t, { question: 'Do kdy podat odpor?' });
        expect(df.conflictEnd).toBe('2026-10-19');
        expect(dateFactsAppendix('Odpor podejte do 19. 10. 2026.', df)).toMatch(/RŮZNÁ data doručení.*19\. 10\. 2026/s);
        expect(dateFactsAppendix('Pozor na rozpor v datech doručení; do 19. 10. 2026.', df)).toBe('');
    });
});

describe('4) název zákona', () => {
    const kb = { '89/2012': new Set(['1023', '2910']) };
    test('§ existuje v uvedeném zákoně → název se opraví v textu', () => {
        const r = fixLawNames('Podle § 1023 zákona č. 89/2012 Sb. (Zákon o obchodních korporacích) soused odpovídá.', kb);
        expect(r.text).toBe('Podle § 1023 zákona č. 89/2012 Sb. (občanský zákoník) soused odpovídá.');
        expect(r.fixed[0].stated).toBe('Zákon o obchodních korporacích');
    });
    test('§ v bázi není / báze chybí → text beze změny, jen upozornění', () => {
        const t = 'Podle § 9999 zákona č. 89/2012 Sb. (zákon o obchodním právu).';
        expect(fixLawNames(t, kb).text).toBe(t);
        expect(fixLawNames(t, kb).issues).toHaveLength(1);
        expect(fixLawNames('Podle § 1023 zákona č. 89/2012 Sb. (zákon o obchodním právu).', null).fixed).toHaveLength(0);
    });
    test('správný název se nemění', () => {
        const t = 'Podle § 2910 zákona č. 89/2012 Sb., občanský zákoník.';
        expect(fixLawNames(t, kb)).toMatchObject({ text: t, fixed: [], issues: [] });
    });
});

describe('zapojení do /api/agent', () => {
    const H = (r) => r.set('X-API-Token', 'tok-det');

    test('Kontrolor: model dostane kontrolní seznam (bez osobních údajů) a vynechané doložky se doplní', async () => {
        const t = (await extractTextFromFile(path.join(FX, 'smlouva_o_dilo_Novotna_Novak.docx'))).text;
        mockReply = 'Rizika: čl. VII obsahuje rozhodčí doložku, která je u spotřebitele neplatná (§ 3 odst. 6 zák. č. 216/1994 Sb.).';
        const r = await H(request(app).post('/api/agent/kontrolor')).send({ prompt: 'Zkontroluj smlouvu o dílo pro klienta (spotřebitel).', context: t });
        expect(r.status).toBe(200);
        const note = mockSeen[mockSeen.length - 1].find(m => /Automatická kontrola smlouvy/.test(m.content));
        expect(note).toBeTruthy();
        expect(note.content).not.toMatch(/Novotná|Lazebnická/);
        expect(r.body.response).toMatch(/Automatická kontrola smlouvy našla i tato ustanovení/);
        expect(r.body.response).toMatch(/30 %/);
        expect(r.body.response).toMatch(/6 měsíců/);
        expect(r.body.outputGuard.clausesAppended).not.toContain('rozhodci'); // model ji zmínil
    });

    test('Rešeršník: chybný název zákona opraven, promlčení doplněno', async () => {
        mockReply = 'Podle § 1023 zákona č. 89/2012 Sb. (Zákon o obchodních korporacích) soused odpovídá za škodu.';
        const r = await H(request(app).post('/api/agent/resersnik')).send({
            prompt: 'Klientka se ptá, jestli a do kdy může po sousedovi vymáhat náhradu škody z vytopení bytu.',
            context: fs.readFileSync(path.join(FX, 'email_klientky_vytopeni.txt'), 'utf8')
        });
        expect(r.status).toBe(200);
        expect(r.body.response).not.toMatch(/89\/2012 Sb\.?\s*\(\s*Zákon o obchodn/);
        expect(r.body.response).toMatch(/89\/2012 Sb\. \(občanský zákoník\)/);
        expect(r.body.response).toMatch(/13\. 3\. 2028/);
        expect(r.body.response).toMatch(/§ 629/);
        expect(r.body.response).toMatch(/10 let/);
    });
});
