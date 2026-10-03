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

test('poškozený archiv → zkouška obnovy selže', () => {
    const bad = path.join(root.out, 'poskozena.tar.gz');
    fs.writeFileSync(bad, 'nic');
    expect(run(['--overit', bad]).status).toBe(1);
});
