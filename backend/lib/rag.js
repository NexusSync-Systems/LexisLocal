/**
 * LexisLocal RAG & Embedded Vector Database Module
 * Implements a lightweight, zero-dependency, pure JavaScript vector storage.
 * Stores chunked text and vectors in WATCH_DIR/ under encrypted partitions.
 *
 * Embeddingy počítá lokální Ollama (sémantické vyhledávání). Když model NEBĚŽÍ,
 * modul degraduje na deterministický LEXIKÁLNÍ (klíčový) fallback nad textem
 * chunků — RAG tak funguje i bez modelu (viz lexicalScore / searchSimilar opts).
 * Indexace bez modelu ukládá chunky TEXTOVĚ (bez vektoru), lexikálně dohledatelné.
 * POZOR: fallback je OPT-IN (searchSimilar(..., { lexicalFallback:true })), aby
 * bezpečnostně kritická cesta (conflicts.js) při výpadku modelu stále FAIL-CLOSED
 * vyhodila chybu místo neúplného „žádný konflikt".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');

// AI poskytovatel nezávislý na backendu (Ollama | OpenAI | Anthropic) — stejné
// rozhraní jako ollama lib. Embeddingy tak fungují pro jakýkoli model.
const ollama = require('./ai_provider');

const { WATCH_DIR, dataPath } = require('./config'); // jeden zdroj pravdy, viz lib/config.js
const secureCrypto = require('./secure_crypto'); // AES-GCM + zpětné čtení CBC (jeden zdroj)
const rerankService = require('./rerank_service');
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';

// #5: hybridní retrieval (sémantika + lexikální shoda). OPT-IN (RAG_HYBRID=1),
// default VYPNUTO → chování beze změny. České §, čísla zákonů a sp. zn. jsou přesné
// tokeny, které lexikální shoda trefí a embeddingy rozmažou; blend obojí. Váhu řídí
// RAG_HYBRID_ALPHA (podíl sémantiky, default 0.2 dle evalu). Po zapnutí dolaď RAG_MIN_SCORE.
function _hybridEnabled() {
    const v = String(process.env.RAG_HYBRID == null ? '' : process.env.RAG_HYBRID).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
function _hybridAlpha() {
    const a = parseFloat(process.env.RAG_HYBRID_ALPHA);
    // Default 0.8 (silně sémantický). Změřeno na rozšířeném golden setu judikatury (39
    // dotazů, bge-m3): α=0.8 = hit@5 100 %, recall@5 65 %, MRR 0.955 — vrchol křivky
    // (0.7→0.934, 0.9→0.919); bije čistý semantic (0.864) i starý α=0.2 (0.800). Pozn.:
    // α=0.2 byl optimální pro nomic-embed-text, ale bge-m3 sémantika je silná.
    return (Number.isFinite(a) && a >= 0 && a <= 1) ? a : 0.8;
}
// RRF (Reciprocal Rank Fusion): místo lineárního blendu skóre kombinuj POŘADÍ ze
// sémantického a lexikálního žebříčku. Rank-fúze hustého + řídkého vyhledávání je v IR
// robustní default (silný zásah v kterémkoliv žebříčku táhne dokument nahoru, škály skóre
// nevadí). Zapíná RAG_RRF=1; konstanta K přes RAG_RRF_K (default 60). Má přednost před
// lineárním hybridem.
// Hybrid nad velkou bází: lexikální skóre (tokenizace textu každého kousku) stojí ~0,06 ms
// na kousek — u báze s judikaturou NS/ÚS/NSS (~300 tis. kousků) to bylo ~10–20 s na dotaz,
// sémantika přitom ~1 s. Lexikální složka se proto počítá jen pro POOL nejlepších kandidátů
// podle sémantiky (výchozí 400; α=0.8 = lexikální složka hlavně přeřazuje špičku). Ostatní
// kousky by s α·sem stejně skončily pod nimi. RAG_HYBRID_POOL=0 = počítat vše (staré chování).
function _hybridPool(opts) {
    if (opts && Number.isInteger(opts.hybridPool) && opts.hybridPool >= 0) return opts.hybridPool;
    const n = parseInt(process.env.RAG_HYBRID_POOL, 10);
    return Number.isFinite(n) && n >= 0 ? n : 400;
}
// --- Zákony vs. judikatura ve znalostní bázi ----------------------------------------
// Báze rešeršníka má ~10 tis. kousků zákonů a ~290 tis. kousků judikatury (NS, ÚS, NSS).
// Měření 23. 10. 2026 (kb_regression.js, 124 dotazů na paragraf): po nahrání judikatury
// spadl správný paragraf v top 3 z 82 % na 51 % — judikatura zabrala 66 % míst, protože
// rozhodnutí citují tytéž paragrafy a je jich třicetkrát víc. Agent ale potřebuje OBOJÍ:
// znění zákona i výklad soudů. Proto:
//  • pool kandidátů hybridu se bere zvlášť ze zákonů (RAG_HYBRID_POOL_LAWS, výchozí 100),
//    aby zákony nevypadly už před přeřazením,
//  • výsledky agenta (dedupeKb) se skládají z podílu zákonů RAG_KB_LAW_SHARE (výchozí 0.6
//    → u k=3 dva paragrafy a jedno rozhodnutí, u k=5 tři a dvě); chybí-li jeden druh,
//    doplní se druhým. Pořadí mezi vybranými zůstává podle skóre. RAG_KB_LAW_SHARE=0 = vypnuto.
// Judikaturu poznáme podle scope (`_kb_judikatura`, `_kb_obor_*`) nebo názvu souboru
// z fetch skriptů (NS_…, US_…, NSS_…); RAG_KB_JUD_RE ho umí přepsat.
function _judRe() {
    try { return new RegExp(process.env.RAG_KB_JUD_RE || '^(NS|NSS|US)_'); } catch (e) { return /^(NS|NSS|US)_/; }
}
function isJudikaturaChunk(c) {
    if (!c || typeof c.scope !== 'string' || c.scope.indexOf(KB_PREFIX) !== 0) return false;
    if (c.scope === '_kb_judikatura' || c.scope.indexOf('_kb_obor_') === 0) return true;
    return _judRe().test(String(c.fileName || ''));
}
function isLawChunk(c) {
    return !!c && typeof c.scope === 'string' && c.scope.indexOf(KB_PREFIX) === 0 && !isJudikaturaChunk(c);
}
function _lawShare(opts) {
    if (opts && typeof opts.kbLawShare === 'number') return opts.kbLawShare;
    const v = parseFloat(process.env.RAG_KB_LAW_SHARE);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.6;
}
function _lawPool() {
    const n = parseInt(process.env.RAG_HYBRID_POOL_LAWS, 10);
    return Number.isFinite(n) && n >= 0 ? n : 100;
}
/**
 * Z setříděných výsledků vybere `limit` tak, aby zákony měly ceil(limit·share) míst
 * (pokud jsou k dispozici), zbytek nejlepší ostatní (judikatura, klientské spisy).
 * Pořadí vybraných zachová. Čistá funkce.
 */
function mixKbResults(sorted, limit, share) {
    if (!(share > 0) || !Array.isArray(sorted) || sorted.length <= limit) return sorted;
    const laws = sorted.filter(r => typeof r.scope === 'string' && r.scope.indexOf(KB_PREFIX) === 0 && !isJudikaturaChunk(r));
    if (!laws.length || laws.length === sorted.length) return sorted;
    const lawSlots = Math.min(laws.length, Math.ceil(limit * share));
    const lawSet = new Set(laws);
    const chosen = new Set(laws.slice(0, lawSlots));
    for (const r of sorted) { if (chosen.size >= limit) break; if (!chosen.has(r) && !lawSet.has(r)) chosen.add(r); }
    for (const r of laws) { if (chosen.size >= limit) break; chosen.add(r); } // málo ostatních → doplnit zákony
    const picked = sorted.filter(r => chosen.has(r));
    return picked.concat(sorted.filter(r => !chosen.has(r)));
}

function _rrfEnabled() {
    const v = String(process.env.RAG_RRF == null ? '' : process.env.RAG_RRF).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
function _rrfK() {
    const k = parseInt(process.env.RAG_RRF_K, 10);
    return (Number.isFinite(k) && k > 0) ? k : 60;
}
// Blend sémantického a lexikálního skóre (obě v [0,1]).
// Počet pasáží z báze pro agenty (rešeršník, spisovatel…). Default 3. Změřeno na L4
// (2026-10-01, 10 úloh): k=5 qwen2.5:7b zhoršilo z 92 % na 86 % (víc šumu → špatný §
// u nájmu i odvolání), qwen2.5:32b beze změny (98 % při k=3 i k=5). Přepis RAG_AGENT_K (1–10).
// 14. 10. 2026: S rerankerem (bge-reranker-v2-m3) a kousky 2000 znaků je to naopak — laboratoř: správný §
// v top 5 95 % vs. top 3 92 % (klientské dotazy 94 vs. 88 %); serverový test 10× s k=5: 174/174, agenti
// 220/220, neověřené citace 1 %. → se zapnutým rerankerem výchozí 5, bez něj zůstává 3.
function agentRagK() {
    const k = parseInt(process.env.RAG_AGENT_K, 10);
    if (Number.isFinite(k) && k >= 1 && k <= 10) return k;
    try { return rerankService.rerankEnabled() ? 5 : 3; } catch (e) { return 3; }
}

function blendScore(semantic, lexical, alpha) {
    const a = (Number.isFinite(alpha) && alpha >= 0 && alpha <= 1) ? alpha : 0.2;
    const sem = Number.isFinite(semantic) ? semantic : 0;
    const lex = Number.isFinite(lexical) ? lexical : 0;
    return a * sem + (1 - a) * lex;
}

// Jednoduchý mutex — serializuje zápisové operace nad indexem. Chokidar spouští
// indexaci více souborů paralelně; bez serializace by se interleaved load→save
// navzájem přepisovaly (ztráta chunků / přepis partitionů).
// Jeden zdroj: lib/mutex.js (dřív měl rag.js vlastní identickou kopii třídy).
const Mutex = require('./mutex');
const ragMutex = new Mutex();

/**
 * Lists all active subdirectories in WATCH_DIR to determine partition boundaries.
 */
function getActiveDirectories() {
    const dirs = ['root'];
    try {
        if (fs.existsSync(WATCH_DIR)) {
            const entries = fs.readdirSync(WATCH_DIR, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    dirs.push(entry.name);
                }
            }
        }
    } catch (e) {
        console.error("⚠️ RAG: Selhal výpis aktivních složek:", e.message);
    }
    return dirs;
}

/**
 * Derives a cryptographic partition key from master key and directory name.
 */
function getPartitionKey(directoryName) {
    const masterKey = db.encryptionKey || crypto.pbkdf2Sync('default_lexis_master_key', 'salt', 100, 32, 'sha256');
    return crypto.pbkdf2Sync(masterKey, directoryName, 1000, 32, 'sha256');
}

// --- Kompaktní ukládání vektorů (base64 Float32) --------------------------------
// Vektor jako JSON pole čísel je ~2–3× větší než binární Float32; u velkých partitionů
// to naráží na V8 limit délky řetězce (~512 MB) při JSON.stringify před šifrováním
// (Cannot create a string longer than 0x1fffffe8). Na disk proto vektory ukládáme jako
// base64 Float32 (pole `vec`); v PAMĚTI zůstávají jako `vector` (pole čísel), takže se
// zbytek kódu (cosineSimilarity apod.) nemění. Čtení zvládá OBA formáty (zpětná komp.).
// PAMĚŤ: vektory načtené z disku drží `Float32Array` (4 B/číslo), ne pole čísel
// (8 B/číslo + režie). U báze judikatury (~130 tis. kousků × 1024 dim.) je to rozdíl
// ~0,5 GB vs. >1 GB a server jinak padal na „heap out of memory". Typované pole se
// indexuje stejně jako pole (cosineSimilarity se nemění); kde se dřív testovalo
// `Array.isArray(vector)`, používej `isVector()`.
function isVector(v) {
    return (Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView))) && v.length > 0;
}
function _toF32(vec) {
    if (vec == null) return null;
    if (vec instanceof Float32Array) return vec;
    return isVector(vec) ? Float32Array.from(vec) : vec;
}
function _vecToB64(vec) {
    if (!isVector(vec)) return null;
    const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
    return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}
function _b64ToVec(b64) {
    if (typeof b64 !== 'string' || !b64) return null;
    const buf = Buffer.from(b64, 'base64');
    const n = Math.floor(buf.byteLength / 4);
    // Kopie do vlastního (zarovnaného) bufferu — Buffer z poolu nemusí být zarovnaný na 4 B
    // a sdílený pool by držel v paměti víc, než je potřeba.
    // Vlastní (nesdílený, zarovnaný) buffer → pohled bez kopie. Malé buffery z poolu se kopírují,
    // aby vektor nedržel v paměti celý sdílený slab.
    if (buf.byteOffset % 4 === 0 && buf.buffer.byteLength === buf.byteLength) return new Float32Array(buf.buffer, buf.byteOffset, n);
    const out = new Float32Array(n);
    out.set(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4)));
    return out;
}
// Deduplikace chunků dle id (fallback fileName#chunkIndex) — brání navrstvení při
// opakovaném seedování, které partition nafukuje.
function _dedupChunks(chunks) {
    const seen = new Set();
    const out = [];
    for (const c of (chunks || [])) {
        if (!c || typeof c !== 'object') continue;
        const key = (c.id != null) ? ('id:' + c.id) : ('f:' + c.fileName + '#' + c.chunkIndex);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
    }
    return out;
}
// --- Kompaktní podoba velkých partitionů v paměti -----------------------------------
// Měření 24. 10. 2026: báze rešeršníka (297 tis. kousků) zabírala ~2,8 GB haldy + vektory
// mimo haldu (RSS ~8 GB) a Mac ji odkládal do swapu — hledání trvalo 10–20 s místo ~1 s.
// Partition s aspoň RAG_COMPACT_MIN kousky (výchozí 2000) se proto po načtení uloží úsporně:
//  • texty v jednom UTF-8 bufferu na shard (české texty jsou v JS po 2 B/znak), `text` je
//    getter, který úsek dekóduje až při přístupu (pool hybridu, výsledky — jednotky stovek),
//  • vektory v jednom souvislém bloku na shard jako Int8 se škálou na kousek (RAG_VEC_INT8=0 →
//    Float32). Kosinová podobnost na škále nezávisí, takže `cosineSimilarity(dotaz, int8)` dává
//    stejné pořadí; skutečné hodnoty vrací floatVector(c) (zápis na disk, centroidy oborů).
// Na disku se nic nemění: _encodeChunkForDisk zapisuje float32 a plný text jako dřív.
const TXT_BUF = Symbol('txtBuf'), TXT_OFF = Symbol('txtOff'), TXT_LEN = Symbol('txtLen'), TXT_OWN = Symbol('txtOwn');
const TEXT_COMPACT = Symbol('textCompact');
class KbChunk {
    constructor(src, buf, off, len) {
        for (const k of Object.keys(src)) { if (k !== 'text') this[k] = src[k]; }
        this[TXT_BUF] = buf; this[TXT_OFF] = off; this[TXT_LEN] = len;
    }
    get text() { return this[TXT_BUF] ? this[TXT_BUF].toString('utf8', this[TXT_OFF], this[TXT_OFF] + this[TXT_LEN]) : this[TXT_OWN]; }
    set text(v) { this[TXT_BUF] = null; this[TXT_OWN] = v; }
}
function _compactMin() {
    const n = parseInt(process.env.RAG_COMPACT_MIN, 10);
    return Number.isFinite(n) && n >= 0 ? n : 2000; // 0 = vypnuto
}
function _int8Enabled() { return String(process.env.RAG_VEC_INT8 == null ? '1' : process.env.RAG_VEC_INT8).trim() !== '0'; }

/** Skutečné (float) hodnoty vektoru — u Int8 přenásobí škálou kousku. */
function floatVector(c) {
    const v = c && c.vector;
    if (v instanceof Int8Array) {
        const s = Number(c.vecScale) || 1;
        const out = new Float32Array(v.length);
        for (let i = 0; i < v.length; i++) out[i] = v[i] * s;
        return out;
    }
    return v;
}
/** Značka textu pro porovnání shardů bez dekódování: nezměněný kompaktní text = konstanta. */
function _textTag(c) { return c instanceof KbChunk && c[TXT_BUF] ? TEXT_COMPACT : c.text; }

/** Pole kousků (dekódovaných z disku) → kompaktní KbChunk se sdíleným bufferem textů a vektorů. */
function _compactChunks(chunks) {
    const n = chunks.length;
    if (!n) return chunks;
    const texts = new Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) { const t = chunks[i].text; texts[i] = typeof t === 'string' ? t : ''; total += Buffer.byteLength(texts[i]); }
    const buf = Buffer.allocUnsafeSlow(total);
    let dim = 0;
    for (const c of chunks) { if (isVector(c.vector)) { dim = c.vector.length; break; } }
    const int8 = _int8Enabled();
    const vbuf = dim ? (int8 ? new Int8Array(n * dim) : new Float32Array(n * dim)) : null;
    const out = new Array(n);
    let off = 0;
    for (let i = 0; i < n; i++) {
        const c = chunks[i];
        const len = buf.write(texts[i], off, 'utf8');
        const k = new KbChunk(c, buf, off, len);
        off += len;
        const v = c.vector;
        if (vbuf && isVector(v) && v.length === dim) {
            const view = vbuf.subarray(i * dim, (i + 1) * dim);
            if (int8) {
                let max = 0;
                for (let j = 0; j < dim; j++) { const a = Math.abs(v[j]); if (a > max) max = a; }
                const sc = max > 0 ? max / 127 : 1;
                for (let j = 0; j < dim; j++) view[j] = Math.round(v[j] / sc);
                k.vecScale = sc;
            } else {
                view.set(v);
            }
            k.vector = view;
            // Norma uloženého vektoru předem — hledání pak počítá jen skalární součin.
            let nn = 0;
            for (let j = 0; j < dim; j++) nn += view[j] * view[j];
            k.vecNorm = Math.sqrt(nn);
        }
        out[i] = k;
    }
    return out;
}

// Chunk → diskový tvar: vektor jako base64 (`vec`), bez pole `vector`.
function _encodeChunkForDisk(c) {
    const out = {};
    for (const k of Object.keys(c)) { if (k !== 'vector' && k !== 'vec' && k !== 'vecScale' && k !== 'vecNorm') out[k] = c[k]; }
    if (c instanceof KbChunk) out.text = c.text; // text je u kompaktního kousku getter (není vlastní klíč)
    const b64 = _vecToB64(floatVector(c));
    if (b64) out.vec = b64;
    else out.vector = null; // neembedovaný chunk: zachovej explicitní null (ne undefined)
    return out;
}
// Diskový tvar → chunk: rekonstruuj `vector` z `vec`, nebo ponech staré pole `vector`.
function _decodeChunkFromDisk(c) {
    if (!c || typeof c !== 'object') return c;
    if (typeof c.vec === 'string') {
        const out = {};
        for (const k of Object.keys(c)) { if (k !== 'vec') out[k] = c[k]; }
        out.vector = _b64ToVec(c.vec);
        return out;
    }
    return c;
}
function _encodeIndexForDisk(index) {
    const chunks = _dedupChunks(index && index.chunks).map(_encodeChunkForDisk);
    return Object.assign({}, index, { chunks });
}
function _decodeIndexFromDisk(index) {
    if (!index || !Array.isArray(index.chunks)) return index || { chunks: [] };
    return Object.assign({}, index, { chunks: index.chunks.map(_decodeChunkFromDisk) });
}

// --- Shardování partitionů ------------------------------------------------------
// I s base64 vektory může velká báze (desítky tisíc chunků) překročit V8 limit délky
// řetězce: JSON.stringify plaintextu se blíží ~512 MB, a šifra navíc dělá HEX ciphertext
// ~2× (efektivní strop plaintextu ~256 MB). Partition proto ukládáme po SHARDECH — každý
// shard je samostatně šifrovaný soubor s omezeným počtem chunků, takže žádný řetězec
// (plaintext ANI hex) se limitu nepřiblíží. Shard 0 = `.rag_<id>.json` (nese i meta a
// `_shards` = počet shardů), další = `.rag_<id>.p1.json`, `.p2.json`, …
const SHARD_MAX_CHUNKS = Math.max(1, parseInt(process.env.RAG_SHARD_MAX_CHUNKS, 10) || 6000);

function _partitionBase(directoryName) {
    const partitionId = crypto.createHash('sha256').update(directoryName).digest('hex').substring(0, 16);
    return dataPath(`.rag_${partitionId}`);
}
function _shardPath(base, i) {
    return i === 0 ? `${base}.json` : `${base}.p${i}.json`;
}

/**
 * Saves a partition index file encrypted with a key derived for the specific directory.
 * Velké partitiony se rozdělí na víc shardů (viz SHARD_MAX_CHUNKS), aby se serializace
 * nedotkla V8 limitu délky řetězce.
 */
// --- Přírůstkový zápis a cache partitionů ---------------------------------------
// Dřív každé uložení (= každý nahraný dokument) znovu zakódovalo, zašifrovalo
// a přepsalo CELOU partition a každé načtení ji celou dešifrovalo. U báze judikatury
// (desítky shardů, ~1 GB) to dělalo nahrávání kvadratické (každý další dokument
// pomalejší) a server padal na paměť.
//
// Teď:
//  • `_shardState` si pamatuje, které objekty chunků (a jejich vektory) leží v kterém
//    shardu na disku. Při uložení se přepíší jen shardy, jejichž obsah se změnil
//    (u přidání dokumentu typicky poslední shard) + shard 0, který nese meta a jehož
//    mtime je podpis změny pro partitionStat(). Nezměněná partition se nepřepisuje vůbec.
//  • `_partCache` drží dešifrovanou partition v paměti; platnost hlídá podpis shardu 0
//    (mtime + velikost) a otisk klíče — zápis jiným procesem nebo rotace klíče ji zneplatní.
//  • Stav platí, jen když shard 0 na disku odpovídá tomu, co jsme sami zapsali/načetli;
//    jinak se zapisuje vše jako dřív (bezpečný návrat ke starému chování).
// Vypnutí: RAG_PARTITION_CACHE=0 (pak se vždy čte i zapisuje celá partition).
const _partCache = new Map();   // base → { sig, chunks, meta }
const _shardState = new Map();  // base → { sig, count, metaJson, shards: [[{c,v,e,t}]] }

function _cacheEnabled() {
    return String(process.env.RAG_PARTITION_CACHE == null ? '1' : process.env.RAG_PARTITION_CACHE).trim() !== '0';
}
function _keyTag(key) {
    return crypto.createHash('sha256').update(key).digest('hex').substring(0, 12);
}
function _diskSig(base, keyTag) {
    try {
        const st = fs.statSync(_shardPath(base, 0));
        return `${st.mtimeMs}:${st.size}:${keyTag}`;
    } catch (e) {
        return null;
    }
}
function _sliceSig(chunks) {
    return chunks.map(c => ({ c, v: c.vector, e: c.embedded, t: _textTag(c) }));
}
function _sameSlice(prev, cur) {
    if (!prev || prev.length !== cur.length) return false;
    for (let i = 0; i < cur.length; i++) {
        const p = prev[i], c = cur[i];
        if (p.c !== c || p.v !== c.vector || p.e !== c.embedded || p.t !== _textTag(c)) return false;
    }
    return true;
}
function _forgetPartition(base) {
    _partCache.delete(base);
    _shardState.delete(base);
}
/** Testy: vyprázdní cache a stav shardů (simulace restartu procesu). */
function _resetPartitionCache() {
    _partCache.clear();
    _shardState.clear();
}

// --- Odložené ukládání znalostních bází (hromadné plnění) ---------------------------
// Server 24. 10. 2026: seed-kb nahrával judikaturu ~1 soubor/s a zpomaloval — po KAŽDÉM
// souboru se znovu zašifroval a zapsal shard 0 (až 6000 kousků s vektory, desítky MB).
// S RAG_KB_SAVE_DEBOUNCE_MS > 0 se zápis báze agenta (_kb_*) odloží: změna je hned vidět
// v paměti (cache partitionů → hledání i další nahrávání ji vidí), na disk se zapíše po
// chvíli klidu, nejpozději po RAG_KB_SAVE_MAX_MS, a při ukončení procesu (exit).
// Při tvrdém pádu se ztratí nejvýš nahrávání z posledního okna (seed-kb je pak přeskočí
// jako chybějící a nahraje znovu). Výchozí stav: vypnuto (0) = zápis hned jako dosud.
const _pendingSaves = new Map(); // base → { directoryName, index, timer, since }
function _saveDebounceMs() {
    const n = parseInt(process.env.RAG_KB_SAVE_DEBOUNCE_MS || '0', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
function _saveMaxMs() {
    const n = parseInt(process.env.RAG_KB_SAVE_MAX_MS || '', 10);
    return Number.isFinite(n) && n > 0 ? n : 30000;
}
function _flushPending(base) {
    const p = _pendingSaves.get(base);
    if (!p) return;
    _pendingSaves.delete(base);
    if (p.timer) clearTimeout(p.timer);
    _savePartitionNow(p.directoryName, p.index);
}
/** Zapíše všechny odložené báze na disk (synchronně). Volá se i při ukončení procesu. */
function flushPendingSaves() {
    for (const base of Array.from(_pendingSaves.keys())) _flushPending(base);
}
let _exitHook = false;
function _deferSave(directoryName, index) {
    const base = _partitionBase(directoryName);
    const key = getPartitionKey(directoryName);
    const sig = _diskSig(base, _keyTag(key)); // disk se nemění → podpis zůstává platný
    const meta = Object.assign({}, index); delete meta.chunks;
    _partCache.set(base, { sig, chunks: (index && index.chunks) || [], meta });
    const now = Date.now();
    const prev = _pendingSaves.get(base);
    if (prev && prev.timer) clearTimeout(prev.timer);
    const since = prev ? prev.since : now;
    const wait = Math.max(0, Math.min(_saveDebounceMs(), since + _saveMaxMs() - now));
    const timer = setTimeout(() => {
        ragMutex.acquire().then(() => { try { _flushPending(base); } finally { ragMutex.release(); } });
    }, wait);
    if (timer.unref) timer.unref();
    _pendingSaves.set(base, { directoryName, index, timer, since });
    if (!_exitHook) { _exitHook = true; process.on('exit', flushPendingSaves); }
}

function savePartition(directoryName, index) {
    if (_saveDebounceMs() && _cacheEnabled() && String(directoryName).indexOf(KB_PREFIX) === 0) {
        try { return _deferSave(directoryName, index); }
        catch (e) { _flushPending(_partitionBase(directoryName)); /* bez odložení */ }
    }
    _pendingSaves.delete(_partitionBase(directoryName)); // přímý zápis přebíjí odložený
    return _savePartitionNow(directoryName, index);
}

function _savePartitionNow(directoryName, index) {
    const base = _partitionBase(directoryName);
    try {
        const key = getPartitionKey(directoryName);
        const keyTag = _keyTag(key);
        const useCache = _cacheEnabled();
        // Dedup → shardy se skládají z týchž objektů chunků, jaké má volající.
        const deduped = _dedupChunks(index && index.chunks);
        const meta = Object.assign({}, index); delete meta.chunks;
        const metaJson = JSON.stringify(meta);

        const shardCount = Math.max(1, Math.ceil(deduped.length / SHARD_MAX_CHUNKS));
        const slices = [];
        for (let s = 0; s < shardCount; s++) {
            slices.push(deduped.slice(s * SHARD_MAX_CHUNKS, (s + 1) * SHARD_MAX_CHUNKS));
        }

        // Předchozí stav platí jen tehdy, když shard 0 na disku je pořád ten, který
        // známe (nikdo jiný ho mezitím nepřepsal) a klíč se nezměnil.
        let prev = useCache ? _shardState.get(base) : null;
        if (prev && prev.sig !== _diskSig(base, keyTag)) prev = null;
        // Shard se přepisuje, jen když se změnil. Přibyl-li shard (báze přerostla další
        // SHARD_MAX_CHUNKS), staré shardy zůstávají — dřív se tím přepsala celá báze
        // (server 25. 10.: 50 shardů, zastavení serveru 54 s). Shard 0 nese `_shards`,
        // takže se při změně počtu přepíše vždy (níž).
        const sameMeta = !!prev && prev.metaJson === metaJson;

        const changed = slices.map((slice, s) => !sameMeta || s >= prev.count || !_sameSlice(prev.shards[s], slice));
        if (prev && prev.count !== shardCount) changed[0] = true;
        if (changed.some(Boolean)) changed[0] = true; // shard 0 = meta + podpis změny
        // Shardy se zapisují od posledního k prvnímu: shard 0 (podpis) je poslední,
        // takže při pádu uprostřed zápisu se neshoduje se stavem a příště se přepíše vše.
        for (let s = shardCount - 1; s >= 0; s--) {
            if (!changed[s]) continue;
            const encoded = slices[s].map(_encodeChunkForDisk);
            const shardObj = (s === 0)
                ? Object.assign({}, meta, { _shards: shardCount, chunks: encoded })
                : { chunks: encoded };
            // AES-256-GCM (integrita) přes sdílený secure_crypto — každý shard zvlášť.
            const payload = JSON.stringify(secureCrypto.encrypt(key, JSON.stringify(shardObj)));
            fs.writeFileSync(_shardPath(base, s), payload, 'utf8');
        }
        // Ukliď staré (nadbytečné) shardy po zmenšení báze.
        for (let s = shardCount; ; s++) {
            const p = _shardPath(base, s);
            if (!fs.existsSync(p)) break;
            try { fs.unlinkSync(p); } catch (e) { /* best-effort */ }
        }

        if (useCache) {
            const sig = _diskSig(base, keyTag);
            _shardState.set(base, { sig, count: shardCount, metaJson, shards: slices.map(_sliceSig) });
            _partCache.set(base, { sig, chunks: deduped, meta });
        }
    } catch (e) {
        _forgetPartition(base); // stav na disku je nejistý → příště číst i psát celé
        console.error(`⚠️ RAG: Nepodařilo se uložit partition pro ${directoryName}:`, e.message);
    }
}

/**
 * Levné metadata partition souboru (mtime + velikost) BEZ dešifrování — slouží
 * jako podpis pro invalidaci cache (např. centroidy oborů v obor_detect.js).
 * Vrací { mtimeMs, size } nebo null, když partition ještě neexistuje.
 */
function partitionStat(directoryName) {
    // Shard 0 se přepisuje při KAŽDÉM uložení partitionu, takže jeho mtime je platný
    // podpis pro invalidaci cache i u shardovaných bází.
    const partitionPath = _shardPath(_partitionBase(directoryName), 0);
    try {
        const st = fs.statSync(partitionPath);
        return { mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) {
        return null;
    }
}

/**
 * Loads and decrypts a partition index file.
 */
/**
 * Načtení partition jako generátor: po každém dalším shardu `yield`. loadPartition ho
 * proběhne naráz (synchronně, jako dřív), loadPartitionAsync mezi shardy pustí smyčku
 * událostí — předehřátí plné báze (50 shardů, ~40 s) pak neblokuje server
 * (server 25. 10.: po startu 42 s bez odpovědi).
 */
function* _loadPartitionSteps(directoryName) {
    const base = _partitionBase(directoryName);
    const shard0 = _shardPath(base, 0);

    // Odložený (ještě nezapsaný) stav báze má přednost před diskem — i u NOVÉ báze, která
    // shard 0 na disku ještě nemá (jinak se vracela prázdná a každé nahrání ji přepsalo).
    const pend = _cacheEnabled() ? _pendingSaves.get(base) : null; // odklad jde jen s cache
    if (pend) {
        const meta = Object.assign({}, pend.index); delete meta.chunks;
        return Object.assign(meta, { chunks: ((pend.index && pend.index.chunks) || []).slice() });
    }

    if (!fs.existsSync(shard0)) {
        const RAG_INDEX_PATH = dataPath('.rag_index.json');
        if (fs.existsSync(RAG_INDEX_PATH)) {
            try {
                const data = fs.readFileSync(RAG_INDEX_PATH, 'utf-8');
                const index = JSON.parse(data);
                const filteredChunks = (index.chunks || []).filter(c => {
                    const dir = c.fileName.includes('/') ? c.fileName.split('/')[0] : 'root';
                    return dir === directoryName;
                });
                return _decodeIndexFromDisk({ chunks: filteredChunks });
            } catch (e) {}
        }
        return { chunks: [] };
    }

    try {
        const key = getPartitionKey(directoryName);
        const keyTag = _keyTag(key);
        const useCache = _cacheEnabled();
        const sigBefore = useCache ? _diskSig(base, keyTag) : null;
        if (useCache) {
            const hit = _partCache.get(base);
            // Kopie pole chunků: volající ho smí filtrovat/doplňovat, aniž by měnil cache.
            if (hit && hit.sig === sigBefore) return Object.assign({}, hit.meta, { chunks: hit.chunks.slice() });
        }
        // Shard 0 nese meta + `_shards`. Starší jednosouborové partitiony `_shards` nemají
        // → čtou se jako jeden shard (zpětná kompatibilita).
        const first = JSON.parse(secureCrypto.decrypt(key, JSON.parse(fs.readFileSync(shard0, 'utf8'))));
        const shardCount = (first && Number.isInteger(first._shards) && first._shards > 0) ? first._shards : 1;
        // Velká partition se zhušťuje shard po shardu, aby v paměti nikdy neležela celá
        // v původní (rozměrné) podobě — špička je kompaktní zbytek + jeden shard.
        const min = _compactMin();
        const compact = min > 0 && (shardCount > 1 ? shardCount * SHARD_MAX_CHUNKS : (first.chunks || []).length) >= min;
        const prep = arr => {
            const dec = arr.map(_decodeChunkFromDisk);
            return compact ? _compactChunks(dec) : dec;
        };
        const firstChunks = prep(first.chunks || []);
        const shardLens = [firstChunks.length];
        const allChunks = firstChunks;
        first.chunks = null;
        for (let s = 1; s < shardCount; s++) {
            const p = _shardPath(base, s);
            if (!fs.existsSync(p)) break;
            const obj = JSON.parse(secureCrypto.decrypt(key, JSON.parse(fs.readFileSync(p, 'utf8'))));
            const arr = prep((obj && Array.isArray(obj.chunks)) ? obj.chunks : []);
            for (const c of arr) allChunks.push(c); // bez push(...arr): velké shardy by přetekly zásobník
            shardLens.push(arr.length);
            yield s;
        }
        const decoded = Object.assign({}, first, { chunks: allChunks });
        delete decoded._shards;

        if (useCache && sigBefore && sigBefore === _diskSig(base, keyTag)) {
            const meta = Object.assign({}, decoded); delete meta.chunks;
            const shards = [];
            let off = 0;
            for (const n of shardLens) { shards.push(_sliceSig(decoded.chunks.slice(off, off + n))); off += n; }
            _partCache.set(base, { sig: sigBefore, chunks: decoded.chunks, meta });
            _shardState.set(base, { sig: sigBefore, count: shardLens.length, metaJson: JSON.stringify(meta), shards });
            return Object.assign({}, meta, { chunks: decoded.chunks.slice() });
        }
        return decoded;
    } catch (e) {
        _forgetPartition(base);
        console.error(`⚠️ RAG: Nepodařilo se dešifrovat partition pro ${directoryName}:`, e.message);
        return { chunks: [] };
    }
}

function loadPartition(directoryName) {
    const it = _loadPartitionSteps(directoryName);
    let r;
    while (!(r = it.next()).done) { /* synchronně naráz */ }
    return r.value;
}

/** Jako loadPartition, ale mezi shardy uvolní smyčku událostí (server mezitím odpovídá). */
async function loadPartitionAsync(directoryName) {
    const it = _loadPartitionSteps(directoryName);
    let r;
    while (!(r = it.next()).done) await new Promise(res => setImmediate(res));
    return r.value;
}

/**
 * Re-encrypts all partitions when the master key is rotated.
 */
function reencryptAllPartitions(oldMasterKey, newMasterKey) {
    // Klientské složky (getActiveDirectories) I znalostní báze agentů (_kb_* z registru) —
    // KB partitiony nejsou reálné složky, takže by je jinak rotace klíče minula a zůstaly
    // by šifrované starým klíčem (nedešifrovatelné).
    const dirs = [...new Set([...getActiveDirectories(), ..._listKbScopes()])];
    for (const dir of dirs) {
        const base = _partitionBase(dir);
        if (!fs.existsSync(_shardPath(base, 0))) continue;

        _forgetPartition(base); // shardy se přepíšou mimo savePartition
        const oldKey = crypto.pbkdf2Sync(oldMasterKey, dir, 1000, 32, 'sha256');
        const newKey = crypto.pbkdf2Sync(newMasterKey, dir, 1000, 32, 'sha256');
        // Každý shard je samostatně šifrovaný — přešifruj soubor po souboru (bez slučování),
        // takže se ani u velkých bází nedotkneme V8 limitu délky řetězce.
        for (let s = 0; ; s++) {
            const p = _shardPath(base, s);
            if (!fs.existsSync(p)) break;
            try {
                const payload = JSON.parse(fs.readFileSync(p, 'utf8'));
                const decrypted = secureCrypto.decrypt(oldKey, payload); // GCM i legacy CBC
                const newPayload = JSON.stringify(secureCrypto.encrypt(newKey, decrypted));
                fs.writeFileSync(p, newPayload, 'utf8');
            } catch (e) {
                console.error(`❌ RAG: Selhal přepisy klíče pro partition ${dir} (shard ${s}):`, e.message);
            }
        }
    }
}

// Load RAG index from disk (merges all partitions for backward compatibility)
async function loadIndex() {
    const dirs = getActiveDirectories();
    const allChunks = [];
    for (const dir of dirs) {
        const part = loadPartition(dir);
        if (part.chunks) {
            for (const c of part.chunks) allChunks.push(c);
        }
    }
    
    // BACKWARD COMPATIBILITY: Merge chunks from monolithic index if it exists
    const RAG_INDEX_PATH = dataPath('.rag_index.json');
    if (fs.existsSync(RAG_INDEX_PATH)) {
        try {
            const data = fs.readFileSync(RAG_INDEX_PATH, 'utf-8');
            const index = JSON.parse(data);
            if (index.chunks) {
                const loadedIds = new Set(allChunks.map(c => c.id));
                for (const chunk of index.chunks) {
                    if (!loadedIds.has(chunk.id)) {
                        allChunks.push(chunk);
                    }
                }
            }
        } catch (e) {}
    }
    
    return { chunks: allChunks };
}

// Save RAG index to disk (splits chunks back to correct partitions).
// POZOR: neukládá nešifrovaný monolit .rag_index.json — ten by obcházel
// šifrování partitionů (plný text + vektory v plaintextu). Partitiony jsou
// jediný perzistentní formát; případný starý plaintext se po zápisu smaže.
function saveIndex(index) {
    const groups = {};
    const dirs = getActiveDirectories();
    for (const dir of dirs) {
        groups[dir] = [];
    }

    for (const chunk of index.chunks || []) {
        const dir = chunk.fileName.includes('/') ? chunk.fileName.split('/')[0] : 'root';
        if (!groups[dir]) {
            groups[dir] = [];
        }
        groups[dir].push(chunk);
    }

    for (const dir of Object.keys(groups)) {
        savePartition(dir, { chunks: groups[dir] });
    }

    // Migrace/úklid: starý nešifrovaný monolit už není potřeba (data jsou nyní
    // v šifrovaných partitionech) — smažeme ho, aby PII nezůstávalo v plaintextu.
    const RAG_INDEX_PATH = dataPath('.rag_index.json');
    try {
        if (fs.existsSync(RAG_INDEX_PATH)) fs.unlinkSync(RAG_INDEX_PATH);
    } catch (e) { /* best-effort */ }
}

/**
 * Fetch embeddings from local Ollama service.
 */
async function getEmbedding(text) {
    // Volitelná cache vektorů (jen když je nastavené EMBED_CACHE_FILE — testovací server).
    const embedCache = require('./embed_cache');
    const cached = embedCache.get(EMBEDDING_MODEL, text);
    if (cached) return cached;

    const response = await ollama.embeddings({
        model: EMBEDDING_MODEL,
        prompt: text
    });

    if (response && response.embedding) {
        embedCache.set(EMBEDDING_MODEL, text, response.embedding);
        return response.embedding;
    }

    throw new Error("Ollama returned an empty embedding.");
}

// --- Lexikální (deterministický, offline) fallback ---
// Když embedding model neběží, RAG degraduje na klíčové vyhledávání nad TEXTEM
// chunků: kosinová podobnost frekvencí termů. Bez závislostí, deterministické,
// funguje i nad chunky uloženými bez vektoru (indexace proběhla offline).
function _deaccent(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
// Krátká česká/anglická stop-slova — nenesou rozlišovací význam pro shodu.
const _STOP = new Set(['a', 'i', 'o', 'u', 'v', 'k', 's', 'z', 'na', 'do', 'od', 'po', 'za', 'se', 'si',
    'je', 'to', 've', 'ke', 'ze', 'pro', 'nad', 'pod', 'pri', 'ci', 'ze', 'by', 'byl', 'byla', 'bylo',
    'jako', 'tak', 'ale', 'nebo', 'aby', 'jsou', 'jsem', 'the', 'of', 'and', 'or', 'in', 'on', 'at']);
function _lexTokens(text) {
    return _deaccent(text).split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !_STOP.has(t));
}
function _termFreq(tokens) {
    const tf = Object.create(null);
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    return tf;
}
// Kosinová podobnost term-frekvencí mezi dotazem a textem chunku. query může být
// řetězec i předtokenizované pole (rychlejší při skórování mnoha chunků).
function lexicalScore(query, text) {
    const q = _termFreq(Array.isArray(query) ? query : _lexTokens(query));
    const d = _termFreq(_lexTokens(text));
    let dot = 0, nq = 0, nd = 0;
    for (const k in q) { nq += q[k] * q[k]; if (d[k]) dot += q[k] * d[k]; }
    for (const k in d) { nd += d[k] * d[k]; }
    if (nq === 0 || nd === 0) return 0;
    return dot / (Math.sqrt(nq) * Math.sqrt(nd));
}

// Cílová velikost chunku a překryv (znaky). Laditelné přes env BEZ zásahu do kódu:
//   RAG_CHUNK_MAX_CHARS  (def. 700) — horní mez délky chunku,
//   RAG_CHUNK_OVERLAP_CHARS (def. 120) — kolik znaků konce chunku se zopakuje na
//   začátku dalšího (kontinuita kontextu přes hranici — lepší dohledatelnost faktů,
//   která by jinak padla přesně na předěl). Změna se projeví AŽ PO re-indexaci
//   (POST /api/rag/reindex-all); skóre ani prahy (0.70 v conflicts/agent) to nemění.
const CHUNK_MAX = Math.max(200, parseInt(process.env.RAG_CHUNK_MAX_CHARS, 10) || 700);
const CHUNK_OVERLAP = Math.max(0, Math.min(
    (parseInt(process.env.RAG_CHUNK_OVERLAP_CHARS, 10) || 120),
    Math.floor(CHUNK_MAX / 2)
));
// Znalostní báze agentů (_kb_*: zákony, judikatura, vzory) má VLASTNÍ, větší kousky.
// Měření 11. 10. 2026 (training/embed/search_lab.py, zlatá sada 124 dotazů nad zákony):
// kousky 700 znaků 66,1 % správně na 1. místě, 1200 → 68,5 %, 2000 → 69,3 % (celé § 70,2 %).
// Paragraf rozsekaný na 700 znaků ztrácí kontext (nadpis, odstavce) → hledání ho hůř trefí.
// Klientské spisy zůstávají na RAG_CHUNK_MAX_CHARS (jiný druh textu, neměřeno).
// Změna se projeví u NOVĚ nahraných dokumentů báze — stávající je třeba nahrát znovu
// (reindex-kb jen přepočítá vektory stávajících kousků, nepřeseká je).
function kbChunkMaxChars() {
    const v = parseInt(process.env.RAG_KB_CHUNK_MAX_CHARS, 10);
    return Number.isFinite(v) ? Math.max(200, v) : 2000;
}

// Rozdělí příliš dlouhý odstavec na věty (tečka/!/? + mezera + další „slovo"). Věta
// delší než `max` se tvrdě rozseká po slovech. České zkratky (odst., §, č.) můžou
// větu občas rozdělit navíc — pro embeddingy to nevadí (kratší smysluplné jednotky).
function _splitSentences(paragraph, max) {
    const parts = String(paragraph).split(/(?<=[.!?])\s+(?=[A-ZÁ-Ža-zá-ž0-9(„"])/);
    const out = [];
    for (const s of parts) {
        const seg = s.trim();
        if (!seg) continue;
        if (seg.length <= max) { out.push(seg); continue; }
        let buf = '';
        for (const w of seg.split(/\s+/)) {
            if (w.length > max) {
                // Patologicky dlouhé „slovo" (bez mezer) — nasekej po znacích, ať žádný
                // chunk nepřeteče MAX a nezahltí embedding.
                if (buf) { out.push(buf); buf = ''; }
                for (let i = 0; i < w.length; i += max) out.push(w.slice(i, i + max));
                continue;
            }
            if (buf && (buf.length + 1 + w.length) > max) { out.push(buf); buf = w; }
            else buf = buf ? buf + ' ' + w : w;
        }
        if (buf) out.push(buf);
    }
    return out;
}

// Vrátí konec chunku (~overlap znaků) začínající na hranici slova — pro překryv.
function _tailForOverlap(chunk, overlap) {
    if (overlap <= 0) return '';
    const s = String(chunk);
    if (s.length <= overlap) return s;
    const slice = s.slice(s.length - overlap);
    const sp = slice.indexOf(' ');
    return sp >= 0 ? slice.slice(sp + 1) : slice;
}

/**
 * Rozdělí text dokumentu na chunky vhodné k indexaci. Oproti dřívějšku:
 *  • dlouhé odstavce (typické u smluv/podání) se rozdělí na věty → menší, přesnější
 *    chunky = kvalitnější embeddingy a cílenější dohledání,
 *  • mezi chunky je PŘEKRYV (kontinuita kontextu přes hranici),
 *  • velikost i překryv jsou laditelné (opts nebo env).
 * Krátký text zůstává jedním chunkem (zpětně kompatibilní chování).
 */
function chunkText(text, opts) {
    if (!text) return [];
    const MAX = (opts && opts.maxChars) || CHUNK_MAX;
    const OVERLAP = (opts && opts.overlapChars != null) ? opts.overlapChars : CHUNK_OVERLAP;

    const paragraphs = String(text)
        .split(/\r?\n/)
        .map(p => p.trim())
        .filter(p => p.length > 0);

    // Dlouhé odstavce → věty (aby chunky nebyly obří).
    const units = [];
    for (const p of paragraphs) {
        if (p.length <= MAX) units.push(p);
        else units.push(..._splitSentences(p, MAX));
    }

    const chunks = [];
    let cur = '';
    for (const u of units) {
        if (cur && (cur.length + 1 + u.length) > MAX) {
            chunks.push(cur);
            const tail = _tailForOverlap(cur, OVERLAP);
            cur = tail ? tail + ' ' + u : u;
        } else {
            cur = cur ? cur + ' ' + u : u;
        }
    }
    if (cur) chunks.push(cur);

    return chunks.map(c => c.trim()).filter(Boolean);
}

/**
 * Calculate Cosine Similarity between two numeric vectors.
 */
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function indexDocument(fileName, text) {
    console.log(`🧠 RAG: Zahajuji vektorovou indexaci pro soubor ${fileName}...`);

    const chunks = chunkText(text);
    if (chunks.length === 0) {
        console.warn(`⚠️ RAG: Soubor ${fileName} neobsahuje text k indexaci.`);
        return;
    }

    // Embeddings (síťová/CPU operace) počítáme MIMO zámek, abychom neblokovali
    // ostatní; kritickou sekci load→merge→save serializuje mutex.
    // Když model neběží, NEshazujeme celou indexaci — chunk uložíme TEXTOVĚ
    // (vector=null) a je pak dohledatelný lexikálně; po zapnutí modelu stačí
    // spustit re-indexaci (POST /api/rag/reindex-all), která vektory doplní.
    const vectors = [];
    let embeddedCount = 0;
    for (let i = 0; i < chunks.length; i++) {
        try {
            vectors.push(await getEmbedding(chunks[i]));
            embeddedCount++;
        } catch (e) {
            vectors.push(null);
        }
    }
    if (embeddedCount === 0) {
        console.warn(`⚠️ RAG: Embedding model nedostupný — „${fileName}" indexován TEXTOVĚ (lexikální vyhledávání). Po zapnutí modelu spusťte re-indexaci.`);
    } else if (embeddedCount < chunks.length) {
        console.warn(`⚠️ RAG: „${fileName}" — část chunků bez vektoru (${chunks.length - embeddedCount}/${chunks.length}); po zapnutí modelu doindexujte.`);
    }

    await ragMutex.acquire();
    try {
        const index = await loadIndex();
        // Odstranit staré chunky téhož souboru (re-indexace).
        index.chunks = index.chunks.filter(chunk => chunk.fileName !== fileName);
        for (let i = 0; i < chunks.length; i++) {
            index.chunks.push({
                id: `chk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                fileName: fileName,
                text: chunks[i],
                vector: _toF32(vectors[i]),
                embedded: vectors[i] != null,
                chunkIndex: i,
                totalChunks: chunks.length
            });
        }
        saveIndex(index);
        console.log(`✅ RAG: Soubor ${fileName} úspěšně indexován (${chunks.length} odstavců).`);
    } finally {
        ragMutex.release();
    }
}

// --- Znalostní báze agentů (per-agent RAG) --------------------------------------
// Každý agent má vlastní IZOLOVANOU partition `_kb_<id>` (role knowledge base:
// rešeršník = judikatura/legislativa, spisovatel = vzory, kontrolor = checklisty…).
// Tyto partitiony ZÁMĚRNĚ NEJSOU v getActiveDirectories() (nejsou to reálné složky),
// takže se NEpletou do obecného vyhledávání ani do conflicts.js/AML. Do vyhledávání
// vstupují jen když je explicitně požádá volající přes filters.scopes.
//
// Registr scope (prostý seznam jmen, ne citlivé) drží, které KB partitiony existují —
// aby je rotace šifrovacího klíče (reencryptAllPartitions) taky přešifrovala.
const KB_PREFIX = '_kb_';
function _kbRegistryPath() { return dataPath('.rag_kb_registry.json'); }
function _listKbScopes() {
    try {
        const raw = fs.readFileSync(_kbRegistryPath(), 'utf8');
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter(s => typeof s === 'string') : [];
    } catch (e) { return []; }
}
function _registerKbScope(scope) {
    try {
        const cur = _listKbScopes();
        if (!cur.includes(scope)) {
            cur.push(scope);
            fs.writeFileSync(_kbRegistryPath(), JSON.stringify(cur), 'utf8');
        }
    } catch (e) { console.warn('⚠️ RAG KB: registr scope se nepodařilo zapsat:', e.message); }
}

/**
 * Zaindexuje dokument do znalostní báze agenta (scope = `_kb_<id>`). Izolovaný
 * round-trip: pracuje jen s danou partition (na rozdíl od indexDocument, který
 * slévá všechny klientské partitiony). Bez modelu uloží chunky textově (vector=null),
 * dohledatelné lexikálně.
 */
async function indexKnowledge(scope, fileName, text) {
    if (!scope || String(scope).indexOf(KB_PREFIX) !== 0) {
        throw new Error(`indexKnowledge: neplatný scope „${scope}" (musí začínat ${KB_PREFIX}).`);
    }
    const kbMax = kbChunkMaxChars();
    const chunks = chunkText(text, { maxChars: kbMax, overlapChars: Math.min(CHUNK_OVERLAP, Math.floor(kbMax / 2)) });
    if (chunks.length === 0) {
        console.warn(`⚠️ RAG KB: „${fileName}" (${scope}) neobsahuje text k indexaci.`);
        return { indexed: 0 };
    }
    const vectors = [];
    let embedded = 0;
    for (let i = 0; i < chunks.length; i++) {
        try { vectors.push(await getEmbedding(chunks[i])); embedded++; }
        catch (e) { vectors.push(null); }
    }

    await ragMutex.acquire();
    try {
        const part = loadPartition(scope);
        const kept = (part.chunks || []).filter(c => c.fileName !== fileName);
        for (let i = 0; i < chunks.length; i++) {
            kept.push({
                id: `kb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                fileName: fileName,
                text: chunks[i],
                vector: _toF32(vectors[i]),
                embedded: vectors[i] != null,
                chunkIndex: i,
                totalChunks: chunks.length,
                scope: scope
            });
        }
        savePartition(scope, { chunks: kept });
        _registerKbScope(scope);
        console.log(`✅ RAG KB: „${fileName}" → ${scope} (${chunks.length} chunků, ${embedded} s vektorem).`);
        return { indexed: chunks.length, embedded };
    } finally {
        ragMutex.release();
    }
}

/** Smaže dokument ze znalostní báze agenta. */
async function deleteKnowledge(scope, fileName) {
    await ragMutex.acquire();
    try {
        const part = loadPartition(scope);
        const before = (part.chunks || []).length;
        const kept = (part.chunks || []).filter(c => c.fileName !== fileName);
        if (kept.length !== before) savePartition(scope, { chunks: kept });
        return { removed: before - kept.length };
    } finally {
        ragMutex.release();
    }
}

/**
 * Znovu spočítá VEKTORY existujících chunků znalostní báze (scope). KB dokumenty
 * nemají zdrojový soubor na disku (plní se textem), proto je reindex-all z inboxu
 * MINE — tahle funkce re-embeduje jejich uložený text NA MÍSTĚ. Nutné po změně
 * embedding modelu/poskytovatele (jiná dimenze vektoru). Embedding počítá MIMO zámek;
 * pod zámkem jen zapíše dle id (chunky přidané mezitím zůstanou nedotčené).
 */
async function reindexKnowledge(scope, onProgress, opts = {}) {
    // Dedup PŘED embedováním — duplicitní chunky (navrstvené opakovaným seedováním) se
    // jinak zbytečně re-embedují a nafukují dobu běhu. Klíč = id (fallback fileName#idx).
    const snapshot = _dedupChunks(loadPartition(scope).chunks || []);
    if (!snapshot.length) return { scope, chunks: 0, embedded: 0, reused: 0 };

    // Obnovitelnost: chunk, který UŽ má vektor cílové dimenze (targetDim), se přeskočí
    // (nepřepočítává se). Díky tomu je reindex bezpečně opakovatelný — re-běh po pádu
    // pokračuje, kde skončil, a dokončené báze proletí okamžitě. `force` vynutí přepočet.
    const targetDim = Number.isInteger(opts.targetDim) && opts.targetDim > 0 ? opts.targetDim : null;
    const force = !!opts.force;

    const total = snapshot.length;
    const vectors = Object.create(null);
    let embedded = 0;
    let reused = 0;
    let done = 0;
    for (const c of snapshot) {
        const cur = c.vector;
        if (!force && targetDim && isVector(cur) && cur.length === targetDim) {
            // už embedováno správným modelem → recykluj, žádné volání ollamy
            vectors[c.id] = floatVector(c); // u Int8 vrátí skutečné hodnoty (jinak by se zapsala čísla bez škály)
            embedded++; reused++;
        } else {
            try {
                const v = await getEmbedding(c.text || '');
                vectors[c.id] = v;
                if (v != null) embedded++;
            } catch (e) {
                vectors[c.id] = null;
            }
        }
        done++;
        // Průběh (živý log v reindex-kb.js) — hlásí každých 25 chunků + na konci.
        if (typeof onProgress === 'function' && (done % 25 === 0 || done === total)) {
            try { onProgress(done, total, embedded, reused); } catch (e) { /* log nesmí shodit reindex */ }
        }
    }

    await ragMutex.acquire();
    try {
        const part = loadPartition(scope);
        const chunks = _dedupChunks(part.chunks || []);
        for (const c of chunks) {
            if (Object.prototype.hasOwnProperty.call(vectors, c.id)) {
                c.vector = _toF32(vectors[c.id]);
                c.embedded = c.vector != null;
            }
        }
        savePartition(scope, { chunks });
        return { scope, chunks: chunks.length, embedded, reused };
    } finally {
        ragMutex.release();
    }
}

/**
 * Re-embeduje VŠECHNY registrované znalostní báze (po změně embedding modelu).
 * Volitelný `onScope(phase, scope, i, n, extra)` hlásí průběh: phase 'start' | 'progress'
 * | 'done' (extra = {done,total,emb,reused} u 'progress', výsledek {scope,chunks,embedded,
 * reused} u 'done'). `opts` ({targetDim, force}) se předá do reindexKnowledge (obnovitelnost).
 */
async function reindexAllKnowledge(onScope, opts = {}) {
    const results = [];
    const scopes = _listKbScopes();
    for (let i = 0; i < scopes.length; i++) {
        const scope = scopes[i];
        if (typeof onScope === 'function') { try { onScope('start', scope, i, scopes.length); } catch (e) {} }
        const r = await reindexKnowledge(scope, (done, total, emb, reused) => {
            if (typeof onScope === 'function') { try { onScope('progress', scope, i, scopes.length, { done, total, emb, reused }); } catch (e) {} }
        }, opts);
        results.push(r);
        if (typeof onScope === 'function') { try { onScope('done', scope, i, scopes.length, r); } catch (e) {} }
    }
    return results;
}

/** Judikaturní scopy pro celoplošné hledání: obory `_kb_obor_*` + volitelná společná `_kb_judikatura`. */
function listJudikaturaScopes() {
    return _listKbScopes().filter(sc => sc === '_kb_judikatura' || String(sc).indexOf('_kb_obor_') === 0);
}

/**
 * Načte znalostní báze agentů do paměti hned po startu serveru (ne až při prvním dotazu).
 * Báze s judikaturou se načítá ~1 min; bez toho by na ni čekal první advokát.
 * Načítání je synchronní (dešifrování + JSON) — proto až chvíli po startu a s logem.
 * Vypnutí: RAG_WARMUP=0. Vrací Promise s přehledem (pro testy a log).
 */
function warmKnowledgeBases(opts = {}) {
    const off = String(process.env.RAG_WARMUP == null ? '1' : process.env.RAG_WARMUP).trim() === '0';
    if (off) return Promise.resolve({ skipped: true });
    const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 3000;
    return new Promise(resolve => {
        const t = setTimeout(async () => {
            const out = [];
            for (const scope of _listKbScopes()) {
                await new Promise(r => setImmediate(r)); // mezi bázemi pustit čekající požadavky
                const t0 = Date.now();
                const n = ((await loadPartitionAsync(scope)).chunks || []).length;
                out.push({ scope, chunks: n, ms: Date.now() - t0 });
                if (n) console.log(`🧠 RAG: báze ${scope} připravena (${n} kousků, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
            }
            resolve({ scopes: out });
        }, delayMs);
        if (t.unref) t.unref();
    });
}

/** Vypíše dokumenty ve znalostní bázi agenta (název + počet chunků). */
function listKnowledge(scope) {
    const part = loadPartition(scope);
    const byFile = {};
    for (const c of part.chunks || []) {
        if (!byFile[c.fileName]) byFile[c.fileName] = { fileName: c.fileName, chunks: 0, embedded: 0 };
        byFile[c.fileName].chunks++;
        if (c.embedded) byFile[c.fileName].embedded++;
    }
    return Object.values(byFile);
}

/**
 * API: Removes indexed chunks belonging to the specified file.
 */
async function deleteDocumentIndex(fileName) {
    await ragMutex.acquire();
    try {
        const index = await loadIndex();
        const originalCount = index.chunks.length;

        index.chunks = index.chunks.filter(chunk => chunk.fileName !== fileName);

        if (index.chunks.length !== originalCount) {
            saveIndex(index);
            console.log(`🗑️ RAG: Odstraněno ${originalCount - index.chunks.length} odstavců pro soubor ${fileName}.`);
        }
    } finally {
        ragMutex.release();
    }
}

/**
 * API: Queries the vector index for semantically similar chunks.
 */
async function searchSimilar(query, limit = 5, filters = null, opts = {}) {
    if (!query || !query.trim()) return [];
    // Volitelné měření fází (kb_regression.js): opts.timing = {} → doby jednotlivých kroků v ms.
    const _T = opts && opts.timing && typeof opts.timing === 'object' ? opts.timing : null;
    let _t0 = _T ? process.hrtime.bigint() : 0n;
    const _mark = name => {
        if (!_T) return;
        const t = process.hrtime.bigint();
        _T[name] = (_T[name] || 0) + Number(t - _t0) / 1e6;
        _t0 = t;
    };

    // Fallback je OPT-IN: přísné volání (bez opts) při výpadku modelu vyhodí chybu
    // (fail-closed) — kritické pro conflicts.js, kde „nemožnost prověřit" ≠ „bez
    // konfliktu". Obecné vyhledávání zapne { lexicalFallback:true } a degraduje.
    const allowLexicalFallback = !!(opts && opts.lexicalFallback);

    let queryVector = null;
    let embeddingFailed = false;
    try {
        queryVector = await getEmbedding(query);
        _mark('embedding');
    } catch (e) {
        if (!allowLexicalFallback) {
            console.error(`❌ RAG: Vyhledávání selhalo, model nedostupný:`, e.message);
            throw e;
        }
        embeddingFailed = true;
        console.warn(`⚠️ RAG: Embedding model nedostupný — lexikální (klíčový) fallback:`, e.message);
    }

    // Přístup ke KLIENTSKÝM spisům lze vypnout (filters.clientAccess === false) — pak
    // agent čerpá JEN z vlastní znalostní báze (filters.scopes). Výchozí = plný přístup,
    // takže conflicts.js/AML (filters=null) i dosavadní volání se nemění.
    const clientAccess = !(filters && filters.clientAccess === false);

    let chunks = [];
    if (clientAccess) {
        if (filters && filters.directory) {
            chunks = loadPartition(filters.directory).chunks || [];
        } else if (filters && Array.isArray(filters.fileNames) && filters.fileNames.length > 0) {
            const dirs = new Set(filters.fileNames.map(f => f.includes('/') ? f.split('/')[0] : 'root'));
            for (const dir of dirs) {
                chunks.push(...(loadPartition(dir).chunks || []));
            }
        } else {
            const index = await loadIndex();
            chunks = index.chunks || [];
        }

        if (filters) {
            if (Array.isArray(filters.fileNames) && filters.fileNames.length > 0) {
                const allowedFiles = new Set(filters.fileNames.map(f => f.toLowerCase().replace(/\\/g, '/')));
                chunks = chunks.filter(chunk => {
                    const normName = chunk.fileName.toLowerCase().replace(/\\/g, '/');
                    return allowedFiles.has(normName);
                });
            }

            if (filters.directory) {
                const normDir = filters.directory.toLowerCase().replace(/\\/g, '/');
                chunks = chunks.filter(chunk => {
                    const normName = chunk.fileName.toLowerCase().replace(/\\/g, '/');
                    return normName.startsWith(normDir + '/') || normName === normDir;
                });
            }
        }
    }

    // Firemní režim: jen úseky dokumentů ze spisů, ke kterým má volající přístup
    // (lib/file_acl.js; principal z opts nebo z request_context). Nález 14. 10. 2026:
    // agent jinak čerpal i z cizích spisů. Výjimka jen opts.aclBypass (prověrka střetu
    // zájmů musí projít celou kancelář — výsledky si redaguje sama, viz conflicts.js).
    if (clientAccess && !(opts && opts.aclBypass)) {
        chunks = require('./file_acl').filterChunks(chunks, opts ? opts.principal : undefined);
    }

    // Znalostní báze agenta (per-agent RAG): PŘIDÁ chunky z KB partitionů `_kb_<id>`
    // do kandidátů. Skórují se stejně (kosinově), takže se nemění význam prahu 0.70.
    if (filters && Array.isArray(filters.scopes) && filters.scopes.length > 0) {
        for (const scope of filters.scopes) {
            if (typeof scope === 'string' && scope.indexOf(KB_PREFIX) === 0) {
                // opts.kbFilter: jen pro měření (např. „jen zákony" vs. plná báze), produkce ho nepoužívá.
                const keep = opts && typeof opts.kbFilter === 'function' ? opts.kbFilter : null;
                for (const c of (loadPartition(scope).chunks || [])) if (!keep || keep(c)) chunks.push(c);
            }
        }
    }

    _mark('kandidati');
    // Sémantický režim: kosinová podobnost vektorů (chunky bez vektoru → 0, jako dřív).
    // Lexikální fallback: kosinová podobnost term-frekvencí nad textem chunku.
    // Hybrid: blend obou. withComponents: vrátí i dílčí skóre (sem/lex) — pro sweep,
    // který pak blenduje offline pro víc alph BEZ opakovaného embedování dotazu.
    const rrf = _rrfEnabled() && !embeddingFailed;
    const hybrid = _hybridEnabled() && !embeddingFailed && !rrf; // RRF má přednost před lin. hybridem
    const hybridAlpha = _hybridAlpha();
    const withComponents = !!(opts && opts.withComponents);
    const needLex = embeddingFailed || hybrid || withComponents || rrf;
    const qTokens = needLex ? _lexTokens(query) : null;
    // Hybrid s poolem: nejdřív sémantika pro všechny, lexikální složka jen pro nejlepší kandidáty.
    const pool = _hybridPool(opts);
    // Platí i pro čistou sémantiku: pořadí podle skóre = pořadí podle sémantiky, takže top pool
    // je přesný — a výsledky (s textem) se nevyrábějí pro všechny kousky báze.
    if ((hybrid || !needLex) && !withComponents && pool > 0 && chunks.length > pool) {
        const sems = new Float64Array(chunks.length);
        const q = Float32Array.from(queryVector);
        let qn = 0;
        for (let j = 0; j < q.length; j++) qn += q[j] * q[j];
        qn = Math.sqrt(qn);
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i], v = c.vector;
            // Rychlá cesta pro kompaktní kousky (předpočítaná norma); jinak obecný výpočet.
            if (c.vecNorm > 0 && qn > 0 && v && v.length === q.length) {
                let dot = 0;
                for (let j = 0; j < q.length; j++) dot += q[j] * v[j];
                sems[i] = dot / (qn * c.vecNorm);
            } else {
                sems[i] = cosineSimilarity(queryVector, v);
            }
        }
        const order = Array.from({ length: chunks.length }, (_, i) => i).sort((a, b) => sems[b] - sems[a]);
        const idx = order.slice(0, pool);
        // Zákony mají vlastní pool, aby je převaha judikatury nevytlačila už tady.
        const lawPool = _lawPool();
        if (lawPool > 0) {
            const inPool = new Set(idx);
            let added = 0;
            for (const i of order) { if (added >= lawPool) break; if (isLawChunk(chunks[i])) { if (!inPool.has(i)) idx.push(i); added++; } }
        }
        const semOf = new Map(idx.map(i => [chunks[i], sems[i]]));
        chunks = idx.map(i => chunks[i]);
        opts = Object.assign({}, opts, { _semOf: semOf });
    }
    _mark('semantika+pool');
    const semCache = opts && opts._semOf;
    const results = chunks.map(chunk => {
        const txt = chunk.text || '';
        const sem = embeddingFailed ? 0 : (semCache && semCache.has(chunk) ? semCache.get(chunk) : cosineSimilarity(queryVector, chunk.vector));
        const lex = needLex ? lexicalScore(qTokens, txt) : 0;
        let score, method;
        if (embeddingFailed) { score = lex; method = 'lexical'; }
        else if (rrf) { score = sem; method = 'rrf'; }      // dočasné skóre; přepíše fúze níž
        else if (hybrid) { score = blendScore(sem, lex, hybridAlpha); method = 'hybrid'; }
        else { score = sem; method = 'semantic'; }
        const r = {
            fileName: chunk.fileName,
            text: txt,
            score: score,
            method: method,
            degraded: embeddingFailed,
            scope: chunk.scope || null, // KB chunk (_kb_<id>) vs. klientský spis (null)
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks
        };
        if (withComponents || rrf) { r.semantic = embeddingFailed ? null : sem; r.lexical = lex; }
        return r;
    });

    // RRF: fúze pořadí ze sémantického a lexikálního žebříčku (r.semantic/r.lexical).
    _mark('skore');
    if (rrf && results.length) _applyRrf(results, _rrfK());

    results.sort((a, b) => b.score - a.score);
    // dedupeKb: z téhož souboru ZNALOSTNÍ BÁZE (např. „§ 204“) max. 1 úsek — dlouhý
    // paragraf jinak zabere víc míst v top-k a vytlačí další relevantní ustanovení.
    // Klientské spisy se nededuplikují (u dlouhé smlouvy chceme víc jejích částí).
    _mark('razeni');
    let ranked = opts && opts.dedupeKb ? dedupeKbResults(results) : results;
    // Volitelný reranker (lib/rerank_service.js): jen když o něj volající požádá (opts.rerank)
    // A je zapnutý v env (RAG_RERANK=1; služba RAG_RERANK_URL, jinak ONNX v procesu). Mění POŘADÍ top-K, ne `score` —
    // prahy (RAG_MIN_SCORE, 0.70 v conflicts) tak drží význam. Chyba/timeout → původní pořadí.
    if (opts && opts.rerank && !embeddingFailed && rerankService.rerankEnabled()) {
        ranked = await rerankService.rerankResults(query, ranked);
    }
    // Agent (dedupeKb) dostane zákony i judikaturu v daném poměru — viz mixKbResults.
    if (opts && opts.dedupeKb && opts.kbMix !== false) ranked = mixKbResults(ranked, limit, _lawShare(opts));
    _mark('dedup+mix');
    return ranked.slice(0, limit);
}

/** Ponechá z každého KB souboru (scope `_kb_*`) jen první = nejlépe skórovaný úsek. Čistá funkce. */
function dedupeKbResults(sorted) {
    const seen = new Set();
    return sorted.filter(r => {
        if (!(typeof r.scope === 'string' && r.scope.indexOf(KB_PREFIX) === 0)) return true;
        const key = r.scope + '/' + r.fileName;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Reciprocal Rank Fusion nad výsledky RAG: přepíše `score` každého výsledku na
 * Σ 1/(K + rank_i), kde rank_i je pořadí v sémantickém (r.semantic) a lexikálním
 * (r.lexical) žebříčku. Robustní kombinace hustého + řídkého vyhledávání.
 * Mutuje a vrací totéž pole (setříděné volající). Čistá funkce (testovatelná).
 */
function _applyRrf(results, K = 60) {
    const s = (Number.isFinite(K) && K > 0) ? K : 60;
    const fused = new Map();
    const bySem = [...results].sort((a, b) => (b.semantic || 0) - (a.semantic || 0));
    const byLex = [...results].sort((a, b) => (b.lexical || 0) - (a.lexical || 0));
    bySem.forEach((r, i) => fused.set(r, (fused.get(r) || 0) + 1 / (s + i + 1)));
    byLex.forEach((r, i) => fused.set(r, (fused.get(r) || 0) + 1 / (s + i + 1)));
    for (const r of results) { r.score = fused.get(r) || 0; r.method = 'rrf'; }
    return results;
}

module.exports = {
    loadPartitionAsync,
    flushPendingSaves,
    agentRagK,
    dedupeKbResults,
    indexDocument,
    deleteDocumentIndex,
    searchSimilar,
    loadIndex,
    getEmbedding,
    cosineSimilarity,
    lexicalScore,
    blendScore,
    chunkText,
    kbChunkMaxChars,
    indexKnowledge,
    deleteKnowledge,
    listKnowledge,
    reindexKnowledge,
    reindexAllKnowledge,
    reencryptAllPartitions,
    listJudikaturaScopes,
    listKbScopes: _listKbScopes,
    loadPartition,
    partitionStat,
    savePartition,
    getActiveDirectories,
    // #úložiště: kompaktní vektory (testy)
    vecToBase64: _vecToB64,
    base64ToVec: _b64ToVec,
    dedupChunks: _dedupChunks,
    encodeChunkForDisk: _encodeChunkForDisk,
    decodeChunkFromDisk: _decodeChunkFromDisk,
    applyRrf: _applyRrf,
    isVector,
    floatVector,
    warmKnowledgeBases,
    isJudikaturaChunk,
    mixKbResults,
    _resetPartitionCache
};
