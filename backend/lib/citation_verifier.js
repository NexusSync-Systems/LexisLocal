/**
 * LexisLocal — Citation Verifier
 * ------------------------------------------------------------------
 * Deterministická (NE-AI) ověřovací vrstva. Bere odpověď modelu a každou
 * právní citaci (§, "zákon č. X/Y Sb.", spisové značky) ověří proti:
 *   (a) vytaženým RAG chunkům  → objevila se citace / citát v kontextu?
 *   (b) referenčnímu indexu    → existuje ten § v daném zákoně? je sp. zn. známá?
 *
 * Filozofie: model je NEDŮVĚRYHODNÝ. Důvěřujeme až tomuto verifieru.
 * Cokoli, co nelze ověřit, se označí (nebo odstraní) DŘÍV, než to uvidí advokát.
 *
 * Zero-dependency, CommonJS — v souladu se zbytkem backendu.
 *
 * ⚠️ Co tento modul ZARUČUJE: model neprotlačí § ani sp. zn., které
 *    neexistují nebo nebyly v podkladech (falešné citace a falešné doslovné
 *    citáty). Co NEZARUČUJE: že správně pochopí správně citovaný paragraf —
 *    to odchytí až člověk (human-in-the-loop).
 */

'use strict';

// ── Normalizace ────────────────────────────────────────────────────────────

/** Sjednotí bílé znaky a nedělitelné mezery, ať porovnání sedí. */
function normalizeWhitespace(str) {
    return String(str || '')
        .replace(/ /g, ' ')      // nbsp → mezera
        .replace(/\s+/g, ' ')
        .trim();
}

/** Normalizace pro porovnání citace (case-insensitive, sjednocené mezery). */
function normalizeCitation(str) {
    return normalizeWhitespace(str)
        .toLowerCase()
        .replace(/\s*\.\s*/g, '. ')   // "č.89" i "č. 89" → stejně
        .replace(/\s+/g, ' ')
        .trim();
}

// ── Extrakce citací z volného textu ────────────────────────────────────────
// Záměrně parsujeme volný text (ne strukturovaný JSON), protože slabé 3B modely
// strukturu spolehlivě nedodrží. Strukturovaný kontrakt [[C1]] je bonus navíc.

// Zákon: "zákon č. 89/2012 Sb.", "zákona č. 40/2009 Sb."
const RE_ZAKON = /zákon(?:a|em|u|ě)?\s+č\.?\s*(\d{1,4})\/(\d{4})\s*Sb\./gi;

// Paragraf: "§ 2048", "§2048", "§ 2048 odst. 2 písm. a)", i rozsah "§ 2079 a násl."
const RE_PARAGRAF = /§\s?(\d+[a-z]?)(\s*odst\.\s*\d+)?(\s*písm\.\s*[a-z]\))?/gi;

// Zkratky / názvy předpisů za paragrafem: „§ 57 OSŘ“, „§ 2048 obč. zák.“,
// „§ 57 občanského soudního řádu“. Bez nich verifier nevěděl, ke kterému zákonu § patří.
const LAW_ALIASES = [
    ['99/1963', /^(?:OSŘ|o\.\s?s\.\s?ř\.|občansk\S*\s+soudn\S*\s+řád\S*)/i],
    ['89/2012', /^(?:NOZ|OZ|obč\.\s?zák\.|občansk\S*\s+zákoník\S*)/i],
    ['90/2012', /^(?:ZOK|zákon\S*\s+o\s+obchodních\s+korporacích)/i],
    ['262/2006', /^(?:ZP|zák\.\s?práce|zákoník\S*\s+práce)/i],
    ['40/2009', /^(?:TZ|tr\.\s?zák\.|trestní\S*\s+zákoník\S*)/i],
    ['141/1961', /^(?:TŘ|tr\.\s?ř\.|trestní\S*\s+řád\S*)/i],
    ['150/2002', /^(?:s\.\s?ř\.\s?s\.|SŘS|soudní\S*\s+řád\S*\s+správní\S*)/i],
    ['500/2004', /^(?:SŘ|spr\.\s?ř\.|správní\S*\s+řád\S*)/i],
    ['182/2006', /^(?:IZ|InsZ|insolvenční\S*\s+zákon\S*)/i],
    ['120/2001', /^(?:EŘ|ex\.\s?ř\.|exekuční\S*\s+řád\S*)/i],
    ['292/2013', /^(?:ZŘS|z\.\s?ř\.\s?s\.|zákon\S*\s+o\s+zvláštních\s+řízeních\s+soudních)/i]
];
function _lawFromAlias(after) {
    // „§ 57 odst. 2 OSŘ“, „§ 57 OSŘ“ — přeskočí odstavec/písmeno a čárku
    const rest = String(after || '').replace(/^\s*(?:odst\.\s*\d+\s*)?(?:písm\.\s*[a-z]\)\s*)?,?\s*/, '');
    for (const [law, re] of LAW_ALIASES) if (re.test(rest)) return law;
    return null;
}

// Článek předpisu: „čl. 46c zákona …“, „článku 36 Listiny“, „čl. 6 GDPR“.
// Bez navázaného předpisu („čl. 5 smlouvy“) to není právní citace → nebereme.
const RE_CLANEK = /(?<![A-Za-zÁ-žá-ž])čl(?:\.|ánek|ánku|ánkem)\s*([IVXLC]+|\d+[a-z]?)(?![A-Za-z0-9])((?:\s*odst\.\s*\d+)?(?:\s*písm\.\s*[a-z]\))?)(?=[^.;\n]{0,40}?(?:zákon|Listin|Ústav|Úmluv|směrnic|nařízen|GDPR|Sb\.|Smlouvy\s+o\s+fungování))/gi;

// Spisová značka soudu (heuristika pokrývající běžné české formáty):
//   "26 Cdo 1230/2021", "II. ÚS 2168/07", "8 Afs 21/2009", "Pl. ÚS 19/08"
// Volitelný úvodní senát: arabské číslo (obecné soudy) NEBO římská číslice (ÚS).
const RE_SPISOVA_ZNACKA =
    /\b(?:\d{1,3}\s+|[IVX]{1,4}\.?\s+)?(?:Pl\.\s*ÚS|ÚS|Cdo|Tdo|Odo|Afs|As|Ads|Azs|Ao|Aps|Ncu|Nd|Konf|Cdon|Co|Tz|Nt)\s+\d+\/\d{2,4}\b/g;

/**
 * Vytáhne z textu všechny právní citace a jejich pozici.
 * @returns {Array<{raw, type, index, law?, paragraph?}>}
 */
function extractCitations(text) {
    const src = String(text || '');
    const found = [];

    let m;
    RE_ZAKON.lastIndex = 0;
    while ((m = RE_ZAKON.exec(src)) !== null) {
        found.push({
            raw: normalizeWhitespace(m[0]),
            type: 'zakon',
            index: m.index,
            law: `${m[1]}/${m[2]}`
        });
    }

    RE_PARAGRAF.lastIndex = 0;
    while ((m = RE_PARAGRAF.exec(src)) !== null) {
        found.push({
            raw: normalizeWhitespace(m[0]),
            type: 'paragraf',
            index: m.index,
            paragraph: m[1].toLowerCase()
        });
    }

    RE_CLANEK.lastIndex = 0;
    while ((m = RE_CLANEK.exec(src)) !== null) {
        found.push({
            raw: normalizeWhitespace(m[0]),
            type: 'clanek',
            index: m.index,
            article: m[1]
        });
    }

    RE_SPISOVA_ZNACKA.lastIndex = 0;
    while ((m = RE_SPISOVA_ZNACKA.exec(src)) !== null) {
        found.push({
            raw: normalizeWhitespace(m[0]),
            type: 'judikat',
            index: m.index
        });
    }

    // Přiřadí každému paragrafu nejbližší PŘEDCHÁZEJÍCÍ zákon (běžný zápis
    // "§ 2048 zákona č. 89/2012 Sb." i "podle zákona č. 89/2012 Sb. v § 2048").
    const laws = found.filter(c => c.type === 'zakon').sort((a, b) => a.index - b.index);
    for (const c of found) {
        if (c.type !== 'paragraf') continue;
        // Nejbližší zákon podle ABSOLUTNÍ vzdálenosti v textu. Pokrývá oba běžné
        // české zápisy: "§ X zákona č. Y Sb." (zákon ZA paragrafem — nejčastější)
        // i "podle zákona č. Y Sb. ... v § X" (zákon PŘED). Dřív se bral jen nejbližší
        // PŘEDCHÁZEJÍCÍ zákon, což u více zákonů v pořadí "§ X zákona Y" přiřadilo
        // paragraf ke špatnému (dřívějšímu) zákonu → chybné ověření.
        const alias = _lawFromAlias(src.slice(c.index + c.raw.length, c.index + c.raw.length + 60));
        if (alias) { c.law = alias; continue; }
        let nearest = null, best = Infinity;
        for (const law of laws) {
            const dist = Math.abs(law.index - c.index);
            if (dist < best) { best = dist; nearest = law; }
        }
        // Vzdálený zákon (jiný odstavec) k paragrafu nepatří.
        c.law = (nearest && best <= 300) ? nearest.law : null;
    }

    return found.sort((a, b) => a.index - b.index);
}

// ── Referenční index ───────────────────────────────────────────────────────
// Autoritativní mapa "co existuje". Naplní se při ingestu zákonů/judikatury.
// Struktura:
//   {
//     laws: { "89/2012": Set<"2048","2079",...>, ... },   // platné paragrafy
//     caseNumbers: Set<"26 cdo 1230/2021", ...>            // známé sp. zn. (normalizované)
//   }
// Když je index prázdný/chybí, verifier degraduje na ověření "bylo to v kontextu?".

function buildEmptyReferenceIndex() {
    return { laws: {}, caseNumbers: new Set() };
}

/**
 * Ověří jednu citaci proti kontextu i referenci.
 * @returns {{status, reason}} status ∈
 *   verified | unsupported_by_context | not_in_reference | unverified_case | no_reference_context_ok
 */
function verifyOne(citation, contextNorm, referenceIndex) {
    const rawNorm = normalizeCitation(citation.raw);
    const inContext = contextNorm.includes(rawNorm);

    const hasReference =
        referenceIndex &&
        ((referenceIndex.laws && Object.keys(referenceIndex.laws).length > 0) ||
         (referenceIndex.caseNumbers && referenceIndex.caseNumbers.size > 0));

    // 1) Judikatura — nejrizikovější, nejpřísnější.
    if (citation.type === 'judikat') {
        const key = normalizeCitation(citation.raw);
        if (referenceIndex && referenceIndex.caseNumbers && referenceIndex.caseNumbers.size > 0) {
            if (referenceIndex.caseNumbers.has(key)) return { status: 'verified', reason: 'sp. zn. je v referenčním indexu' };
            if (inContext) return { status: 'verified', reason: 'sp. zn. je doslovně v podkladech' };
            return { status: 'unverified_case', reason: 'sp. zn. není v indexu ani v podkladech' };
        }
        // Bez indexu judikatury: jediná opora je doslovný výskyt v podkladech.
        return inContext
            ? { status: 'verified', reason: 'sp. zn. je doslovně v podkladech' }
            : { status: 'unverified_case', reason: 'sp. zn. nelze ověřit (chybí index i výskyt v podkladech)' };
    }

    // 2) Zákon jako celek.
    if (citation.type === 'zakon') {
        if (referenceIndex && referenceIndex.laws && referenceIndex.laws[citation.law]) {
            return { status: 'verified', reason: 'zákon existuje v referenčním indexu' };
        }
        if (hasReference) {
            return { status: 'not_in_reference', reason: `zákon č. ${citation.law} Sb. není v referenčním indexu` };
        }
        return inContext
            ? { status: 'verified', reason: 'odkaz na zákon je v podkladech' }
            : { status: 'no_reference_context_ok', reason: 'bez indexu nelze existenci zákona ověřit' };
    }

    // 3) Paragraf (+ navázaný zákon).
    if (citation.type === 'paragraf') {
        const lawSet = citation.law && referenceIndex && referenceIndex.laws
            ? referenceIndex.laws[citation.law]
            : null;
        if (lawSet) {
            if (lawSet.has(citation.paragraph)) return { status: 'verified', reason: 'paragraf existuje v daném zákoně' };
            return { status: 'not_in_reference', reason: `§ ${citation.paragraph} v zákoně č. ${citation.law} Sb. neexistuje` };
        }
        // Reference pro tento zákon nemáme → opíráme se o kontext.
        if (inContext) return { status: 'verified', reason: 'paragraf je doslovně v podkladech' };
        if (hasReference && citation.law) {
            return { status: 'not_in_reference', reason: `zákon č. ${citation.law} Sb. není indexován` };
        }
        return { status: 'unsupported_by_context', reason: 'paragraf není v podkladech a nelze ho ověřit v referenci' };
    }

    // 4) Článek předpisu — ověřitelný jen doslovným výskytem v podkladech.
    if (citation.type === 'clanek') {
        const art = String(citation.article || '').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const artInCtx = art && new RegExp('čl(?:\\.|ánek|ánku|ánkem)?\\s*' + art + '(?![a-z0-9])', 'i').test(contextNorm);
        return (inContext || artInCtx)
            ? { status: 'verified', reason: 'článek je doslovně v podkladech' }
            : { status: 'unsupported_by_context', reason: 'článek předpisu není v podkladech — ověřte' };
    }

    return { status: 'unsupported_by_context', reason: 'neznámý typ citace' };
}

/**
 * Hlavní API. Ověří všechny citace v odpovědi.
 * @param {string} text            Odpověď modelu.
 * @param {object} opts
 * @param {Array}  opts.contextChunks  Vytažené RAG pasáže: [{text, sourceId?, fileName?}]
 * @param {object} opts.referenceIndex Autoritativní index (viz buildEmptyReferenceIndex).
 * @param {boolean} opts.strict        V strict módu se neověřené citace považují za blokující.
 * @returns {{
 *   ok, citations, counts, hallucinationRate, unverified, annotatedText
 * }}
 */
function verifyCitations(text, opts = {}) {
    const contextChunks = Array.isArray(opts.contextChunks) ? opts.contextChunks : [];
    const referenceIndex = opts.referenceIndex || buildEmptyReferenceIndex();
    const strict = !!opts.strict;

    const contextNorm = normalizeCitation(
        contextChunks.map(c => (c && c.text) ? c.text : '').join('\n')
    );

    const raw = extractCitations(text);
    const kbIndex = opts.kbIndex || null; // { '99/1963': Set('57') } z lib/kb_law_index.js
    const citations = raw.map(c => {
        let res = verifyOne(c, contextNorm, referenceIndex);
        if (res.status !== 'verified' && kbIndex && c.law && kbIndex[c.law]) {
            if (c.type === 'zakon') res = { status: 'verified', reason: 'zákon je ve znalostní bázi' };
            else if (c.type === 'paragraf' && kbIndex[c.law].has(c.paragraph)) res = { status: 'verified', reason: 'paragraf je ve znalostní bázi zákonů' };
        }
        // Dohledá, ve kterém chunku citace je (pro odkaz v UI).
        let sourceId = null;
        const rawNorm = normalizeCitation(c.raw);
        for (const chunk of contextChunks) {
            if (chunk && chunk.text && normalizeCitation(chunk.text).includes(rawNorm)) {
                sourceId = chunk.sourceId || chunk.fileName || null;
                break;
            }
        }
        return {
            raw: c.raw,
            type: c.type,
            law: c.law || null,
            paragraph: c.paragraph || null,
            article: c.article || null,
            status: res.status,
            reason: res.reason,
            // „no_reference_context_ok" NENÍ ověřeno: bez indexu i bez kontextu nemáme
            // podle čeho existenci citace potvrdit — falešná jistota by porušila zásadu
            // „nevymýšlet právo". Ověřené je jen to, co je doložené v indexu nebo podkladech.
            verified: res.status === 'verified',
            sourceId
        };
    });

    const VERIFIED = new Set(['verified']);
    const unverified = citations.filter(c => !VERIFIED.has(c.status));

    const counts = citations.reduce((acc, c) => {
        acc[c.status] = (acc[c.status] || 0) + 1;
        return acc;
    }, {});

    const hallucinationRate = citations.length
        ? +(unverified.length / citations.length).toFixed(3)
        : 0;

    return {
        ok: strict ? unverified.length === 0 : true,
        citations,
        counts,
        total: citations.length,
        unverifiedCount: unverified.length,
        hallucinationRate,
        unverified,
        annotatedText: annotateText(text, citations)
    };
}

/**
 * Označí v textu neověřené citace inline značkou ⚠, ať je advokát na první
 * pohled pozná. (Nemaže je — o smazání/přegenerování rozhoduje volající.)
 */
function annotateText(text, citations) {
    let out = String(text || '');
    const bad = citations
        .filter(c => c.status !== 'verified' && c.status !== 'verified_by_source' && c.status !== 'no_reference_context_ok')
        .map(c => c.raw)
        // nejdelší napřed, ať se kratší nezanoří do delšího
        .sort((a, b) => b.length - a.length);
    const seen = new Set();
    for (const raw of bad) {
        if (seen.has(raw)) continue;
        seen.add(raw);
        // nahradí jen výskyty, které ještě nejsou označené
        const safe = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(safe + '(?!\\s*⚠ NEOVĚŘENO)', 'g'), raw + ' ⚠ NEOVĚŘENO');
    }
    return out;
}

/**
 * Async nadstavba: po deterministickém jádru (verifyCitations) zkonzultuje u
 * NEověřených citací externí právní zdroje (legalSources). Zdroj může citaci jen
 * POTVRDIT → status 'verified_by_source'. Nedostupnost/nenalezení nechá citaci
 * BEZE ZMĚNY (fail-closed) a ověřenou citaci nikdy nedegraduje. Sync jádro je
 * netknuté — tahle funkce je čistě aditivní a volitelná.
 */
async function verifyCitationsWithSources(text, opts = {}) {
    const base = verifyCitations(text, opts);
    let legalSources = null;
    try { legalSources = require('./legalSources'); } catch (e) { return Object.assign({}, base, { sourcesConsulted: false }); }

    const NEEDS = new Set(['not_in_reference', 'unsupported_by_context', 'unverified_case']);
    let consulted = false;
    const citations = [];
    for (const c of base.citations) {
        if (!NEEDS.has(c.status)) { citations.push(c); continue; }
        try {
            let r = null;
            if (c.type === 'zakon' || c.type === 'paragraf') {
                r = await legalSources.verifyStatute({ law: c.law, paragraph: c.paragraph });
            } else if (c.type === 'judikat') {
                r = await legalSources.verifyCaseLaw({ spisZn: c.raw });
            }
            if (r && r.ok) consulted = true;
            if (r && r.ok && r.found) {
                citations.push(Object.assign({}, c, {
                    status: 'verified_by_source',
                    reason: 'ověřeno externím zdrojem (' + (r.source || 'zdroj') + ')',
                    verified: true,
                    source: r.source || null
                }));
                continue;
            }
        } catch (e) { /* fail-closed: citace zůstává beze změny */ }
        citations.push(c);
    }

    const VERIFIED = new Set(['verified', 'verified_by_source']);
    const unverified = citations.filter(c => !VERIFIED.has(c.status));
    const counts = citations.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {});
    return {
        ok: opts.strict ? unverified.length === 0 : true,
        citations,
        counts,
        total: citations.length,
        unverifiedCount: unverified.length,
        hallucinationRate: citations.length ? +(unverified.length / citations.length).toFixed(3) : 0,
        unverified,
        annotatedText: annotateText(text, citations),
        sourcesConsulted: consulted
    };
}

module.exports = {
    verifyCitations,
    verifyCitationsWithSources,
    extractCitations,
    buildEmptyReferenceIndex,
    annotateText,
    normalizeCitation,
    // interní, exportováno kvůli testům
    _verifyOne: verifyOne
};
