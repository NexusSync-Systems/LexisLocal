#!/usr/bin/env node
/**
 * kb_regression.js — zhoršila velká judikatura (NS, ÚS, NSS) hledání v bázi rešeršníka?
 *
 * Běží PŘÍMO nad daty (jako rag_eval.js), se stejným nastavením jako server (.env):
 * embedding model, hybrid, α. Potřebuje běžící Ollamu; server běžet nemusí.
 *
 * Měří:
 *  1) ZÁKONY — zlatá sada training/embed/gold_queries.json (dotaz → paragraf):
 *       a) „jen zákony"  = kandidáti jen ze zákonů (stav před nahráním judikatury),
 *       b) „plná báze"   = zákony + judikatura, jak hledá agent (dedupeKb, pool hybridu),
 *     hit@1 / hit@3 (= co dostane agent bez rerankeru) / hit@5, MRR, kolik míst v top 3
 *     zabrala judikatura a u kolika dotazů paragraf vypadl z top 3 kvůli judikatuře.
 *  2) POOL HYBRIDU — u prvních N dotazů porovná pool (RAG_HYBRID_POOL) s plným výpočtem:
 *     shoda top 3 a zrychlení.
 *  3) JUDIKATURA — náhodný vzorek rozhodnutí NS/ÚS/NSS (pevný seed): dotaz z jejich
 *     klíčových slov / populárního názvu → najde se rozhodnutí v top 5? (Orientační:
 *     dotaz vychází z hlavičky, která je v textu — měří hlavně, že se nic neztratilo.)
 *  4) VARIANTY K17 (jako agent v produkci, tj. s rerankerem, je-li zapnutý): dnešní přeřazení × přeřazení
 *     zákonů a judikatury zvlášť × navíc slovník hovorových pojmů a zvýhodnění zmíněného zákona — na zlaté
 *     sadě i na odložené sadě training/embed/holdout_queries.json (slovník podle ní laděn nebyl).
 *  + doba načtení báze, paměť, latence dotazu (p50/p95).
 *
 * Použití (z kořene projektu):
 *   node backend/scripts/kb_regression.js
 *   node backend/scripts/kb_regression.js --sample 30 --pool-compare 20 --limit 40
 * Výstup: tabulka v konzoli + bench-results/kb_regression_<čas>.md a .json
 */
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch (e) { /* bez dotenv: jen proměnné prostředí */ }

// Vektor dotazu se spočítá jednou a pro další varianty hledání se vezme z dočasné cache
// (veřejné dotazy zlaté sady, žádná data klientů) — latence hledání pak neobsahuje embedding,
// ten se měří zvlášť.
const os = require('os');
const _tmpCache = !process.env.EMBED_CACHE_FILE ? path.join(os.tmpdir(), `kb_regression_${process.pid}.jsonl`) : null;
if (_tmpCache) process.env.EMBED_CACHE_FILE = _tmpCache;

const rag = require('../lib/rag');

function parseArgs(argv) {
    const a = { scope: '_kb_resersnik', sample: 20, poolCompare: 15, limit: 0, gold: path.join(ROOT, 'training', 'embed', 'gold_queries.json'),
        holdout: path.join(ROOT, 'training', 'embed', 'holdout_queries.json'), varianty: true };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], next = () => argv[++i];
        if (k === '--scope') a.scope = next();
        else if (k === '--sample') a.sample = parseInt(next(), 10) || 0;
        else if (k === '--pool-compare') a.poolCompare = parseInt(next(), 10) || 0;
        else if (k === '--limit') a.limit = parseInt(next(), 10) || 0;
        else if (k === '--gold') a.gold = next();
        else if (k === '--holdout') a.holdout = next();
        else if (k === '--bez-variant') a.varianty = false;
        else if (k === '--help' || k === '-h') a.help = true;
        else { console.error(`Neznámý argument: ${k}`); a.help = true; }
    }
    return a;
}

const JUD = /^(NS|US|NSS)_/;
const isJud = f => JUD.test(String(f || ''));
const kindOf = f => (String(f).match(JUD) || [])[1] || 'zákon';

function pct(x) { return (100 * x).toFixed(1) + ' %'; }
function quantile(arr, q) { if (!arr.length) return 0; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

/** Deterministický výběr (mulberry32), aby šlo běhy porovnávat. */
function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }

const LABELS = ['Soud', 'Rozhodl', 'Sp\\. zn\\.', 'Datum vydání', 'Datum vyhlášení', 'ECLI', 'Sbírka[^:]{0,40}', 'Vyhlášeno[^:]{0,30}', 'Typ rozhodnutí',
    'Populární název', 'Soudce zpravodaj', 'Význam', 'Typ řízení', 'Výrok', 'Napadený akt', 'Dotčené ústavní předpisy', 'Zmíněná ustanovení',
    'Předmět řízení', 'Klíčová slova', 'Odlišné stanovisko', 'Zdroj', 'Data', 'K ustanovení', 'Související judikatura', 'Druh', 'Právní věta'];
/**
 * Dotaz z hlavičky rozhodnutí: populární název (ÚS) / klíčová slova / začátek právní věty.
 * Pozor: v kouscích báze jsou řádky slité mezerou (chunkText), proto se hodnota hledá
 * až po další známý popisek, ne po konec řádku.
 */
function queryFromHeader(text) {
    const next = '(?=\\s+(?:' + LABELS.join('|') + '):|\\n|$)';
    const line = label => ((new RegExp(label + ':\\s*([\\s\\S]+?)' + next).exec(text) || [])[1] || '').trim();
    // Pořadí: populární název (ÚS) → první věta právní věty → klíčová slova. Klíčová slova NS
    // („Insolvence, Konkurs, Zástavní právo") sdílí stovky rozhodnutí, takže jedno konkrétní
    // podle nich dohledat nejde (server 24. 10.: NS hit@5 21 % jen kvůli tomu) — jsou až poslední.
    let q = line('Populární název');
    if (!q) {
        // Začátek právní věty (~200 znaků, celá slova). Ne „do první tečky": zkratky
        // („§ 26 odst. 1") větu useknou a dlouhé věty tečku v dosahu nemají.
        const pv = /Právní věta:\s*([\s\S]{20,})/.exec(text);
        if (pv) {
            const t = pv[1].replace(/\s+/g, ' ').trim();
            q = t.length > 200 ? t.slice(0, 200).replace(/\s+\S*$/, '') : t;
        }
    }
    if (!q) q = line('Klíčová slova');
    return q.replace(/\s+/g, ' ').slice(0, 220).trim();
}

function rankOf(results, rel) {
    const want = new Set(rel);
    const i = results.findIndex(r => want.has(r.fileName));
    return i < 0 ? 0 : i + 1;
}

async function timed(fn) { const t = process.hrtime.bigint(); const r = await fn(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; }

// Garbage collector: kolik ms z hledání připadne na úklid paměti (velká báze = velká halda).
const { PerformanceObserver } = require('perf_hooks');
let _gcMs = 0;
try { new PerformanceObserver(list => { for (const e of list.getEntries()) _gcMs += e.duration; }).observe({ entryTypes: ['gc'] }); } catch (e) { /* bez měření GC */ }
const faze = {};
function zapisFaze(variant, t, gc) {
    const f = faze[variant] = faze[variant] || { n: 0, gc: 0 };
    f.n++; f.gc += gc;
    for (const [k, v] of Object.entries(t)) f[k] = (f[k] || 0) + v;
}
/** Hledání s měřením fází a GC. */
async function hledej(variant, q, limit, F, opts) {
    const t = {};
    const gc0 = _gcMs;
    const [r, ms] = await timed(() => rag.searchSimilar(q, limit, F, Object.assign({}, opts, { timing: t })));
    await new Promise(res => setImmediate(res)); // nechat doběhnout záznamy GC
    zapisFaze(variant, t, _gcMs - gc0);
    return [r, ms];
}

async function main() {
    const a = parseArgs(process.argv);
    if (a.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }
    const F = { scopes: [a.scope], clientAccess: false };
    const out = { datum: new Date().toISOString(), scope: a.scope, env: {
        EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || '(výchozí)', RAG_HYBRID: process.env.RAG_HYBRID || '0',
        RAG_HYBRID_ALPHA: process.env.RAG_HYBRID_ALPHA || '(výchozí)', RAG_HYBRID_POOL: process.env.RAG_HYBRID_POOL || '(výchozí 400)',
        RAG_RERANK: process.env.RAG_RERANK || '0', agentK: rag.agentRagK(),
    } };

    // --- Báze ---
    const heap0 = process.memoryUsage().heapUsed;
    const [part, loadMs] = await timed(async () => rag.loadPartition(a.scope));
    const chunks = part.chunks || [];
    if (!chunks.length) { console.error(`❌ Báze ${a.scope} je prázdná nebo nečitelná.`); process.exit(2); }
    const docs = new Map();
    for (const c of chunks) { if (!docs.has(c.fileName)) docs.set(c.fileName, c); else if (c.chunkIndex === 0) docs.set(c.fileName, c); }
    const perKind = {};
    for (const c of chunks) { const k = kindOf(c.fileName); perKind[k] = perKind[k] || { dokumentu: new Set(), kousku: 0 }; perKind[k].kousku++; perKind[k].dokumentu.add(c.fileName); }
    const mu = process.memoryUsage();
    out.baze = { kousku: chunks.length, dokumentu: docs.size, nacteniMs: Math.round(loadMs), heapMB: Math.round((mu.heapUsed - heap0) / 1e6),
        rssMB: Math.round(mu.rss / 1e6), mimoHaldu: Math.round((mu.external + mu.arrayBuffers) / 1e6),
        vektory: chunks[0] && chunks[0].vector ? chunks[0].vector.constructor.name : '?',
        podleDruhu: Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, { dokumentu: v.dokumentu.size, kousku: v.kousku }])) };
    console.log(`\n📚 ${a.scope}: ${chunks.length} kousků, ${docs.size} dokumentů, načtení ${(loadMs / 1000).toFixed(1)} s, halda +${out.baze.heapMB} MB, mimo haldu ${out.baze.mimoHaldu} MB, RSS ${out.baze.rssMB} MB, vektory ${out.baze.vektory}`);
    for (const [k, v] of Object.entries(out.baze.podleDruhu)) console.log(`   ${k.padEnd(6)} ${String(v.dokumentu).padStart(6)} dok. · ${v.kousku} kousků`);
    console.log(`   nastavení: ${JSON.stringify(out.env)}`);

    // Zahřátí (embedding model, cache partition).
    await rag.searchSimilar('zahřátí', 3, F, { dedupeKb: true });

    // --- 1) Zákony ---
    const gold = JSON.parse(fs.readFileSync(a.gold, 'utf8')).queries || [];
    let cases = gold.filter(g => g.rel.some(r => docs.has(r)));
    const chybi = gold.length - cases.length;
    if (a.limit) cases = cases.slice(0, a.limit);
    console.log(`\n⚖️  Zákony: ${cases.length} dotazů${chybi ? ` (${chybi} vynecháno — paragraf není v bázi)` : ''}`);
    const K = 5, KA = rag.agentRagK(); // kolik pasáží dostane agent (RAG_AGENT_K; výchozí 3 bez rerankeru)
    const stat = () => ({ h1: 0, h3: 0, h5: 0, mrr: 0, judTop3: 0, lawTop3: 0, vytlaceno: 0, lat: [] });
    const S = { jenZakony: stat(), plna: stat(), bezMixu: stat() };
    const embLat = [];
    const detail = [];
    for (let i = 0; i < cases.length; i++) {
        const g = cases[i];
        const [, te] = await timed(() => rag.getEmbedding(g.q)); // naplní cache; měří embedding
        embLat.push(te);
        const [rz, tz] = await hledej('jen zákony', g.q, K, F, { dedupeKb: true, kbFilter: c => !isJud(c.fileName) });
        // Agent hledá s limitem k = agentRagK (3) — poměr zákonů a judikatury se počítá z něj.
        const [rp, tp] = await hledej('agent (mix)', g.q, KA, F, { dedupeKb: true });
        const [rb, tb] = await hledej('bez mixu', g.q, K, F, { dedupeKb: true, kbMix: false });
        const rankZ = rankOf(rz, g.rel), rankP = rankOf(rp, g.rel), rankB = rankOf(rb, g.rel);
        for (const [s, rank, res, t] of [[S.jenZakony, rankZ, rz, tz], [S.plna, rankP, rp, tp], [S.bezMixu, rankB, rb, tb]]) {
            if (rank === 1) s.h1++;
            if (rank && rank <= KA) s.h3++;
            if (rank && rank <= K) s.h5++;
            if (rank) s.mrr += 1 / rank;
            s.judTop3 += res.slice(0, KA).filter(r => isJud(r.fileName)).length;
            s.lawTop3 += res.slice(0, KA).some(r => !isJud(r.fileName)) && res.slice(0, KA).some(r => isJud(r.fileName)) ? 1 : 0;
            s.lat.push(t);
        }
        const vytlacen = rankZ && rankZ <= KA && !(rankP && rankP <= KA);
        if (vytlacen) S.plna.vytlaceno++;
        detail.push({ q: g.q, rel: g.rel, rankJenZakony: rankZ, rankPlna: rankP, top3Plna: rp.slice(0, KA).map(r => r.fileName), vytlacen });
        process.stdout.write(`\r   ${i + 1}/${cases.length}`);
    }
    process.stdout.write('\n');
    const n = cases.length || 1;
    const shrn = s => ({ hit1: s.h1 / n, hit3: s.h3 / n, hit5: s.h5 / n, mrr: s.mrr / n, judikaturaVTop3: s.judTop3 / (n * KA), obojiVTop3: s.lawTop3 / n, vytlacenoJudikaturou: s.vytlaceno, latP50: quantile(s.lat, 0.5), latP95: quantile(s.lat, 0.95) });
    out.zakony = { dotazu: cases.length, vynechano: chybi, embeddingP50: quantile(embLat, 0.5), embeddingP95: quantile(embLat, 0.95),
        jenZakony: shrn(S.jenZakony), plnaBaze: shrn(S.plna), bezMixu: shrn(S.bezMixu), vytlacene: detail.filter(d => d.vytlacen) };
    const row = (name, s) => console.log(`   ${name.padEnd(16)} hit@1 ${pct(s.hit1).padStart(7)} | hit@3 ${pct(s.hit3).padStart(7)} | hit@5 ${pct(s.hit5).padStart(7)} | MRR ${s.mrr.toFixed(3)} | judikatura v top 3 ${pct(s.judikaturaVTop3).padStart(7)} | zákon i judikatura ${pct(s.obojiVTop3).padStart(7)} | hledání ${Math.round(s.latP50)}/${Math.round(s.latP95)} ms`);
    row('jen zákony', out.zakony.jenZakony);
    row('agent (mix)', out.zakony.plnaBaze);
    row('bez mixu', out.zakony.bezMixu);
    console.log(`   embedding dotazu p50/p95: ${Math.round(out.zakony.embeddingP50)}/${Math.round(out.zakony.embeddingP95)} ms   (agent má jen ${KA} výsledky → hit@5 = hit@3)`);
    out.faze = Object.fromEntries(Object.entries(faze).map(([v, f]) => [v, Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'n').map(([k, x]) => [k, Math.round(x / f.n)]))]));
    console.log('   průměrné fáze hledání (ms):');
    for (const [v, f] of Object.entries(out.faze)) console.log(`     ${v.padEnd(14)} ${Object.entries(f).map(([k, x]) => `${k} ${x}`).join(' · ')}`);
    console.log(`   paragraf vypadl z top ${KA} kvůli judikatuře: ${out.zakony.plnaBaze.vytlacenoJudikaturou}×`);
    for (const d of out.zakony.vytlacene.slice(0, 8)) console.log(`     – „${d.q}" → ${d.rel[0]} (bez judikatury #${d.rankJenZakony}, s ní ${d.rankPlna ? '#' + d.rankPlna : 'mimo top 5'}; top 3: ${d.top3Plna.join(', ')})`);

    // --- 1b) Varianty K17 (jako agent v produkci: rerank) ---
    if (a.varianty) {
        let holdout = [];
        try { holdout = (JSON.parse(fs.readFileSync(a.holdout, 'utf8')).queries || []).filter(g => g.rel.some(r => docs.has(r))); } catch (e) { /* bez odložené sady */ }
        const VAR = [
            ['produkce (dnes)', { rerankSplit: false, queryTerms: false }],
            ['+ přeřazení zvlášť', { rerankSplit: true, queryTerms: false }],
            ['+ zvlášť + slovník', { rerankSplit: true, queryTerms: true }],
        ];
        out.varianty = { rerank: require('../lib/rerank_service').rerankEnabled(), sady: {} };
        for (const [sada, qs] of [['zlatá', cases], ['zlatá – klient', cases.filter(g => g.styl === 'klient')], ['odložená', holdout]]) {
            if (!qs.length) continue;
            out.varianty.sady[sada] = {};
            for (const [nm, o] of VAR) {
                const st = { h1: 0, hk: 0, mrr: 0, lat: [] };
                for (const g of qs) {
                    const [r, t] = await timed(() => rag.searchSimilar(g.q, KA, F, Object.assign({ dedupeKb: true, rerank: true }, o)));
                    const rk = rankOf(r, g.rel);
                    if (rk === 1) st.h1++;
                    if (rk && rk <= KA) st.hk++;
                    if (rk) st.mrr += 1 / rk;
                    st.lat.push(t);
                }
                const m = qs.length;
                out.varianty.sady[sada][nm] = { dotazu: m, hit1: st.h1 / m, hitK: st.hk / m, mrr: st.mrr / m, latP50: quantile(st.lat, 0.5), latP95: quantile(st.lat, 0.95) };
                const v = out.varianty.sady[sada][nm];
                console.log(`   ${sada.padEnd(15)} ${nm.padEnd(20)} hit@1 ${pct(v.hit1).padStart(7)} | hit@${KA} ${pct(v.hitK).padStart(7)} | MRR ${v.mrr.toFixed(3)} | ${Math.round(v.latP50)}/${Math.round(v.latP95)} ms`);
            }
        }
    }

    // --- 2) Pool hybridu vs. plný výpočet ---
    if (a.poolCompare && String(process.env.RAG_HYBRID || '') !== '0' && process.env.RAG_HYBRID) {
        const m = Math.min(a.poolCompare, cases.length);
        let shoda = 0, tPool = 0, tFull = 0, rankFull = 0, rankPool = 0;
        console.log(`\n🧮 Pool hybridu vs. plný výpočet (${m} dotazů, plný výpočet je pomalý)…`);
        for (let i = 0; i < m; i++) {
            const g = cases[i];
            const [rp, tp] = await timed(() => rag.searchSimilar(g.q, K, F, { dedupeKb: true }));
            const [rf, tf] = await timed(() => rag.searchSimilar(g.q, K, F, { dedupeKb: true, hybridPool: 0 }));
            if (JSON.stringify(rp.slice(0, KA).map(r => r.fileName)) === JSON.stringify(rf.slice(0, KA).map(r => r.fileName))) shoda++;
            const a1 = rankOf(rp, g.rel), b1 = rankOf(rf, g.rel);
            if (a1 && a1 <= KA) rankPool++;
            if (b1 && b1 <= KA) rankFull++;
            tPool += tp; tFull += tf;
            process.stdout.write(`\r   ${i + 1}/${m}`);
        }
        process.stdout.write('\n');
        out.pool = { dotazu: m, shodaTop3: shoda / m, hit3Pool: rankPool / m, hit3Plny: rankFull / m, msPool: tPool / m, msPlny: tFull / m };
        console.log(`   shoda top 3: ${pct(out.pool.shodaTop3)} | hit@3 pool ${pct(out.pool.hit3Pool)} vs. plný ${pct(out.pool.hit3Plny)} | ${Math.round(out.pool.msPool)} ms vs. ${Math.round(out.pool.msPlny)} ms na dotaz`);
    }

    // --- 3) Judikatura ---
    if (a.sample) {
        const rand = rng(20261023);
        out.judikatura = {};
        console.log(`\n🏛️  Judikatura: vzorek ${a.sample} rozhodnutí z každého soudu`);
        for (const kind of ['NS', 'US', 'NSS']) {
            const files = [...docs.keys()].filter(f => kindOf(f) === kind).sort();
            if (!files.length) { console.log(`   ${kind}: v bázi nic`); continue; }
            const picked = new Set();
            while (picked.size < Math.min(a.sample, files.length)) picked.add(files[Math.floor(rand() * files.length)]);
            let hit = 0, tested = 0; const lat = []; const miss = [];
            for (const f of picked) {
                const q = queryFromHeader(docs.get(f).text || '');
                if (q.length < 8) continue;
                tested++;
                const [r, t] = await timed(() => rag.searchSimilar(q, K, F, { dedupeKb: true }));
                lat.push(t);
                if (rankOf(r, [f])) hit++; else miss.push({ f, q });
            }
            out.judikatura[kind] = { testovano: tested, hit5: tested ? hit / tested : 0, latP50: quantile(lat, 0.5), nenalezeno: miss };
            console.log(`   ${kind.padEnd(4)} hit@5 ${pct(out.judikatura[kind].hit5)} (${hit}/${tested})${miss[0] ? ` — např. nenalezeno ${miss[0].f} pro „${miss[0].q.slice(0, 80)}"` : ''}`);
        }
    }

    // --- Zápis ---
    const dir = path.join(ROOT, 'bench-results');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = out.datum.replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(dir, `kb_regression_${stamp}.json`), JSON.stringify(out, null, 2));
    const z = out.zakony;
    const md = [
        `# Regrese báze ${a.scope} — ${out.datum.slice(0, 16).replace('T', ' ')}`, '',
        `Báze: ${out.baze.kousku} kousků, ${out.baze.dokumentu} dokumentů, načtení ${(out.baze.nacteniMs / 1000).toFixed(1)} s, paměť +${out.baze.heapMB} MB.`, '',
        `Nastavení: \`${JSON.stringify(out.env)}\``, '',
        `## Zákony (${z.dotazu} dotazů)`, '',
        '| | hit@1 | hit@3 (agent) | hit@5 | MRR | judikatura v top 3 | zákon i judikatura v top 3 | hledání p50/p95 |', '|---|---|---|---|---|---|---|---|',
        ...[['jen zákony', z.jenZakony], ['agent (mix)', z.plnaBaze], ['bez mixu', z.bezMixu]].map(([nm, s]) => `| ${nm} | ${pct(s.hit1)} | ${pct(s.hit3)} | ${pct(s.hit5)} | ${s.mrr.toFixed(3)} | ${pct(s.judikaturaVTop3)} | ${pct(s.obojiVTop3)} | ${Math.round(s.latP50)} / ${Math.round(s.latP95)} ms |`),
        '', `Embedding dotazu p50/p95: ${Math.round(z.embeddingP50)} / ${Math.round(z.embeddingP95)} ms (v tabulce není).`,
        '', `Paragraf vypadl z top 3 kvůli judikatuře: **${z.plnaBaze.vytlacenoJudikaturou}×**`, '',
        ...z.vytlacene.map(d => `- „${d.q}" → ${d.rel.join(', ')} (bez judikatury #${d.rankJenZakony}, s ní ${d.rankPlna ? '#' + d.rankPlna : 'mimo top 5'}); top 3: ${d.top3Plna.join(', ')}`),
        '',
        out.varianty ? `## Varianty K17 (jako agent${out.varianty.rerank ? ', s rerankerem' : ', BEZ rerankeru'}, ${KA} pasáží)\n\n| Sada | Varianta | hit@1 | hit@${KA} (agent) | MRR | hledání p50/p95 |\n|---|---|---|---|---|---|\n` +
            Object.entries(out.varianty.sady).map(([sada, vs]) => Object.entries(vs).map(([nm, v]) => `| ${sada} (${v.dotazu}) | ${nm} | ${pct(v.hit1)} | ${pct(v.hitK)} | ${v.mrr.toFixed(3)} | ${Math.round(v.latP50)} / ${Math.round(v.latP95)} ms |`).join('\n')).join('\n') + '\n' : '',
        out.pool ? `## Pool hybridu\n\nShoda top 3 s plným výpočtem ${pct(out.pool.shodaTop3)}, hit@3 ${pct(out.pool.hit3Pool)} (pool) vs. ${pct(out.pool.hit3Plny)} (plný), ${Math.round(out.pool.msPool)} ms vs. ${Math.round(out.pool.msPlny)} ms na dotaz.\n` : '',
        out.judikatura ? '## Judikatura (vzorek)\n\n' + Object.entries(out.judikatura).map(([k, v]) => `- ${k}: hit@5 ${pct(v.hit5)} (${v.testovano} rozhodnutí), p50 ${Math.round(v.latP50)} ms`).join('\n') + '\n' : '',
    ].join('\n');
    const mdPath = path.join(dir, `kb_regression_${stamp}.md`);
    fs.writeFileSync(mdPath, md);
    console.log(`\n📝 Report: ${path.relative(ROOT, mdPath)}`);
    if (_tmpCache) { try { fs.unlinkSync(_tmpCache); } catch (e) { /* nic */ } }
}

if (require.main === module) main().catch(e => { console.error('❌ ' + (e.stack || e.message)); process.exit(1); });

module.exports = { queryFromHeader, rankOf, kindOf };
