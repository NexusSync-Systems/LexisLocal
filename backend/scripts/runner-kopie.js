#!/usr/bin/env node
/**
 * runner-kopie.js — správa KOPIE projektu, ze které spouštěč úloh (task-runner.js) spouští kód.
 *
 * PROČ (poslední bod review 2)
 *  Spouštěč běží v terminálu Macu a spouští úlohy ze seznamu. Dosud je spouštěl z téže složky
 *  projektu, do které vidí (a může zapisovat) Claude přes připojenou složku. Seznam úloh hlídá
 *  jen to, JAKÝ příkaz se složí — ne, jaký KÓD se tím spustí. Kdo umí zapsat do
 *  backend/scripts/*.js, scripts/aws/bootstrap-*.sh nebo node_modules, obejde seznam úplně.
 *  Proto kód bere spouštěč z kopie mimo projekt (výchozí ~/.lexislocal/runner/kopie), do které
 *  agenti nevidí; kopie se obnovuje jen ručně na Macu z posledního commitu.
 *
 * CO KOPIE OBSAHUJE
 *  • Kód z `git archive HEAD` — tedy jen to, co je zacommitované (necommitnuté změny v projektu
 *    se do kopie nedostanou; obnovu dělá Zdeněk až po commitu).
 *  • `.env` z projektu (zkopíruje se, nečte se a nikam se nevypisuje) — scripty bez něj neznají
 *    nastavení. V kopii je read-only.
 *  • `node_modules` — klon z projektu (APFS `cp -Rc`, prakticky okamžitě a bez místa na disku),
 *    nebo s `--npm-ci` čistá instalace podle package-lock.json (pomalé, ale nezávislé na projektu).
 *  • Symlinky na složky, které jsou SDÍLENÉ s projektem (fronta úloh, logy, výsledky, stažená
 *    judikatura) — jsou v nich data a výstupy, ne spouštěný kód, a Claude je potřebuje vidět.
 *
 * POUŽITÍ (z kořene projektu)
 *   node backend/scripts/runner-kopie.js              # stav kopie
 *   node backend/scripts/runner-kopie.js --obnov      # obnovit z HEAD (po commitu)
 *   node backend/scripts/runner-kopie.js --obnov --npm-ci     # + čistá instalace modulů
 *   node backend/scripts/runner-kopie.js --obnov --bez-zamku  # bez chmod a-w (ladění)
 *   node backend/scripts/runner-kopie.js --obnov --z-pracovni # i necommitnuté změny (jen ověření
 *                                                             # na Macu; spouštěč to pak hlásí)
 *   node backend/scripts/runner-kopie.js --smaz       # kopii zahodit
 * Jiné místo pro kopii: LEXIS_RUNNER_KOPIE=/cesta (musí být mimo projekt).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

/** Živý projekt — sem vidí agenti, odsud se kopie obnovuje. */
const ZIVY = path.resolve(__dirname, '..', '..');
const KOREN = process.env.LEXIS_RUNNER_KOREN || path.join(os.homedir(), '.lexislocal', 'runner');
const KOPIE = process.env.LEXIS_RUNNER_KOPIE || path.join(KOREN, 'kopie');
const MANIFEST = '.lexis-runner-kopie.json';

/**
 * Složky, které kopie nemá vlastní — ukazují symlinkem do živého projektu.
 * Jsou v nich DATA a VÝSTUPY (fronta úloh, logy, stažená judikatura, výsledky běhů), ne kód:
 * kód se spouští jen z kopie. Nová sdílená složka = přidat sem a obnovit kopii.
 */
const SDILENE = ['scratch', 'bench-results', 'judikatura', 'judikatura-us', 'judikatura-ns', 'judikatura-nss', 'zakony'];

function git(args, cwd = ZIVY) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) return null;
    return String(r.stdout || '').trim();
}

/** Manifest kopie, nebo null (kopie neexistuje / je nedodělaná). */
function nactiManifest(kopie = KOPIE) {
    try { return JSON.parse(fs.readFileSync(path.join(kopie, MANIFEST), 'utf8')); } catch (e) { return null; }
}

/** Commit, na kterém stojí živý projekt. */
function zivyCommit() { return git(['rev-parse', 'HEAD']); }

function kontrolaCesty(dir) {
    const abs = path.resolve(dir);
    if (abs === path.resolve(ZIVY)) throw new Error('kopie nesmí být sám projekt');
    if (abs.startsWith(path.resolve(ZIVY) + path.sep)) throw new Error(`kopie nesmí být uvnitř projektu (${abs}) — agenti do ní vidí`);
    if (abs === path.resolve(os.homedir()) || abs === '/') throw new Error(`nebezpečná cesta kopie: ${abs}`);
    return abs;
}

/** Smaže kopii — jen složku s naším manifestem, aby nešlo omylem smazat něco jiného. */
function smaz(kopie = KOPIE) {
    const abs = kontrolaCesty(kopie);
    if (!fs.existsSync(abs)) return false;
    if (!fs.existsSync(path.join(abs, MANIFEST))) throw new Error(`${abs} není kopie spouštěče (chybí ${MANIFEST}) — smažte ji ručně`);
    spawnSync('chmod', ['-R', 'u+w', abs]);
    fs.rmSync(abs, { recursive: true, force: true }); // symlinky se jen odpojí, cíle v projektu zůstanou
    return true;
}

function obnov(volby = {}) {
    const abs = kontrolaCesty(KOPIE);
    const commit = zivyCommit();
    if (!commit) throw new Error(`${ZIVY} není git repozitář — kopie se dělá z posledního commitu`);
    const vetev = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const predmet = git(['log', '-1', '--format=%s']);
    const zmenene = (git(['status', '--porcelain', '--untracked-files=no']) || '').split('\n').filter(Boolean);

    smaz(abs);
    fs.mkdirSync(abs, { recursive: true });

    // 1) kód: výchozí z posledního commitu (necommitnuté změny se do kopie nedostanou).
    //    --z-pracovni vezme sledované soubory tak, jak jsou teď na disku — jen na ověření změn
    //    před commitem; spouštěč takovou kopii označí jako „pracovní".
    const zdroj = volby.zPracovni ? 'pracovní' : 'commit';
    const tar = path.join(os.tmpdir(), `lexis-runner-kopie-${process.pid}.tar`);
    const seznam = path.join(os.tmpdir(), `lexis-runner-kopie-${process.pid}.list`);
    try {
        let r;
        if (volby.zPracovni) {
            // sledované + nové nezaignorované soubory, bez sdílených složek (ty jsou symlink)
            r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
                { cwd: ZIVY, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
            if (r.status !== 0) throw new Error('git ls-files selhal');
            const cesty = String(r.stdout).split('\0').filter(Boolean).filter(c => !SDILENE.includes(c.split('/')[0]));
            fs.writeFileSync(seznam, cesty.join('\0') + '\0');
            r = spawnSync('tar', ['-cf', tar, '--null', '-T', seznam], { cwd: ZIVY, encoding: 'utf8' });
            if (r.status !== 0) throw new Error(`zabalení pracovní kopie selhalo: ${String(r.stderr || '').trim()}`);
        } else {
            r = spawnSync('git', ['archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: ZIVY, encoding: 'utf8' });
            if (r.status !== 0) throw new Error(`git archive selhal: ${String(r.stderr || '').trim()}`);
        }
        r = spawnSync('tar', ['-xf', tar, '-C', abs], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`rozbalení selhalo: ${String(r.stderr || '').trim()}`);
    } finally { fs.rmSync(tar, { force: true }); fs.rmSync(seznam, { force: true }); }

    // 2) .env (jen zkopírovat — obsah se nikde nečte ani nevypisuje)
    let env = 'ne';
    if (!volby.bezEnv && fs.existsSync(path.join(ZIVY, '.env'))) {
        fs.copyFileSync(path.join(ZIVY, '.env'), path.join(abs, '.env'));
        fs.chmodSync(path.join(abs, '.env'), 0o400); // jen ke čtení a jen pro vlastníka
        env = 'zkopírován';
    }

    // 3) node_modules
    const moduly = volby.npmCi ? 'npm ci' : 'klon';
    if (volby.npmCi) {
        const r = spawnSync('npm', ['ci'], { cwd: abs, stdio: 'inherit' });
        if (r.status !== 0) throw new Error('npm ci v kopii selhalo');
    } else {
        const src = path.join(ZIVY, 'node_modules');
        if (!fs.existsSync(src)) throw new Error(`chybí ${src} — nainstalujte moduly (npm ci) nebo použijte --npm-ci`);
        const cil = path.join(abs, 'node_modules');
        let r = spawnSync('cp', ['-Rc', src, cil], { encoding: 'utf8' });      // APFS clonefile
        if (r.status !== 0) r = spawnSync('cp', ['-R', src, cil], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`kopie node_modules selhala: ${String(r.stderr || '').trim()}`);
    }

    // 4) sdílené složky → symlink do živého projektu
    for (const s of SDILENE) {
        const zivaCesta = path.join(ZIVY, s);
        fs.mkdirSync(zivaCesta, { recursive: true });
        const vKopii = path.join(abs, s);
        if (fs.existsSync(vKopii) || fs.lstatSync(vKopii, { throwIfNoEntry: false })) fs.rmSync(vKopii, { recursive: true, force: true });
        fs.symlinkSync(zivaCesta, vKopii);
    }

    // 5) manifest
    const manifest = { verze: 1, zdroj, commit, kratky: commit.slice(0, 7), vetev, predmet, cas: new Date().toISOString(),
        zivyKoren: ZIVY, moduly, env, sdilene: SDILENE, zamek: !volby.bezZamku,
        necommitnutychPriObnove: zmenene.length };
    fs.writeFileSync(path.join(abs, MANIFEST), JSON.stringify(manifest, null, 2));

    // 6) zámek: kód v kopii read-only (sdílené symlinky a moduly se nezamykají)
    if (!volby.bezZamku) {
        const polozky = fs.readdirSync(abs).filter(n => !SDILENE.includes(n) && n !== 'node_modules').map(n => path.join(abs, n));
        if (polozky.length) spawnSync('chmod', ['-R', 'a-w', ...polozky]);
    }
    return { manifest, zmenene };
}

function stav() {
    const m = nactiManifest();
    if (!m) {
        console.log(`❌ kopie spouštěče neexistuje (${KOPIE})`);
        console.log('   vytvoření: node backend/scripts/runner-kopie.js --obnov');
        return 1;
    }
    const zivy = zivyCommit();
    console.log(`📦 kopie spouštěče: ${KOPIE}`);
    console.log(`   commit ${m.kratky} (${m.vetev || '?'}) — ${m.predmet || ''}`);
    console.log(`   obnoveno ${m.cas}  ·  moduly: ${m.moduly}  ·  .env: ${m.env}  ·  zámek: ${m.zamek ? 'ano' : 'ne'}`);
    if (m.zdroj === 'pracovní') console.log('   ⚠️  kopie je z PRACOVNÍ verze (necommitnuté změny) — pro provoz obnovte bez --z-pracovni');
    if (zivy && zivy !== m.commit) {
        console.log(`   ⚠️  projekt je jinde (${zivy.slice(0, 7)}) — po commitu obnovte: node backend/scripts/runner-kopie.js --obnov`);
        return 2;
    }
    console.log('   ✅ odpovídá poslednímu commitu projektu');
    return 0;
}

function main() {
    const a = process.argv.slice(2);
    const volby = { npmCi: a.includes('--npm-ci'), bezZamku: a.includes('--bez-zamku'), bezEnv: a.includes('--bez-env'),
        zPracovni: a.includes('--z-pracovni') };
    try {
        if (a.includes('--smaz')) {
            console.log(smaz() ? `🗑  kopie smazána: ${KOPIE}` : `nic ke smazání (${KOPIE})`);
            return;
        }
        if (a.includes('--obnov')) {
            const { manifest, zmenene } = obnov(volby);
            console.log(`✅ kopie obnovena: ${KOPIE}`);
            console.log(`   commit ${manifest.kratky} (${manifest.vetev}) — ${manifest.predmet}`);
            console.log(`   zdroj: ${manifest.zdroj === 'pracovní' ? 'PRACOVNÍ verze (necommitnuté změny)' : 'poslední commit'}`);
            console.log(`   moduly: ${manifest.moduly}  ·  .env: ${manifest.env}  ·  zámek: ${manifest.zamek ? 'ano (chmod a-w)' : 'ne'}`);
            console.log(`   sdílené s projektem (symlink): ${manifest.sdilene.join(', ')}`);
            if (zmenene.length && manifest.zdroj !== 'pracovní') {
                console.log(`   ⚠️  v projektu je ${zmenene.length} necommitnutých změn sledovaných souborů — v kopii NEJSOU:`);
                for (const z of zmenene.slice(0, 20)) console.log(`      ${z}`);
            }
            return;
        }
        process.exitCode = stav();
    } catch (e) {
        console.error(`❌ ${e.message}`);
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = { ZIVY, KOREN, KOPIE, MANIFEST, SDILENE, nactiManifest, zivyCommit, obnov, smaz, stav };
