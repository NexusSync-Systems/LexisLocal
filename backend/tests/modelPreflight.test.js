/**
 * #6: preflight modelů — čisté jádro analyzePreflight() + isModelPresent() +
 * rolesFromEnv(). Bez sítě, deterministické.
 */
'use strict';
const { analyzePreflight, isModelPresent, rolesFromEnv } = require('../lib/model_preflight');

describe('#6 isModelPresent', () => {
    test('wanted s tagem → jen přesná shoda (3b ≠ 7b)', () => {
        expect(isModelPresent('qwen2.5:3b', ['qwen2.5:3b'])).toBe(true);
        expect(isModelPresent('qwen2.5:3b', ['qwen2.5:7b'])).toBe(false);
    });
    test('wanted bez tagu → shoda základu (llama3 == llama3:latest/8b)', () => {
        expect(isModelPresent('llama3', ['llama3:latest'])).toBe(true);
        expect(isModelPresent('llama3', ['llama3:8b'])).toBe(true);
        expect(isModelPresent('llama3', ['mistral:latest'])).toBe(false);
    });
    test('prázdný wanted = default knihovny → považuj za přítomný', () => {
        expect(isModelPresent('', ['cokoli'])).toBe(true);
    });
});

describe('#6 analyzePreflight', () => {
    const roles = [
        { key: 'CHAT_MODEL', type: 'chat', wanted: 'qwen2.5:3b' },
        { key: 'REVIEW_MODEL', type: 'chat', wanted: 'mistral' },
        { key: 'EMBEDDING_MODEL', type: 'embed', wanted: 'nomic-embed-text' }
    ];

    test('vše dostupné → ok:true, žádná varování', () => {
        const r = analyzePreflight(roles, ['qwen2.5:3b', 'mistral:latest', 'nomic-embed-text']);
        expect(r.ok).toBe(true);
        expect(r.warnings).toHaveLength(0);
        expect(r.missing).toHaveLength(0);
    });

    test('chybějící chat model → varování + návrh dostupné náhrady (bez embed modelu)', () => {
        const r = analyzePreflight(roles, ['qwen2.5:3b', 'nomic-embed-text']);
        expect(r.ok).toBe(false);
        expect(r.missing.map(m => m.key)).toContain('REVIEW_MODEL');
        expect(r.suggestions.chat).toContain('qwen2.5:3b');
        expect(r.suggestions.chat).not.toContain('nomic-embed-text'); // embed se jako chat náhrada nenabízí
        expect(r.warnings.join(' ')).toMatch(/mistral/);
    });

    test('prázdný seznam (Ollama neběží) → varování o žádných modelech', () => {
        const r = analyzePreflight(roles, []);
        expect(r.ok).toBe(false);
        expect(r.warnings[0]).toMatch(/žádné modely/i);
    });

    test('stejný model ve více rolích → jedno sloučené varování', () => {
        const same = [
            { key: 'CHAT_MODEL', type: 'chat', wanted: 'gemma:2b' },
            { key: 'DRAFT_MODEL', type: 'chat', wanted: 'gemma:2b' }
        ];
        const r = analyzePreflight(same, ['qwen2.5:3b']);
        const gemmaWarns = r.warnings.filter(w => w.includes('gemma:2b'));
        expect(gemmaWarns).toHaveLength(1);
        expect(gemmaWarns[0]).toMatch(/CHAT_MODEL, DRAFT_MODEL/);
    });
});

describe('#6 rolesFromEnv', () => {
    test('REVIEW padá na DRAFT, ten na CHAT; EMBEDDING má vlastní default', () => {
        const roles = rolesFromEnv({ CHAT_MODEL: 'a', DRAFT_MODEL: 'b' });
        const by = Object.fromEntries(roles.map(r => [r.key, r.wanted]));
        expect(by.CHAT_MODEL).toBe('a');
        expect(by.FAST_MODEL).toBe('a');
        expect(by.DRAFT_MODEL).toBe('b');
        expect(by.REVIEW_MODEL).toBe('b');
        expect(by.EMBEDDING_MODEL).toBe('nomic-embed-text');
    });
});
