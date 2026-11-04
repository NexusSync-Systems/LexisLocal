#!/usr/bin/env node
/**
 * scripts/spis_eval.js — eval sada nad SYNTETICKÝMI spisy: typ úlohy × model (heat mapa), citace jako vlastní metrika.
 *
 *   node backend/scripts/spis_eval.js --provider bedrock [--model eu.anthropic.claude-sonnet-4-6] --label sonnet46
 *   node backend/scripts/spis_eval.js --provider ollama --model qwen2.5:3b --label qwen3b
 *   node backend/scripts/spis_eval.js --provider mock                    # zlaté odpovědi — kontrola samotného harnessu (zdarma)
 *
 * Přepínače: --rezim aplikace|model   aplikace (výchozí) = celý řetězec /api/agent (osnovy, pravidla zdůvodnění, kontroly
 *                                      výstupu, pseudonymizace) nad dočasnou databází se syntetickými spisy;
 *                                      model = jen model s dokumenty v kontextu (čisté porovnání modelů)
 *            --typy reserse,citace     jen vybrané typy      --pripady R1,C2   jen vybrané případy
 *            --opakovani 3             každý případ víckrát (rozptyl)        --out <složka> (výchozí scratch/spis-eval)
 *            --judge / --judge-vse     LLM-judge posoudí nejisté / všechny platné citace (ANO/NE; eval/spis_eval/judge.js)
 *            --max-tokens 2000  --timeout 300 (s)  --aws-profile lexislocal-pilot
 * Výstup: <out>/<čas>_<label>.json (surové odpovědi, chyby, citace, souhrn) + .md (heat mapa, nejčastější chyby).
 * Porovnání běhů: node backend/scripts/spis_eval_compare.js A.json B.json [C.json …]
 *
 * Data: backend/eval/spis_eval/ (spisy S1–S4 a cases.json) — vše smyšlené. NIKDY sem nedávat reálné spisy.
 * Běží nad dočasnou databází (nesahá na spisy, audit ani nastavení kanceláře). Klíče nevypisuje.
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const EVAL = path.join(__dirname, '..', 'eval', 'spis_eval');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const flag = k => args.includes(k);
const PROVIDER = String(arg('--provider', 'mock')).toLowerCase();
const REZIM = String(arg('--rezim', 'aplikace')).toLowerCase();
const MODEL = arg('--model', null);
const OPAK = Math.max(1, Math.min(10, parseInt(arg('--opakovani', '1'), 10) || 1));
const MAXTOK = parseInt(arg('--max-tokens', '2000'), 10) || 2000;
const TIMEOUT = (parseInt(arg('--timeout', '300'), 10) || 300) * 1000;
const TYPY = arg('--typy', null) ? arg('--typy').split(',') : null;
const PRIPADY = arg('--pripady', null) ? arg('--pripady').split(',') : null;
const OUT = path.resolve(arg('--out', path.join(ROOT, 'scratch', 'spis-eval')));
const JUDGE_VSE = flag('--judge-vse');
const JUDGE = flag('--judge') || JUDGE_VSE;
if (!['bedrock', 'ollama', 'mock'].includes(PROVIDER)) { console.error('--provider bedrock | ollama | mock'); process.exit(2); }
if (!['aplikace', 'model'].includes(REZIM)) { console.error('--rezim aplikace | model'); process.exit(2); }

try { require('../lib/env_load').nacti({ cwd: ROOT }); } catch (e) { /* bez .env */ }
if (arg('--aws-profile')) process.env.AWS_PROFILE = arg('--aws-profile');

// Dočasná data — žádný zásah do spisů kanceláře.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-spiseval-'));
process.env.WATCH_DIR = path.join(TMP, 'data'); process.env.LEXIS_DATA_DIR = path.join(TMP, 'settings'); process.env.LEXIS_KEY_DIR = path.join(TMP, 'key');
fs.mkdirSync(process.env.WATCH_DIR, { recursive: true });
process.env.API_TOKEN = crypto.randomBytes(16).toString('hex');
delete process.env.LEXIS_PILOT_LOCAL_ONLY; delete process.env.AI_LOCAL_ONLY;
process.env.LEXIS_KB_CASE_INDEX_MIN = '999999';   // báze judikatury v dočasné databázi není → nic nevypouštět
if (PROVIDER === 'bedrock') {
    process.env.AI_CHAT_PROVIDER = 'bedrock';
    process.env.LEXIS_JEN_CLOUD = '1';               // žádný tichý záskok lokálním modelem — chyba je chyba
    if (MODEL) process.env.BEDROCK_MODEL_ID = MODEL;
} else {
    process.env.AI_CHAT_PROVIDER = 'ollama';
    delete process.env.LEXIS_JEN_CLOUD;
    const m = MODEL || process.env.CHAT_MODEL || 'llama3';
    for (const k of ['CHAT_MODEL', 'DRAFT_MODEL', 'REVIEW_MODEL', 'FAST_MODEL']) process.env[k] = m;   // všichni agenti stejný model
}
if (String(process.env.AI_EMBED_PROVIDER || '').toLowerCase() === 'onnx') process.env.AI_EMBED_PROVIDER = 'ollama';

// Mock: „model“ vrací zlatou odpověď aktuálního případu (ověření harnessu bez AI).
let aktualni = null;
if (PROVIDER === 'mock') {
    const ocPath = require.resolve('../lib/ollama_client');
    require.cache[ocPath] = { id: ocPath, filename: ocPath, loaded: true, exports: {
        chat: async () => ({ message: { content: aktualni ? aktualni.reference : '' } }),
        embeddings: async () => { throw new Error('mock: bez embeddingů'); }, list: async () => ({ models: [] })
    } };
}
// Vyhledávání: dokumenty spisu jdou do kontextu, báze v dočasné databázi je prázdná → RAG přeskočit (rychlost, žádné embeddingy).
const rag = require('../lib/rag');
rag.searchSimilar = async () => [];

const C = require('../eval/spis_eval/checks');
const SPISY = C.nactiSpisy(path.join(EVAL, 'spisy'));
const SADA = JSON.parse(fs.readFileSync(path.join(EVAL, 'cases.json'), 'utf8'));
let pripady = SADA.pripady.filter(p => (!TYPY || TYPY.includes(p.typ)) && (!PRIPADY || PRIPADY.includes(p.id)));

function kontext(p) {
    const spis = SPISY[p.spis];
    return (p.docs || Object.keys(spis.docs)).map(k => `=== Dokument: ${spis.docs[k].nazev} ===\n${spis.docs[k].text.trim()}`).join('\n\n');
}
function hash(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12); }
function gitCommit() { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return null; } }

async function main() {
    // --prehodnot <běh.json>: znovu vyhodnotí uložené odpovědi aktuálními kontrolami (bez volání modelu, zdarma).
    if (arg('--prehodnot')) {
        const src = JSON.parse(fs.readFileSync(arg('--prehodnot'), 'utf8'));
        const vys = src.vysledky.map(r => {
            const p = SADA.pripady.find(x => x.id === r.id);
            return Object.assign({ opakovani: r.opakovani, ms: r.ms, odpoved: r.odpoved, chybaBehu: r.chybaBehu },
                C.vyhodnot(p, r.odpoved, SPISY, { chyba: r.chybaBehu, dnes: src.meta.datum }), { meta: r.meta });
        });
        const out = { meta: Object.assign({}, src.meta, { label: src.meta.label + '-prehodnoceno', prehodnoceno: new Date().toISOString(),
            sada: Object.assign({}, src.meta.sada, { hash: hash(fs.readFileSync(path.join(EVAL, 'cases.json'))) }) }), souhrn: souhrnBehu(vys), vysledky: vys };
        const stem = path.join(OUT, path.basename(arg('--prehodnot')).replace(/\.json$/, '') + '_prehodnoceno');
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(stem + '.json', JSON.stringify(out, null, 1));
        fs.writeFileSync(stem + '.md', require('./spis_eval_compare').report([src, out]));
        console.log(require('./spis_eval_compare').tabulka([src, out]));
        console.log(`\nVýsledek: ${stem}.json\n          ${stem}.md`);
        return;
    }
    // Bedrock: přístup k AWS ověřit hned — ne 48× „chyba běhu“ (klíč se nevypisuje).
    if (PROVIDER === 'bedrock') {
        try { const c = await require('../lib/bedrock').credentialsAsync(); if (!c || !c.accessKeyId) throw new Error('bez klíče'); }
        catch (e) {
            console.error(`❌ Bez přístupu k AWS (${String(e.message || e).slice(0, 160)}).\n   Zkontrolujte profily: aws configure list-profiles — a spusťte s --aws-profile <profil>, který smí volat Bedrock v EU.`);
            process.exit(2);
        }
    }
    const P = require('../lib/cloud_policy');
    const spisy = require('../lib/spisy');
    const ADV = { userId: 'eval', name: 'Eval', kind: 'user', scopes: ['read', 'write', 'approve'] };
    const spisId = {};
    for (const s of Object.values(SPISY)) {
        const sp = spisy.createSpis({ spisZn: s.spisZn, nazev: s.nazev });
        try { P.udelSouhlas(sp.id, { typ: 'spis', principal: ADV, poznamka: 'eval — syntetická data' }); } catch (e) { /* lokální model souhlas nepotřebuje */ }
        spisId[s.id] = sp.id;
    }

    let base = null, server = null;
    if (REZIM === 'aplikace') {
        const app = require('../server');
        server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
        base = `http://127.0.0.1:${server.address().port}`;
    }
    const ai = require('../lib/ai_provider');
    const LB = require('../lib/legal_basis');
    const agents = require('../lib/agents').loadAgents();

    const modelNazev = PROVIDER === 'bedrock' ? (process.env.BEDROCK_MODEL_ID || '?') : PROVIDER === 'mock' ? 'mock (zlaté odpovědi)' : process.env.CHAT_MODEL;
    const label = arg('--label', `${PROVIDER}-${String(modelNazev).replace(/[^A-Za-z0-9.-]+/g, '_')}`);
    console.log(`Spis eval — ${pripady.length} případů × ${OPAK} · ${PROVIDER} · model ${modelNazev} · režim ${REZIM}${JUDGE ? ' · judge' : ''}\n`);

    const vysledky = [];
    let naklady = 0, tokIn = 0, tokOut = 0;
    // Běh 4. 11. 2026: Mac uprostřed usnul / ztratil síť → 24 případů „chyba běhu“ a skóre 43 místo ~90.
    // Po 3 výpadcích cloudu / sítě za sebou se běh přeruší a uloží jen hotové případy (meta.prerusen).
    let vypadkuZaSebou = 0, prerusen = null;
    const jeVypadek = t => /HTTP 503|nedostupn|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|aborted/i.test(String(t || ''));
    vnejsi:
    for (let o = 1; o <= OPAK; o++) {
        for (const p of pripady) {
            aktualni = p;
            const t0 = Date.now();
            let odpoved = '', chybaBehu = null, meta = {};
            try {
                if (REZIM === 'aplikace') {
                    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), TIMEOUT);
                    const r = await fetch(`${base}/api/agent/${p.agent}`, {
                        method: 'POST', signal: ctl.signal,
                        headers: { 'Content-Type': 'application/json', 'X-API-Token': process.env.API_TOKEN },
                        body: JSON.stringify({ prompt: p.prompt, context: kontext(p), caseNumber: SPISY[p.spis].spisZn, model: process.env.CHAT_MODEL })
                    });
                    clearTimeout(tm);
                    const j = await r.json().catch(() => ({}));
                    if (!r.ok) throw new Error(`HTTP ${r.status}: ${j.error || ''}`.slice(0, 300));
                    odpoved = j.response || '';
                    const n = j.cloudPolicy && j.cloudPolicy.naklady;
                    meta = { modelUsed: j.modelUsed || null, cloud: j.cloudPolicy ? j.cloudPolicy.cloud : null, naklady: n || null,
                        kontrolaAplikace: j.outputGuard ? { taskKind: j.outputGuard.taskKind, selfCheck: j.outputGuard.selfCheck ? j.outputGuard.selfCheck.found : [], judikatyVypusteno: j.outputGuard.judikatyVypusteno || [] } : null,
                        neovereneCitace: j.citationCheck ? j.citationCheck.unverifiedCount : null };
                    if (n) { naklady += n.odhadUsd || 0; tokIn += n.inputTokens || 0; tokOut += n.outputTokens || 0; }
                } else {
                    const agent = agents[p.agent];
                    const r = await P.scope({}, async () => {
                        P.noteSpis(spisId[p.spis]);
                        const x = await ai.chat({ model: process.env.CHAT_MODEL, options: { temperature: 0, num_predict: MAXTOK, max_tokens: MAXTOK },
                            messages: [{ role: 'system', content: LB.systemPrompt(agent) + '\n\nOdpovídej jen z dokumentů spisu níže. Když v nich údaj není, řekni to.' },
                                { role: 'system', content: 'Dokumenty spisu:\n' + kontext(p) }, { role: 'user', content: p.prompt }] });
                        return { x, sh: P.shrnuti() };
                    });
                    odpoved = (r.x && r.x.message && r.x.message.content) || '';
                    const n = r.sh && r.sh.naklady;
                    if (n) { naklady += n.odhadUsd || 0; tokIn += n.inputTokens || 0; tokOut += n.outputTokens || 0; }
                    meta = { cloud: r.sh ? r.sh.cloud : null, naklady: n || null };
                }
            } catch (e) { chybaBehu = String(e.message || e).slice(0, 300); }
            const ms = Date.now() - t0;
            const v = C.vyhodnot(p, odpoved, SPISY, { chyba: chybaBehu });
            if (JUDGE && !chybaBehu) await posudNejiste(v, p, ai, P);
            vysledky.push(Object.assign({ opakovani: o, ms, odpoved, chybaBehu }, v, { meta }));
            console.log(`${v.prosel ? '✅' : '❌'} ${p.id.padEnd(3)} ${p.typ.padEnd(17)} ${String(v.skore).padStart(3)}  ${(ms / 1000).toFixed(1)} s  ${v.chyby.map(c => c.typ).join(', ')}${chybaBehu ? '  ← ' + chybaBehu.slice(0, 140) : ''}`);
            // Případ trval mnohem déle než časový limit → proces stál (spánek Macu); hodiny běžely dál.
            if (ms > TIMEOUT * 1.5) console.log(`   ⚠️  ${Math.round(ms / 1000)} s > limit ${TIMEOUT / 1000} s — Mac nejspíš usnul. Spouštějte přes „caffeinate -i node …“.`);
            vypadkuZaSebou = chybaBehu && jeVypadek(chybaBehu) ? vypadkuZaSebou + 1 : 0;
            if (vypadkuZaSebou >= 3) {
                prerusen = `3 výpadky cloudu / sítě za sebou (poslední: ${chybaBehu.slice(0, 160)})`;
                // tyto 3 případy nejsou vypovídající — do výsledku nepatří
                vysledky.splice(vysledky.length - 3, 3);
                console.log(`\n🛑 Běh přerušen: ${prerusen}.\n   Uloží se jen hotové případy. Zkontrolujte síť / spánek Macu a pusťte zbytek: --typy … nebo --pripady …`);
                break vnejsi;
            }
        }
    }
    if (server) server.close();

    const souhrn = souhrnBehu(vysledky);
    const vystup = {
        meta: { datum: new Date().toISOString(), label, provider: PROVIDER, model: modelNazev, rezim: REZIM, opakovani: OPAK, judge: JUDGE, prerusen,
            commit: gitCommit(), sada: { verze: SADA.verze, hash: hash(fs.readFileSync(path.join(EVAL, 'cases.json'))), pripadu: pripady.length },
            prompty: hash(JSON.stringify(agents) + fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent_outlines.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'lib', 'legal_basis.js'), 'utf8')),
            naklady: { odhadUsd: Math.round(naklady * 1e4) / 1e4, inputTokens: tokIn, outputTokens: tokOut } },
        souhrn, vysledky
    };
    fs.mkdirSync(OUT, { recursive: true });
    const stem = path.join(OUT, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${label}`);
    fs.writeFileSync(stem + '.json', JSON.stringify(vystup, null, 1));
    fs.writeFileSync(stem + '.md', require('./spis_eval_compare').report([vystup]));
    console.log('\n' + require('./spis_eval_compare').tabulka([vystup]));
    console.log(`\nNáklady (odhad): ${vystup.meta.naklady.odhadUsd} USD · tokeny ${tokIn} → ${tokOut}`);
    console.log(`Výsledek: ${stem}.json\n          ${stem}.md`);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* úklid best-effort */ }
}

// LLM-judge (eval/spis_eval/judge.js, kalibrace: spis_eval_judge.js): --judge = citace, které program nerozhodl;
// --judge-vse = všechny platné citace (program bez judge „schvaluje“ i podvržené — kalibrace 4. 11.: 12 FP z 34).
let _priklady = null;
async function posudNejiste(v, p, ai, P) {
    const J = require('../eval/spis_eval/judge');
    if (!_priklady) {
        const pary = JSON.parse(fs.readFileSync(path.join(EVAL, 'judge', 'pary.json'), 'utf8')).pary;
        _priklady = J.vyberPriklady(pary.map(x => Object.assign({}, x, { misto: J.textMista(SPISY[x.spis], x.kotva) })), 8);
    }
    const kandidati = v.citace.polozky.filter(x => x.kotva && x.platna && (JUDGE_VSE || x.podpora === 'nejiste'));
    for (const c of kandidati) {
        const misto = J.textMista(SPISY[p.spis], c.kotva);
        try {
            const r = await J.posud({ ai, P, misto, tvrzeni: c.tvrzeni || c.raw, priklady: _priklady, model: process.env.CHAT_MODEL });
            if (r.verdikt) {
                const pred = c.podpora;
                c.podpora = r.verdikt === 'ANO' ? 'ano' : 'ne'; c.judge = r.duvod || true;
                if (pred !== 'ne' && c.podpora === 'ne') v.chyby.push({ typ: 'citace_nepodporuje', detail: `${c.kotva} (judge): ${r.duvod}`.slice(0, 200) });
                if (pred === 'ne' && c.podpora === 'ano') { const k = v.chyby.findIndex(x => x.typ === 'citace_nepodporuje' && x.detail.startsWith(c.kotva)); if (k >= 0) v.chyby.splice(k, 1); }
            }
        } catch (e) { /* zůstane, jak rozhodl program */ }
    }
    v.citace.nejiste = v.citace.polozky.filter(x => x.podpora === 'nejiste').length;
    v.citace.podporujici = v.citace.polozky.filter(x => x.platna && x.podpora === 'ano').length;
}

function souhrnBehu(vys) {
    const poTypu = {};
    const chyby = {};
    const cit = { celkem: 0, platne: 0, podporujici: 0, nejiste: 0 };
    for (const v of vys) {
        const t = poTypu[v.typ] = poTypu[v.typ] || { n: 0, skore: 0, prosel: 0, cit: { celkem: 0, platne: 0, podporujici: 0, nejiste: 0 }, chyby: {} };
        t.n++; t.skore += v.skore; if (v.prosel) t.prosel++;
        for (const k of Object.keys(cit)) { t.cit[k] += v.citace[k]; cit[k] += v.citace[k]; }
        for (const c of v.chyby) { chyby[c.typ] = (chyby[c.typ] || 0) + 1; t.chyby[c.typ] = (t.chyby[c.typ] || 0) + 1; }
    }
    for (const t of Object.values(poTypu)) { t.skore = Math.round(t.skore / t.n); t.uspesnost = Math.round(100 * t.prosel / t.n); }
    const pom = (a, b) => b ? Math.round(1000 * a / b) / 10 : null;
    return {
        poTypu, chyby,
        citace: Object.assign({}, cit, { platnost: pom(cit.platne, cit.celkem), podpora: pom(cit.podporujici, cit.celkem - cit.nejiste) }),
        celkem: { n: vys.length, skore: Math.round(vys.reduce((a, v) => a + v.skore, 0) / Math.max(1, vys.length)), prosel: vys.filter(v => v.prosel).length }
    };
}

if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.error('❌', e && e.stack || e); process.exit(1); });
module.exports = { souhrnBehu };
