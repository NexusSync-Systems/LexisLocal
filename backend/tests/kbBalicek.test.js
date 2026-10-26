/**
 * kb-balicek.js — instalační balíček báze: vytvoření, instalace z cache bez volání modelu,
 * idempotence, kontrola poškozené cache. Jen syntetické texty.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_balicek_'));
process.env.WATCH_DIR = path.join(tmp, 'data');
process.env.LEXIS_KEY_DIR = path.join(tmp, 'key');
process.env.EMBEDDING_MODEL = 'bge-m3';
delete process.env.EMBED_CACHE_FILE;

let mockCalls = 0, mockFail = false;
jest.mock('../lib/ai_provider', () => Object.assign({}, jest.requireActual('../lib/ai_provider'), {
    embeddings: jest.fn(async ({ prompt }) => {
        mockCalls++;
        if (mockFail) throw new Error('Ollama neběží');
        return { embedding: [prompt.length % 11, 0.5, -0.25, 1 / 3] };
    })
}));

const B = require('../scripts/kb-balicek');
const rag = require('../lib/rag');
const ec = require('../lib/embed_cache');

// Zdroje: 2 zákony (podsložky) + judikatura NS a ÚS
const src = path.join(tmp, 'src');
const w = (rel, text) => { const p = path.join(src, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
w('zakony/OZ/OZ 89-2012 § 2051.txt', 'Zákon č. 89/2012 Sb. / § 2051 / Dlužník může navrhnout snížení nepřiměřeně vysoké smluvní pokuty.');
w('zakony/OSŘ/OSŘ 99-1963 § 0204.txt', 'Zákon č. 99/1963 Sb. / § 204 / Odvolání se podává do 15 dnů od doručení písemného vyhotovení.');
w('judikatura-ns/Stanoviska/NS_1_31_Cdo_2273_2022.txt', 'Sp. zn.: 31 Cdo 2273/2022\nPrávní věta: Přiměřenost smluvní pokuty se posuzuje u konkrétního nároku.');
w('judikatura-us/US_II._ÚS_3335_11_1.txt', 'Sp. zn.: II. ÚS 3335/11\nPopulární název: Odměna exekutora v případě dobrovolného plnění povinným');
fs.writeFileSync(path.join(src, 'zakony', '.DS_Store'), 'x');

// Cache vektorů: spočítá se jednou (jako na serveru) a zabalí do .jsonl.gz
async function buildCache() {
    const f = path.join(tmp, 'cache.jsonl');
    process.env.EMBED_CACHE_FILE = f;
    ec._reset();
    for (const p of B.listTxt(src)) {
        const text = fs.readFileSync(p, 'utf8');
        await rag.indexKnowledge('_kb_cachebuild', path.basename(p), text);
    }
    delete process.env.EMBED_CACHE_FILE;
    ec._reset();
    fs.writeFileSync(f + '.gz', zlib.gzipSync(fs.readFileSync(f)));
    return f + '.gz';
}

const opts = extra => Object.assign({ port: 1, log: () => {} }, extra);
let pkg;

beforeAll(async () => {
    const cache = await buildCache();
    pkg = B.vytvor({ out: path.join(tmp, 'baze.tar.gz'), cache, zakony: path.join(src, 'zakony'),
        judikatura: [path.join(src, 'judikatura-ns'), path.join(src, 'judikatura-us'), path.join(src, 'neexistuje')] });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('vytvoření: manifest s počty, modelem a cache (bez skrytých souborů)', () => {
    const m = B.info(pkg.out);
    expect(m).toMatchObject({ format: 1, typ: 'znalostni-baze', embeddingModel: 'bge-m3', souboru: 4 });
    expect(m.slozky).toEqual({ zakony: 2, 'judikatura-ns': 1, 'judikatura-us': 1 });
    expect(m.cache.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test('instalace z cache: všechny dokumenty, vektory bez volání modelu; podruhé vše přeskočí', async () => {
    mockCalls = 0; mockFail = true; // model „neběží" — vše musí jít z cache
    const r = await B.instaluj(opts({ file: pkg.out, agent: 'testbaze' }));
    expect(r).toMatchObject({ scope: '_kb_testbaze', souboru: 4, nahrano: 4, preskoceno: 0, chyb: 0, bezVektoru: 0 });
    expect(r.cache.spocitano).toBe(0);
    expect(mockCalls).toBe(0);
    rag._resetPartitionCache();
    const docs = rag.listKnowledge('_kb_testbaze');
    expect(docs.map(d => d.fileName).sort()).toEqual(['NS_1_31_Cdo_2273_2022.txt', 'OSŘ 99-1963 § 0204.txt', 'OZ 89-2012 § 2051.txt', 'US_II._ÚS_3335_11_1.txt']);
    expect(docs.every(d => d.embedded === d.chunks)).toBe(true);
    expect(process.env.EMBED_CACHE_FILE).toBeUndefined(); // dočasná cache uklizená

    const r2 = await B.instaluj(opts({ file: pkg.out, agent: 'testbaze' }));
    expect(r2).toMatchObject({ nahrano: 0, preskoceno: 4, chyb: 0 });
});

test('běžící server (obsazený port) → instalace odmítnuta', async () => {
    const srv = require('net').createServer().listen(0, '127.0.0.1');
    await new Promise(r => srv.once('listening', r));
    try {
        await expect(B.instaluj(opts({ file: pkg.out, port: srv.address().port }))).rejects.toThrow(/běží server/);
    } finally { srv.close(); }
});

test('poškozená cache → instalace odmítnuta, báze beze změny', async () => {
    const bad = path.join(tmp, 'bad');
    fs.mkdirSync(bad);
    require('child_process').spawnSync('tar', ['-xzf', pkg.out, '-C', bad]);
    const m = JSON.parse(fs.readFileSync(path.join(bad, 'manifest.json'), 'utf8'));
    m.cache.sha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify(m));
    const badPkg = path.join(tmp, 'bad.tar.gz');
    require('child_process').spawnSync('tar', ['-czf', badPkg, '-C', bad, '.']);
    await expect(B.instaluj(opts({ file: badPkg, agent: 'poskozena' }))).rejects.toThrow(/poškozená/);
    expect(rag.listKnowledge('_kb_poskozena')).toHaveLength(0);
});
