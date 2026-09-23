/**
 * LexisLocal Chief Orchestrator Module (Bod 15)
 * Decomposes complex legal queries into sequential sub-tasks, routes them to sandboxed 
 * agents with model-tiering, accumulates context, and synthesizes a final response.
 */

const { loadAgents, agentTemperature } = require('./agents');
const { CHAT_MODEL, RAG_MIN_SCORE } = require('./model_config');
const { anonymizeText } = require('./anonymizer'); // GDPR: kontext se anonymizuje před modelem
const { searchSimilar } = require('./rag');
// B1: per-agent scope i v ChiefOrchestrator cestě — bez toho agenti v orchestrátoru
// NEčerpají z vlastní znalostní báze (_kb_<id>) ani z judikatury (na rozdíl od
// přímých rout /api/agent a /api/agent-swarm, které buildRagScope volají).
const { applyAgentScope } = require('./rag_request');
const { routeByIntent, sanitizeSteps } = require('./agent_router'); // #1 deterministický router
const { checkSubject } = require('./registries');
// AI poskytovatel nezávislý na backendu (Ollama | OpenAI | Anthropic).
const ollama = require('./ai_provider');
const crypto = require('crypto');
const db = require('./database');
const { calculateInferenceMetrics } = require('./green_monitor');

// #3: přepínač smyčky kritika→revize (default ZAP). Vypnutí: AGENT_REVISE_LOOP=0.
function _reviseEnabled() {
    const v = String(process.env.AGENT_REVISE_LOOP == null ? '1' : process.env.AGENT_REVISE_LOOP).trim().toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

class ChiefOrchestrator {
    constructor() {
        this.defaultModel = CHAT_MODEL;
    }

    /**
     * Main orchestration engine entrypoint
     * @param {string} prompt - Comprehensive user instruction
     * @param {string} context - Active document context from LexisEditor
     * @param {string} globalModel - Default fallback model if preferred not available
     * @param {function} onStepProgress - Optional callback for real-time step reporting in UI
     */
    async orchestrate(prompt, context = "", globalModel = CHAT_MODEL, onStepProgress = null, ragFilters = null) {
        console.log("🧩 Chief Orchestrator: Zahajuji zpracování komplexního dotazu...");
        const startTime = Date.now();
        const stepsLog = [];

        // --- KROK 1: Dekompozice (Decomposition) ---
        if (onStepProgress) {
            onStepProgress({ status: "decomposing", message: "Rozkládám komplexní dotaz na dílčí pod-úkoly..." });
        }

        const steps = await this.decomposeQuery(prompt, globalModel);
        console.log(`🧩 Chief Orchestrator: Dekompozice dokončena. Vygenerováno ${steps.length} kroků.`);
        
        let accumulatedContext = "";
        if (context) {
            // GDPR: syrový kontext z editoru se před vstupem do modelu anonymizuje.
            accumulatedContext += `Výchozí kontext dokumentu z editoru:\n${anonymizeText(context)}\n\n`;
        }

        // --- KROK 2: Sekvenční spuštění (Delegation & Sandbox) ---
        const agents = loadAgents();

        for (const step of steps) {
            const agent = agents[step.agentId];
            if (!agent) {
                console.warn(`⚠️ Chief Orchestrator: Agent ${step.agentId} nebyl nalezen, přeskakuji krok.`);
                continue;
            }

            let stepModel = agent.preferredModel || globalModel;
            if (step.tier === 'light') {
                stepModel = CHAT_MODEL; // Route lightweight tasks to standard efficient model
            }

            console.log(`🤖 Chief Orchestrator: Spouštím krok ${step.step} s agentem [${agent.name}] (Model: ${stepModel})`);

            if (onStepProgress) {
                onStepProgress({
                    status: "running_step",
                    step: step.step,
                    agentName: agent.name,
                    agentEmoji: agent.emoji,
                    instruction: step.instruction,
                    message: `Spouštím krok ${step.step}: ${agent.name} (${agent.role})`
                });
            }

            // --- SANDBOX: Kontrola oprávnění ---
            let ragContext = "";
            let highConfidence = [];
            // #7: retrieval povol i agentovi BEZ přístupu ke spisům, pokud má vlastní
            // znalostní bázi (_kb_<id>). applyAgentScope u spisAccess:'none' nastaví
            // clientAccess:false → čte JEN svou KB, ne klientské spisy.
            const canRetrieve = (agent.permissions && agent.permissions.read_files) || !!agent.knowledgeScope;
            if (canRetrieve) {
                try {
                    // Agent má právo číst klientské spisy -> dotážeme sémantické vyhledávání
                    // Best-effort kontext pro agenta — lexikální fallback zapnut,
                    // ať RAG precedenty fungují i při vypnutém modelu (degradovaně).
                    // B1: přidej znalostní bázi agenta + judikaturní politiku k základním
                    // ragFilters (obor/spisy). Když selže, degraduj na holé ragFilters.
                    let stepFilters = ragFilters;
                    try {
                        const scoped = applyAgentScope(ragFilters, agent, {});
                        if (scoped) stepFilters = scoped;
                    } catch (scopeErr) {
                        console.warn(`⚠️ Sandbox: applyAgentScope selhal pro ${agent.name}:`, scopeErr.message);
                    }
                    const matches = await searchSimilar(step.instruction, 2, stepFilters, { lexicalFallback: true });
                    highConfidence = matches.filter(m => m.score >= RAG_MIN_SCORE);
                    if (highConfidence.length > 0) {
                        ragContext = highConfidence
                            .map(m => `[Precedent ze spisu: ${m.fileName}]:\n${m.text}`)
                            .join('\n\n');
                        console.log(`🔒 Sandbox: Agentovi [${agent.name}] byl povolen přístup k RAG precedensům.`);
                    }
                } catch (ragErr) {
                    console.warn(`⚠️ Sandbox RAG selhal pro ${agent.name}:`, ragErr.message);
                }
            } else {
                console.log(`🔒 Sandbox: Agent [${agent.name}] nemá oprávnění ke čtení klientských spisů.`);
            }

            let registryContext = "";
            if (agent.permissions && agent.permissions.query_registries) {
                // Agent má právo lustrovat registry -> pokusíme se detekovat IČO v instrukci
                const icoMatch = step.instruction.match(/\b\d{8}\b/);
                if (icoMatch) {
                    try {
                        const ico = icoMatch[0];
                        console.log(`🔒 Sandbox: Detekováno IČO ${ico}. Spouštím automatickou lustraci pro agenta [${agent.name}]`);
                        const regData = await checkSubject(ico);
                        registryContext = `Aktuální ověřená data z registru ARES/ISIR pro IČO ${ico}:\n` +
                                          `- Název: ${regData.name}\n` +
                                          `- Sídlo: ${regData.seat}\n` +
                                          `- V insolvenci: ${regData.inInsolvency ? "ANO" : "NE"}\n` +
                                          `- Insolvenční spis: ${regData.insolvencyCase || "Není"}\n`;
                    } catch (regErr) {
                        console.warn(`⚠️ Sandbox Registries: Automatická lustrace selhala:`, regErr.message);
                    }
                }
            }

            // --- Spuštění lokálního modelu pro krok ---
            const strictMode = ragFilters && (ragFilters.strict === true || ragFilters.strict === 'true');
            let strictInstruction = "";
            if (strictMode) {
                strictInstruction = "\n⚠️ ARCHITEKTURA PROTI HALUCINACÍM (STRICT RAG):\n" +
                    "Jsi v režimu přísné shody s dokumentací. Odpovídej výhradně na základě poskytnutého schváleného kontextu ze spisů.\n" +
                    "Pokud kontext neobsahuje odpověď na položenou otázku nebo zadání, nesmíš použít své obecné znalosti ani si nic domýšlet. " +
                    "V takovém případě musí tvůj výstup začínat přesnou větou: 'Nedostatek podkladů ze spisů pro bezpečné vypracování.' a stručně uvést, co chybí.\n";
            }

            const systemContent = `${agent.systemPrompt}\n\n` +
                strictInstruction +
                `Pracuješ v hierarchickém swarmu pod dozorem Chief Orchestrátora. Tvůj úkol je: ${step.instruction}\n` +
                (ragContext ? `\nSchválený bezpečný kontext ze spisů:\n${ragContext}\n` : "") +
                (registryContext ? `\nČerstvá data z registru:\n${registryContext}\n` : "");

            const messages = [
                { role: 'system', content: systemContent }
            ];

            if (accumulatedContext) {
                messages.push({
                    role: 'system',
                    content: `Dosavadní výsledky z předchozích kroků swarmu:\n${accumulatedContext}`
                });
            }

            messages.push({ role: 'user', content: step.instruction });

            const stepStartTime = Date.now();
            try {
                const response = await ollama.chat({
                    model: stepModel,
                    messages: messages,
                    options: { temperature: agentTemperature(agent, 0.2) }
                });

                const stepResult = response.message.content;
                const durationMs = Date.now() - stepStartTime;
                accumulatedContext += `\n--- Výstup z kroku ${step.step} (${agent.name}): ---\n${stepResult}\n`;

                const greenMetrics = calculateInferenceMetrics(durationMs);
                db.insert('green_logs', {
                    agentId: agent.id,
                    model: stepModel,
                    timestamp: new Date().toISOString(),
                    ...greenMetrics
                });

                // GDPR: v auditním logu (transparency_logs) ukládáme ANONYMIZOVANOU verzi
                // system promptu — RAG text z klientských spisů se nesmí do logu dostat s PII.
                // Model výše dostal plný kontext (kvalita); do trvalého logu jde očištěná verze.
                const systemContentForLog = anonymizeText(systemContent);
                const systemPromptHash = crypto.createHash('sha256').update(systemContentForLog).digest('hex');
                const stepRagSources = highConfidence.map(m => ({
                    fileName: m.fileName,
                    score: m.score,
                    textHash: crypto.createHash('sha256').update(m.text).digest('hex').substring(0, 8)
                }));

                const transparencyRecord = db.insert('transparency_logs', {
                    agentId: agent.id,
                    agentName: agent.name,
                    model: stepModel,
                    prompt: step.instruction,
                    systemPrompt: systemContentForLog,
                    systemPromptHash: systemPromptHash,
                    ragSources: stepRagSources,
                    timestamp: new Date().toISOString(),
                    humanApproved: false,
                    greenMetrics: {
                        energyWh: greenMetrics.energyWh,
                        co2Grams: greenMetrics.co2Grams
                    }
                });

                stepsLog.push({
                    step: step.step,
                    agentId: step.agentId,
                    agentName: agent.name,
                    agentEmoji: agent.emoji,
                    instruction: step.instruction,
                    output: stepResult,
                    transparencyId: transparencyRecord.id,
                    metrics: greenMetrics
                });

            } catch (chatErr) {
                console.error(`❌ Swarm: Krok ${step.step} selhal při volání modelu:`, chatErr.message);
                accumulatedContext += `\n--- Krok ${step.step} (${agent.name}) selhal s chybou: ${chatErr.message} ---\n`;
            }
        }

        // --- KROK 2.5: Kritika → revize (bounded, 1 průchod; #3) ---------------------
        // Dřív se výstupy jen zřetězily; Kontrolorovy připomínky se nikam nezapracovaly.
        // Teď: má-li plán koncept od Spisovatele, Kontrolor ho oponuje a Spisovatel
        // vytvoří JEDNU revizi. Revidovaný text jde do syntézy. Best-effort + přepínatelné.
        let revisionInfo = null;
        try {
            revisionInfo = await this._reviewReviseLoop({ agents, stepsLog, onStepProgress });
            if (revisionInfo && revisionInfo.revisedText) {
                accumulatedContext += `\n--- Revidovaný koncept (Spisovatel po oponentuře Kontrolora): ---\n${revisionInfo.revisedText}\n`;
            }
        } catch (revErr) {
            console.warn('⚠️ Kritika→revize selhala (nekritické):', revErr.message);
        }

        // --- KROK 3: Syntéza (Synthesis) ---
        if (onStepProgress) {
            onStepProgress({ status: "synthesizing", message: "Provádím finální syntézu a kompletaci výsledků swarmu..." });
        }
        console.log("🧩 Chief Orchestrator: Provádím závěrečnou syntézu...");

        const strictMode = ragFilters && (ragFilters.strict === true || ragFilters.strict === 'true');
        let synthesisSystem = "Jsi Chief Orchestrator lokálního právního AI swarmu Lexis.\n" +
            "Tvým úkolem je vzít dosavadní dílčí výstupy a analýzy od specializovaných agentů swarmu a sestavit z nich pro advokáta jednu finální, perfektně strukturovanou, ucelenou a vysoce profesionální odpověď v češtině.\n" +
            "Zajisti, aby text neměl zbytečné duplicity, logicky navazoval a byl připraven k přímému použití v praxi. Pokud některý krok selhal, stručně na to upozorni.";

        if (strictMode) {
            synthesisSystem += "\n\n⚠️ ARCHITEKTURA PROTI HALUCINACÍM (STRICT RAG):\n" +
                "Pokud v dílčích výstupech od agentů chybí informace k vypracování nebo pokud agenti nahlásili nedostatek podkladů, nesmíš si nic domýšlet ani doplňovat informace z vlastní hlavy. " +
                "V takovém případě musí finální výstup jasně a uctivě konstatovat, že chybí podklady k bezpečnému vypracování, a uvést, co konkrétně chybí.";
        }

        const synthesisMessages = [
            { role: 'system', content: synthesisSystem },
            { role: 'user', content: `Komplexní zadání advokáta: ${prompt}\n\nZpracované dílčí výstupy od agentů swarmu:\n${accumulatedContext}` }
        ];

        let finalResponse = "";
        const synthesisStartTime = Date.now();
        try {
            const response = await ollama.chat({
                model: globalModel,
                messages: synthesisMessages,
                options: { temperature: 0.1 }
            });
            finalResponse = response.message.content;

            const durationMs = Date.now() - synthesisStartTime;
            const greenMetrics = calculateInferenceMetrics(durationMs);
            db.insert('green_logs', {
                agentId: 'chief_orchestrator',
                model: globalModel,
                timestamp: new Date().toISOString(),
                ...greenMetrics
            });

            const synthesisSystemHash = crypto.createHash('sha256').update(synthesisSystem).digest('hex');
            db.insert('transparency_logs', {
                agentId: 'chief_orchestrator',
                agentName: 'Chief Orchestrator',
                model: globalModel,
                prompt: prompt,
                systemPrompt: synthesisSystem,
                systemPromptHash: synthesisSystemHash,
                ragSources: [],
                timestamp: new Date().toISOString(),
                humanApproved: false,
                greenMetrics: {
                    energyWh: greenMetrics.energyWh,
                    co2Grams: greenMetrics.co2Grams
                }
            });
        } catch (synErr) {
            console.error("❌ Chief Orchestrator: Selhala finální syntéza:", synErr.message);
            finalResponse = `Omlouvám se, nepodařilo se provést finální syntézu. Zde jsou alespoň dílčí nasbírané výstupy:\n\n${accumulatedContext}`;
        }

        const durationMs = Date.now() - startTime;
        console.log(`🏁 Chief Orchestrator: Kompletní orchestrace úspěšně dokončena za ${durationMs}ms.`);

        // Anti-halucinační kontrola citací nad finálním výstupem (deterministicky +
        // proti externím zdrojům). Neověřené §/značky se označí, ať je advokát vidí.
        let citationCheck = null;
        try {
            const { verifyCitationsWithSources } = require('./citation_verifier');
            citationCheck = await verifyCitationsWithSources(finalResponse, {});
        } catch (e) { citationCheck = null; }

        return {
            success: true,
            prompt,
            steps: stepsLog,
            finalOutput: finalResponse,
            revision: revisionInfo,
            citationCheck: citationCheck ? {
                total: citationCheck.total,
                unverifiedCount: citationCheck.unverifiedCount,
                citations: citationCheck.citations,
                annotatedText: citationCheck.annotatedText,
                sourcesConsulted: citationCheck.sourcesConsulted
            } : null,
            durationMs,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * #3: jedno volání agenta nad hotovým textem (kritika/revize) + zápis do
     * green/transparency logu (AI Act). RAG se zde nezapojuje — pracuje se s
     * poskytnutým konceptem. Teplota dle agenta.
     */
    async _callAgent(agent, model, messages, logLabel) {
        const usedModel = model || this.defaultModel;
        const t0 = Date.now();
        const response = await ollama.chat({
            model: usedModel,
            messages: messages,
            options: { temperature: agentTemperature(agent, 0.2) }
        });
        const content = (response && response.message && response.message.content) || '';
        const durationMs = Date.now() - t0;
        try {
            const greenMetrics = calculateInferenceMetrics(durationMs);
            db.insert('green_logs', { agentId: agent.id, model: usedModel, timestamp: new Date().toISOString(), ...greenMetrics });
            const forLog = anonymizeText(messages.map(m => m.content).join('\n'));
            db.insert('transparency_logs', {
                agentId: agent.id, agentName: agent.name, model: usedModel,
                prompt: logLabel, systemPrompt: forLog,
                systemPromptHash: crypto.createHash('sha256').update(forLog).digest('hex'),
                ragSources: [], timestamp: new Date().toISOString(), humanApproved: false,
                greenMetrics: { energyWh: greenMetrics.energyWh, co2Grams: greenMetrics.co2Grams }
            });
        } catch (e) { /* logování je best-effort */ }
        return content;
    }

    /**
     * #3: smyčka kritika→revize. Kontrolor oponuje poslední koncept Spisovatele;
     * pokud najde vady, Spisovatel vytvoří JEDNU revidovanou verzi. Bounded (1×),
     * best-effort, přepínatelné (AGENT_REVISE_LOOP=0). Vrací
     * { critiqued, revised, issues, revisedText } nebo null (smyčka se nespustila).
     */
    async _reviewReviseLoop({ agents, stepsLog, onStepProgress }) {
        if (!_reviseEnabled()) return null;
        const kontrolor = agents && agents.kontrolor;
        const spisovatel = agents && agents.spisovatel;
        if (!kontrolor || !spisovatel) return null;

        const draftEntry = [...stepsLog].reverse().find(s => s.agentId === 'spisovatel' && s.output && String(s.output).trim());
        if (!draftEntry) return null;
        const draft = String(draftEntry.output);

        if (onStepProgress) onStepProgress({ status: 'reviewing', agentName: kontrolor.name, agentEmoji: kontrolor.emoji, message: 'Kontrolor oponuje koncept…' });

        const critiqueInstruction = 'Vypiš KONKRÉTNÍ, číslované právní i formální vady níže uvedeného KONCEPTU ' +
            '(chybějící náležitosti, vymyšlené/nepřesné §, rozpory, slabá místa). Pokud koncept nemá vady, ' +
            "napiš přesně 'BEZ VÝHRAD'. Nepřepisuj celý dokument, jen seznam připomínek.";
        const critique = await this._callAgent(kontrolor, kontrolor.preferredModel,
            [{ role: 'system', content: kontrolor.systemPrompt },
             { role: 'user', content: critiqueInstruction + '\n\nKONCEPT:\n' + draft }],
            'Kritika konceptu (Kontrolor)');
        stepsLog.push({ step: 'revize-kritika', agentId: 'kontrolor', agentName: kontrolor.name, agentEmoji: kontrolor.emoji, instruction: 'Oponentura konceptu', output: critique });

        if (/BEZ\s+VÝHRAD/i.test(critique)) {
            return { critiqued: true, revised: false, issues: critique, revisedText: null };
        }

        if (onStepProgress) onStepProgress({ status: 'revising', agentName: spisovatel.name, agentEmoji: spisovatel.emoji, message: 'Spisovatel zapracovává připomínky…' });

        const reviseInstruction = 'Zapracuj do KONCEPTU níže uvedené PŘIPOMÍNKY a vrať CELÝ opravený text ' +
            'dokumentu — bez komentářů, bez uvození, bez seznamu změn. Chybějící konkrétní údaje nevymýšlej, ' +
            'ponech [Doplnit...].';
        const revisedText = await this._callAgent(spisovatel, spisovatel.preferredModel,
            [{ role: 'system', content: spisovatel.systemPrompt },
             { role: 'user', content: reviseInstruction + '\n\nPŘIPOMÍNKY:\n' + critique + '\n\nKONCEPT:\n' + draft }],
            'Revize konceptu dle připomínek (Spisovatel)');
        stepsLog.push({ step: 'revize-oprava', agentId: 'spisovatel', agentName: spisovatel.name, agentEmoji: spisovatel.emoji, instruction: 'Revize dle připomínek Kontrolora', output: revisedText });

        return { critiqued: true, revised: true, issues: critique, revisedText: revisedText };
    }

    /**
     * Parses complex user prompt into distinct steps via fast local LLM routing
     */
    async decomposeQuery(prompt, model) {
        const systemPrompt = `Jsi Chief Orchestrator lokálního právního AI swarmu Lexis.
Tvým úkolem je analyzovat komplexní právní pokyn od advokáta a rozložit jej na sled jednotlivých dílčích kroků (sub-tasks).
Musíš vrátit VÝHRADNĚ platné JSON pole objektů bez jakéhokoliv dalšího okecávání, uvození, vysvětlování či markdown značek (neodpovídej v \`\`\`json kódovém bloku).
Každý objekt v poli must mít tuto přesnou strukturu:
{
  "step": 1,
  "agentId": "resersnik" | "stylista" | "kontrolor" | "sekretarka" | "spisovatel",
  "instruction": "přesná, stručná instrukce pro tohoto dílčího agenta v češtině",
  "tier": "light" | "advanced"
}

Urči "tier" (úroveň složitosti):
- "light": Pro rutinní, jednoduché úkoly (formátování, organizace, e-maily, jednoduché shrnutí, sekretářské práce).
- "advanced": Pro analyticky náročné úkoly (rešerše zákonů/judikátů, psaní složitých smluv, oponentura, detekce právních rizik).

Dostupní agenti swarmu:
1. "resersnik" (vyhledávání, analýza zákonů, judikátů, hledání právních opor)
2. "stylista" (úprava stylu, klonování stylu, tón, elegantní advokátní čeština)
3. "kontrolor" (revize rizik, hledání logických chyb, oponentura, slabá místa)
4. "sekretarka" (úprava schůzek, shrnutí úkolů, e-maily, organizace, lustrace IČO)
5. "spisovatel" (psaní smluv, žalob, podání, zapracování změn a odstavců)

Vytvoř maximálně 2 až 4 logické a vysoce efektivní kroky tak, aby na sebe logicky navazovaly.`;

        try {
            const response = await ollama.chat({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
                options: { temperature: 0.1 }
            });

            const contentText = response.message.content.trim();
            // Robustně odstraníme markdown fence — ať už ```json, prostý ``` nebo
            // fence uprostřed textu (dřív se řešil jen prefix ```json).
            let jsonText = contentText;
            const fenceMatch = contentText.match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (fenceMatch) {
                jsonText = fenceMatch[1];
            }
            jsonText = jsonText.trim();
            
            const parsed = JSON.parse(jsonText);
            // #1: očisti a zvaliduj kroky (zahoď neznámé agenty, ořízni na 1..4).
            const clean = sanitizeSteps(parsed);
            if (clean.length > 0) {
                return clean;
            }
            console.warn("⚠️ Dekompozice: LLM vrátil neplatné/prázdné kroky → deterministický router.");
        } catch (e) {
            console.warn("⚠️ Selhala inteligentní dekompozice → deterministický router:", e.message);
        }

        // #1: deterministický router z klíčových slov (respektuje záměr, offline).
        const routed = routeByIntent(prompt);
        if (routed && routed.length > 0) {
            console.log(`🧭 Router: deterministický plán (${routed.map(s => s.agentId).join(' → ')}).`);
            return routed;
        }

        // Poslední pojistka: obecný lineární plán, když nelze určit záměr.
        return [
            {
                step: 1,
                agentId: "resersnik",
                instruction: `Proveď úvodní analýzu a vyhledej právní oporu pro: ${prompt}`,
                tier: "advanced"
            },
            {
                step: 2,
                agentId: "spisovatel",
                instruction: `Sestav text dokumentu či výstupu na základě úvodní analýzy.`,
                tier: "advanced"
            },
            {
                step: 3,
                agentId: "kontrolor",
                instruction: `Zkontroluj vygenerovaný dokument na právní a věcná rizika a navrhni úpravy.`,
                tier: "advanced"
            }
        ];
    }
}

module.exports = new ChiefOrchestrator();
