#!/usr/bin/env node
/**
 * kb-balicek.js — instalační balíček znalostní báze (zákony + judikatura + hotové vektory).
 *
 * PROČ: plnění báze rešeršníka na novém počítači kanceláře (zákony + ~21 tis. rozhodnutí
 * NS/ÚS/NSS, ~300 tis. pasáží) trvá s výpočtem vektorů hodiny (Mac dny, GPU server 2 h).
 * Vektory veřejných textů jsou všude stejné, takže je dodáme spočítané: s cache se báze
 * naplní za desítky minut (server 25. 10. 2026: 23 min) a vektory se počítají jen u toho,
 * co v cache není. Jen veřejná data (úřední díla, § 3 autorského zákona) — žádné spisy.
 *
 *   node backend/scripts/kb-balicek.js --vytvor --out lexis-baze-2026-10.tar.gz \
 *        [--cache embeddings-bge-m3.jsonl.gz] [--zakony ./zakony] \
 *        [--judikatura ./judikatura-ns,./judikatura-us,./judikatura-nss]
 *   node backend/scripts/kb-balicek.js --info lexis-baze-2026-10.tar.gz
 *   node backend/scripts/kb-balicek.js --instaluj lexis-baze-2026-10.tar.gz [--agent resersnik]
 *
 * Instalace zapisuje PŘÍMO do šifrované báze (bez API a tokenu), proto musí být server
 * LexisLocalu ZASTAVENÝ (skript to ověří a jinak skončí). Je idempotentní: dokumenty, které
 * v bázi už jsou (podle názvu souboru), přeskočí — po přerušení stačí spustit znovu.
 * Ollama musí běžet jen pro texty, které v cache nejsou (jinak se nepoužije).
 * Nezašifrovaná cache se rozbalí do dočasné složky a po instalaci se smaže.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch (e) { /* bez dotenv */ }

const FORMAT = 1;
const CACHE_NAME = 'embeddings.jsonl.gz';
const JUD_DEFAULT = ['judikatura-ns', 'judikatura-us', 'judikatura-nss'];

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
function has(argv, name) { return argv.includes(name); }

function tar(args, cwd) {
    const r = spawnSync('tar', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`tar selhal: ${String(r.stderr || '').trim() || r.status}`);
    return String(r.stdout || '');
}

/** Rekurzivně .txt soubory (seřazené — stejné pořadí na každém počítači). */
function listTxt(dir) {
    const out = [];
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.name.startsWith('.')) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile() && /\.txt$/i.test(e.name)) out.push(p);
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out;
}

/** SHA-256 souboru po kusech (cache má přes 1 GB). */
function sha256File(file) {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8 * 1024 * 1024);
    try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(n === buf.length ? buf : buf.subarray(0, n)); }
    finally { fs.closeSync(fd); }
    return h.digest('hex');
}

/** Rozbalí .jsonl.gz (nebo zkopíruje .jsonl) do cíle; vrátí počet řádků. */
async function unpackCache(src, dst) {
    await new Promise((resolve, reject) => {
        const input = fs.createReadStream(src);
        const out = fs.createWriteStream(dst);
        const s = /\.gz$/i.test(src) ? input.pipe(zlib.createGunzip()) : input;
        s.on('error', reject); out.on('error', reject); out.on('finish', resolve);
        s.pipe(out);
    });
    let lines = 0;
    const fd = fs.openSync(dst, 'r'), buf = Buffer.alloc(8 * 1024 * 1024);
    try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) for (let i = 0; i < n; i++) if (buf[i] === 10) lines++; }
    finally { fs.closeSync(fd); }
    return lines;
}

// ─── vytvoření ──────────────────────────────────────────────────────────────────
function vytvor(opts) {
    const out = path.resolve(opts.out || `lexis-baze-${new Date().toISOString().slice(0, 10)}.tar.gz`);
    const zakony = path.resolve(opts.zakony || path.join(ROOT, 'zakony'));
    const jud = (opts.judikatura || JUD_DEFAULT.map(d => path.join(ROOT, d))).map(d => path.resolve(d));
    if (!fs.existsSync(zakony)) throw new Error(`Složka zákonů neexistuje: ${zakony}`);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-balicek-'));
    try {
        const obsah = path.join(stage, 'obsah');
        fs.mkdirSync(obsah);
        const slozky = [{ nazev: 'zakony', src: zakony }, ...jud.filter(d => fs.existsSync(d)).map(d => ({ nazev: path.basename(d), src: d }))];
        const counts = {};
        for (const s of slozky) {
            fs.symlinkSync(s.src, path.join(obsah, s.nazev), 'dir');
            counts[s.nazev] = listTxt(s.src).length;
        }
        let cache = null;
        if (opts.cache) {
            const c = path.resolve(opts.cache);
            if (!fs.existsSync(c)) throw new Error(`Cache vektorů neexistuje: ${c}`);
            if (!/\.gz$/i.test(c)) throw new Error('Cache čekám zabalenou (.jsonl.gz) — tak ji ukládá serverový test do S3.');
            fs.symlinkSync(c, path.join(stage, CACHE_NAME));
            cache = { soubor: CACHE_NAME, velikost: fs.statSync(c).size, sha256: sha256File(c) };
        }
        const manifest = {
            format: FORMAT, system: 'LexisLocal', typ: 'znalostni-baze',
            vytvoreno: new Date().toISOString(),
            verzeAplikace: (() => { try { return require(path.join(ROOT, 'package.json')).version; } catch (e) { return null; } })(),
            embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
            kbChunkMaxChars: require('../lib/rag').kbChunkMaxChars(),
            slozky: counts, souboru: Object.values(counts).reduce((a, b) => a + b, 0), cache,
            poznamka: 'Jen veřejná data: zákony (e-Sbírka) a judikatura NS, ÚS, NSS. Žádné klientské údaje.'
        };
        fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
        // -h: symlinky se zabalí jako skutečné složky/soubory
        tar(['-czhf', out, 'manifest.json', 'obsah', ...(cache ? [CACHE_NAME] : [])], stage);
        return { out, manifest, velikost: fs.statSync(out).size };
    } finally {
        fs.rmSync(stage, { recursive: true, force: true });
    }
}

function info(file) {
    const m = JSON.parse(tar(['-xzOf', path.resolve(file), 'manifest.json']));
    return m;
}

// ─── instalace ──────────────────────────────────────────────────────────────────
function serverBezi(port, host = '127.0.0.1', timeoutMs = 800) {
    return new Promise(resolve => {
        const s = net.connect({ port: Number(port), host });
        const done = v => { s.destroy(); resolve(v); };
        s.setTimeout(timeoutMs, () => done(false));
        s.on('connect', () => done(true));
        s.on('error', () => done(false));
    });
}

async function instaluj(opts) {
    const file = path.resolve(opts.file);
    const log = opts.log || (s => console.log(s));
    if (!opts.force && await serverBezi(opts.port || process.env.PORT || 4000)) {
        throw new Error(`Na portu ${opts.port || process.env.PORT || 4000} běží server LexisLocalu. Zastavte ho (instalace zapisuje přímo do báze), nebo použijte --force, pokud tam běží něco jiného.`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-baze-'));
    const prevEnv = { EMBED_CACHE_FILE: process.env.EMBED_CACHE_FILE, RAG_KB_SAVE_DEBOUNCE_MS: process.env.RAG_KB_SAVE_DEBOUNCE_MS };
    try {
        tar(['-xzf', file, '-C', tmp]);
        const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
        if (manifest.format !== FORMAT || manifest.typ !== 'znalostni-baze') throw new Error('Neznámý formát balíčku.');
        const model = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
        const rag = require('../lib/rag');
        const warn = [];
        if (manifest.embeddingModel !== model) warn.push(`Balíček má vektory pro „${manifest.embeddingModel}", tady je EMBEDDING_MODEL=${model} → cache se nepoužije, vektory se spočítají znovu (pomalé).`);
        if (manifest.kbChunkMaxChars !== rag.kbChunkMaxChars()) warn.push(`Jiná velikost kousků (${manifest.kbChunkMaxChars} vs. ${rag.kbChunkMaxChars()}) → většina vektorů se spočítá znovu.`);
        warn.forEach(w => log('⚠️  ' + w));

        let cacheLines = 0;
        if (manifest.cache) {
            const c = path.join(tmp, manifest.cache.soubor);
            if (sha256File(c) !== manifest.cache.sha256) throw new Error('Cache vektorů je poškozená (nesedí SHA-256).');
            const jsonl = path.join(tmp, 'embeddings.jsonl');
            cacheLines = await unpackCache(c, jsonl);
            fs.unlinkSync(c);
            process.env.EMBED_CACHE_FILE = jsonl;
            log(`📦 Cache vektorů: ${cacheLines} záznamů`);
        } else log('ℹ️  Balíček je bez cache vektorů — vektory spočítá Ollama (pomalé).');
        // Odložený zápis báze (jinak se po každém souboru přešifruje shard 0).
        process.env.RAG_KB_SAVE_DEBOUNCE_MS = process.env.RAG_KB_SAVE_DEBOUNCE_MS || '3000';
        const embedCache = require('../lib/embed_cache');
        embedCache._reset();

        const scope = `_kb_${String(opts.agent || 'resersnik').replace(/[^a-z0-9_-]/gi, '')}`;
        const uz = new Set(rag.listKnowledge(scope).map(d => String(d.fileName).normalize('NFC')));
        const { extractTextFromFile } = require('../lib/ocr');
        const files = listTxt(path.join(tmp, 'obsah'));
        let ok = 0, skip = 0, err = 0, chunks = 0, bezVektoru = 0;
        const t0 = Date.now();
        for (let i = 0; i < files.length; i++) {
            // NFC: tar na macOS rozbaluje názvy s diakritikou rozložené (NFD) — „ÚS“ by pak
            // nebylo totéž co v bázi naplněné jinde a idempotence by nefungovala.
            const f = files[i], label = path.basename(f).normalize('NFC');
            if (uz.has(label)) { skip++; continue; }
            try {
                const { text } = await extractTextFromFile(f);
                if (!String(text || '').trim()) { err++; continue; }
                const r = await rag.indexKnowledge(scope, label, String(text));
                ok++; chunks += r.indexed || 0; bezVektoru += (r.indexed || 0) - (r.embedded || 0);
                uz.add(label);
            } catch (e) { err++; if (err <= 5) log(`❌ ${label}: ${e.message}`); }
            if ((i + 1) % 1000 === 0) log(`   … ${i + 1}/${files.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
        }
        rag.flushPendingSaves();
        const st = embedCache.stats();
        const vysledek = { scope, souboru: files.length, nahrano: ok, preskoceno: skip, chyb: err, kousku: chunks, bezVektoru,
            cache: { zaznamu: cacheLines, zasahu: st.hits, spocitano: st.misses }, sekund: Math.round((Date.now() - t0) / 1000), varovani: warn };
        log(`✅ Báze ${scope}: nahráno ${ok}, přeskočeno ${skip} (už v bázi), chyb ${err}; ${chunks} kousků` +
            `${manifest.cache ? `, vektory z cache ${st.hits}, nově spočítané ${st.misses}` : ''} · ${vysledek.sekund} s`);
        if (bezVektoru) log(`⚠️  ${bezVektoru} kousků je bez vektoru (Ollama neběží?) — po spuštění Ollamy: node backend/scripts/reindex-kb.js`);
        return vysledek;
    } finally {
        for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        try { require('../lib/embed_cache')._reset(); } catch (e) { /* */ }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function main(argv) {
    if (has(argv, '--vytvor')) {
        const r = vytvor({ out: arg(argv, '--out'), cache: arg(argv, '--cache'), zakony: arg(argv, '--zakony'),
            judikatura: arg(argv, '--judikatura') ? arg(argv, '--judikatura').split(',') : null });
        console.log(`📦 Balíček: ${r.out} (${(r.velikost / 1048576).toFixed(1)} MB)`);
        console.log(`   souborů ${r.manifest.souboru} ${JSON.stringify(r.manifest.slozky)} · model ${r.manifest.embeddingModel} · cache ${r.manifest.cache ? 'ano' : 'ne'}`);
        return 0;
    }
    if (arg(argv, '--info')) { console.log(JSON.stringify(info(arg(argv, '--info')), null, 2)); return 0; }
    if (arg(argv, '--instaluj')) {
        const r = await instaluj({ file: arg(argv, '--instaluj'), agent: arg(argv, '--agent'), force: has(argv, '--force') });
        return r.chyb ? 1 : 0;
    }
    console.log('Použití: --vytvor --out <soubor> [--cache <.jsonl.gz>] | --info <soubor> | --instaluj <soubor> [--agent resersnik] [--force]');
    return 2;
}

if (require.main === module) main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error('❌ ' + e.message); process.exit(1); });

module.exports = { vytvor, info, instaluj, listTxt, serverBezi };
