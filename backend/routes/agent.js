/**
 * routes/agent.js — volání jednoho AI agenta (RAG-obohacený prompt, anti-halucinační
 * strict režim, Green AI + transparency ledger, offline fallback).
 * Montuje se v server.js na /api/agent.
 */
'use strict';

const express = require('express');
const { CHAT_MODEL, RAG_MIN_SCORE } = require('../lib/model_config');
const router = express.Router();
const crypto = require('crypto');
const { loadAgents, agentTemperature } = require('../lib/agents');
const { searchSimilar, agentRagK } = require('../lib/rag');
const { anonymizeText, pseudonymizeText, restorePseudonyms } = require('../lib/anonymizer');
const injectionGuard = require('../lib/injection_guard');
const { logEvent } = require('../lib/audit');
const { calculateInferenceMetrics } = require('../lib/green_monitor');
const db = require('../lib/database');
const ollama = require('../lib/ai_provider'); // Ollama | OpenAI | Anthropic (stejné rozhraní)
const { generateAgentFallback } = require('../lib/agent_fallback');
const { buildRagScope } = require('../lib/rag_request');
const agentTools = require('../lib/agent_tools'); // interní tool-registry (Fáze 1, za AGENT_TOOLS=1)
const { buildDateFacts, dateFactsAppendix } = require('../lib/date_facts');
const clauseScan = require('../lib/clause_scan');
const { guardInventedIdentifiers, fixLawNames, buildWarnings } = require('../lib/output_guard');
const { agentNumCtx, isEmbeddingModel, isModelMissingError } = require('../lib/agent_options');

// POST /api/agent/:agentId - Volání agenta s modelem dle výběru
router.post('/:agentId', async (req, res) => {
    const { agentId } = req.params;
    const { prompt, model } = req.body;
    let { context } = req.body;
    const startTime = Date.now();

    const agents = loadAgents();
    const agent = agents[agentId];
    if (!agent) {
        return res.status(404).json({ error: "Agent nebyl nalezen." });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: 'Zadání (prompt) je povinné.' });
    }

    // Koncepty (webový LexisEditor Lite): draftId = agent reviduje existující koncept
    // (dostane jeho znění + otevřené připomínky); saveDraft true/'auto' = výstup se uloží
    // jako koncept „ke kontrole“. Bez těchto polí (např. volání z LexisEditoru) beze změny.
    const Drafts = require('../lib/drafts');
    const callerPrincipal = req.principal || { userId: 'local', kind: 'implicit', scopes: ['read', 'write', 'admin'] };
    let draftTarget = null;
    if (req.body.draftId) {
        const dd = Drafts.getDraft(String(req.body.draftId));
        if (!dd) return res.status(404).json({ error: 'Koncept nenalezen.' });
        const denied = Drafts.checkAccess(callerPrincipal, dd.spisId, 'write');
        if (denied) return res.status(denied.status).json({ error: denied.error });
        if (dd.status === 'schvaleno') return res.status(409).json({ error: 'Koncept je schválený — agent ho nemůže revidovat.' });
        if (dd.lock && Date.parse(dd.lock.until) > Date.now()) return res.status(423).json({ error: `Koncept právě upravuje ${dd.lock.name} — revizi AI spusťte po uložení.`, code: 'locked' });
        draftTarget = { id: dd.id, baseVersion: dd.version, text: Drafts.specToText(dd.versions[dd.versions.length - 1].spec) };
        context = [context, Drafts.revisionContext(dd)].filter(Boolean).join('\n\n');
    }
    const draftSpisId = req.body.spisId ? String(req.body.spisId) : null;
    const wantDraft = !!draftTarget || req.body.saveDraft === true || (req.body.saveDraft === 'auto' && Drafts.autoDraftFor(agentId, agent));
    if (wantDraft && !draftTarget) {
        const denied = Drafts.checkAccess(callerPrincipal, draftSpisId, 'write');
        if (denied) return res.status(denied.status).json({ error: denied.error });
    }

    // Choose model (default to llama3 if not specified)
    const selectedModel = model || CHAT_MODEL;
    // Embedding model (bge-m3 apod.) neumí chat — dřív to skončilo „simulovaným fallbackem“
    // s HTTP 200 a hláškou, že neběží Ollama. Teď jasná chyba 400.
    if (isEmbeddingModel(selectedModel)) {
        return res.status(400).json({ error: `Model „${selectedModel}“ je vyhledávací (embedding) model a neumí odpovídat. Zvolte chatovací model.` });
    }
    console.log(`🤖 Volám agenta [${agent.name}] s modelem [${selectedModel}]`);

    // systemPromptText musí být viditelný i ve větvi catch (fallback loguje jeho hash).
    let systemPromptText = agent.systemPrompt;
    // Detekce oboru (pro UI „detekován obor…") — viditelná i ve fallbacku.
    let oborDetection = null;

    try {
        let resolvedFilters = null;
        try {
            // Per-agent RAG (vlastní báze + úroveň přístupu ke spisům) + judikaturní
            // politika VČETNĚ auto-detekce oboru z promptu (viz lib/rag_request.buildRagScope).
            const built = await buildRagScope(req.body, agent, prompt);
            resolvedFilters = built.filters;
            oborDetection = built.detection;
            if (oborDetection) {
                console.log(`🧭 RAG obor: ${oborDetection.label} (${oborDetection.source}${oborDetection.confident ? '' : ', nejistě → celoplošně'})`);
            }
        } catch (fErr) {
            console.warn("⚠️ RAG: Selhalo rozlišení filtrů:", fErr.message);
        }

        const strictMode = resolvedFilters && (resolvedFilters.strict === true || resolvedFilters.strict === 'true');
        if (strictMode) {
            systemPromptText += "\n\n⚠️ ARCHITEKTURA PROTI HALUCINACÍM (STRICT RAG):\n" +
                "Jsi v režimu přísné shody s dokumentací. Odpovídej výhradně na základě poskytnutého schváleného kontextu ze spisů a kontextu dokumentu.\n" +
                "Pokud dodaný kontext neobsahuje odpověď na položenou otázku nebo zadání, nesmíš použít své obecné znalosti ani si nic domýšlet. " +
                "V takovém případě musí tvůj výstup začínat přesnou větou: 'Nedostatek podkladů ze spisů pro bezpečné vypracování.' a stručně uvést, co chybí.\n";
        }

        const messages = [
            { role: 'system', content: systemPromptText }
        ];

        // Retrieve relevant historical context from RAG memory
        let ragSources = [];
        // Pasáže, které model skutečně dostal — kontrola citací je musí znát, jinak
        // označí za neověřené i § doslovně citované z báze zákonů.
        let ragContextChunks = [];
        try {
            if (resolvedFilters) {
                console.log(`🧠 RAG: Aktivní filtry pro vyhledávání: ${JSON.stringify(resolvedFilters)}`);
            }
            const matches = await searchSimilar(prompt, agentRagK(), resolvedFilters, { dedupeKb: true });
            const highConfidenceMatches = matches.filter(m => m.score >= RAG_MIN_SCORE);
            ragSources = highConfidenceMatches.map(m => ({
                fileName: m.fileName,
                score: m.score,
                textHash: crypto.createHash('sha256').update(m.text).digest('hex').substring(0, 8)
            }));

            if (highConfidenceMatches.length > 0) {
                // Úroveň přístupu 'redacted': klientské pasáže (scope=null) předáme
                // ANONYMIZOVANĚ; vlastní znalostní báze agenta (scope=_kb_*) zůstává beze změny.
                const redact = !!(resolvedFilters && resolvedFilters.redactClient);
                const isKb = m => typeof m.scope === 'string' && m.scope.startsWith('_kb_');
                const fmt = m => {
                    const passage = (redact && !m.scope) ? anonymizeText(m.text) : m.text;
                    ragContextChunks.push({ text: passage, fileName: m.fileName });
                    return `[Zdroj: ${m.fileName}, Shoda: ${Math.round(m.score * 100)}%]:\n${passage}`;
                };
                const kbMatches = highConfidenceMatches.filter(isKb);
                const clientMatches = highConfidenceMatches.filter(m => !isKb(m));
                // Zákony/judikatura z báze NESMÍ být podané jako „klientské spisy“ — model
                // pak píše „podle zadaných spisů“ a s ustanoveními zachází volně (změřeno
                // 1. 10. 2026: odvolání „do dvou měsíců“ místo 15 dnů). Rámec jako v model_bench.
                if (kbMatches.length > 0) {
                    messages.push({
                        role: 'system',
                        content: `Podklady ze znalostní báze (zákony, judikatura):\n${kbMatches.map(fmt).join('\n\n---\n\n')}\n\n` +
                            'Při odpovědi vycházej z těchto podkladů a cituj jen ustanovení, která v nich jsou. Lhůty a čísla přebírej doslovně. Pokud podklady na otázku nestačí, řekni to.'
                    });
                }
                if (clientMatches.length > 0) {
                    messages.push({
                        role: 'system',
                        content: `Historický kontext a zjištěné precedenty z klientských spisů v archivu:\n${clientMatches.map(fmt).join('\n\n---\n\n')}\n\nVýše uvedené historické pasáže a informace využij k přesnější argumentaci a přizpůsobení stylu, pokud je to vhodné.`
                    });
                }
                console.log(`🧠 RAG: Obohatil jsem systémovou zprávu agenta [${agent.name}] o ${highConfidenceMatches.length} sémantických pasáží.`);
            }
        } catch (ragErr) {
            console.warn("⚠️ RAG: Selhalo automatické sémantické vyhledávání pro agenta:", ragErr.message);
        }

        // Kontext se před modelem PSEUDONYMIZUJE vratně: model vidí [OSOBA_1], [ADRESA_1]…
        // a po odpovědi se doplní skutečné údaje (dřív nevratná anonymizace → Spisovatel
        // nemohl v plné moci uvést jméno klienta). AGENT_CONTEXT_REDACTION=irreversible
        // vrací staré chování (např. pro vzdálený/cloudový model).
        let pseudoMap = null;
        if (context) {
            let ctxForModel;
            if (process.env.AGENT_CONTEXT_REDACTION === 'irreversible') {
                ctxForModel = anonymizeText(context);
            } else {
                const ps = pseudonymizeText(context);
                ctxForModel = ps.text; pseudoMap = ps.map;
            }
            const note = pseudoMap && Object.keys(pseudoMap).length
                ? '\n\n(Osobní údaje jsou nahrazeny symboly jako [OSOBA_1], [ADRESA_1]. Pokud je v odpovědi potřebuješ, napiš symbol PŘESNĚ v tomto tvaru — systém za něj doplní skutečný údaj. Nevymýšlej jména ani adresy.)'
                : '';
            messages.push({ role: 'system', content: `Kontext dokumentu / spisové podklady:\n${ctxForModel}${note}` });
        }
        // Text v podkladech, který se vydává za pokyn pro AI (prompt injection).
        const injectionHits = injectionGuard.detectInjection([prompt, context, ...ragContextChunks.map(c => c.text)].filter(Boolean).join('\n'));
        if (injectionHits.length) {
            messages.push({ role: 'system', content: injectionGuard.MODEL_NOTE });
            console.warn(`⚠️ Agent: podklady obsahují možný pokyn pro AI (${injectionHits.length}×).`);
        }

        // Datumovou aritmetiku dělá program, ne model (viz lib/date_facts.js).
        const dateFacts = buildDateFacts(`${prompt || ''}\n${context || ''}`, { question: prompt });
        if (dateFacts) messages.push({ role: 'system', content: dateFacts.text });

        // Rizikové doložky ve smlouvě najde program (lib/clause_scan.js) — model je jen vysvětlí.
        // Poznámka pro model nese jen článek, typ a § (žádné osobní údaje z textu).
        let clauseFindings = [];
        try {
            const reviewAsked = agentId === 'kontrolor' || /smlouv|ustanoven|rizik|dolo[žz]k|nevyv[aá][žz]/i.test(String(prompt || ''));
            if (reviewAsked) clauseFindings = clauseScan.scanContract(context || prompt);
            if (clauseFindings.length) messages.push({ role: 'system', content: clauseScan.modelNote(clauseFindings) });
        } catch (csErr) { console.warn('⚠️ Agent: kontrola doložek selhala (nekritické):', csErr.message); }

        messages.push({ role: 'user', content: prompt });

        // Okno kontextu: bez num_ctx Ollama použije výchozí malé okno (2–4k tokenů) a dlouhý
        // spis TIŠE ořízne zepředu — změřeno 1. 10. 2026: u 40článkové smlouvy model viděl
        // jen konec a riziko v čl. 31 nenašel. AGENT_NUM_CTX (výchozí 8192).
        const numCtx = agentNumCtx();
        const chatOptions = { temperature: agentTemperature(agent, 0.3), num_ctx: numCtx };
        // Hrubý odhad tokenů (čeština ~3 znaky/token); při přetečení to advokátovi řekneme.
        const approxTokens = Math.round(messages.reduce((n, m) => n + String(m.content || '').length, 0) / 3);
        const contextOverflow = approxTokens > numCtx * 0.85;
        if (contextOverflow) console.warn(`⚠️ Vstup agenta ~${approxTokens} tokenů > okno ${numCtx} — část textu model neuvidí.`);
        // Tool-calling (Fáze 1, read-only): agent si smí sám došáhnout pro fakta (search_rag,
        // get_document, check_registry) v mezích svých oprávnění. Za AGENT_TOOLS=1; jinak
        // beze změny. RAG kontext je už předvyplněný výše — tooly slouží ke zpřesnění.
        let response, toolsUsed = [];
        // Jeden opakovaný pokus při přechodné chybě spojení s Ollamou (souběh, reset).
        const llm = require('../lib/ollama_retry').retryingProvider(ollama, {
            onRetry: (e) => console.warn(`🔁 Ollama: přechodná chyba (${e.message}) — opakuji dotaz agenta ${agent.name}.`)
        });
        if (agentTools.enabled() && agentTools.toolsForAgent(agent).length > 0) {
            const ctx = {
                ragFilters: resolvedFilters, // search_rag respektuje scope/přístup agenta
                principal: callerPrincipal, // koncepty: ACL spisu podle volajícího
                audit: (ev) => {
                    try {
                        logEvent('LexisEditor', `AI Agent nástroj (${agent.name})`, 'Volání nástroje', {
                            tool: ev.tool, ok: ev.ok, args: ev.args
                        });
                    } catch (e) { /* audit nesmí shodit odpověď */ }
                }
            };
            const loop = await agentTools.runToolLoop({
                provider: llm, model: selectedModel, messages, options: chatOptions, agent, ctx
            });
            toolsUsed = loop.toolCalls.map(c => c.name);
            if (toolsUsed.length) console.log(`🔧 Agent [${agent.name}] použil nástroje: ${toolsUsed.join(', ')} (${loop.iters} it.)`);
            response = { message: { content: loop.content } };
        } else {
            response = await llm.chat({ model: selectedModel, messages: messages, options: chatOptions });
        }

        if (pseudoMap && response && response.message) {
            // Při revizi konceptu se vrací i údaje, které v konceptu už stály (např. RČ v plné moci).
            response.message.content = restorePseudonyms(response.message.content, pseudoMap,
                draftTarget ? { alwaysRestore: (v) => !!v && draftTarget.text.includes(v) } : {});
        }

        // #2: Antihalucinační kontrola citací i v single-agent routě (dřív jen v
        // orchestrátoru). Neověřené §/sp. zn. se advokátovi označí. Best-effort —
        // chyba ověření nesmí shodit odpověď agenta.
        let citationCheck = null;
        try {
            const { verifyCitationsWithSources } = require('../lib/citation_verifier');
            // Podklady = RAG pasáže + zadání + kontext ze spisu (citace převzaté z dokumentu
            // klienta nejsou halucinace) + index § z celé báze zákonů (ne jen top-k pasáží).
            const { getKbLawIndex } = require('../lib/kb_law_index');
            const verifyChunks = ragContextChunks.concat(
                [prompt, context].filter(Boolean).map(t => ({ text: String(t), fileName: 'zadání' })));
            const cc = await verifyCitationsWithSources(response.message.content, { contextChunks: verifyChunks, kbIndex: getKbLawIndex() });
            citationCheck = cc ? {
                total: cc.total,
                unverifiedCount: cc.unverifiedCount,
                citations: cc.citations,
                annotatedText: cc.annotatedText,
                sourcesConsulted: cc.sourcesConsulted
            } : null;
        } catch (ccErr) {
            console.warn('⚠️ Agent: ověření citací selhalo (nekritické):', ccErr.message);
        }

        // Deterministická kontrola výstupu: vymyšlené identifikátory → pole k doplnění,
        // nesoulad čísla a názvu předpisu, neověřené citace → upozornění pod odpovědí.
        let outputGuard = null;
        let draftBody = null, draftWarn = '';
        try {
            const sourceText = [prompt, context, ...ragContextChunks.map(c => c.text)].filter(Boolean).join('\n');
            const g = guardInventedIdentifiers(response.message.content, sourceText);
            // Chybný název u správného čísla zákona (§ v bázi existuje) → opravit v textu.
            let kbIdx = null;
            try { kbIdx = require('../lib/kb_law_index').getKbLawIndex(); } catch (e) { kbIdx = null; }
            const lf = fixLawNames(g.text, kbIdx);
            const lawIssues = lf.issues;
            // Co model z kontrolního seznamu doložek / výpočtů lhůt vynechal, doplní program.
            const clauseApx = clauseFindings.length ? clauseScan.missingAppendix(lf.text, clauseFindings) : { text: '', missing: [] };
            const dateApx = dateFactsAppendix(lf.text, dateFacts);
            const body = lf.text + clauseApx.text + dateApx;
            const warn = buildWarnings({ replaced: g.replaced, lawIssues, lawFixed: lf.fixed, unverifiedCount: citationCheck ? citationCheck.unverifiedCount : 0, extra: [injectionGuard.warningLine(injectionHits)] });
            response.message.content = body + warn;
            draftBody = body; draftWarn = warn;
            outputGuard = { replaced: g.replaced, lawIssues, lawFixed: lf.fixed, injection: injectionHits,
                clauses: clauseFindings.map(f => ({ id: f.id, article: f.article })), clausesAppended: clauseApx.missing, dateAppended: !!dateApx };
        } catch (gErr) {
            console.warn('⚠️ Agent: kontrola výstupu selhala (nekritické):', gErr.message);
        }

        const durationMs = Date.now() - startTime;
        logEvent('LexisEditor', `AI Agent (${agent.name})`, 'Generování textu', {
            model: selectedModel,
            promptLength: prompt.length,
            contextLength: context ? context.length : 0,
            responseLength: response.message.content.length,
            durationMs: durationMs
        });

        // 🌿 Green AI and 🔍 AI Act Transparency logs
        const greenMetrics = calculateInferenceMetrics(durationMs);
        db.insert('green_logs', {
            agentId,
            model: selectedModel,
            timestamp: new Date().toISOString(),
            ...greenMetrics
        });

        const systemPromptHash = crypto.createHash('sha256').update(systemPromptText).digest('hex');
        const transparencyRecord = db.insert('transparency_logs', {
            agentId,
            agentName: agent.name,
            model: selectedModel,
            prompt: prompt,
            systemPrompt: systemPromptText,
            systemPromptHash: systemPromptHash,
            ragSources: ragSources,
            timestamp: new Date().toISOString(),
            humanApproved: false,
            greenMetrics: {
                energyWh: greenMetrics.energyWh,
                co2Grams: greenMetrics.co2Grams
            }
        });

        let draft = null;
        if (wantDraft) {
            draft = Drafts.saveAgentOutput({
                text: draftBody != null ? draftBody : response.message.content, warnings: draftWarn,
                agentId, agentName: agent.name, model: selectedModel, transparencyId: transparencyRecord.id,
                spisId: draftSpisId, title: req.body.draftTitle, draftId: draftTarget && draftTarget.id,
                baseVersion: draftTarget && draftTarget.baseVersion
            });
            if (draft && draft.id) logEvent('Koncepty', draft.created ? 'Koncept od AI agenta' : 'Revize konceptu AI agentem', agent.name, { draftId: draft.id, version: draft.version, spisId: draftSpisId });
        }

        res.json({
            agent: agent.name,
            model: selectedModel,
            response: response.message.content,
            draft,
            transparencyId: transparencyRecord.id,
            greenMetrics,
            oborDetected: oborDetection,
            citationCheck: citationCheck,
            toolsUsed: toolsUsed,
            contextOverflow: contextOverflow ? { approxTokens, numCtx } : null,
            dateFacts: dateFacts ? dateFacts.facts : null,
            outputGuard: outputGuard,
            timestamp: new Date().toISOString()
        });

     } catch (err) {
        if (isModelMissingError(err)) {
            return res.status(400).json({ error: `Model „${selectedModel}“ není na serveru nainstalován. Zvolte jiný model nebo ho stáhněte v Nastavení.` });
        }
        console.warn(`⚠️ Selhalo spojení s Ollama (${err.message}). Používám robustní lokální simulovaný fallback.`);
        const fallbackResponse = generateAgentFallback(agentId, prompt);
        const durationMs = Date.now() - startTime;

        logEvent('LexisEditor', `AI Agent Fallback (${agent.name})`, 'Generování textu (Fallback)', {
            model: `${selectedModel} (Simulovaný)`,
            promptLength: prompt.length,
            contextLength: context ? context.length : 0,
            responseLength: fallbackResponse.length,
            durationMs: durationMs
        });

        const greenMetrics = calculateInferenceMetrics(durationMs);
        db.insert('green_logs', {
            agentId,
            model: `${selectedModel} (Simulovaný)`,
            timestamp: new Date().toISOString(),
            ...greenMetrics
        });

        const systemPromptHash = crypto.createHash('sha256').update(systemPromptText).digest('hex');
        const transparencyRecord = db.insert('transparency_logs', {
            agentId,
            agentName: agent.name,
            model: `${selectedModel} (Simulovaný)`,
            prompt: prompt,
            systemPrompt: systemPromptText,
            systemPromptHash: systemPromptHash,
            ragSources: [],
            timestamp: new Date().toISOString(),
            humanApproved: false,
            greenMetrics: {
                energyWh: greenMetrics.energyWh,
                co2Grams: greenMetrics.co2Grams
            }
        });

        res.json({
            agent: agent.name,
            model: `${selectedModel} (Simulovaný)`,
            response: fallbackResponse,
            transparencyId: transparencyRecord.id,
            greenMetrics,
            oborDetected: oborDetection,
            timestamp: new Date().toISOString()
        });
     }
});

module.exports = router;
