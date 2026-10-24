/**
 * obor_detect.js — AUTOMATICKÁ detekce právního oboru z textu dotazu.
 *
 * Cíl: agent s právem „Používat judikaturu" sám pozná, o jaké právo v zadání jde,
 * a zúží judikaturní RAG na příslušný obor (`_kb_obor_<slug>`) — místo celoplošného
 * hledání přes všechny obory. Když si NENÍ jistý, vrátí confident:false a volající
 * degraduje na celoplošné hledání (recall > přesnost, bezpečná strana).
 *
 * Hybridní skóre (bez nových závislostí, plně lokální):
 *   • SÉMANTICKY (když běží embedding model): kosinus dotazu vůči CENTROIDU vektorů
 *     dané oborové báze. Centroid = průměr vektorů chunků oboru; cachuje se a
 *     přepočítá jen když se partition změní (podpis = mtime+velikost souboru).
 *   • LEXIKÁLNĚ (vždy, i offline): kosinus term-frekvencí dotazu vůči klíčovým
 *     slovům oboru z taxonomie (lib/obory.js).
 * Výsledné skóre = váhovaný součet (sémantika převažuje, když je k dispozici).
 *
 * Detekuje jen mezi obory, které REÁLNĚ mají data (`_kb_obor_*` v registru).
 */
'use strict';

const rag = require('./rag');
const obory = require('./obory');

// Laditelné prahy (env, bez zásahu do kódu). Konzervativní výchozí hodnoty —
// při nejistotě raději confident:false (→ celoplošná judikatura u volajícího).
// LEXIKÁLNĚ-PRIMÁRNÍ klasifikace. Ověřeno na reálné judikatuře: charakteristický
// slovník oboru (klíčová slova) rozlišuje SPOLEHLIVĚ, kdežto průměrový centroid
// je zašuměný (krátký dotaz „výpověď z nájmu" umí sémanticky spadnout k pracovnímu
// právu). Sémantika proto jen jemně dorovnává při lexikální shodě/nule. Když
// lexikální signál chybí úplně (neznámá formulace bez klíčových slov), skóre
// zůstane pod prahem → detekce se neprosadí a volající degraduje na celoplošné
// hledání (recall). Vše laditelné přes env bez zásahu do kódu.
const MIN_SEM = parseFloat(process.env.OBOR_DETECT_MIN_SEM || '0.12');   // min. kombinované skóre (je-li k dispozici sémantika)
const MIN_LEX = parseFloat(process.env.OBOR_DETECT_MIN_LEX || '0.06');   // min. skóre v čistě lexikálním režimu
const MIN_MARGIN = parseFloat(process.env.OBOR_DETECT_MARGIN || '0.03'); // min. náskok #1 nad #2
const SEM_WEIGHT = parseFloat(process.env.OBOR_DETECT_SEM_WEIGHT || '0.2');
const LEX_WEIGHT = parseFloat(process.env.OBOR_DETECT_LEX_WEIGHT || '0.8');

// Cache centroidů: scope → { sig, centroid }. sig = mtime:size partition souboru.
const _centroidCache = new Map();

function _centroidFor(scope) {
    const stat = rag.partitionStat(scope);
    const sig = stat ? (stat.mtimeMs + ':' + stat.size) : 'none';
    const cached = _centroidCache.get(scope);
    if (cached && cached.sig === sig) return cached.centroid;

    let centroid = null;
    try {
        const chunks = rag.loadPartition(scope).chunks || [];
        let dim = 0, n = 0, sum = null;
        for (const c of chunks) {
            // Int8 vektory (kompaktní partition) mají škálu na kousek — pro průměr je potřeba skutečná hodnota.
            const v = c && (typeof rag.floatVector === 'function' ? rag.floatVector(c) : c.vector);
            // Pole i Float32Array (vektory načtené z disku jsou typované pole, viz rag.isVector).
            if (!(Array.isArray(v) || ArrayBuffer.isView(v)) || !v.length) continue;
            if (!sum) { dim = v.length; sum = new Array(dim).fill(0); }
            if (v.length !== dim) continue; // ochrana proti smíšeným dimenzím (změna modelu)
            for (let i = 0; i < dim; i++) sum[i] += v[i];
            n++;
        }
        if (n > 0) { for (let i = 0; i < dim; i++) sum[i] /= n; centroid = sum; }
    } catch (e) {
        centroid = null;
    }
    _centroidCache.set(scope, { sig, centroid });
    return centroid;
}

// Kandidátní obory = existující judikaturní obory (`_kb_obor_*`) s daty.
function _candidateScopes() {
    try {
        return rag.listJudikaturaScopes().filter(s => String(s).indexOf('_kb_obor_') === 0);
    } catch (e) {
        return [];
    }
}

/**
 * detectObor(queryText) → objekt s nejlepším oborem a žebříčkem, nebo null.
 * Návrat:
 *   { scope, slug, label, score, margin, confident, degraded, method, ranked[] }
 *   • confident — má se scope skutečně použít k zúžení,
 *   • degraded  — běželo jen lexikálně (model nedostupný),
 *   • ranked    — top kandidáti (pro náhled v UI).
 * null = není podle čeho detekovat (žádná oborová data / prázdný dotaz).
 */
async function detectObor(queryText) {
    const q = String(queryText || '').trim();
    if (!q) return null;

    const scopes = _candidateScopes();
    if (!scopes.length) return null;

    // Sémantika jen když embedding model odpoví; jinak čistě lexikálně.
    let qv = null;
    try { qv = await rag.getEmbedding(q); } catch (e) { qv = null; }

    // 1) Posbírej kandidáty a jejich centroidy (průměr vektorů oborové báze).
    const cands = scopes.map(scope => {
        const meta = obory.byScope(scope);
        const label = obory.labelForScope(scope);
        return {
            scope,
            slug: meta ? meta.slug : String(scope).replace('_kb_obor_', ''),
            label,
            keywordText: meta ? meta.keywordText : label,
            centroid: qv ? _centroidFor(scope) : null
        };
    });

    // 2) MEAN-CENTERING: společný průměr centroidů ≈ „obecné české právní pozadí",
    //    které mají všechny obory shodné (proto surové kosinusy vycházely ploše
    //    ~0,74). Odečtením zůstane jen ROZLIŠUJÍCÍ směr oboru — sémantika pak
    //    skutečně rozlišuje. Cena: pár vektorů navíc, zanedbatelná.
    const withC = cands.filter(c => Array.isArray(c.centroid) && c.centroid.length);
    let globalMean = null;
    if (withC.length >= 2) {
        const dim = withC[0].centroid.length;
        globalMean = new Array(dim).fill(0);
        for (const c of withC) {
            if (c.centroid.length !== dim) continue;
            for (let i = 0; i < dim; i++) globalMean[i] += c.centroid[i];
        }
        for (let i = 0; i < dim; i++) globalMean[i] /= withC.length;
    }
    const qc = (qv && globalMean) ? qv.map((x, i) => x - globalMean[i]) : qv;

    // 3) Skóruj: sémantika (centrovaná, clamp ≥0) + lexikální klíčová slova.
    const ranked = cands.map(c => {
        const lex = rag.lexicalScore(q, c.keywordText); // 0..1
        let sem = 0, hasSem = false;
        if (qv && Array.isArray(c.centroid) && c.centroid.length) {
            if (globalMean) {
                const sig = c.centroid.map((x, i) => x - globalMean[i]); // rozlišující směr
                sem = Math.max(0, rag.cosineSimilarity(qc, sig));
            } else {
                sem = Math.max(0, rag.cosineSimilarity(qv, c.centroid)); // fallback (< 2 obory)
            }
            hasSem = true;
        }
        const score = hasSem ? (SEM_WEIGHT * sem + LEX_WEIGHT * lex) : lex;
        return {
            scope: c.scope, slug: c.slug, label: c.label,
            sem: Number(sem.toFixed(4)), lex: Number(lex.toFixed(4)),
            score: Number(score.toFixed(4)),
            method: hasSem ? 'semantic+lexical' : 'lexical'
        };
    });

    ranked.sort((a, b) => b.score - a.score);
    const top = ranked[0];
    const second = ranked[1];
    const margin = Number((second ? top.score - second.score : top.score).toFixed(4));

    const anySem = ranked.some(r => r.method !== 'lexical');
    const minScore = anySem ? MIN_SEM : MIN_LEX;
    const confident = top.score >= minScore && margin >= MIN_MARGIN;

    return {
        scope: top.scope,
        slug: top.slug,
        label: top.label,
        score: top.score,
        margin,
        confident,
        degraded: !qv,
        method: top.method,
        ranked: ranked.slice(0, 5)
    };
}

// Vyprázdní cache centroidů (volitelně po re-indexaci; jinak se invaliduje sama dle mtime).
function clearCentroidCache() { _centroidCache.clear(); }

module.exports = { detectObor, clearCentroidCache };
