'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const B = require('../lib/bedrock');

const ENV = ['BEDROCK_REGION', 'AWS_REGION', 'BEDROCK_MODEL_ID', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AI_CHAT_PROVIDER', 'LEXIS_PILOT_LOCAL_ONLY', 'AI_LOCAL_ONLY'];
const saved = {};
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } delete global.fetch; });

test('SigV4: oficiální testovací vektor AWS (get-vanilla)', () => {
    const s = B.sign({ method: 'GET', host: 'example.amazonaws.com', pathSegments: [], service: 'service', region: 'us-east-1',
        creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, date: new Date('2015-08-30T12:36:00Z') });
    expect(s.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('SigV4: dvojtečka v ID modelu — v požadavku %3A, v kanonické cestě %253A', () => {
    const s = B.sign({ method: 'POST', host: 'bedrock-runtime.eu-central-1.amazonaws.com', pathSegments: ['model', 'eu.anthropic.x-v1:0', 'converse'],
        service: 'bedrock', region: 'eu-central-1', body: '{}', creds: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T' } });
    expect(s.path).toBe('/model/eu.anthropic.x-v1%3A0/converse');
    expect(s.canonical.split('\n')[1]).toBe('/model/eu.anthropic.x-v1%253A0/converse');
    expect(s.headers['x-amz-security-token']).toBe('T');
    expect(s.headers.authorization).toMatch(/Credential=A\/\d{8}\/eu-central-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token|SignedHeaders=host;x-amz-date;x-amz-security-token/);
});

test('zámek na EU: region i profil modelu', () => {
    for (const r of ['', 'us-east-1', 'eu-central', 'ap-northeast-1']) { process.env.BEDROCK_REGION = r; expect(() => B.region()).toThrow(/není v EU/); }
    process.env.BEDROCK_REGION = 'eu-central-1'; expect(B.region()).toBe('eu-central-1');
    for (const m of ['us.anthropic.claude-x', 'global.anthropic.claude-x', 'apac.anthropic.claude-x', 'arn:aws:bedrock:us-east-1:1:inference-profile/x']) {
        process.env.BEDROCK_MODEL_ID = m; expect(() => B.modelId()).toThrow(/EU/);
    }
    for (const m of ['eu.anthropic.claude-x-v1:0', 'anthropic.claude-x-v1:0', 'arn:aws:bedrock:eu-west-1:123:inference-profile/eu.x']) {
        process.env.BEDROCK_MODEL_ID = m; expect(B.modelId()).toBe(m);
    }
    delete process.env.BEDROCK_MODEL_ID; expect(() => B.modelId()).toThrow(/chybí BEDROCK_MODEL_ID/);
});

test('přístup: z prostředí, nebo ze souboru ~/.aws/credentials (profil)', () => {
    const f = path.join(os.tmpdir(), `lexis_awscred_${Date.now()}`);
    fs.writeFileSync(f, '[default]\naws_access_key_id = AK1\naws_secret_access_key = SK1\n\n[lexis]\naws_access_key_id=AK2\naws_secret_access_key=SK2\naws_session_token=TK2\n');
    process.env.AWS_SHARED_CREDENTIALS_FILE = f;
    expect(B.credentials()).toEqual({ accessKeyId: 'AK1', secretAccessKey: 'SK1', sessionToken: null });
    process.env.AWS_PROFILE = 'lexis';
    expect(B.credentials()).toEqual({ accessKeyId: 'AK2', secretAccessKey: 'SK2', sessionToken: 'TK2' });
    process.env.AWS_ACCESS_KEY_ID = 'E'; process.env.AWS_SECRET_ACCESS_KEY = 'ES';
    expect(B.credentials().accessKeyId).toBe('E');
    process.env.AWS_PROFILE = 'neni'; delete process.env.AWS_ACCESS_KEY_ID;
    expect(() => B.credentials()).toThrow(/chybí přístup/);
    fs.unlinkSync(f);
});

test('Converse: system zvlášť, sloučení rolí, odpověď ve tvaru ollama; ai_provider přes AI_CHAT_PROVIDER=bedrock', async () => {
    expect(B.toConverse([{ role: 'system', content: 'S1' }, { role: 'system', content: 'S2' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }]))
        .toEqual({ system: [{ text: 'S1' }, { text: 'S2' }], messages: [{ role: 'user', content: [{ text: 'a' }, { text: 'b' }] }, { role: 'assistant', content: [{ text: 'c' }] }] });
    Object.assign(process.env, { AI_CHAT_PROVIDER: 'bedrock', BEDROCK_REGION: 'eu-central-1', BEDROCK_MODEL_ID: 'eu.anthropic.claude-x-v1:0', AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S' });
    let seen;
    global.fetch = jest.fn(async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ output: { message: { content: [{ text: 'Ahoj' }, { text: '!' }] } }, stopReason: 'end_turn', usage: { inputTokens: 3 } }) }; });
    const ai = require('../lib/ai_provider');
    const r = await ai.chat({ model: 'ignorovano', messages: [{ role: 'system', content: 'Jsi rešeršník.' }, { role: 'user', content: 'Dotaz' }], options: { temperature: 0.2 } });
    expect(r.message.content).toBe('Ahoj!');
    expect(seen.url).toBe('https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-x-v1%3A0/converse');
    const body = JSON.parse(seen.init.body);
    expect(body).toMatchObject({ system: [{ text: 'Jsi rešeršník.' }], inferenceConfig: { temperature: 0.2 } });
    expect(seen.init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
});

test('lokální režim zakáže Bedrock dřív, než cokoli odejde', async () => {
    Object.assign(process.env, { AI_CHAT_PROVIDER: 'bedrock', LEXIS_PILOT_LOCAL_ONLY: '1', BEDROCK_REGION: 'eu-central-1', BEDROCK_MODEL_ID: 'eu.x.y', AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S' });
    global.fetch = jest.fn();
    await expect(require('../lib/ai_provider').chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/LEXIS_PILOT_LOCAL_ONLY/);
    expect(global.fetch).not.toHaveBeenCalled();
});
