/**
 * scripts/backup.js — záloha, zkouška obnovy a obnova do prázdných složek.
 * Běží jako samostatné procesy (stejně jako u zákazníka), jen syntetická data.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backup.js');
const mk = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const root = { data: mk('lexis_bk_data_'), key: mk('lexis_bk_key_'), ingest: mk('lexis_bk_spisy_'), out: mk('lexis_bk_out_') };
const env = { ...process.env, LEXIS_DATA_DIR: root.data, LEXIS_KEY_DIR: root.key, INGEST_DIR: root.ingest, NODE_ENV: 'production' };
delete env.WATCH_DIR; delete env.JEST_WORKER_ID;
const run = (args, e = env) => spawnSync(process.execPath, [SCRIPT, ...args], { env: e, encoding: 'utf8', timeout: 60000 });

beforeAll(() => {
    // Naplnit databázi přes skutečné moduly (spis + záznam auditu) v samostatném procesu.
    const seed = `const db=require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'database'))});
        db.insert('spisy',{nazev:'Záloha test',spisZn:'12 C 45/2026'});
        require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'audit'))}).logEvent('Test','Záloha','x',{});`;
    const r = spawnSync(process.execPath, ['-e', seed], { env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    fs.writeFileSync(path.join(root.ingest, 'rozsudek.txt'), 'Sp. zn. 12 C 45/2026');
}, 60000);

let archive;
test('záloha se vytvoří a hned ověří', () => {
    const r = run(['--out', root.out]);
    expect(r.stdout).toMatch(/✅ Ověřeno: databáze jde otevřít \(spisů 1/);
    expect(r.status).toBe(0);
    archive = fs.readdirSync(root.out).map(f => path.join(root.out, f)).find(f => f.endsWith('.tar.gz'));
    expect(archive).toBeTruthy();
    expect(fs.existsSync(archive + '.sha256')).toBe(true);
});

test('zkouška obnovy nic nepřepíše a projde', () => {
    const r = run(['--overit', archive]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Zkouška obnovy prošla: spisů 1/);
});

test('obnova do prázdných složek; do neprázdných jen s --prepsat', () => {
    const t = { data: mk('lexis_bk_rd_'), key: mk('lexis_bk_rk_'), ingest: mk('lexis_bk_rs_') };
    const r = run(['--obnovit', archive, '--data-dir', t.data, '--key-dir', t.key, '--spisovna', t.ingest]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(t.key, 'lexis.key'))).toBe(true);
    expect(fs.readFileSync(path.join(t.ingest, 'rozsudek.txt'), 'utf8')).toMatch(/12 C 45/);
    const again = run(['--obnovit', archive, '--data-dir', t.data, '--key-dir', t.key, '--spisovna', t.ingest]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/nejsou prázdné/);
});

test('zkouška obnovy ověří i hlavní auditní log: změněný záznam → selže', () => {
    const tmp = mk('lexis_bk_tamper_');
    spawnSync('tar', ['-xzf', archive, '-C', tmp]);
    const sc = require('../lib/secure_crypto');
    const key = Buffer.from(fs.readFileSync(path.join(tmp, 'klic', 'lexis.key'), 'utf8').trim(), 'hex');
    const af = path.join(tmp, 'data', '.audit_log.json');
    const logs = JSON.parse(sc.decrypt(key, JSON.parse(fs.readFileSync(af, 'utf8'))));
    expect(logs.length).toBeGreaterThan(0);
    const ok = run(['--overit', archive]);
    expect(ok.stdout).toMatch(new RegExp(`záznamů auditu ${logs.length}, záznamů AI \\d+ — oba řetězce v pořádku`));
    logs[0].target = 'dodatečně změněno';
    fs.writeFileSync(af, JSON.stringify(sc.encrypt(key, JSON.stringify(logs))));
    const bad = path.join(root.out, 'zmeneny-audit.tar.gz');
    spawnSync('tar', ['-czf', bad, '.'], { cwd: tmp });
    const r = run(['--overit', bad]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/Hlavní auditní log v záloze je porušený/);
});

test('poškozený archiv → zkouška obnovy selže', () => {
    const bad = path.join(root.out, 'poskozena.tar.gz');
    fs.writeFileSync(bad, 'nic');
    expect(run(['--overit', bad]).status).toBe(1);
});

test('sha256File: počítá po kusech a shoduje se s hashem celého obsahu (soubor přes velikost kusu)', () => {
    const fs2 = require('fs'), os2 = require('os'), path2 = require('path'), crypto2 = require('crypto');
    const { sha256File } = require('../scripts/backup');
    const f = path2.join(os2.tmpdir(), `lexis_sha_${Date.now()}.bin`);
    const data = crypto2.randomBytes(9 * 1024 * 1024 + 123); // > 8 MB kus → dva kusy, druhý neúplný
    fs2.writeFileSync(f, data);
    try { expect(sha256File(f)).toBe(crypto2.createHash('sha256').update(data).digest('hex')); }
    finally { fs2.unlinkSync(f); }
});
