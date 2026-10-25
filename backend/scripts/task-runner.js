#!/usr/bin/env node
/**
 * task-runner.js — spouštěč PŘEDEM SCHVÁLENÝCH úloh na Macu pro Clauda (Cowork).
 *
 * Claude vidí připojenou složku projektu, ale ne terminál Macu, Ollamu ani běžící procesy.
 * Tenhle spouštěč běží v terminálu Macu a hlídá složku scratch/ukoly/fronta/. Když tam
 * Claude (nebo kdokoli s přístupem ke složce) zapíše požadavek, spouštěč ho spustí,
 * výstup zapisuje do scratch/ukoly/logy/<id>.log a stav do scratch/ukoly/stav/<id>.json.
 *
 * BEZPEČNOST
 *  • Spouští se JEN úlohy ze seznamu ULOHY níž. Žádný libovolný příkaz, žádný shell
 *    (spawn bez shellu, argumenty jako pole), parametry se ověřují (čísla, výčty, cesty
 *    jen uvnitř projektu a jen ze schválených složek).
 *  • Token API se nepředává v požadavku — seed-kb ho čte ze souboru jako dosud.
 *  • Nic nemaže, necommituje, nic neposílá ven (kromě úloh, které stahují veřejné zdroje
 *    a dělají to i ručně: NALUS, Sbírka NSS).
 *  • AWS (aws_stav, aws_behy, aws_vysledky) jen čte — přes AWS CLI s přihlášením na Macu;
 *    pevný region a bucket, _connect.txt s tokenem se nestahuje. aws_spust_test spustí
 *    serverový test s pevnými parametry (stojí peníze — jen po souhlasu v chatu).
 *  • Jedna úloha najednou. Zastavení: požadavek {"uloha":"stop"} nebo Ctrl+C v terminálu.
 *
 * Spuštění (z kořene projektu, nechte běžet v samostatném okně terminálu):
 *   node backend/scripts/task-runner.js
 * Požadavek (soubor scratch/ukoly/fronta/<cokoli>.json):
 *   {"uloha": "kb_regression", "parametry": {"limit": 40, "sample": 0}}
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = path.join(ROOT, 'scratch', 'ukoly');
const DIRS = { fronta: path.join(BASE, 'fronta'), hotovo: path.join(BASE, 'hotovo'), logy: path.join(BASE, 'logy'), stav: path.join(BASE, 'stav') };
const TOKEN_FILE = path.join(require('os').homedir(), '.lexislocal', 'api_token');
const NODE = process.execPath;

// --- Ověření parametrů ------------------------------------------------------------
function int(v, min, max, def) {
    if (v === undefined || v === null || v === '') return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`číslo mimo rozsah ${min}–${max}: ${v}`);
    return n;
}
function oneOf(v, allowed, def) {
    if (v === undefined || v === null || v === '') return def;
    if (!allowed.includes(v)) throw new Error(`nepovolená hodnota „${v}" (povolené: ${allowed.join(', ')})`);
    return v;
}
function datum(v, def) {
    if (v === undefined || v === null || v === '') return def;
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(String(v))) throw new Error(`datum musí být DD.MM.RRRR: ${v}`);
    return String(v);
}
/** Relativní složka projektu ze schváleného seznamu (žádné .., žádné absolutní cesty). */
const SLOZKY = /^(judikatura-(us|ns|nss)|judikatura(\/[\p{L}\p{N} ,_-]+)?|zakony(\/[\p{L}\p{N} _-]+)?)$/u;
function slozka(v, def) {
    const s = v === undefined || v === null || v === '' ? def : String(v).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!SLOZKY.test(s)) throw new Error(`nepovolená složka „${s}"`);
    const abs = path.resolve(ROOT, s);
    if (!abs.startsWith(ROOT + path.sep)) throw new Error('složka mimo projekt');
    return s;
}
/** Vzor názvu testů pro jest: jen písmena, čísla, / _ - a |. */
function vzorTestu(v) {
    if (v === undefined || v === null || v === '') return [];
    const s = String(v);
    if (!/^[A-Za-z0-9_\/|.-]{1,200}$/.test(s)) throw new Error(`nepovolený vzor testů „${s}"`);
    return [s];
}

/** Název běhu serverového testu v S3 (např. 2026-10-24_1623_remote_judikatura). */
function behTestu(v) {
    const s = String(v || '');
    if (!/^\d{4}-\d{2}-\d{2}_\d{4}_[a-z0-9_-]{1,40}$/.test(s)) throw new Error(`nepovolený název běhu „${s}"`);
    return s;
}
// AWS: jen ČTENÍ (stav instancí, seznam běhů, stažení výsledků) přes AWS CLI a přihlášení na Macu.
// Nic se nespouští, nemaže ani nemění. _connect.txt (obsahuje token) se nestahuje.
const AWS_REGION = 'eu-central-1';
const AWS_BUCKET = 'lexislocal-bench-results-485237569555';
const AWS_TEST_AMI = 'ami-0bac4f1462de1bb51';   // Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04) 20261016
const AWS_TEST_SG = 'sg-08da0035b6d9a171c';      // bez příchozích pravidel

// --- Schválené úlohy ----------------------------------------------------------------
// Každá vrací { cmd, args, env? } — cmd je vždy pevný (node / npx), argumenty jako pole.
const ULOHY = {
    testy: p => ({ cmd: 'npx', args: ['jest', '--silent', ...vzorTestu(p.vzor)] }),
    kb_regression: p => ({
        cmd: NODE,
        args: ['backend/scripts/kb_regression.js',
            '--limit', String(int(p.limit, 0, 1000, 40)),
            '--sample', String(int(p.sample, 0, 200, 0)),
            '--pool-compare', String(int(p.poolCompare, 0, 100, 0))],
        env: Object.assign({ NODE_OPTIONS: '--max-old-space-size=8192' }, p.int8 === false ? { RAG_VEC_INT8: '0' } : {}),
    }),
    seed_kb: p => ({
        cmd: NODE,
        args: ['backend/scripts/seed-kb.js', '--agent', oneOf(p.agent, ['resersnik', 'spisovatel', 'kontrolor'], 'resersnik'),
            '--dir', './' + slozka(p.dir), '--token-file', TOKEN_FILE],
    }),
    fetch_us_nalus: p => ({
        cmd: NODE,
        args: ['backend/scripts/fetch-us.js', '--nalus', '--od', datum(p.od, '01.01.2024'), '--out', './judikatura-us'],
    }),
    fetch_nss: p => ({
        cmd: NODE,
        args: ['backend/scripts/fetch-nss-sbirka.js', '--out', './judikatura-nss',
            ...(p.odRoku ? ['--od-roku', String(int(p.odRoku, 2003, 2100))] : [])],
    }),
    fetch_ns: p => ({
        cmd: NODE,
        args: ['backend/scripts/fetch-ns-sbirka.js', '--out', './judikatura-ns',
            ...(p.odRoku ? ['--od-roku', String(int(p.odRoku, 1990, 2100))] : [])],
    }),
    aws_stav: () => ({
        cmd: 'aws',
        args: ['ec2', 'describe-instances', '--region', AWS_REGION,
            '--filters', 'Name=instance-state-name,Values=pending,running,stopping,shutting-down',
            '--query', 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name,LaunchTime,Tags[?Key==`Name`]|[0].Value]',
            '--output', 'table'],
    }),
    aws_behy: () => ({ cmd: 'aws', args: ['s3', 'ls', `s3://${AWS_BUCKET}/`, '--region', AWS_REGION] }),
    aws_vysledky: p => {
        const beh = behTestu(p.beh);
        return {
            cmd: 'aws',
            args: ['s3', 'sync', `s3://${AWS_BUCKET}/${beh}/`, `scratch/aws-vysledky/${beh}/`, '--region', AWS_REGION,
                '--exclude', '_connect.txt', '--exclude', '*/_connect.txt', '--only-show-errors'],
        };
    },
    // Spuštění serverového testu — STOJÍ PENÍZE (g6.xlarge ~1 USD/h, sama se vypne po testech,
    // nejpozději po 8 h). Claude ji zařadí jen po výslovném souhlasu v chatu. Vše pevné: typ,
    // disk, role, security group (bez příchozích pravidel), user data z repozitáře; jen AMI
    // lze změnit (nová verze Deep Learning AMI). Oprávnění uživatele lexis-runner to vynucují i v AWS.
    aws_spust_test: p => {
        const ami = String(p.ami || AWS_TEST_AMI);
        if (!/^ami-[0-9a-f]{8,17}$/.test(ami)) throw new Error(`nepovolené AMI „${ami}"`);
        return {
            cmd: 'aws',
            args: ['ec2', 'run-instances', '--region', AWS_REGION, '--image-id', ami, '--instance-type', 'g6.xlarge', '--count', '1',
                '--iam-instance-profile', 'Name=lexis-bench-ec2', '--security-group-ids', AWS_TEST_SG,
                '--instance-initiated-shutdown-behavior', 'terminate',
                '--block-device-mappings', '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":200,"VolumeType":"gp3","DeleteOnTermination":true}}]',
                '--user-data', 'file://scripts/aws/bootstrap-judikatura.sh',
                '--tag-specifications', 'ResourceType=instance,Tags=[{Key=Name,Value=lexis-test-1.2.0-judikatura}]',
                '--query', 'Instances[0].[InstanceId,State.Name,LaunchTime]', '--output', 'text'],
        };
    },
    git_stav: () => ({ cmd: 'git', args: ['status', '--short', '--branch'] }),
    git_log: p => ({ cmd: 'git', args: ['log', '--oneline', '-n', String(int(p.n, 1, 50, 10))] }),
};

/** Požadavek → příkaz. Vyhodí chybu u neznámé úlohy nebo špatného parametru. */
function sestav(pozadavek) {
    const uloha = pozadavek && pozadavek.uloha;
    if (!Object.prototype.hasOwnProperty.call(ULOHY, uloha)) throw new Error(`neznámá úloha „${uloha}" (povolené: ${Object.keys(ULOHY).join(', ')}, stop)`);
    const p = pozadavek.parametry && typeof pozadavek.parametry === 'object' ? pozadavek.parametry : {};
    return ULOHY[uloha](p);
}

// --- Běh ------------------------------------------------------------------------------
let bezi = null; // { id, child }

function zapisStav(id, o) { fs.writeFileSync(path.join(DIRS.stav, id + '.json'), JSON.stringify(o, null, 2)); }
function cas() { return new Date().toISOString(); }

function spust(id, poz) {
    let prikaz;
    try { prikaz = sestav(poz); }
    catch (e) {
        zapisStav(id, { id, uloha: poz && poz.uloha, stav: 'odmítnuto', duvod: e.message, cas: cas() });
        console.log(`⛔ ${id}: ${e.message}`);
        return;
    }
    const logPath = path.join(DIRS.logy, id + '.log');
    const log = fs.createWriteStream(logPath);
    const zacatek = cas();
    console.log(`▶ ${id}: ${poz.uloha} → ${[path.basename(prikaz.cmd), ...prikaz.args].join(' ')}`);
    zapisStav(id, { id, uloha: poz.uloha, stav: 'běží', prikaz: [path.basename(prikaz.cmd), ...prikaz.args.map(a => (a === TOKEN_FILE ? '~/.lexislocal/api_token' : a))], zacatek, log: path.relative(ROOT, logPath) });
    const child = spawn(prikaz.cmd, prikaz.args, { cwd: ROOT, env: Object.assign({}, process.env, prikaz.env || {}), shell: false });
    bezi = { id, child };
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', e => { log.write(`\n❌ ${e.message}\n`); });
    child.on('close', (code, signal) => {
        log.end(`\n[konec: kód ${code}${signal ? `, signál ${signal}` : ''}]\n`);
        zapisStav(id, { id, uloha: poz.uloha, stav: code === 0 ? 'hotovo' : 'chyba', kod: code, signal, zacatek, konec: cas(), log: path.relative(ROOT, logPath) });
        console.log(`${code === 0 ? '✅' : '❌'} ${id}: ${poz.uloha} (kód ${code})`);
        bezi = null;
    });
}

function dalsi() {
    let soubory;
    try { soubory = fs.readdirSync(DIRS.fronta).filter(f => f.endsWith('.json')).sort(); } catch (e) { return; }
    for (const f of soubory) {
        const src = path.join(DIRS.fronta, f);
        let poz;
        try { poz = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { poz = { uloha: '(neplatný JSON)' }; }
        const id = (new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)) + '_' + f.replace(/\.json$/, '').replace(/[^\w-]/g, '_').slice(0, 40);
        if (poz && poz.uloha === 'stop') {
            fs.renameSync(src, path.join(DIRS.hotovo, id + '.json'));
            if (bezi) { console.log(`⏹  zastavuji ${bezi.id}`); bezi.child.kill('SIGINT'); }
            continue;
        }
        if (bezi) return; // jedna úloha najednou; další počká ve frontě
        fs.renameSync(src, path.join(DIRS.hotovo, id + '.json'));
        spust(id, poz);
        return;
    }
}

function main() {
    for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
    console.log(`🧰 Spouštěč úloh běží. Fronta: ${path.relative(ROOT, DIRS.fronta)}  ·  úlohy: ${Object.keys(ULOHY).join(', ')}, stop`);
    console.log('   Zastavení spouštěče: Ctrl+C');
    const t = setInterval(dalsi, 2000);
    process.on('SIGINT', () => {
        clearInterval(t);
        if (bezi) { console.log(`\n⏹  ukončuji běžící úlohu ${bezi.id}`); bezi.child.kill('SIGINT'); }
        setTimeout(() => process.exit(0), 500);
    });
}

if (require.main === module) main();

module.exports = { sestav, ULOHY, slozka, vzorTestu, behTestu };
