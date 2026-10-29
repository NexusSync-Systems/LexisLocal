/**
 * Bedrock z role instance EC2 (BEDROCK_CREDENTIALS=instance) — serverový test LexisLocalu s Claude v EU (29. 10. 2026).
 * IMDSv2 se nevolá doopravdy (podvržený fetch).
 */
const B = require('../lib/bedrock');

function fakeFetch(calls, exp) {
    return async (url, opts) => {
        calls.push({ url, method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {} });
        if (url.endsWith('/api/token')) return { text: async () => 'tok123' };
        if (url.endsWith('/security-credentials/')) return { text: async () => 'lexis-bench-ec2\n' };
        return { json: async () => ({ AccessKeyId: 'ASIATEST', SecretAccessKey: 'sek', Token: 'sess', Expiration: exp }) };
    };
}

describe('bedrock — role instance', () => {
    afterEach(() => { delete process.env.BEDROCK_CREDENTIALS; B._resetImds(); });

    test('IMDSv2: token, role, dočasné klíče; cache do vypršení', async () => {
        process.env.BEDROCK_CREDENTIALS = 'instance';
        const calls = [];
        const f = fakeFetch(calls, new Date(Date.now() + 3600e3).toISOString());
        const c = await B.credentialsAsync({ fetch: f });
        expect(c).toMatchObject({ accessKeyId: 'ASIATEST', secretAccessKey: 'sek', sessionToken: 'sess', role: 'lexis-bench-ec2' });
        expect(calls[0]).toMatchObject({ method: 'PUT' });
        expect(calls[1].headers['X-aws-ec2-metadata-token']).toBe('tok123');
        await B.credentialsAsync({ fetch: f });
        expect(calls.length).toBe(3); // podruhé z cache
    });

    test('klíče těsně před vypršením se obnoví', async () => {
        process.env.BEDROCK_CREDENTIALS = 'instance';
        const calls = [];
        await B.credentialsAsync({ fetch: fakeFetch(calls, new Date(Date.now() + 60e3).toISOString()) });
        await B.credentialsAsync({ fetch: fakeFetch(calls, new Date(Date.now() + 60e3).toISOString()) });
        expect(calls.length).toBe(6);
    });

    test('bez režimu instance se IMDS nevolá (soubor / proměnné prostředí)', async () => {
        process.env.AWS_ACCESS_KEY_ID = 'AKIATEST'; process.env.AWS_SECRET_ACCESS_KEY = 'x';
        const calls = [];
        const c = await B.credentialsAsync({ fetch: fakeFetch(calls, '') });
        expect(c.accessKeyId).toBe('AKIATEST');
        expect(calls.length).toBe(0);
        delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY;
    });
});
