/**
 * rag_request.js — přeloží `ragFilters` z těla requestu na filtry pro RAG
 * vyhledávání (rozbalí caseNumber na konkrétní soubory spisu apod.).
 *
 * Sdílené mezi server.js (agent / agent-swarm routy) a routes/rag.js, aby
 * logika žila na jednom místě.
 */
'use strict';

// --- Oborově dělený RAG -------------------------------------------------------
// Judikatura se plní do oborových partitionů `_kb_obor_<slug>`; slug se odvozuje
// z volného pole `agenda` spisu (viz spisy.js). STEJNÁ funkce se použije při
// plnění (routes/knowledge.js) i při dotazu, aby se scope trefily.
// Taxonomie oborů + slug žijí v lib/obory.js (jeden zdroj pravdy, bez cyklu).
const { oborSlug, scopeOf: oborScope, labelForScope } = require('./obory');

// `watcher` (a jeho závislost `ocr`) načítáme LÍNĚ až uvnitř resolveRagFilters —
// aby se dal modul (a applyAgentScope) použít bez roztažení celého watcher řetězce.

async function resolveRagFilters(reqBody) {
    if (!reqBody || !reqBody.ragFilters) return null;
    const { ragFilters } = reqBody;

    let fileNames = [];
    if (Array.isArray(ragFilters.fileNames)) {
        fileNames = [...ragFilters.fileNames];
    }

    if (ragFilters.caseNumber) {
        try {
            const { loadInbox } = require('./watcher');
            const inbox = await loadInbox();
            const caseFiles = Object.values(inbox.files || {})
                .filter(f => f.caseNumber === ragFilters.caseNumber)
                .map(f => f.relativePath || f.fileName);
            fileNames = [...new Set([...fileNames, ...caseFiles])];
        } catch (err) {
            console.warn("⚠️ RAG Filter: Nepodařilo se načíst spisy pro caseNumber:", err.message);
        }
    }

    const filters = {};
    if (fileNames.length > 0) {
        filters.fileNames = fileNames;
    }
    if (ragFilters.directory) {
        filters.directory = ragFilters.directory;
    }
    if (ragFilters.strict !== undefined) {
        filters.strict = ragFilters.strict;
    }

    // Oborový scope (dělený RAG): explicitní `obor`, jinak z `agenda` spisu dle caseNumber.
    let oborAgenda = ragFilters.obor || '';
    let oborSource = ragFilters.obor ? 'explicit' : null;
    if (!oborAgenda && ragFilters.caseNumber) {
        try {
            const spisy = require('./spisy');
            const spis = spisy.findByCase(ragFilters.caseNumber);
            if (spis && spis.agenda) { oborAgenda = spis.agenda; oborSource = 'spis'; }
        } catch (e) { /* spisy modul nedostupný → dotaz jede bez oborového scope */ }
    }
    const scope = oborScope(oborAgenda);
    if (scope) {
        filters.scopes = Array.isArray(filters.scopes) ? filters.scopes : [];
        if (!filters.scopes.includes(scope)) filters.scopes.push(scope);
        // Marker: ZNÁMÝ konkrétní obor (explicitní volba / agenda spisu). Judikatura
        // se pak drží JEN tohoto oboru (přesnost) místo celoplošného hledání.
        filters.oborScope = scope;
        filters.oborSource = oborSource;
    }

    return Object.keys(filters).length > 0 ? filters : null;
}

/**
 * Doplní do RAG filtrů zaměření AGENTA (per-agent RAG + úroveň přístupu ke spisům):
 *   • přidá vlastní znalostní bázi agenta (`knowledgeScope` → filters.scopes),
 *   • pokud agent nemá přístup ke klientským spisům (`spisAccess === 'none'`),
 *     nastaví `clientAccess:false` (agent pak čerpá JEN z vlastní báze).
 * Přijímá jednoho agenta i pole (debata dvou agentů) — scopes se sjednotí a přístup
 * ke klientským spisům se omezí, jakmile ho NEMÁ kterýkoli z účastníků (konzervativně).
 *
 * Judikatura (společná báze) — politika zaměření:
 *   • ZNÁMÝ konkrétní obor (opts.preferOborScope, jinak filters.oborScope z agendy/volby,
 *     nebo spolehlivá auto-detekce) → hledej JEN v tom oboru (přesnost),
 *   • obor NEznámý → přidej VŠECHNY judikaturní obory (celoplošně, recall).
 *
 * Vrací nový objekt (nemutuje vstup); null když nevzniknou žádné filtry.
 */
function applyAgentScope(filters, agentOrAgents, opts = {}) {
    const agents = Array.isArray(agentOrAgents) ? agentOrAgents : [agentOrAgents];
    const f = filters ? { ...filters } : {};
    const scopes = new Set(Array.isArray(f.scopes) ? f.scopes : []);
    // Nejpřísnější úroveň napříč účastníky vyhrává: none > redacted > full.
    let restrictClient = false;   // 'none'
    let redactClient = false;     // 'redacted'
    for (const a of agents) {
        if (!a) continue;
        if (a.knowledgeScope) scopes.add(a.knowledgeScope);
        if (a.spisAccess === 'none') restrictClient = true;
        else if (a.spisAccess === 'redacted') redactClient = true;
    }
    // Judikatura: má-li ji některý účastník zapnutou…
    if (agents.some(a => a && a.useJudikatura)) {
        const preferred = opts.preferOborScope || f.oborScope || null;
        if (preferred) {
            // …a známe konkrétní obor → drž se JEN jeho (přesnost). Ostatní obory nepřidávej.
            scopes.add(preferred);
        } else {
            // …obor neznámý → celoplošně přes všechny judikaturní obory (recall).
            try {
                const rag = require('./rag');
                if (typeof rag.listJudikaturaScopes === 'function') {
                    for (const sc of rag.listJudikaturaScopes()) scopes.add(sc);
                }
            } catch (e) { /* rag nedostupný → bez judikatury */ }
        }
    }
    if (scopes.size) f.scopes = [...scopes];
    if (restrictClient) f.clientAccess = false;
    else if (redactClient) f.redactClient = true; // klientský kontext se anonymizuje (viz agent.js)
    // Interní markery (oborScope/oborSource) ať neprobublají do searchSimilar filtrů — nevadí,
    // searchSimilar je ignoruje; necháváme je pro čitelnost logu a případný debug.
    return Object.keys(f).length > 0 ? f : null;
}

/**
 * buildRagScope — JEDNO místo, kde se poskládá kompletní RAG scope pro (jednoho i
 * dva) agenty, VČETNĚ automatické detekce oboru z textu dotazu:
 *   1) resolveRagFilters — explicitní obor / agenda spisu / soubory / directory,
 *   2) když je judikatura zapnutá a obor NENÍ znám z kroku 1, zkus ho AUTO-detekovat
 *      z `queryText` (lib/obor_detect.js); spolehlivá detekce zúží na daný obor,
 *   3) applyAgentScope — sjednotí KB agentů, přístup ke spisům a judikaturní politiku.
 *
 * Vrací { filters, detection }, kde `detection` je info pro UI („detekován obor…"):
 *   { scope, slug, label, source:'spis'|'explicit'|'auto', confident, score?, ranked? }
 *   nebo null (obor se neurčoval / nešel určit).
 */
async function buildRagScope(reqBody, agentOrAgents, queryText) {
    const agents = Array.isArray(agentOrAgents) ? agentOrAgents : [agentOrAgents];
    let filters = await resolveRagFilters(reqBody);

    const wantJudikatura = agents.some(a => a && a.useJudikatura);
    const knownScope = filters && filters.oborScope;

    let detection = null;
    let preferOborScope = knownScope || null;

    if (knownScope) {
        // Obor už známe z agendy/volby → jen ho ohlásíme UI.
        detection = {
            scope: knownScope,
            slug: String(knownScope).replace('_kb_obor_', ''),
            label: labelForScope(knownScope),
            source: (filters && filters.oborSource) || 'spis',
            confident: true
        };
    } else if (wantJudikatura && queryText) {
        // Judikatura zapnutá, obor neznámý → zkusit auto-detekci z textu dotazu.
        try {
            const { detectObor } = require('./obor_detect');
            const d = await detectObor(queryText);
            if (d) {
                detection = {
                    scope: d.scope, slug: d.slug, label: d.label,
                    source: 'auto', confident: d.confident, degraded: d.degraded,
                    score: d.score, margin: d.margin, method: d.method, ranked: d.ranked
                };
                if (d.confident) preferOborScope = d.scope;
            }
        } catch (e) {
            console.warn('⚠️ RAG: Auto-detekce oboru selhala:', e.message);
        }
    }

    filters = applyAgentScope(filters, agents, { preferOborScope });
    return { filters, detection };
}

module.exports = { resolveRagFilters, applyAgentScope, buildRagScope, oborSlug, oborScope };
