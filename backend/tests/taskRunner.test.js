'use strict';
/**
 * task-runner.js — spouští jen schválené úlohy s ověřenými parametry.
 * Hlavní slib je negativní: z požadavku ve složce se nesmí stát libovolný příkaz.
 */
const R = require('../scripts/task-runner');

describe('task-runner — schválené úlohy', () => {
    test('neznámá úloha se odmítne', () => {
        expect(() => R.sestav({ uloha: 'rm' })).toThrow(/neznámá úloha/);
        expect(() => R.sestav({ uloha: '__proto__' })).toThrow(/neznámá úloha/);
        expect(() => R.sestav({})).toThrow(/neznámá úloha/);
    });

    test('kb_regression: čísla v rozsahu, výchozí hodnoty, int8 přepínač', () => {
        const c = R.sestav({ uloha: 'kb_regression', parametry: { limit: 40, sample: 5 } });
        expect(c.args).toEqual(['backend/scripts/kb_regression.js', '--limit', '40', '--sample', '5', '--pool-compare', '0']);
        expect(c.env.NODE_OPTIONS).toMatch(/max-old-space-size/);
        expect(R.sestav({ uloha: 'kb_regression', parametry: { int8: false } }).env.RAG_VEC_INT8).toBe('0');
        expect(() => R.sestav({ uloha: 'kb_regression', parametry: { limit: '40; rm -rf /' } })).toThrow(/číslo/);
        expect(() => R.sestav({ uloha: 'kb_regression', parametry: { limit: 1e9 } })).toThrow(/rozsah/);
    });

    test('seed_kb: jen schválené složky uvnitř projektu, agent z výčtu, token se nepředává', () => {
        const c = R.sestav({ uloha: 'seed_kb', parametry: { dir: './judikatura-us' } });
        expect(c.args).toContain('./judikatura-us');
        expect(c.args.join(' ')).toMatch(/--token-file .*api_token/);
        expect(R.sestav({ uloha: 'seed_kb', parametry: { dir: 'judikatura/Pracovní právo' } }).args).toContain('./judikatura/Pracovní právo');
        for (const zla of ['../etc', '/etc', 'judikatura/../../x', 'scratch', 'judikatura-us; ls', '~/.ssh', undefined]) {
            expect(() => R.sestav({ uloha: 'seed_kb', parametry: { dir: zla } })).toThrow();
        }
        expect(() => R.sestav({ uloha: 'seed_kb', parametry: { dir: 'judikatura-us', agent: 'root' } })).toThrow(/nepovolená hodnota/);
    });

    test('testy: vzor bez mezer a shellových znaků', () => {
        expect(R.sestav({ uloha: 'testy', parametry: { vzor: 'backend/tests/rag|backend/tests/obor' } }).args).toEqual(['jest', '--silent', 'backend/tests/rag|backend/tests/obor']);
        expect(() => R.sestav({ uloha: 'testy', parametry: { vzor: 'x && curl evil' } })).toThrow();
        expect(() => R.sestav({ uloha: 'testy', parametry: { vzor: '$(id)' } })).toThrow();
    });

    test('fetch_us_nalus: datum ve formátu DD.MM.RRRR', () => {
        expect(R.sestav({ uloha: 'fetch_us_nalus', parametry: { od: '01.10.2026' } }).args).toContain('01.10.2026');
        expect(() => R.sestav({ uloha: 'fetch_us_nalus', parametry: { od: '2026-10-01' } })).toThrow(/datum/);
    });

    test('příkazy jsou pevné (node / npx / git), nikdy z požadavku', () => {
        for (const u of Object.keys(R.ULOHY)) {
            const c = R.sestav({ uloha: u, parametry: u === 'seed_kb' ? { dir: 'judikatura-ns' } : {}, cmd: 'sh', args: ['-c', 'x'] });
            expect([process.execPath, 'npx', 'git']).toContain(c.cmd);
        }
    });
});
