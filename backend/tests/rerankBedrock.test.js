'use strict';
// Pilot přes Bedrock (1. 11. 2026): na Macu bez GPU přeřazuje výsledky Amazon Bedrock Rerank v EU.
// Do AWS jde jen dotaz a veřejné pasáže báze, nikdy úseky ze spisů, a jen když to pravidla cloudu dovolí.
const RS = require('../lib/rerank_service');

const bedrockEu = {
    region: () => 'eu-central-1',
    credentialsAsync: async () => ({ accessKeyId: 'AKIATEST', secretAccessKey: 'tajne' }),
    sign: require('../lib/bedrock').sign
};
const bedrockUs = Object.assign({}, bedrockEu, { region: () => { throw new Error('Bedrock: region „us-east-1" není v EU'); } });

function fakeFetch(calls, scoresByText) {
    return async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body, headers: init.headers });
        const results = body.sources.map((s, index) => ({ index, relevanceScore: scoresByText(s.inlineDocumentSource.textDocument.text) }));
        return { ok: true, json: async () => ({ results }) };
    };
}
const kb = (n, score) => ({ fileName: `OZ 89-2012 § ${n}.txt`, scope: '_kb_resersnik', score, text: `zákon ${n}` });
const spis = (n, score) => ({ fileName: `spis/${n}.pdf`, scope: null, score, text: `klient ${n} Novák` });
const allow = () => ({ ok: true });
beforeEach(() => { RS._resetBedrock(); delete process.env.BEDROCK_RERANK_RPM; });

test('požadavek: EU agent-runtime, /rerank, model v EU, podepsaný', async () => {
    const calls = [];
    const s = await RS.scoreViaBedrock('smluvní pokuta', ['a', 'b'], { bedrock: bedrockEu, fetchImpl: fakeFetch(calls, t => (t === 'b' ? 0.9 : 0.1)) });
    expect(s).toEqual([0.1, 0.9]);
    expect(calls[0].url).toBe('https://bedrock-agent-runtime.eu-central-1.amazonaws.com/rerank');
    expect(calls[0].body.rerankingConfiguration.bedrockRerankingConfiguration.modelConfiguration.modelArn)
        .toBe('arn:aws:bedrock:eu-central-1::foundation-model/cohere.rerank-v3-5:0');
    expect(calls[0].body.queries[0].textQuery.text).toBe('smluvní pokuta');
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/eu-central-1\/bedrock\/aws4_request/);
});

test('do AWS jdou jen pasáže báze; úsek ze spisu zůstane na svém místě', async () => {
    const calls = [];
    const top = [kb(1, 0.9), spis('a', 0.85), kb(2, 0.8), kb(3, 0.7)];
    const out = await RS.rerankResults('dotaz', top, { force: true, provider: 'bedrock', gate: allow, weight: 1, bedrock: bedrockEu,
        fetchImpl: fakeFetch(calls, t => ({ 'zákon 1': 0.1, 'zákon 2': 0.5, 'zákon 3': 0.9 })[t]) });
    const sent = calls[0].body.sources.map(s => s.inlineDocumentSource.textDocument.text);
    expect(sent).toEqual(['zákon 1', 'zákon 2', 'zákon 3']);
    expect(sent.join(' ')).not.toMatch(/Novák/);
    expect(out.map(r => r.fileName)).toEqual(['OZ 89-2012 § 3.txt', 'spis/a.pdf', 'OZ 89-2012 § 2.txt', 'OZ 89-2012 § 1.txt']);
});

test('pravidla cloudu dotaz nepustí → nic se neposílá, původní pořadí', async () => {
    const calls = [];
    const top = [kb(1, 0.9), kb(2, 0.8)];
    const out = await RS.rerankResults('dotaz', top, { force: true, provider: 'bedrock', gate: () => ({ ok: false, duvod: 'spis bez souhlasu' }), bedrock: bedrockEu, fetchImpl: fakeFetch(calls, () => 1) });
    expect(calls).toHaveLength(0);
    expect(out).toBe(top);
});

test('výchozí brána: mimo požadavek asistenta (bez kontextu) se do Bedrocku nejde', () => {
    expect(RS.bedrockGate().ok).toBe(false);
});

test('region mimo EU / chyba služby → původní pořadí (fail-open)', async () => {
    const calls = [];
    const top = [kb(1, 0.9), kb(2, 0.8)];
    expect(await RS.rerankResults('dotaz', top, { force: true, provider: 'bedrock', gate: allow, bedrock: bedrockUs, fetchImpl: fakeFetch(calls, () => 1) })).toBe(top);
    expect(calls).toHaveLength(0);
    const err = async () => ({ ok: false, status: 403, text: async () => 'AccessDeniedException' });
    expect(await RS.rerankResults('dotaz', top, { force: true, provider: 'bedrock', gate: allow, bedrock: bedrockEu, fetchImpl: err })).toBe(top);
});

test('výchozí brána v požadavku: veřejný dotaz při zapnutém Bedrocku projde, nezařazený ne', () => {
    const prev = { c: process.env.AI_CHAT_PROVIDER, l: process.env.LEXIS_PILOT_LOCAL_ONLY };
    process.env.AI_CHAT_PROVIDER = 'bedrock'; delete process.env.LEXIS_PILOT_LOCAL_ONLY;
    try {
        const rc = require('../lib/request_context'), cp = require('../lib/cloud_policy');
        rc.run({}, () => { cp.declare({ dataClass: 'verejne' }); expect(RS.bedrockGate().ok).toBe(true); });
        rc.run({}, () => { cp.declare({}); expect(RS.bedrockGate()).toMatchObject({ ok: false, duvod: expect.stringMatching(/nezarazeno/) }); });
        rc.run({}, () => { cp.declare({ dataClass: 'verejne' }); cp.noteUnknown('dokument mimo spis'); expect(RS.bedrockGate().ok).toBe(false); });
    } finally {
        if (prev.c === undefined) delete process.env.AI_CHAT_PROVIDER; else process.env.AI_CHAT_PROVIDER = prev.c;
        if (prev.l !== undefined) process.env.LEXIS_PILOT_LOCAL_ONLY = prev.l;
    }
});

describe('limit volání, opakování a cache (kvóta nového účtu 3/min, 1. 11. 2026)', () => {
    const base = { force: true, provider: 'bedrock', gate: allow, bedrock: bedrockEu, weight: 1 };
    test('přes limit: asistent nečeká, hledá bez přeřazení a nic neposílá', async () => {
        process.env.BEDROCK_RERANK_RPM = '1';
        const calls = [];
        const f = fakeFetch(calls, t => (t === 'zákon 2' ? 0.9 : 0.1));
        const a = await RS.rerankResults('dotaz A', [kb(1, 0.9), kb(2, 0.8)], Object.assign({ fetchImpl: f, maxWaitMs: 0 }, base));
        expect(a[0].fileName).toBe('OZ 89-2012 § 2.txt');
        const top = [kb(3, 0.9), kb(4, 0.8)];
        const l0 = RS.stats.bedrockLimit;
        const b = await RS.rerankResults('dotaz B', top, Object.assign({ fetchImpl: f, maxWaitMs: 0 }, base));
        expect(b).toBe(top);
        expect(calls).toHaveLength(1);
        expect(RS.stats.bedrockLimit).toBe(l0 + 1);
    });
    test('měření smí počkat na volný slot (simulovaný čas)', async () => {
        process.env.BEDROCK_RERANK_RPM = '1';
        let t = 1000000;
        const now = () => t, sleep = async ms => { t += ms; };
        const calls = [];
        const f = fakeFetch(calls, () => 0.5);
        await RS.bedrockScores('q1', [kb(1), kb(2)], { gate: allow, bedrock: bedrockEu, fetchImpl: f, now, sleep, maxWaitMs: 120000 });
        await RS.bedrockScores('q2', [kb(1), kb(2)], { gate: allow, bedrock: bedrockEu, fetchImpl: f, now, sleep, maxWaitMs: 120000 });
        expect(calls).toHaveLength(2);
        expect(t - 1000000).toBeGreaterThanOrEqual(60000); // druhé volání počkalo na další minutu
    });
    test('429 → opakování s prodlevou, pak skóre', async () => {
        let n = 0;
        const f = async (url, init) => {
            n++;
            if (n === 1) return { ok: false, status: 429, text: async () => '{"message":"Your request rate is too high."}' };
            return fakeFetch([], t => (t === 'zákon 2' ? 0.9 : 0.1))(url, init);
        };
        const out = await RS.rerankResults('dotaz C', [kb(1, 0.9), kb(2, 0.8)], Object.assign({ fetchImpl: f, sleep: async () => {} }, base));
        expect(n).toBe(2);
        expect(out[0].fileName).toBe('OZ 89-2012 § 2.txt');
    });
    test('stejný dotaz nad stejnými pasážemi → z cache, bez dalšího volání', async () => {
        const calls = [];
        const f = fakeFetch(calls, () => 0.5);
        await RS.bedrockScores('stejný', [kb(1), kb(2)], { gate: allow, bedrock: bedrockEu, fetchImpl: f });
        await RS.bedrockScores('stejný', [kb(1), kb(2)], { gate: allow, bedrock: bedrockEu, fetchImpl: f });
        expect(calls).toHaveLength(1);
    });
    test('úsek ze spisu do bedrockScores neprojde (pojistka)', async () => {
        await expect(RS.bedrockScores('q', [kb(1), spis('a')], { gate: allow })).rejects.toThrow(/jen pasáže báze/);
    });
});

describe('přeřazení zákonů a judikatury zvlášť přes Bedrock: jedno volání', () => {
    test('zákony i judikatura v jednom volání, úseky ze spisů se neposílají', async () => {
        const prev = { ...process.env };
        Object.assign(process.env, { RAG_RERANK: '1', RAG_RERANK_PROVIDER: 'bedrock', AI_CHAT_PROVIDER: 'bedrock', BEDROCK_REGION: 'eu-central-1',
            AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'x' });
        delete process.env.LEXIS_PILOT_LOCAL_ONLY;
        const calls = [];
        const realFetch = global.fetch;
        global.fetch = fakeFetch(calls, t => (/NS/.test(t) ? 0.95 : 0.2));
        try {
            const rag = require('../lib/rag'), rc = require('../lib/request_context'), cp = require('../lib/cloud_policy');
            const jud = n => ({ fileName: `NS_${n}_2020.txt`, scope: '_kb_resersnik', score: 0.6, text: `NS rozhodnutí ${n}` });
            const ranked = [spis('a', 0.9), kb(1, 0.8), kb(2, 0.7), jud(1, 0.6), jud(2, 0.5)];
            const out = await rc.run({}, () => { cp.declare({ dataClass: 'verejne' }); return rag._rerankSplitMix('dotaz', ranked, 5, 0.75); });
            expect(calls).toHaveLength(1);
            const sent = calls[0].body.sources.map(s => s.inlineDocumentSource.textDocument.text);
            expect(sent.sort()).toEqual(['NS rozhodnutí 1', 'NS rozhodnutí 2', 'zákon 1', 'zákon 2']);
            expect(out).toHaveLength(5);
            expect(out[0].fileName).toBe('spis/a.pdf');
        } finally {
            global.fetch = realFetch;
            for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
            Object.assign(process.env, prev);
        }
    });
});

describe('počítadla přeřazení pro Manažerský přehled', () => {
    test('null bez Bedrock Rerank; jinak dnešní přeřazení, cache a hledání přes limit', async () => {
        delete process.env.RAG_RERANK; delete process.env.RAG_RERANK_PROVIDER;
        expect(RS.prehledPrerazeni()).toBeNull();
        process.env.RAG_RERANK = '1'; process.env.RAG_RERANK_PROVIDER = 'bedrock'; process.env.BEDROCK_RERANK_RPM = '1';
        try {
            const f = fakeFetch([], () => 0.5);
            const o = { gate: allow, bedrock: bedrockEu, fetchImpl: f, maxWaitMs: 0 };
            await RS.bedrockScores('p1', [kb(1), kb(2)], o);           // přeřazeno
            await RS.bedrockScores('p1', [kb(1), kb(2)], o);           // z cache
            await RS.bedrockScores('p2', [kb(1), kb(2)], o);           // přes limit 1/min
            const p = RS.prehledPrerazeni();
            expect(p).toMatchObject({ model: 'cohere.rerank-v3-5:0', limitZaMinutu: 1, dnes: { prerazeno: 1, zCache: 1, limit: 1, chyba: 0 } });
        } finally { delete process.env.RAG_RERANK; delete process.env.RAG_RERANK_PROVIDER; }
    });
});
