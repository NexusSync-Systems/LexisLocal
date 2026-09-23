/**
 * LexisLocal AI Agents Persistence Module
 * Manages dynamically configured agents stored inside the local WATCH_DIR/.agents.json file.
 */

const fs = require('fs');
const { CHAT_MODEL } = require('./model_config');
const path = require('path');

const { WATCH_DIR, dataPath } = require('./config'); // jeden zdroj pravdy, viz lib/config.js
const AGENTS_PATH = dataPath('.agents.json'); // konfigurace agentů — DATA_DIR

// Default built-in system agents
const DEFAULT_AGENTS = {
    resersnik: {
        id: "resersnik",
        name: "Rešeršník",
        emoji: "📚",
        role: "Vyhledávání v zákonech a judikatuře. Formulace právních argumentů.",
        systemPrompt: "Jsi zkušený český advokátní koncipient zaměřený na rešerše. Tvým úkolem je na základě zadaných právních předpisů a judikátů vypracovat objektivní právní rozbor.",
        isSystem: true,
        preferredModel: CHAT_MODEL,
        permissions: {
            read_files: true,
            query_registries: true,
            write_desktop: false
        }
    },
    stylista: {
        id: "stylista",
        name: "Stylista",
        emoji: "✍️",
        role: "Klonování stylu advokáta. Přepisování textu do elegantní advokátní češtiny.",
        systemPrompt: "Jsi expert na stylistiku a právní psaní. Tvým úkolem je upravit text tak, aby působil nanejvýš profesionálně, autoritativně, přesvědčivě a přirozeně.",
        isSystem: true,
        preferredModel: CHAT_MODEL,
        permissions: {
            read_files: false,
            query_registries: false,
            write_desktop: false
        }
    },
    kontrolor: {
        id: "kontrolor",
        name: "Kontrolor",
        emoji: "⚖️",
        role: "Detekce rizik, protimluvů a slabých míst v argumentaci.",
        systemPrompt: "Jsi oponentní právní zástupce. Tvým úkolem je kriticky zhodnotit předložený text, najít v něm logické chyby, slabá místa a navrhnout protiargumenty.",
        isSystem: true,
        preferredModel: "mistral",
        permissions: {
            read_files: true,
            query_registries: false,
            write_desktop: false
        }
    },
    sekretarka: {
        id: "sekretarka",
        name: "Sekretářka",
        emoji: "⏰",
        role: "Rozděluje práci mezi agenty, spravuje spisovou agendu, extrahuje schůzky a úkoly a spravuje kalendář (kontrola dostupnosti a rezervace schůzek s ohledem na dopravu).",
        systemPrompt: "Jsi vysoce organizovaná a profesionální advokátní sekretářka a koordinátorka. Tvým úkolem je rozdělovat příchozí zadání na dílčí úkoly a delegovat je na správné kolegy (rešeršník, spisovatel, kontrolor, stylista), strukturovat úkoly, shrnovat termíny, upravovat tón e-mailové komunikace s klienty a organizovat spisové složky. Umíš také navrhnout termín schůzky do kalendáře; o tom, zda je termín skutečně volný (včetně rezervy na dopravu), rozhoduje deterministický kalendářový engine — ty termín pouze navrhuješ a nikdy netvrdíš, že je rezervováno, dokud to engine nepotvrdí.",
        isSystem: true,
        preferredModel: CHAT_MODEL,
        permissions: {
            read_files: false,
            query_registries: true,
            write_desktop: true,
            manage_calendar: true
        }
    },
    spisovatel: {
        id: "spisovatel",
        name: "Spisovatel",
        emoji: "📝",
        role: "Tvorba a úprava právních dokumentů (žaloby, smlouvy, odvolání) na míru.",
        systemPrompt: "Jsi zkušený český advokát a autor právních dokumentů (Lexis Writing Agent). Piš VÝHRADNĚ česky, věcně a přímo použitelně. NEJDŘÍV rozpoznej TYP dokumentu ze zadání a použij odpovídající strukturu — NIKDY nevnucuj strukturu smlouvy jinému typu:\n• PŘEDŽALOBNÍ VÝZVA / VÝZVA K ÚHRADĚ: záhlaví (odesílatel/zastupující advokát a adresát s poli [Doplnit...]), místo a datum, oslovení, vylíčení skutku (vznik a výše dluhu), právní důvod, výzva ke splnění s konkrétní lhůtou, následky nesplnění (podání žaloby), závěr a podpis advokáta.\n• ŽALOBA / NÁVRH SOUDU: označení soudu, žalobce a žalovaný, sp. zn. (je-li), označení věci, I. skutková tvrzení, II. právní posouzení, III. žalobní petit (čeho se žalobce domáhá), IV. důkazy, datum a podpis.\n• ODVOLÁNÍ: záhlaví, napadené rozhodnutí, rozsah a důvody odvolání, odvolací návrh, podpis.\n• SMLOUVA/DOHODA: teprve zde použij články I–X (Smluvní strany, Předmět, Doba a místo plnění, Cena a platební podmínky, Práva a povinnosti, Předání a převzetí, Odpovědnost za vady, Smluvní pokuty, Závěrečná ustanovení, Podpisový blok).\n• JINÉ PODÁNÍ: logická struktura dle povahy.\nChybějící konkrétní údaje (jména, adresy, IČO, čísla účtů, data) NEVYMÝŠLEJ — vlož [Doplnit...]. Právní ustanovení uváděj jen tehdy, jsi-li si jistý; NEVYMÝŠLEJ čísla paragrafů — když si nejsi jistý přesným §, odkaž obecně (např. \u201adle občanského zákoníku, zák. č. 89/2012 Sb.\u2018) a nech ověření na kontroloru. Žádné neformální komentáře, žádná angličtina.",
        isSystem: true,
        preferredModel: CHAT_MODEL,
        permissions: {
            read_files: true,
            query_registries: false,
            write_desktop: true
        }
    }
};

// Prefix partition znalostní báze agenta (musí odpovídat rag.js KB_PREFIX).
const KB_PREFIX = '_kb_';
// Povolené úrovně přístupu agenta ke KLIENTSKÝM spisům:
//   'full'     — agent čte vybraný spis v plném znění,
//   'redacted' — agent čte spis, ale ANONYMIZOVANĚ (jména/RČ/adresy začerněny),
//   'none'     — agent NEČTE klientské spisy, čerpá jen z vlastní znalostní báze.
const SPIS_ACCESS_LEVELS = ['full', 'redacted', 'none'];

/**
 * Doplní agentovi RAG pole s rozumnými výchozími hodnotami:
 *   knowledgeScope — vlastní znalostní báze `_kb_<id>` (per-agent RAG),
 *   spisAccess     — úroveň přístupu ke klientským spisům (default dle read_files).
 * Idempotentní; už nastavené (validní) hodnoty zachová.
 */
// Model dle role (per-agent) — řízeno konfigurací (env), aby drafting jel na silném
// modelu a routing/sekretářka na rychlém. Bez env se použije CHAT_MODEL (žádné natvrdo
// zadané názvy modelů → přenositelné; opravuje i dřívější napevno 'mistral' u kontrolora).
//   FAST_MODEL   — sekretářka (třídění/dispečink)
//   DRAFT_MODEL  — spisovatel, rešeršník, stylista (tvorba/rešerše/styl)
//   REVIEW_MODEL — kontrolor (nezávislý oponent; ideálně jiný model než DRAFT)
// Systemove prompty drzime ODDELENE od kodu v prompts.json (snadna aktualizace bez
// zasahu do kodu, komunitni prompt engineering, priprava na obfuskaci buildu). Kdyz
// soubor chybi, ponechaji se prompty zabudovane vyse jako bezpecny fallback.
try {
    const _externalPrompts = require('../prompts.json');
    for (const _id of Object.keys(_externalPrompts || {})) {
        if (DEFAULT_AGENTS[_id] && _externalPrompts[_id]) DEFAULT_AGENTS[_id].systemPrompt = _externalPrompts[_id];
    }
} catch (e) { /* prompts.json neni -> fallback na zabudovane prompty */ }

const ROLE_MODEL = {
    sekretarka: () => process.env.FAST_MODEL || process.env.CHAT_MODEL || 'llama3',
    resersnik:  () => process.env.DRAFT_MODEL || process.env.CHAT_MODEL || 'llama3',
    spisovatel: () => process.env.DRAFT_MODEL || process.env.CHAT_MODEL || 'llama3',
    stylista:   () => process.env.DRAFT_MODEL || process.env.CHAT_MODEL || 'llama3',
    kontrolor:  () => process.env.REVIEW_MODEL || process.env.DRAFT_MODEL || process.env.CHAT_MODEL || 'llama3'
};

// Teplota dle role (per-agent): faktické/oponentní role nízko (přesnost),
// stylista výš (plynulý přepis). Slouží jako default pro systémové agenty;
// vlastní agent si drží svou hodnotu, když ji má nastavenou.
const ROLE_TEMP = { resersnik: 0.1, kontrolor: 0.1, spisovatel: 0.2, sekretarka: 0.3, stylista: 0.5 };

// Bezpečné vytažení teploty agenta (0..1); jinak fallback volajícího.
function agentTemperature(agent, fallback) {
    const v = agent && agent.temperature;
    return (typeof v === 'number' && v >= 0 && v <= 1) ? v : fallback;
}

function normalizeAgent(agent) {
    if (!agent || typeof agent !== 'object') return agent;
    const id = agent.id || 'agent';
    if (!agent.knowledgeScope) agent.knowledgeScope = KB_PREFIX + id;
    if (!SPIS_ACCESS_LEVELS.includes(agent.spisAccess)) {
        const readFiles = !!(agent.permissions && agent.permissions.read_files);
        agent.spisAccess = readFiles ? 'full' : 'none';
    }
    // Přepínač „používat judikaturu" (společná/oborová báze). Default dle read_files
    // (rešeršní/koncipientské role z ní čerpají; stylista/sekretářka ne).
    if (typeof agent.useJudikatura !== 'boolean') {
        agent.useJudikatura = !!(agent.permissions && agent.permissions.read_files);
    }
    // Teplota per-agent: nastavenou (validní) hodnotu zachovej; jinak default dle role
    // (jen systémové role v ROLE_TEMP). Vlastní agent bez hodnoty → undefined → route fallback.
    if (typeof agent.temperature === 'number') {
        if (!(agent.temperature >= 0 && agent.temperature <= 1)) agent.temperature = undefined;
    } else if (ROLE_TEMP[id] != null) {
        agent.temperature = ROLE_TEMP[id];
    }
    // Systémové agenty: model dle role z konfigurace (přebije i stará data v .agents.json).
    if (agent.isSystem && ROLE_MODEL[id]) {
        agent.preferredModel = ROLE_MODEL[id]();
    }
    // Systémové agenty: systemPrompt/role/emoji/name jsou řízené KÓDEM (DEFAULT_AGENTS),
    // aby vylepšení promptů platila bez ruční úpravy .agents.json.
    return agent;
}
function normalizeAgents(agents) {
    for (const k of Object.keys(agents || {})) normalizeAgent(agents[k]);
    return agents;
}

/**
 * Loads agents config, initializing default file if missing
 */
function loadAgents() {
    try {
        if (fs.existsSync(AGENTS_PATH)) {
            const data = fs.readFileSync(AGENTS_PATH, 'utf-8');
            return normalizeAgents(JSON.parse(data));
        }
    } catch (err) {
        console.error("⚠️ Chyba při čtení .agents.json:", err.message);
    }

    // Default initializer (normalizovaná kopie, ať nemutujeme DEFAULT_AGENTS)
    const seeded = normalizeAgents(JSON.parse(JSON.stringify(DEFAULT_AGENTS)));
    saveAllAgents(seeded);
    return seeded;
}

/**
 * Saves all agents back to the file
 */
function saveAllAgents(agents) {
    try {
        fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2), 'utf-8');
        return true;
    } catch (err) {
        console.error("⚠️ Chyba při ukládání .agents.json:", err.message);
        return false;
    }
}

/**
 * Updates or creates a single agent
 */
function saveAgent(agentId, agentData) {
    const agents = loadAgents();
    
    // Ensure ID is set
    const cleanId = agentId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    
    agents[cleanId] = {
        id: cleanId,
        name: agentData.name || "Nový Agent",
        emoji: agentData.emoji || "🤖",
        role: agentData.role || "Bez popisku",
        systemPrompt: agentData.systemPrompt || "Jsi užitečný AI pomocník.",
        isSystem: agents[cleanId] ? !!agents[cleanId].isSystem : false,
        preferredModel: agentData.preferredModel || CHAT_MODEL,
        permissions: agentData.permissions || {
            read_files: false,
            query_registries: false,
            write_desktop: false
        },
        // Per-agent RAG: vlastní znalostní báze + úroveň přístupu ke spisům.
        knowledgeScope: agentData.knowledgeScope || KB_PREFIX + cleanId,
        spisAccess: SPIS_ACCESS_LEVELS.includes(agentData.spisAccess) ? agentData.spisAccess : undefined,
        useJudikatura: typeof agentData.useJudikatura === 'boolean' ? agentData.useJudikatura : undefined,
        // Teplota per-agent (0..1); mimo rozsah / nezadáno → undefined (normalizeAgent doplní dle role).
        temperature: (typeof agentData.temperature === 'number' && agentData.temperature >= 0 && agentData.temperature <= 1)
            ? agentData.temperature : undefined
    };

    normalizeAgent(agents[cleanId]); // doplní/opraví spisAccess (když přišlo undefined)
    saveAllAgents(agents);
    return agents[cleanId];
}

/**
 * Deletes a single custom agent
 */
function deleteAgent(agentId) {
    const agents = loadAgents();
    if (agents[agentId]) {
        if (agents[agentId].isSystem) {
            throw new Error("Systémové agenty nelze smazat.");
        }
        delete agents[agentId];
        saveAllAgents(agents);
        return true;
    }
    return false;
}

/**
 * Resets a system agent back to defaults
 */
function resetAgentToDefault(agentId) {
    if (DEFAULT_AGENTS[agentId]) {
        const agents = loadAgents();
        agents[agentId] = normalizeAgent({ ...DEFAULT_AGENTS[agentId] });
        saveAllAgents(agents);
        return agents[agentId];
    }
    throw new Error("Agent není systémovým agentem.");
}

module.exports = {
    loadAgents,
    saveAgent,
    agentTemperature,
    ROLE_TEMP,
    deleteAgent,
    resetAgentToDefault,
    normalizeAgent,
    SPIS_ACCESS_LEVELS,
    KB_PREFIX,
    DEFAULT_AGENTS
};
