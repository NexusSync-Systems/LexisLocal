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
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';

// #5: hybridní retrieval (sémantika + lexikální shoda). OPT-IN (RAG_HYBRID=1),
// default VYPNUTO → chování beze změny. České §, čísla zákonů a sp. zn. jsou přesné
// tokeny, které lexikální shoda trefí a embeddingy rozmažou; blend obojí. Váhu řídí
// RAG_HYBRID_ALPHA (podíl sémantiky, default 0.7). Po zapnutí dolaď RAG_MIN_SCORE.
function _hybridEnabled() {
    const v = String(process.env.RAG_HYBRID == null ? '' : process.env.RAG_HYBRID).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
function _hybridAlpha() {
    const a = parseFloat(process.env.RAG_HYBRID_ALPHA);
    return (Number.isFinite(a) && a >= 0 && a <= 1) ? a : 0.7;
}
// Blend sémantického a lexikálního skóre (obě v [0,1]).
function blendScore(semantic, lexical, alpha) {
    const a = (Number.isFinite(alpha) && alpha >= 0 && alpha <= 1) ? alpha : 0.7;
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

/**
 * Saves a partition index file encrypted with a key derived for the specific directory.
 */
function savePartition(directoryName, index) {
    const partitionId = crypto.createHash('sha256').update(directoryName).digest('hex').substring(0, 16);
    const partitionPath = dataPath(`.rag_${partitionId}.json`);
    
    try {
        const key = getPartitionKey(directoryName);
        // AES-256-GCM (integrita) přes sdílený secure_crypto.
        const payload = JSON.stringify(secureCrypto.encrypt(key, JSON.stringify(index)));
        fs.writeFileSync(partitionPath, payload, 'utf8');
    } catch (e) {
        console.error(`⚠️ RAG: Nepodařilo se uložit partition pro ${directoryName}:`, e.message);
    }
}

/**
 * Levné metadata partition souboru (mtime + velikost) BEZ dešifrování — slouží
 * jako podpis pro invalidaci cache (např. centroidy oborů v obor_detect.js).
 * Vrací { mtimeMs, size } nebo null, když partition ještě neexistuje.
 */
function partitionStat(directoryName) {
    const partitionId = crypto.createHash('sha256').update(directoryName).digest('hex').substring(0, 16);
    const partitionPath = dataPath(`.rag_${partitionId}.json`);
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
function loadPartition(directoryName) {
    const partitionId = crypto.createHash('sha256').update(directoryName).digest('hex').substring(0, 16);
    const partitionPath = dataPath(`.rag_${partitionId}.json`);
    
    if (!fs.existsSync(partitionPath)) {
        const RAG_INDEX_PATH = dataPath('.rag_index.json');
        if (fs.existsSync(RAG_INDEX_PATH)) {
            try {
                const data = fs.readFileSync(RAG_INDEX_PATH, 'utf-8');
                const index = JSON.parse(data);
                const filteredChunks = (index.chunks || []).filter(c => {
                    const dir = c.fileName.includes('/') ? c.fileName.split('/')[0] : 'root';
                    return dir === directoryName;
                });
                return { chunks: filteredChunks };
            } catch (e) {}
        }
        return { chunks: [] };
    }
    
    try {
        const rawPayload = fs.readFileSync(partitionPath, 'utf8');
        const payload = JSON.parse(rawPayload);

        const key = getPartitionKey(directoryName);
        // Přečte GCM i starší CBC (zpětná kompatibilita).
        const decrypted = secureCrypto.decrypt(key, payload);
        return JSON.parse(decrypted);
    } catch (e) {
        console.error(`⚠️ RAG: Nepodařilo se dešifrovat partition pro ${directoryName}:`, e.message);
        return { chunks: [] };
    }
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
        const partitionId = crypto.createHash('sha256').update(dir).digest('hex').substring(0, 16);
        const partitionPath = dataPath(`.rag_${partitionId}.json`);
        if (!fs.existsSync(partitionPath)) continue;
        
        try {
            const rawPayload = fs.readFileSync(partitionPath, 'utf8');
            const payload = JSON.parse(rawPayload);

            const oldKey = crypto.pbkdf2Sync(oldMasterKey, dir, 1000, 32, 'sha256');
            const decrypted = secureCrypto.decrypt(oldKey, payload); // GCM i legacy CBC
            const index = JSON.parse(decrypted);

            const newKey = crypto.pbkdf2Sync(newMasterKey, dir, 1000, 32, 'sha256');
            const newPayload = JSON.stringify(secureCrypto.encrypt(newKey, JSON.stringify(index)));
            fs.writeFileSync(partitionPath, newPayload, 'utf8');
        } catch (e) {
            console.error(`❌ RAG: Selhal přepisy klíče pro partition ${dir}:`, e.message);
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
            allChunks.push(...part.chunks);
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
    const response = await ollama.embeddings({
        model: EMBEDDING_MODEL,
        prompt: text
    });

    if (response && response.embedding) {
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
                vector: vectors[i],
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
    const chunks = chunkText(text);
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
                vector: vectors[i],
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
async function reindexKnowledge(scope) {
    const snapshot = loadPartition(scope).chunks || [];
    if (!snapshot.length) return { scope, chunks: 0, embedded: 0 };

    const vectors = Object.create(null);
    let embedded = 0;
    for (const c of snapshot) {
        try {
            const v = await getEmbedding(c.text || '');
            vectors[c.id] = v;
            if (v != null) embedded++;
        } catch (e) {
            vectors[c.id] = null;
        }
    }

    await ragMutex.acquire();
    try {
        const part = loadPartition(scope);
        const chunks = part.chunks || [];
        for (const c of chunks) {
            if (Object.prototype.hasOwnProperty.call(vectors, c.id)) {
                c.vector = vectors[c.id];
                c.embedded = c.vector != null;
            }
        }
        savePartition(scope, { chunks });
        return { scope, chunks: chunks.length, embedded };
    } finally {
        ragMutex.release();
    }
}

/** Re-embeduje VŠECHNY registrované znalostní báze (po změně embedding modelu). */
async function reindexAllKnowledge() {
    const results = [];
    for (const scope of _listKbScopes()) {
        results.push(await reindexKnowledge(scope));
    }
    return results;
}

/** Judikaturní scopy pro celoplošné hledání: obory `_kb_obor_*` + volitelná společná `_kb_judikatura`. */
function listJudikaturaScopes() {
    return _listKbScopes().filter(sc => sc === '_kb_judikatura' || String(sc).indexOf('_kb_obor_') === 0);
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

    // Fallback je OPT-IN: přísné volání (bez opts) při výpadku modelu vyhodí chybu
    // (fail-closed) — kritické pro conflicts.js, kde „nemožnost prověřit" ≠ „bez
    // konfliktu". Obecné vyhledávání zapne { lexicalFallback:true } a degraduje.
    const allowLexicalFallback = !!(opts && opts.lexicalFallback);

    let queryVector = null;
    let embeddingFailed = false;
    try {
        queryVector = await getEmbedding(query);
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

    // Znalostní báze agenta (per-agent RAG): PŘIDÁ chunky z KB partitionů `_kb_<id>`
    // do kandidátů. Skórují se stejně (kosinově), takže se nemění význam prahu 0.70.
    if (filters && Array.isArray(filters.scopes) && filters.scopes.length > 0) {
        for (const scope of filters.scopes) {
            if (typeof scope === 'string' && scope.indexOf(KB_PREFIX) === 0) {
                chunks.push(...(loadPartition(scope).chunks || []));
            }
        }
    }

    // Sémantický režim: kosinová podobnost vektorů (chunky bez vektoru → 0, jako dřív).
    // Lexikální fallback: kosinová podobnost term-frekvencí nad textem chunku.
    // Tokeny dotazu potřebujeme pro lexikální fallback i pro hybridní blend.
    const hybrid = _hybridEnabled() && !embeddingFailed;
    const hybridAlpha = _hybridAlpha();
    const qTokens = (embeddingFailed || hybrid) ? _lexTokens(query) : null;
    const results = chunks.map(chunk => {
        let score, method;
        if (embeddingFailed) {
            score = lexicalScore(qTokens, chunk.text || '');
            method = 'lexical';
        } else if (hybrid) {
            const sem = cosineSimilarity(queryVector, chunk.vector);
            const lex = lexicalScore(qTokens, chunk.text || '');
            score = blendScore(sem, lex, hybridAlpha);
            method = 'hybrid';
        } else {
            score = cosineSimilarity(queryVector, chunk.vector);
            method = 'semantic';
        }
        return {
            fileName: chunk.fileName,
            text: chunk.text,
            score: score,
            method: method,
            degraded: embeddingFailed,
            scope: chunk.scope || null, // KB chunk (_kb_<id>) vs. klientský spis (null)
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks
        };
    });

    return results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

module.exports = {
    indexDocument,
    deleteDocumentIndex,
    searchSimilar,
    loadIndex,
    getEmbedding,
    cosineSimilarity,
    lexicalScore,
    blendScore,
    chunkText,
    indexKnowledge,
    deleteKnowledge,
    listKnowledge,
    reindexKnowledge,
    reindexAllKnowledge,
    reencryptAllPartitions,
    listJudikaturaScopes,
    loadPartition,
    partitionStat,
    savePartition,
    getActiveDirectories
};
