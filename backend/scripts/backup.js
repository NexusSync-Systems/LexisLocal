#!/usr/bin/env node
/**
 * backup.js — záloha a obnova LexisLocalu bez vývojáře.
 *
 *   node backend/scripts/backup.js                       záloha do ./zalohy (+ ověření)
 *   node backend/scripts/backup.js --out /Volumes/Zaloha  záloha jinam
 *   node backend/scripts/backup.js --bez-spisovny         jen databáze, klíč a nastavení
 *   node backend/scripts/backup.js --overit <soubor>      zkouška obnovy (nic nepřepíše)
 *   node backend/scripts/backup.js --obnovit <soubor>     obnova (server musí být vypnutý)
 *        [--data-dir D] [--key-dir K] [--spisovna S] [--prepsat]
 *
 * Archiv .tar.gz obsahuje data/ (šifrovaná databáze, index, audit), klic/lexis.key,
 * spisovna/ (dokumenty) a manifest.json. Databáze bez klíče nejde otevřít, proto je klíč
 * v záloze — ZÁLOHU UCHOVÁVEJTE JEN NA ŠIFROVANÉM DISKU a mimo kancelář (požár, krádež).
 * Každá záloha se hned po vytvoření ověří: rozbalí se do dočasné složky, databáze se
 * dešifruje klíčem ze zálohy a zkontroluje se auditní řetězec.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
const has = name => process.argv.includes(name);

function dirs() {
    const config = require('../lib/config');
    const sc = require('../lib/secure_crypto');
    return { data: config.DATA_DIR, key: sc.resolveKeyDir(), ingest: config.getIngestDir() };
}

function tar(args, cwd) {
    const r = spawnSync('tar', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(`tar selhal: ${String(r.stderr || '').trim() || r.status}`);
}

function copyDir(src, dst, { skip } = {}) {
    if (!fs.existsSync(src)) return 0;
    let n = 0;
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        if (skip && skip(e.name)) continue;
        const s = path.join(src, e.name), d = path.join(dst, e.name);
        if (e.isDirectory()) n += copyDir(s, d, { skip });
        else if (e.isFile()) { fs.copyFileSync(s, d); n++; }
    }
    return n;
}

/** Dešifruje databázi klíčem a zkontroluje auditní řetězec. Nic nezapisuje. */
function verifyDir(root) {
    const sc = require('../lib/secure_crypto');
    const keyFile = path.join(root, 'klic', 'lexis.key');
    const dbFile = path.join(root, 'data', '.lexis.db');
    if (!fs.existsSync(keyFile)) return { ok: false, reason: 'V záloze chybí klíč (klic/lexis.key).' };
    if (!fs.existsSync(dbFile)) return { ok: false, reason: 'V záloze chybí databáze (data/.lexis.db).' };
    let collections;
    try {
        const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
        collections = JSON.parse(sc.decrypt(key, JSON.parse(fs.readFileSync(dbFile, 'utf8'))));
    } catch (e) { return { ok: false, reason: 'Databázi nejde klíčem ze zálohy otevřít: ' + e.message }; }
    const logs = collections.transparency_logs || [];
    let prev = 'genesis_hash_lexis_ledger', chainOk = true;
    for (const r of logs) { if (r.prevHash !== prev) { chainOk = false; break; } prev = r.hash; }
    return {
        ok: chainOk, reason: chainOk ? null : 'Auditní řetězec v záloze je přerušený.',
        counts: { spisy: (collections.spisy || []).length, dokumenty: (collections.inbox_files || []).length, audit: logs.length, koncepty: (collections.drafts || []).length }
    };
}

function extract(file) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-obnova-'));
    tar(['-xzf', path.resolve(file), '-C', tmp]);
    return tmp;
}

function backup() {
    const d = dirs();
    const outDir = path.resolve(arg('--out') || 'zalohy');
    const withIngest = !has('--bez-spisovny');
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-zaloha-'));
    const keyFile = path.join(d.key, 'lexis.key');
    if (!fs.existsSync(keyFile)) throw new Error(`Klíč databáze nenalezen (${keyFile}).`);
    const nData = copyDir(d.data, path.join(stage, 'data'), { skip: n => /\.corrupt\.\d+$/.test(n) });
    fs.mkdirSync(path.join(stage, 'klic'), { recursive: true });
    fs.copyFileSync(keyFile, path.join(stage, 'klic', 'lexis.key'));
    let nIngest = 0;
    if (withIngest && path.resolve(d.ingest) !== path.resolve(d.data)) nIngest = copyDir(d.ingest, path.join(stage, 'spisovna'));
    const manifest = {
        system: 'LexisLocal', createdAt: new Date().toISOString(), host: os.hostname(),
        version: (() => { try { return require('../../package.json').version; } catch (e) { return null; } })(),
        source: { dataDir: d.data, keyDir: d.key, ingestDir: withIngest ? d.ingest : null }, files: { data: nData, spisovna: nIngest }
    };
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `lexislocal-zaloha-${stamp}.tar.gz`);
    tar(['-czf', file, '.'], stage);
    fs.rmSync(stage, { recursive: true, force: true });
    try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows */ }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(file + '.sha256', `${sha}  ${path.basename(file)}\n`);
    const tmp = extract(file);
    const v = verifyDir(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`Záloha: ${file}`);
    console.log(`Soubory: data ${nData}, spisovna ${withIngest ? nIngest : 'vynechána'} · velikost ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
    console.log(v.ok ? `✅ Ověřeno: databáze jde otevřít (spisů ${v.counts.spisy}, dokumentů ${v.counts.dokumenty}, záznamů auditu ${v.counts.audit}).`
        : `❌ ZÁLOHA NENÍ POUŽITELNÁ: ${v.reason}`);
    console.log('⚠️  Záloha obsahuje klíč k databázi — ukládejte ji jen na šifrovaný disk.');
    return v.ok ? 0 : 1;
}

function verify(file) {
    const tmp = extract(file);
    const v = verifyDir(tmp);
    let manifest = null; try { manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')); } catch (e) {}
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(manifest ? `Záloha z ${manifest.createdAt} (${manifest.host})` : 'Záloha bez manifestu');
    console.log(v.ok ? `✅ Zkouška obnovy prošla: spisů ${v.counts.spisy}, dokumentů ${v.counts.dokumenty}, záznamů auditu ${v.counts.audit}.` : `❌ ${v.reason}`);
    return v.ok ? 0 : 1;
}

function restore(file) {
    const d = dirs();
    const target = { data: path.resolve(arg('--data-dir') || d.data), key: path.resolve(arg('--key-dir') || d.key), ingest: path.resolve(arg('--spisovna') || d.ingest) };
    const tmp = extract(file);
    const v = verifyDir(tmp);
    if (!v.ok) { fs.rmSync(tmp, { recursive: true, force: true }); console.error(`❌ Obnova zastavena: ${v.reason}`); return 1; }
    const nonEmpty = p => fs.existsSync(p) && fs.readdirSync(p).length > 0;
    if (!has('--prepsat') && (nonEmpty(target.data) || fs.existsSync(path.join(target.key, 'lexis.key')))) {
        fs.rmSync(tmp, { recursive: true, force: true });
        console.error(`❌ Cílové složky nejsou prázdné (${target.data}, ${target.key}). Pro přepsání přidejte --prepsat; stávající data se nejdřív přesunou stranou.`);
        return 1;
    }
    const aside = `.pred-obnovou-${Date.now()}`;
    for (const p of [target.data, target.key]) if (nonEmpty(p)) fs.renameSync(p, p + aside);
    copyDir(path.join(tmp, 'data'), target.data);
    fs.mkdirSync(target.key, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(tmp, 'klic', 'lexis.key'), path.join(target.key, 'lexis.key'));
    try { fs.chmodSync(path.join(target.key, 'lexis.key'), 0o600); } catch (e) {}
    let nIngest = 0;
    if (fs.existsSync(path.join(tmp, 'spisovna'))) nIngest = copyDir(path.join(tmp, 'spisovna'), target.ingest);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`✅ Obnoveno: spisů ${v.counts.spisy}, dokumentů ${v.counts.dokumenty}, souborů spisovny ${nIngest}.`);
    console.log(`Data: ${target.data} · klíč: ${target.key} · spisovna: ${target.ingest}`);
    if (has('--prepsat')) console.log(`Původní data jsou odložena vedle s příponou ${aside}.`);
    console.log('Spusťte server a zkontrolujte přehled a auditní logy.');
    return 0;
}

if (require.main === module) {
    let code = 1;
    try {
        if (arg('--overit')) code = verify(arg('--overit'));
        else if (arg('--obnovit')) code = restore(arg('--obnovit'));
        else code = backup();
    } catch (e) { console.error('❌ ' + e.message); code = 1; }
    process.exit(code);
}

module.exports = { verifyDir, copyDir };
