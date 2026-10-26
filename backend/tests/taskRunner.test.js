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
        const e = R.sestav({ uloha: 'kb_regression', parametry: { agentK: 4, lawShare: 0.75 } }).env;
        expect(e).toMatchObject({ RAG_AGENT_K: '4', RAG_KB_LAW_SHARE: '0.75' });
        expect(() => R.sestav({ uloha: 'kb_regression', parametry: { lawShare: 2 } })).toThrow(/podíl/);
        expect(() => R.sestav({ uloha: 'kb_regression', parametry: { agentK: '3; x' } })).toThrow();
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
            const c = R.sestav({ uloha: u, parametry: u === 'seed_kb' ? { dir: 'judikatura-ns' } : u === 'aws_vysledky' ? { beh: '2026-10-24_1623_remote_judikatura' } : u === 'kb_balicek_test' ? { soubor: 'lexis-baze-2026-10-26.tar.gz' } : {}, cmd: 'sh', args: ['-c', 'x'] });
            expect([process.execPath, 'npx', 'git', 'aws']).toContain(c.cmd);
        }
    });

    test('aws_vysledky: jen platný název běhu, pevný bucket, bez _connect.txt; AWS jen čte', () => {
        const c = R.sestav({ uloha: 'aws_vysledky', parametry: { beh: '2026-10-24_1623_remote_judikatura' } });
        expect(c.cmd).toBe('aws');
        expect(c.args.slice(0, 4)).toEqual(['s3', 'sync', 's3://lexislocal-bench-results-485237569555/2026-10-24_1623_remote_judikatura/', 'scratch/aws-vysledky/2026-10-24_1623_remote_judikatura/']);
        expect(c.args).toContain('_connect.txt');
        for (const zly of ['../x', '_kb', '2026-10-24_1623_remote/../../', '2026-10-24_1623_x y', '', undefined, 's3://jiny']) {
            expect(() => R.sestav({ uloha: 'aws_vysledky', parametry: { beh: zly } })).toThrow(/běhu/);
        }
        for (const u of ['aws_stav', 'aws_behy', 'aws_vysledky']) {
            const a = R.sestav({ uloha: u, parametry: { beh: '2026-10-24_1623_remote' } }).args;
            expect(['ec2 describe-instances', 's3 ls', 's3 sync']).toContain(a.slice(0, 2).join(' '));
        }
    });

    test('aws_spust_test: pevný typ, disk, role, SG a user data; AMI jen ve tvaru ami-…', () => {
        const a = R.sestav({ uloha: 'aws_spust_test' }).args;
        const val = k => a[a.indexOf(k) + 1];
        expect(a.slice(0, 2)).toEqual(['ec2', 'run-instances']);
        expect(val('--instance-type')).toBe('g6.xlarge');
        expect(val('--iam-instance-profile')).toBe('Name=lexis-bench-ec2');
        expect(val('--security-group-ids')).toBe('sg-08da0035b6d9a171c');
        expect(val('--instance-initiated-shutdown-behavior')).toBe('terminate');
        expect(val('--user-data')).toBe('file://scripts/aws/bootstrap-judikatura.sh');
        expect(JSON.parse(val('--block-device-mappings'))[0].Ebs.VolumeSize).toBe(200);
        expect(R.sestav({ uloha: 'aws_spust_test', parametry: { ami: 'ami-0123456789abcdef0' } }).args).toContain('ami-0123456789abcdef0');
        for (const zle of ['ami-x; rm', 'i-123', '--dry-run', 'ami-0123 --count 5']) {
            expect(() => R.sestav({ uloha: 'aws_spust_test', parametry: { ami: zle } })).toThrow(/AMI/);
        }
        expect(R.sestav({ uloha: 'aws_spust_test', parametry: { az: 'b' } }).args).toEqual(expect.arrayContaining(['--placement', 'AvailabilityZone=eu-central-1b']));
        expect(() => R.sestav({ uloha: 'aws_spust_test', parametry: { az: 'us-east-1a' } })).toThrow(/nepovolená hodnota/);
        // profil: jen připravené user data (simulace dne v kanceláři), nic jiného
        const k = R.sestav({ uloha: 'aws_spust_test', parametry: { profil: 'kancelar' } }).args;
        expect(k[k.indexOf('--user-data') + 1]).toBe('file://scripts/aws/bootstrap-kancelar.sh');
        expect(k.join(' ')).toContain('Value=lexis-test-1.2.0-kancelar');
        for (const zly of ['../x', 'judikatura; rm', 'plny']) expect(() => R.sestav({ uloha: 'aws_spust_test', parametry: { profil: zly } })).toThrow(/nepovolená hodnota/);
        expect(require('fs').existsSync(require('path').join(__dirname, '..', '..', 'scripts', 'aws', 'bootstrap-kancelar.sh'))).toBe(true);
        // typ jen ze seznamu jednoho-GPU typů, počet z požadavku nejde změnit
        expect(() => R.sestav({ uloha: 'aws_spust_test', parametry: { typ: 'p5.48xlarge' } })).toThrow(/nepovolená hodnota/);
        const g5 = R.sestav({ uloha: 'aws_spust_test', parametry: { typ: 'g5.xlarge', profil: 'kancelar' } }).args;
        expect(g5[g5.indexOf('--instance-type') + 1]).toBe('g5.xlarge');
        const b = R.sestav({ uloha: 'aws_spust_test', parametry: { count: 10 } }).args;
        expect(b[b.indexOf('--instance-type') + 1]).toBe('g6.xlarge');
        expect(b[b.indexOf('--count') + 1]).toBe('1');
    });

    test('kb_balicek_test: jen balíček ze scratch/kb-balicek, instalace do dočasné datové složky', () => {
        const c = R.sestav({ uloha: 'kb_balicek_test', parametry: { soubor: 'lexis-baze-2026-10-26.tar.gz' } });
        expect(c.args).toContain('scratch/kb-balicek/lexis-baze-2026-10-26.tar.gz');
        expect(c.env.WATCH_DIR).toMatch(/lexis-kb-balicek-test/);
        expect(c.env.LEXIS_KEY_DIR).toMatch(/lexis-kb-balicek-test/);
        for (const zly of ['../x.tar.gz', 'lexis-baze-2026-10-26.tar.gz; rm', '/etc/passwd', '']) {
            expect(() => R.sestav({ uloha: 'kb_balicek_test', parametry: { soubor: zly } })).toThrow(/balíček/);
        }
    });
});
