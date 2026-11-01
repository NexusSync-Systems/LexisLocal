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
