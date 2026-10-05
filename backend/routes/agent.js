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
const { buildDateFacts, dateFactsAppendix, fixDeadlineWording } = require('../lib/date_facts');
const clauseScan = require('../lib/clause_scan');
const { taskProfile, redactForOpponent } = require('../lib/agent_outlines');
const { proceduralFacts, proceduralAppendix } = require('../lib/procedural_facts');
const czProofread = require('../lib/cz_proofread');
const { reviewInChunks } = require('../lib/chunked_review');
const { guardInventedIdentifiers, fixLawNames, buildWarnings } = require('../lib/output_guard');
const { agentNumCtx, isEmbeddingModel, isModelMissingError } = require('../lib/agent_options');
const demandLetter = require('../lib/demand_letter');
const outputChecks = require('../lib/output_checks');
const { selectExamples, examplesMessages } = require('../lib/agent_examples');

// Spojení s modelem selhalo (ne „model neumí formát“) → nemá smysl zkoušet jiný režim.
const _isConnError = e => /fetch failed|ECONN|ETIMEDOUT|EHOSTUNREACH|socket|timeout|aborted|terminated/i.test(String(e && (e.message || e.cause && e.cause.code) || ''));

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
        let ctxModelText = null, ctxMsgIndex = -1, ctxNote = '';
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
            ctxModelText = ctxForModel; ctxMsgIndex = messages.length - 1; ctxNote = note;
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
        // Procesní lhůty (odvolání, odpor, dovolání) a příslušnost soudu dodá program (lib/procedural_facts.js).
        let procFacts = null;
        try { procFacts = proceduralFacts({ prompt, context }); } catch (pfErr) { procFacts = null; }
        if (procFacts) messages.push({ role: 'system', content: procFacts.text });

        // Rizikové doložky ve smlouvě najde program (lib/clause_scan.js) — model je jen vysvětlí.
        // Poznámka pro model nese jen článek, typ a § (žádné osobní údaje z textu).
        let clauseFindings = [];
        try {
            const reviewAsked = agentId === 'kontrolor' || /smlouv|ustanoven|rizik|dolo[žz]k|nevyv[aá][žz]/i.test(String(prompt || ''));
            if (reviewAsked) clauseFindings = clauseScan.scanContract(context || prompt);
            if (clauseFindings.length) messages.push({ role: 'system', content: clauseScan.modelNote(clauseFindings) });
        } catch (csErr) { console.warn('⚠️ Agent: kontrola doložek selhala (nekritické):', csErr.message); }

        // Pevná osnova odpovědi a teplota podle typu úkolu (lib/agent_outlines.js).
        const profile = taskProfile({ agentId, prompt, context, hasClauseFindings: clauseFindings.length > 0 });
        if (profile.outline) messages.push({ role: 'system', content: profile.outline });
        // Korektura: jisté chyby (i/y, bě/pě, shoda, čárka před „že“) najde program (lib/cz_proofread.js).
        let proofTarget = null;
        if (profile.kind === 'proofread') {
            proofTarget = czProofread.extractTarget(prompt) || (context ? String(context).slice(0, 4000) : null);
            const note = proofTarget ? czProofread.modelNote(czProofread.fixText(proofTarget).fixes) : '';
            if (note) messages.push({ role: 'system', content: note });
        }

        // Výzva k úhradě / dopis protistraně: model vrátí JSON a dopis sestaví program
        // (lib/demand_letter.js). AGENT_STRUCTURED_LETTERS=0 vypne.
        const demand = demandLetter.isDemandLetter(prompt) && !draftTarget && profile.kind !== 'proofread' &&
            (agentId === 'spisovatel' || agent.structuredLetters === true) && process.env.AGENT_STRUCTURED_LETTERS !== '0';
        // Vzorové výstupy kanceláře (few-shot, lib/agent_examples.js) — jen když se vejdou do okna.
        let examples = selectExamples(agent, prompt);
        if (examples.length) {
            const used = messages.reduce((n, m) => n + String(m.content || '').length, 0) + String(prompt).length;
            const exLen = examples.reduce((n, e) => n + e.zadani.length + e.vystup.length, 0);
            if ((used + exLen) / 3 > agentNumCtx() * 0.7) {
                console.warn(`⚠️ Agent [${agent.name}]: vzorové výstupy se nevejdou do okna modelu — vynechávám je.`);
                examples = [];
            }
        }
        messages.push(...examplesMessages(examples, { asNote: demand }));
        let letterInstrIdx = -1;
        if (demand) { messages.push({ role: 'system', content: demandLetter.INSTRUCTION }); letterInstrIdx = messages.length - 1; }

        messages.push({ role: 'user', content: prompt });

        // Okno kontextu: bez num_ctx Ollama použije výchozí malé okno (2–4k tokenů) a dlouhý
        // spis TIŠE ořízne zepředu — změřeno 1. 10. 2026: u 40článkové smlouvy model viděl
        // jen konec a riziko v čl. 31 nenašel. AGENT_NUM_CTX (výchozí 8192).
        const numCtx = agentNumCtx();
        const baseTemp = agentTemperature(agent, 0.3);
        const chatOptions = { temperature: profile.temperature != null ? Math.min(baseTemp, profile.temperature) : baseTemp, num_ctx: numCtx };
        // Jeden opakovaný pokus při přechodné chybě spojení s Ollamou (souběh, reset).
        const llm = require('../lib/ollama_retry').retryingProvider(ollama, {
            onRetry: (e) => console.warn(`🔁 Ollama: přechodná chyba (${e.message}) — opakuji dotaz agenta ${agent.name}.`)
        });
        // Dlouhá smlouva: projít po částech (lib/chunked_review.js), finální odpověď z dílčích nálezů.
        let chunked = null;
        if (profile.kind === 'contract_review' && ctxModelText && ctxMsgIndex >= 0 &&
            ctxModelText.length / 3 > numCtx * 0.55 && process.env.AGENT_CHUNKED_REVIEW !== '0') {
            try {
                chunked = await reviewInChunks({ llm, model: selectedModel, systemPrompt: systemPromptText, text: ctxModelText, prompt, numCtx, options: chatOptions });
                if (chunked) {
                    messages[ctxMsgIndex] = { role: 'system', content:
                        `Smlouva je dlouhá (${Math.round(ctxModelText.length / 1000)} tis. znaků), proto ji model prošel po ${chunked.chunks} částech. ` +
                        `Dílčí nálezy z jednotlivých částí (z nich sestav finální odpověď, nic nevynechej):\n${chunked.notes}` +
                        (chunked.skipped ? `\n\n(Pozor: ${chunked.skipped} dalších částí se nevešlo do limitu a nebylo zkontrolováno.)` : '') + ctxNote };
                    console.log(`🧩 Agent [${agent.name}]: dlouhá smlouva prošla po ${chunked.chunks} částech.`);
                }
            } catch (chErr) { console.warn('⚠️ Agent: kontrola po částech selhala, pokračuji celým textem:', chErr.message); chunked = null; }
        }
        // Hrubý odhad tokenů (čeština ~3 znaky/token); při přetečení to advokátovi řekneme.
        const approxTokens = Math.round(messages.reduce((n, m) => n + String(m.content || '').length, 0) / 3);
        const contextOverflow = approxTokens > numCtx * 0.85;
        if (contextOverflow) console.warn(`⚠️ Vstup agenta ~${approxTokens} tokenů > okno ${numCtx} — část textu model neuvidí.`);
        // Tool-calling (Fáze 1, read-only): agent si smí sám došáhnout pro fakta (search_rag,
        // get_document, check_registry) v mezích svých oprávnění. Za AGENT_TOOLS=1; jinak
        // beze změny. RAG kontext je už předvyplněný výše — tooly slouží ke zpřesnění.
        let response, toolsUsed = [];
        // Strukturovaný dopis: JSON → dopis poskládaný programem. Selže-li čtení JSON
        // (starší Ollama bez formátu, jiný poskytovatel), pokračuje se volným textem.
        let letter = null, letterRaw = null, letterMsgs = messages;
        const callLetter = async (msgs) => {
            const r = await llm.chat({ model: selectedModel, messages: msgs, options: chatOptions, format: demandLetter.SCHEMA });
            letterRaw = r && r.message ? r.message.content : '';
            let data = demandLetter.parseLetterJson(letterRaw);
            if (!data) return null;
            if (pseudoMap) data = demandLetter.mapStrings(data, (x) => restorePseudonyms(x, pseudoMap));
            return demandLetter.renderLetter(data, { prompt });
        };
        if (demand) {
            // Výpočty lhůt a procesní fakta jsou pro advokáta, ne pro dopis protistraně — model
            // je pak psal do skutkového stavu (server test 5. 10. 2026). Pro JSON dopis je vynecháme.
            const internal = new Set([dateFacts && dateFacts.text, procFacts && procFacts.text].filter(Boolean));
            letterMsgs = messages.filter(m => !(m.role === 'system' && internal.has(m.content)));
            try {
                letter = await callLetter(letterMsgs);
                if (letter) {
                    response = { message: { content: letter.text } };
                    console.log(`✉️ Agent [${agent.name}]: dopis sestaven programem ze strukturovaných dat (chybí: ${letter.missing.length}).`);
                } else console.warn(`⚠️ Agent [${agent.name}]: strukturovaný dopis — JSON nejde přečíst, pokračuji volným textem.`);
            } catch (lErr) {
                if (isModelMissingError(lErr) || _isConnError(lErr)) throw lErr;
                console.warn(`⚠️ Agent [${agent.name}]: strukturovaný dopis selhal (${lErr.message}), pokračuji volným textem.`);
            }
            if (!letter && letterInstrIdx >= 0) messages.splice(letterInstrIdx, 1);
        }
        if (response) {
            // hotovo (strukturovaný dopis)
        } else if (agentTools.enabled() && agentTools.toolsForAgent(agent).length > 0) {
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

        const restoreOpts = draftTarget ? { alwaysRestore: (v) => !!v && draftTarget.text.includes(v) } : {};
        const rawFirst = letter ? letterRaw : (response && response.message ? response.message.content : '');
        if (pseudoMap && response && response.message && !letter) {
            // Při revizi konceptu se vrací i údaje, které v konceptu už stály (např. RČ v plné moci).
            response.message.content = restorePseudonyms(response.message.content, pseudoMap, restoreOpts);
        }

        // Kontrola výstupu a jedna oprava modelem (lib/output_checks.js). Program sám opraví
        // oslovení a pole [Doplnit – …]; co musí opravit model (chybí částka, lhůta, převzaté
        // údaje z ukázky, jiný jazyk), dostane jako konkrétní výtku. AGENT_SELF_CHECK=0 vypne.
        let selfCheck = null;
        if (process.env.AGENT_SELF_CHECK !== '0' && response && response.message) {
            try {
                const checkSrc = [context, ...ragContextChunks.map(c => c.text)].filter(Boolean).join('\n');
                const evaluate = (text, lt) => {
                    const fx = outputChecks.applyFixes(text, { addressee: lt && lt.addressee, gender: lt && lt.data && lt.data.adresat && lt.data.adresat.pohlavi });
                    const ck = outputChecks.checkOutput({ text: fx.text, prompt, sourceText: checkSrc, demand, bilingual: profile.bilingual, agentId, examples });
                    return { text: fx.text, fixes: fx.fixes, issues: ck.issues, copied: ck.copied, letter: lt };
                };
                const first = evaluate(response.message.content, letter);
                let final = first, retried = false;
                const budget = Number(process.env.AGENT_RETRY_BUDGET_MS || 90000);
                if (first.issues.length && Date.now() - startTime < budget) {
                    retried = true;
                    const fb = outputChecks.retryMessage(first.issues) + (letter ? '\nVrať opět POUZE JSON objekt.' : '');
                    const msgs = (letter ? letterMsgs : messages).concat([{ role: 'assistant', content: rawFirst || '' }, { role: 'user', content: fb }]);
                    try {
                        let second = null;
                        if (letter) {
                            const lt2 = await callLetter(msgs);
                            if (lt2) second = evaluate(lt2.text, lt2);
                        } else {
                            const r2 = await llm.chat({ model: selectedModel, messages: msgs, options: chatOptions });
                            let t2 = r2 && r2.message ? r2.message.content : '';
                            if (pseudoMap) t2 = restorePseudonyms(t2, pseudoMap, restoreOpts);
                            if (t2 && t2.trim()) second = evaluate(t2, null);
                        }
                        if (second) final = outputChecks.better(first, second);
                    } catch (rErr) { console.warn(`⚠️ Agent [${agent.name}]: oprava výstupu selhala (${rErr.message}) — ponechávám první verzi.`); }
                }
                // Údaje převzaté z ukázky, které zůstaly, nahradí program polem k doplnění.
                let text = final.text; const fixes = final.fixes.slice();
                if (final.copied && final.copied.length) {
                    const fx = outputChecks.applyFixes(text, { copied: final.copied });
                    text = fx.text; fixes.push(...fx.fixes.filter(f => /ukázky/.test(f)));
                }
                if (final.letter) letter = final.letter;
                response.message.content = text;
                const remaining = final.issues.filter(i => i.code !== 'copied_example' || !(final.copied || []).length);
                selfCheck = { found: first.issues.map(i => i.code), retried, remaining: remaining.map(i => i.code),
                    remainingText: remaining.map(i => i.msg), fixes, structuredLetter: !!letter, missing: letter ? letter.missing : [],
                    examplesUsed: examples.map(e => e.title) };
                if (first.issues.length) console.log(`🔎 Agent [${agent.name}]: kontrola výstupu — nalezeno ${first.issues.map(i => i.code).join(', ')}${retried ? `; po opravě zbývá: ${selfCheck.remaining.join(', ') || 'nic'}` : ''}.`);
            } catch (scErr) { console.warn('⚠️ Agent: kontrola výstupu selhala (nekritické):', scErr.message); }
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
            let modelText = response.message.content;
            // Únik interních pokynů nebo tajných hodnot → program odpověď opraví (lib/leak_guard.js).
            const lg = require('../lib/leak_guard').guardLeaks(modelText, {
                // Jen vlastní pokyny agenta — fakta od programu (lhůty, příslušnost, osnova) a podklady
                // ze spisů/báze model citovat smí a má.
                instructions: [systemPromptText]
            });
            modelText = lg.text;
            let oppRedacted = [];
            if (profile.kind === 'opponent_letter') {
                const rr = redactForOpponent(modelText, sourceText);
                modelText = rr.text; oppRedacted = rr.removed;
            }
            const g = guardInventedIdentifiers(modelText, sourceText);
            // Chybný název u správného čísla zákona (§ v bázi existuje) → opravit v textu.
            let kbIdx = null;
            try { kbIdx = require('../lib/kb_law_index').getKbLawIndex(); } catch (e) { kbIdx = null; }
            const lf = fixLawNames(g.text, kbIdx);
            const lawIssues = lf.issues;
            // Konec lhůty popsaný jako začátek („běží od 13. 3. 2028“) → „běží do“ (lib/date_facts).
            const dw = fixDeadlineWording(lf.text, dateFacts);
            lf.text = dw.text;
            // Co model z kontrolního seznamu doložek / výpočtů lhůt vynechal, doplní program.
            const clauseApx = clauseFindings.length ? clauseScan.missingAppendix(lf.text, clauseFindings) : { text: '', missing: [] };
            const dateApx = dateFactsAppendix(lf.text, dateFacts);
            const procApx = proceduralAppendix(lf.text, procFacts);
            const mainText = profile.kind === 'proofread' ? czProofread.finalize(lf.text, proofTarget) : lf.text;
            // U dopisu protistraně je výpočet lhůt jen pro advokáta — ať ho nikdo nezkopíruje do dopisu.
            const dateApxOut = letter && dateApx ? dateApx.replace('📅 Doplněno programem (výpočet lhůt):', '📅 Jen pro advokáta — do dopisu nevkládat (výpočet lhůt programem):') : dateApx;
            const procApxOut = letter && procApx ? procApx.replace('⚖️ Doplněno programem (procesní lhůty a příslušnost podle zákona):', '⚖️ Jen pro advokáta — do dopisu nevkládat (procesní lhůty a příslušnost):') : procApx;
            const body = mainText + clauseApx.text + dateApxOut + procApxOut;
            const dwLine = dw.fixed ? `• Opraveno ${dw.fixed}× „lhůta běží od <konec lhůty>“ → „do“ (datum je konec lhůty, spočítal ho program).` : '';
            const oppLine = oppRedacted.length ? `• Z dopisu protistraně odstraněno: ${oppRedacted.join(', ')} (protistrana je nepotřebuje).` : '';
            const scLines = selfCheck ? [
                selfCheck.structuredLetter && selfCheck.missing.length ? `• Dopis sestavil program; doplňte: ${selfCheck.missing.join(', ')}.` : '',
                ...selfCheck.remainingText.map(t => `• Kontrola: ${t.replace(/^V dopise /, 'v dopise ').replace(/ Uveď.*$| Oprav.*$/, '')}`)
            ] : [];
            const warn = buildWarnings({ replaced: g.replaced, lawIssues, lawFixed: lf.fixed, unverifiedCount: citationCheck ? citationCheck.unverifiedCount : 0, extra: [injectionGuard.warningLine(injectionHits), oppLine, dwLine, ...scLines] });
            response.message.content = body + warn;
            draftBody = body; draftWarn = warn;
            outputGuard = { replaced: g.replaced, lawIssues, lawFixed: lf.fixed, injection: injectionHits,
                clauses: clauseFindings.map(f => ({ id: f.id, article: f.article })), clausesAppended: clauseApx.missing, dateAppended: !!dateApx, proceduralAppended: !!procApx,
                taskKind: profile.kind, bilingual: profile.bilingual, opponentRedacted: oppRedacted, promptLeakBlocked: lg.promptLeak, secretsRedacted: lg.redacted, deadlineWordingFixed: dw.fixed,
                chunkedReview: chunked ? { chunks: chunked.chunks, skipped: chunked.skipped } : null, selfCheck };
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
                spisId: draftSpisId, title: req.body.draftTitle || (letter && letter.title) || undefined, draftId: draftTarget && draftTarget.id,
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
            dateFacts: dateFacts ? dateFacts.facts.concat(dateFacts.limitation ? [{
                kind: 'promlceni', base: dateFacts.limitation.event, end: dateFacts.limitation.subjectiveEnd, objectiveEnd: dateFacts.limitation.objectiveEnd
            }] : []) : null,
            outputGuard: outputGuard,
            examplesUsed: selfCheck ? selfCheck.examplesUsed : [],
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
