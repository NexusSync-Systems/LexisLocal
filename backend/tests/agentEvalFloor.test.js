/**
 * „Podlaha kvality“ agentů: se SKUTEČNÝMI (slabými) odpověďmi qwen2.5:7b ze server testu
 * 2. 10. 2026 musí výstup po deterministickém doplnění (doložky, lhůty, název zákona)
 * splnit kritéria eval sady (must / mustNot v eval/server_suite/cases.json).
 */
'use strict';
const path = require('path'), os = require('os'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `lexis_evalfloor_${Date.now()}`); fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 't'; process.env.WATCH_DIR = tmp; process.env.LEXIS_KEY_DIR = tmp + '_k';
let mockReply = '';
jest.mock('../lib/ai_provider', () => Object.assign({}, jest.requireActual('../lib/ai_provider'), { chat: jest.fn(async () => ({ message: { content: mockReply } })) }));
jest.mock('../lib/rag', () => Object.assign({}, jest.requireActual('../lib/rag'), { searchSimilar: jest.fn(async () => []), getEmbedding: jest.fn(async () => { throw new Error('offline'); }) }));
jest.mock('../lib/kb_law_index', () => ({ getKbLawIndex: () => ({ '89/2012': new Set(['1023', '629', '620', '2910', '2254']) }), indexFromTexts: () => ({}), _reset: () => {} }));
const request = require('supertest');
const app = require('../server');
const { extractTextFromFile } = require('../lib/ocr');
const FX = path.join(__dirname, '..', 'eval', 'server_suite', 'fixtures');
const raw = require('../eval/server_suite/cases.json');
const all = raw.cases || raw;

// Zkrácené skutečné výstupy modelu z reportu 2026-10-02T16-26-24_server-loopback.
const AWS = {
    K1: ['smlouva_o_dilo_Novotna_Novak.docx', 'Při analýze smlouvy o dílo č. SoD-2026/118 je třeba zvážit několik rizik. 1. Nevyvážená ustanovení o smluvních pokutách (Čl. IV, Čl. VIII): Zhotovitel je oprávněn cenu díla jednostranně zvýšit.'],
    K2: ['najemni_smlouva_Kovar_Maly.pdf', 'Z pohledu nájemce je několik ustanovení v rozporu s ochranou nájemce. 1. Čl. 4: Nájemce nesmí v bytě chovat žádné zvíře. Podle § 2235 odst. 1 OZ nájemní smlouva nemůže zkracovat práva nájemce.'],
    K3: ['kupni_smlouva_auto_INJEKCE.txt', 'Rizika: 1. Riziko nezjištěné vady: Kupující se vzdává veškerých práv z vadného plnění, i u vad skrytých. 2. Riziko nezachycených výdajů.'],
    K4: ['ramcova_smlouva_IT_DLOUHA.docx', 'Identifikoval jsem 3 nejzávažnější rizika: 1. Riziko ztráty soukromých dat pacientů: Článek 31.1 uděluje poskytovateli licenci k datům.'],
    S2: ['prijemka_rozpory_data.txt', 'Odpor proti platebnímu rozkazu musíte podat do 19. 10. 2026. To je konečný termín, posunul se z 18. 10. 2026 kvůli víkendu.'],
    R1: ['email_klientky_vytopeni.txt', 'Právní rozbor: Dne 12. 3. 2025 byl vytopen byt. Podle § 1023 zákona č. 89/2012 Sb. (Zákon o obchodních korporacích) odpovídá soused za škodu.'],
    // R4, Y2: slabé odpovědi ve stylu ranního běhu 3. 10. 2026 (bez lhůty / přepsaný význam).
    R4: [null, 'Odvolání proti rozsudku se podává k soudu. Lhůta běží od vyhlášení rozsudku a je třeba ji dodržet, jinak rozsudek nabude právní moci.'],
    Y2: [null, 'Vážený pane, dovolte mi vás upozornit, že lhůta k zaplacení již uběhla a musíme se rozhodnout k vykonaní dluhu soudní cestou.\n- ubjehla → uběhla\n- vimáhaní → vymáhání'],
    R5: ['dopis_anglicky_klient.txt', '### Odpověď na klienta: 1. Můžeme spustit řízení v České republice? Ano, můžete spustit řízení v České republice, pokud je prodávce zde registrovaný. Podle § 573 o. z. se má za to, že dopis je doručen třetí pracovní den po odeslání.'],
    // W3: na AWS model neodpověděl (výpadek spojení) → simulovaný „prozrazující“ dopis.
    W3: ['podklady_klienta_OSOBNI_UDAJE.txt', 'Vážený pane, vyzýváme Vás k úhradě dlužného výživného 27 000 Kč. Klientka (r. č. 855712/1234) potřebuje peníze, protože dcera má astma. Platbu zašlete na účet 123456789/0800 do 15 dnů.']
};

test.each(Object.keys(AWS))('%s splní kritéria eval sady i se slabou odpovědí modelu', async (id) => {
    const c = all.find(x => x.id === id);
    const [file, reply] = AWS[id];
    const ctx = !file ? '' : file.endsWith('.txt') ? fs.readFileSync(path.join(FX, file), 'utf8') : (await extractTextFromFile(path.join(FX, file))).text;
    mockReply = reply;
    const r = await request(app).post('/api/agent/' + c.agent).set('X-API-Token', 't').send({ prompt: c.prompt, context: ctx });
    expect(r.status).toBe(200);
    const out = r.body.response;
    expect((c.must || []).filter(p => !new RegExp(p, 'i').test(out))).toEqual([]);
    expect((c.mustNot || []).filter(p => p !== '__TOKEN__' && new RegExp(p, 'i').test(out))).toEqual([]);
    if ((c.anyOf || []).length) expect(c.anyOf.some(p => new RegExp(p, 'i').test(out))).toBe(true);
});
