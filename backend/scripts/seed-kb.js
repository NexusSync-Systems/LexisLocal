#!/usr/bin/env node
/**
 * seed-kb.js — hromadné naplnění znalostní báze (RAG) LexisLocalu.
 *
 * Tři režimy:
 *   --agent <id>  --dir <složka>     → báze konkrétního agenta (_kb_<id>)
 *   --obor <název> --dir <složka>    → oborová báze (_kb_obor_<slug>)
 *   --root <složka>                  → DÁVKA: každá PODSLOŽKA = obor, naplní se všechny
 *
 * Soubory (PDF/DOCX/TXT/HTML/skeny) se pošlou na REST API; server z nich vytáhne
 * text (u skenů OCR) a zaindexuje do izolované šifrované partition. NEtrénuje váhy
 * modelu — plní RAG (retrieval); agent pak z dokumentů cituje.
 *
 * Příklady:
 *   node seed-kb.js --obor "Nájemní právo" --dir ./judikatura-najem
 *   node seed-kb.js --root ./judikatura --token-file ~/.lexislocal/api_token
 *   node seed-kb.js --agent resersnik --dir ./obecne --dry-run
 *
 * Token: --token > --token-file <cesta> > $LEXIS_API_TOKEN. Server ho vypisuje při
 * startu ("Token pro editor: …") a drží v souboru mimo datovou složku.
 * Idempotentní (přeskočí soubory už v bázi podle názvu), sekvenční s rate-limitem,
 * na konci každé báze spustí re-index (vektory). Bez závislostí — Node ≥ 18.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Když se výstupní roura zavře dřív (např. `| head`), nepadej na EPIPE — ukonči čistě.
process.stdout.on('error', e => { if (e && e.code === 'EPIPE') process.exit(0); });

// Povolené přípony = přesně to, co umí server vytáhnout (viz KB_ALLOWED_EXT v routes).
const ALLOWED_EXT = new Set(['.pdf', '.docx', '.txt', '.html', '.htm', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.webp']);
const MAX_BYTES = 40 * 1024 * 1024;

function parseArgs(argv) {
    // reindex VYPNUTÝ ve výchozím stavu: upload embedduje chunky rovnou, takže
    // celopartitionový re-embed je většinou zbytečný a jen zdvojnásobuje zátěž na
    // server/Ollamu (typická příčina „fetch failed" u velkých oborů). Zapni ho
    // explicitně přes --reindex (nebo když upload běžel bez modelu → vektory chybí).
    const a = {
        api: 'http://127.0.0.1:4000', delay: 250, reindex: false, dryRun: false,
        retries: 5, retryWait: 1500, serverWait: 180000
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--agent') a.agent = next();
        else if (k === '--obor') a.obor = next();
        else if (k === '--dir') a.dir = next();
        else if (k === '--root') a.root = next();
        else if (k === '--api') a.api = String(next()).replace(/\/+$/, '');
        else if (k === '--token') a.token = next();
        else if (k === '--token-file') a.tokenFile = next();
        else if (k === '--delay') a.delay = Math.max(0, parseInt(next(), 10) || 0);
        else if (k === '--reindex') a.reindex = true;
        else if (k === '--no-reindex') a.reindex = false;
        else if (k === '--retries') a.retries = Math.max(0, parseInt(next(), 10) || 0);
        else if (k === '--retry-wait') a.retryWait = Math.max(0, parseInt(next(), 10) || 0);
        else if (k === '--server-wait') a.serverWait = Math.max(0, parseInt(next(), 10) || 0);
        else if (k === '--dry-run') a.dryRun = true;
        else if (k === '--replace') a.replace = true;
        else if (k === '--help' || k === '-h') a.help = true;
        else { console.error(`Neznámý argument: ${k}`); a.help = true; }
    }
    return a;
}

function usage() {
    console.log(`seed-kb.js — naplní RAG znalostní bázi ze složky.

Režimy (jeden z nich):
  --agent <id>        báze AGENTA (např. resersnik, spisovatel) + --dir
  --obor <název>      OBOROVÁ báze (dělený RAG) + --dir
  --root <složka>     DÁVKA: každá podsložka = obor (naplní všechny najednou)

  --dir <cesta>       zdrojová složka (u --agent/--obor; projde se i rekurzivně)
  --api <url>         základ API (výchozí http://127.0.0.1:4000)
  --token <hodnota>   API token (nebo --token-file, nebo $LEXIS_API_TOKEN)
  --token-file <c>    soubor s tokenem (přečte se a ořízne)
  --delay <ms>        pauza mezi soubory (výchozí 250)
  --replace           dokumenty se STEJNÝM názvem v bázi nahradí (smaže a nahraje znovu) —
                      pro aktualizaci zákonů na nové znění (výchozí: přeskočí)
  --reindex           PO nahrání přepočítat vektory celé báze (těžké; výchozí VYP)
  --no-reindex        (výchozí) reindex nespouštět — upload embedduje rovnou
  --retries <N>       kolikrát zopakovat přechodný výpadek spojení (výchozí 5)
  --retry-wait <ms>   základ backoffu mezi pokusy (výchozí 1500)
  --server-wait <ms>  max. čekání na návrat spadlého serveru (výchozí 180000)
  --dry-run           jen vypíše, co by nahrál (nic neodešle)
  -h, --help          nápověda

Odolnost: přechodné výpadky (spadlé spojení, HTTP 5xx) se samy opakují; když
server spadne, běh POČKÁ, až naběhne, a plynule pokračuje (idempotentně).

Přípony: ${[...ALLOWED_EXT].join(', ')}`);
}

function resolveToken(a) {
    if (a.token) return String(a.token).trim();
    if (a.tokenFile) {
        try { return fs.readFileSync(a.tokenFile.replace(/^~(?=$|\/)/, process.env.HOME || ''), 'utf8').trim(); }
        catch (e) { throw new Error(`Token-file nelze přečíst: ${e.message}`); }
    }
    if (process.env.LEXIS_API_TOKEN) return String(process.env.LEXIS_API_TOKEN).trim();
    return null; // token nemusí být vynucený (LEXIS_ENFORCE_TOKEN=0)
}

// Rekurzivní výpis souborů s povolenou příponou (skryté složky přeskočí).
function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.isFile() && ALLOWED_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
    return out;
}

// Bezprostřední podsložky (pro --root); vrací [{name, dir}].
function subdirs(root) {
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, dir: path.join(root, e.name) }))
        .sort((x, y) => x.name.localeCompare(y.name));
}

function headers(token) {
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// HTTP status, které má smysl zkusit znovu (server se vzpamatuje / restartuje).
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

// Počká, až server znovu odpovídá (jakákoli HTTP odpověď = žije, i 401). Vrací
// true když naběhl, false po vyčerpání serverWait. Health-ping posílá stejné
// hlavičky jako reálný request (vč. tokenu), aby server nelogoval „🔒 nepovolený
// přístup" — auth brána jinak GET /api/status bez tokenu odmítne (a zbytečně straší).
async function waitForServer(a, authHeaders) {
    const deadline = Date.now() + (a.serverWait || 0);
    let announced = false;
    while (Date.now() <= deadline) {
        try {
            await fetch(`${a.api}/api/status`, { method: 'GET', headers: authHeaders || {} });
            if (announced) console.log('  ✅ server opět odpovídá, pokračuji.');
            return true;
        } catch (e) {
            if (!announced) { console.log(`  ⏳ server neodpovídá — čekám na jeho návrat (až ${Math.round((a.serverWait || 0) / 1000)} s)…`); announced = true; }
            await sleep(2000);
        }
    }
    return false;
}

// fetch s odolností: přechodný síťový výpadek nebo HTTP 5xx zopakuje s backoffem;
// při spadlém spojení navíc počká na návrat serveru (waitForServer). Trvalé chyby
// (4xx kromě 429) vrací hned. `a` nese retries/retryWait/serverWait/api.
async function apiFetch(a, url, opts, label) {
    let lastErr = null;
    for (let attempt = 0; attempt <= a.retries; attempt++) {
        try {
            const res = await fetch(url, opts);
            if (TRANSIENT_STATUS.has(res.status) && attempt < a.retries) {
                console.log(`  ⚠️ ${label}: HTTP ${res.status}, pokus ${attempt + 1}/${a.retries}…`);
                await sleep(a.retryWait * (attempt + 1));
                continue;
            }
            return res;
        } catch (e) {
            // Síťová chyba (spadlé spojení / server dole). Počkej na návrat a zopakuj.
            lastErr = e;
            if (attempt < a.retries) {
                console.log(`  ⚠️ ${label}: spojení selhalo (${e.message}), pokus ${attempt + 1}/${a.retries}…`);
                await waitForServer(a, opts && opts.headers);
                await sleep(a.retryWait * (attempt + 1));
                continue;
            }
        }
    }
    throw lastErr || new Error(`${label}: vyčerpány pokusy`);
}

async function listExisting(a, base, target, token) {
    const res = await apiFetch(a, `${a.api}${base}`, { headers: headers(token) }, `výpis „${target}"`);
    if (res.status === 404) throw new Error(`Cíl „${target}" na serveru neexistuje (404). Zkontroluj --agent / --obor.`);
    if (!res.ok) throw new Error(`Výpis báze selhal: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return new Set((data.documents || []).map(d => d.fileName));
}

async function uploadOne(a, base, token, file) {
    const label = path.basename(file);
    const buf = fs.readFileSync(file);
    if (!buf.length) return { skipped: true, reason: 'prázdný soubor' };
    if (buf.length > MAX_BYTES) return { skipped: true, reason: `> ${Math.round(MAX_BYTES / 1e6)} MB` };
    const res = await apiFetch(a, `${a.api}${base}/upload`, {
        method: 'POST', headers: headers(token),
        body: JSON.stringify({ fileName: label, base64: buf.toString('base64') })
    }, `upload ${label}`);
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
    let json = {}; try { json = JSON.parse(txt); } catch (e) {}
    return { ok: true, chunks: json.indexed, embedded: json.embedded, ocr: json.ocr };
}

// Naplní JEDNU bázi (agent/obor). Vrací souhrn a při chybě výpisu ho vyhodí.
async function ingest(a, token, base, target, dir) {
    const files = walk(dir).sort();
    if (!files.length) { console.log(`\n▶ ${target} — ⚠️ žádné podporované soubory, přeskočeno`); return { ok: 0, skip: 0, fail: 0, chunks: 0 }; }
    console.log(`\n▶ ${target} | ${files.length} souborů${a.dryRun ? ' | DRY-RUN' : ''}`);

    let existing = new Set();
    if (!a.dryRun) {
        existing = await listExisting(a, base, target, token);
        if (existing.size) console.log(`  ℹ️  v bázi už je ${existing.size} dok. — shodné názvy ${a.replace ? 'NAHRADÍM (--replace)' : 'přeskočím'}`);
    }

    let ok = 0, skip = 0, fail = 0, chunks = 0;
    for (let i = 0; i < files.length; i++) {
        const label = path.basename(files[i]);
        const tag = `[${i + 1}/${files.length}] ${label}`;
        if (existing.has(label) && !a.replace) { console.log(`  ⏭  ${tag} (už v bázi)`); skip++; continue; }
        if (existing.has(label) && a.replace && !a.dryRun) {
            try {
                const del = await apiFetch(a, `${a.api}${base}/${encodeURIComponent(label)}`, { method: 'DELETE', headers: headers(token) }, `smazání ${label}`);
                if (!del.ok) throw new Error(`HTTP ${del.status}`);
            } catch (e) { console.log(`  ❌ ${tag} — starou verzi nešlo smazat: ${e.message}`); fail++; continue; }
        }
        if (a.dryRun) { console.log(`  · ${tag}`); continue; }
        try {
            const r = await uploadOne(a, base, token, files[i]);
            if (r.skipped) { console.log(`  ⏭  ${tag} — ${r.reason}`); skip++; }
            else { chunks += (r.chunks || 0); console.log(`  ✅ ${tag} — ${r.chunks} chunků${r.embedded != null ? `, ${r.embedded} s vektorem` : ''}${r.ocr ? ', OCR' : ''}`); ok++; }
        } catch (e) { console.log(`  ❌ ${tag} — ${e.message}`); fail++; }
        if (a.delay) await sleep(a.delay);
    }
    if (!a.dryRun && a.reindex && ok > 0) {
        try {
            const res = await apiFetch(a, `${a.api}${base}/reindex`, { method: 'POST', headers: headers(token) }, 'reindex');
            const j = await res.json().catch(() => ({}));
            console.log(`  🔁 reindex: ${res.ok ? `${j.embedded ?? '?'}/${j.chunks ?? '?'} s vektorem` : `HTTP ${res.status}`}`);
            if (res.ok && j.embedded === 0) console.log('     ⚠️ 0 vektorů — embedding model nejspíš neběží; po spuštění spusť reindex znovu.');
        } catch (e) { console.log(`  🔁 reindex selhal: ${e.message}`); }
    }
    return { ok, skip, fail, chunks };
}

// Slug oboru — MUSÍ odpovídat oborSlug v backend/lib/rag_request.js.
function oborSlug(name) {
    return String(name == null ? '' : name).normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

async function main() {
    const a = parseArgs(process.argv);
    const modes = [a.agent && 'agent', a.obor && 'obor', a.root && 'root'].filter(Boolean);
    if (a.help || modes.length !== 1 || (!a.root && !a.dir)) {
        if (modes.length > 1) console.error(`❌ Zvol jen jeden režim: --agent / --obor / --root (zadáno: ${modes.join(', ')}).`);
        usage(); process.exit(a.help ? 0 : 1);
    }
    let token;
    try { token = resolveToken(a); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }

    // --- DÁVKA: --root, každá podsložka = obor -------------------------------
    if (a.root) {
        if (!fs.existsSync(a.root) || !fs.statSync(a.root).isDirectory()) { console.error(`❌ Kořenová složka neexistuje: ${a.root}`); process.exit(1); }
        const dirs = subdirs(a.root);
        if (!dirs.length) { console.error(`❌ V „${a.root}" nejsou žádné podsložky (obory).`); process.exit(1); }
        console.log(`📚 seed-kb DÁVKA → ${dirs.length} oborů z „${a.root}" | API ${a.api}${a.dryRun ? ' | DRY-RUN' : ''}`);
        for (const d of dirs) if (!oborSlug(d.name)) console.log(`  ⚠️ podsložka „${d.name}" → prázdný slug, přeskočím ji`);

        const total = { ok: 0, skip: 0, fail: 0, chunks: 0 }; let done = 0;
        for (const d of dirs) {
            if (!oborSlug(d.name)) continue;
            const base = `/api/knowledge/${encodeURIComponent(d.name)}`;
            try {
                const r = await ingest(a, token, base, `obor: ${d.name}`, d.dir);
                total.ok += r.ok; total.skip += r.skip; total.fail += r.fail; total.chunks += r.chunks; done++;
            } catch (e) { console.log(`  ❌ obor „${d.name}" — ${e.message}`); total.fail++; }
        }
        console.log(`\n════ HOTOVO: ${done} oborů · ✅ ${total.ok} nahráno (${total.chunks} chunků) · ⏭ ${total.skip} přeskočeno · ❌ ${total.fail} chyb`);
        if (total.fail > 0) process.exitCode = 2;
        return;
    }

    // --- JEDNA báze: --agent / --obor ---------------------------------------
    if (!fs.existsSync(a.dir) || !fs.statSync(a.dir).isDirectory()) { console.error(`❌ Složka neexistuje: ${a.dir}`); process.exit(1); }
    const base = a.obor ? `/api/knowledge/${encodeURIComponent(a.obor)}` : `/api/agent-knowledge/${encodeURIComponent(a.agent)}`;
    const target = a.obor ? `obor: ${a.obor}` : `agent: ${a.agent}`;
    console.log(`📚 seed-kb → ${target} | API ${a.api}${a.dryRun ? ' | DRY-RUN' : ''}`);
    let r;
    try { r = await ingest(a, token, base, target, a.dir); }
    catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
    console.log(`\nHotovo: ✅ ${r.ok} nahráno (${r.chunks} chunků) · ⏭ ${r.skip} přeskočeno · ❌ ${r.fail} chyb`);
    if (r.fail > 0) process.exitCode = 2;
}

main().catch(e => { console.error('❌ Neočekávaná chyba:', e.message); process.exit(1); });
