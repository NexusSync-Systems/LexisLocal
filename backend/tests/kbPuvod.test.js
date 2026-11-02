'use strict';
// Bezpečnostní revize 2. 11. 2026: dokument nahraný do báze agenta nesmí do cloudu jako „veřejná“ pasáž.
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/kb_puvod');

describe('kb_puvod: co z báze je veřejné', () => {
    test('nové pasáže: rozhoduje puvod, ne název souboru', () => {
        expect(P.jeVerejna({ scope: '_kb_resersnik', puvod: 'verejne', fileName: 'cokoli.txt' })).toBe(true);
        expect(P.jeVerejna({ scope: '_kb_resersnik', puvod: 'kancelar', fileName: 'OZ 89-2012 § 0082.txt' })).toBe(false);
    });
    test('starší pasáže bez puvod: veřejné jen zákony a judikatura z balíčku', () => {
        expect(P.jeVerejna({ scope: '_kb_resersnik', fileName: 'OZ 89-2012 § 0082.txt' })).toBe(true);
        expect(P.jeVerejna({ scope: '_kb_resersnik', fileName: 'OSŘ 99-1963 § 0099.txt' })).toBe(true);
        expect(P.jeVerejna({ scope: '_kb_resersnik', fileName: 'NS_7846_29_NSCR_103_2015.txt' })).toBe(true);
        expect(P.jeVerejna({ scope: '_kb_resersnik', fileName: 'US_II._ÚS_3388_11_1.txt' })).toBe(true);
        expect(P.jeVerejna({ scope: '_kb_resersnik', fileName: 'SIMULACE_interni_postup.txt' })).toBe(false);
        expect(P.jeVerejna({ scope: '_kb_resersnik', fileName: 'smlouva Novák.pdf' })).toBe(false);
        expect(P.jeVerejna({ scope: null, fileName: 'OZ 89-2012 § 0082.txt' })).toBe(false); // klientský spis
    });
    test('volba při nahrání: veřejné jen výslovně true', () => {
        expect(P.puvodZVolby(true)).toBe('verejne');
        expect(P.puvodZVolby('true')).toBe('kancelar');
        expect(P.puvodZVolby(undefined)).toBe('kancelar');
    });
});

describe('pravidla cloudu a nahrávání do báze', () => {
    test('dokument kanceláře z báze v obecném dotazu → cloud odepřen (neznámý původ), zákon projde', async () => {
        const prev = process.env.AI_CHAT_PROVIDER; process.env.AI_CHAT_PROVIDER = 'bedrock';
        try {
            const cp = require('../lib/cloud_policy');
            await cp.scope({ dataClass: 'verejne' }, async () => {
                cp.noteRagMatches([{ fileName: 'OZ 89-2012 § 2048.txt', scope: '_kb_resersnik', puvod: 'verejne' }]);
                expect(cp.rozhodni('bedrock').allowed).toBe(true);
                cp.noteRagMatches([{ fileName: 'Postup kanceláře.docx', scope: '_kb_resersnik', puvod: 'kancelar' }]);
                expect(cp.rozhodni('bedrock')).toMatchObject({ allowed: false, code: 'neznamy_puvod' });
            });
        } finally { if (prev === undefined) delete process.env.AI_CHAT_PROVIDER; else process.env.AI_CHAT_PROVIDER = prev; }
    });

    test('nahrávat do bází agentů a oborů smí jen správce', () => {
        const { requiredScope } = require('../lib/authz');
        expect(requiredScope('POST', '/api/agent-knowledge/resersnik')).toBe('admin');
        expect(requiredScope('POST', '/api/agent-knowledge/resersnik/upload')).toBe('admin');
        expect(requiredScope('DELETE', '/api/agent-knowledge/resersnik/x.txt')).toBe('admin');
        expect(requiredScope('POST', '/api/knowledge/najem')).toBe('admin');
        expect(requiredScope('GET', '/api/agent-knowledge/resersnik')).toBe('read');
    });

    test('indexKnowledge ukládá puvod (výchozí kancelar) a vyhledávání ho vrací', async () => {
        jest.resetModules();
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbpuvod-'));
        const prevW = process.env.WATCH_DIR; process.env.WATCH_DIR = tmp;
        jest.doMock('ollama', () => ({ embeddings: jest.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }), chat: jest.fn() }));
        try {
            const rag = require('../lib/rag');
            await rag.indexKnowledge('_kb_puvodtest', 'interni.txt', 'Interní postup kanceláře pro lhůty.');
            await rag.indexKnowledge('_kb_puvodtest', 'OZ 89-2012 § 0609.txt', 'Promlčecí lhůta trvá tři roky.', { puvod: 'verejne' });
            const part = rag.loadPartition('_kb_puvodtest');
            const by = Object.fromEntries(part.chunks.map(c => [c.fileName, c.puvod]));
            expect(by).toEqual({ 'interni.txt': 'kancelar', 'OZ 89-2012 § 0609.txt': 'verejne' });
            const res = await rag.searchSimilar('lhůta', 5, { scopes: ['_kb_puvodtest'], clientAccess: false }, { dedupeKb: true });
            expect(res.map(r => r.puvod).sort()).toEqual(['kancelar', 'verejne']);
        } finally {
            jest.dontMock('ollama');
            if (prevW === undefined) delete process.env.WATCH_DIR; else process.env.WATCH_DIR = prevW;
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
