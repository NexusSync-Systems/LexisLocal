/**
 * routes/agentSwarm.js — vícegentní orchestrace:
 *   - /debate: tvůrce vs. oponent nad stejným zadáním,
 *   - /orchestrate: hierarchická orchestrace přes ChiefOrchestrator.
 * Montuje se v server.js na /api/agent-swarm.
 */
'use strict';

const express = require('express');
const { CHAT_MODEL, RAG_MIN_SCORE } = require('../lib/model_config');
const router = express.Router();
const { loadAgents, agentTemperature } = require('../lib/agents');
const { searchSimilar } = require('../lib/rag');
const { logEvent } = require('../lib/audit');
const { anonymizeText } = require('../lib/anonymizer');
const ollama = require('../lib/ai_provider'); // Ollama | OpenAI | Anthropic (stejné rozhraní)
const { generateAgentFallback } = require('../lib/agent_fallback');
const { resolveRagFilters, buildRagScope } = require('../lib/rag_request');
const ChiefOrchestrator = require('../lib/orchestrator');
const spisFolders = require('../lib/spisFolders');
const spisy = require('../lib/spisy');

// POST /api/agent-swarm/debate - Coordinate two agents interacting over the same task
router.post('/debate', async (req, res) => {
    const { prompt, agentId1, agentId2, context, model } = req.body;
    const startTime = Date.now();

    const agents = loadAgents();
    const agent1 = agents[agentId1];
    const agent2 = agents[agentId2];

    if (!agent1 || !agent2) {
        return res.status(404).json({ error: "Jeden nebo oba vybraní agenti nebyli nalezeni." });
    }

    const selectedModel = model || CHAT_MODEL;
    console.log(`🤖 Spouštím Swarm Debatu: Tvůrce [${agent1.name}] & Oponent [${agent2.name}] s modelem [${selectedModel}]`);

    // Retrieve RAG context
    let ragContext = "";
    let oborDetection = null; // pro UI („detekován obor…"); viditelné i ve fallbacku
    try {
        // Debata dvou agentů: sjednotit jejich znalostní báze; přístup ke klientským
        // spisům omezit, jakmile ho nemá kterýkoli z nich (konzervativně). Judikaturní
        // politika vč. auto-detekce oboru z promptu (buildRagScope).
        const built = await buildRagScope(req.body, [agent1, agent2], prompt);
        let resolvedFilters = built.filters;
        oborDetection = built.detection;
        if (resolvedFilters) {
            console.log(`🧠 Swarm RAG: Aktivní filtry pro debatu: ${JSON.stringify(resolvedFilters)}`);
        }
        if (oborDetection) {
            console.log(`🧭 Swarm obor: ${oborDetection.label} (${oborDetection.source}${oborDetection.confident ? '' : ', nejistě → celoplošně'})`);
        }
        const matches = await searchSimilar(prompt, 3, resolvedFilters);
        const highConfidenceMatches = matches.filter(m => m.score >= RAG_MIN_SCORE);

        if (highConfidenceMatches.length > 0) {
            // 'redacted' (kterýkoli agent debaty) → klientské pasáže anonymizovaně; KB beze změny.
            const redact = !!(resolvedFilters && resolvedFilters.redactClient);
            ragContext = highConfidenceMatches
                .map(m => {
                    const passage = (redact && !m.scope) ? anonymizeText(m.text) : m.text;
                    return `[Zdrojový spis: ${m.fileName}, Shoda: ${Math.round(m.score * 100)}%]:\n${passage}`;
                })
                .join('\n\n---\n\n');
            console.log(`🧠 Swarm RAG: Získáno ${highConfidenceMatches.length} sémantických precedensů pro debatu.`);
        }
    } catch (ragErr) {
        console.warn("⚠️ Swarm RAG: Selhalo vyhledávání kontextu:", ragErr.message);
    }

    try {
        // --- STEP 1: INVOKE AGENT 1 (CREATOR) ---
        const messages1 = [
            { role: 'system', content: agent1.systemPrompt }
        ];

        if (ragContext) {
            messages1.push({
                role: 'system',
                content: `Historický kontext a precedenty z klientských spisů:\n${ragContext}`
            });
        }

        if (context) {
            messages1.push({ role: 'system', content: `Kontext dokumentu:\n${context}` });
        }

        messages1.push({ role: 'user', content: prompt });

        const response1 = await ollama.chat({
            model: selectedModel,
            messages: messages1,
            options: { temperature: agentTemperature(agent1, 0.3) }
        });

        const answer1 = response1.message.content;

        // --- STEP 2: INVOKE AGENT 2 (OPPONENT / CRITIQUE) ---
        const messages2 = [
            { role: 'system', content: agent2.systemPrompt }
        ];

        if (ragContext) {
            messages2.push({
                role: 'system',
                content: `Historický kontext a precedenty z klientských spisů:\n${ragContext}`
            });
        }

        if (context) {
            messages2.push({ role: 'system', content: `Kontext dokumentu:\n${context}` });
        }

        messages2.push({
            role: 'system',
            content: `Tvůj AI kolega [${agent1.name}] vypracoval pro uživatele tento prvotní návrh:\n\n${answer1}\n\nJako přísný a konstruktivní oponent zhodnoť tento návrh. Identifikuj slabá místa, právní kličky, potenciální rizika nebo stylistické nedostatky. Následně vypracuj revidované znění nebo finální doporučení pro advokáta.`
        });

        messages2.push({ role: 'user', content: prompt });

        const response2 = await ollama.chat({
            model: selectedModel,
            messages: messages2,
            options: { temperature: agentTemperature(agent2, 0.2) }
        });

        const answer2 = response2.message.content;

        logEvent('LexisEditor', 'Swarm Debata', `Duel: ${agent1.name} vs. ${agent2.name}`, {
            model: selectedModel,
            agent1: agent1.name,
            agent2: agent2.name,
            promptLength: prompt.length,
            contextLength: context ? context.length : 0,
            response1Length: answer1.length,
            response2Length: answer2.length,
            durationMs: Date.now() - startTime
        });

        res.json({
            success: true,
            model: selectedModel,
            agent1: { id: agentId1, name: agent1.name, response: answer1 },
            agent2: { id: agentId2, name: agent2.name, response: answer2 },
            oborDetected: oborDetection,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.warn(`⚠️ Selhalo spojení s Ollama ve Swarmu (${err.message}). Používám lokalizovaný robustní simulovaný oponentní výstup.`);

        const answer1 = generateAgentFallback(agentId1, prompt);
        const answer2 = `[Oponentní posudek od agenta ${agent2.name} na návrh od ${agent1.name}]:\n\nAnalyzoval jsem předchozí vypracování. Návrh je strukturovaný správně, avšak doporučuji doplnit výslovnou doložku o volbě práva a smluvní pokutě ve výši 0.05 % denně za prodlení, aby byly zájmy našeho klienta chráněny neprůstřelně.\n\nZde je revidovaný odstavec:\n"V případě prodlení kupujícího s úhradou kupní ceny se sjednává smluvní pokuta ve výši 0.05 % z dlužné částky za každý den prodlení."`;

        logEvent('LexisEditor', 'Swarm Debata Fallback', `Duel Fallback: ${agent1.name} vs. ${agent2.name}`, {
            model: `${selectedModel} (Simulovaný Swarm)`,
            agent1: agent1.name,
            agent2: agent2.name,
            promptLength: prompt.length,
            contextLength: context ? context.length : 0,
            response1Length: answer1.length,
            response2Length: answer2.length,
            durationMs: Date.now() - startTime
        });

        res.json({
            success: true,
            model: `${selectedModel} (Simulovaný Swarm)`,
            agent1: { id: agentId1, name: agent1.name, response: answer1 },
            agent2: { id: agentId2, name: agent2.name, response: answer2 },
            oborDetected: oborDetection,
            timestamp: new Date().toISOString()
        });
    }
});

// POST /api/agent-swarm/orchestrate - Hierarchy Swarm Orchestration with Chief Orchestrator
router.post('/orchestrate', async (req, res) => {
    const { prompt, context, model, spisId, saveDraft, fileName } = req.body;
    if (!prompt) {
        return res.status(400).json({ error: "Zadání (prompt) je povinné." });
    }

    const selectedModel = model || CHAT_MODEL;
    console.log(`🧠 Express Server: Spouštím Chief Orchestrator pro: "${prompt.substring(0, 50)}..."`);

    try {
        const resolvedFilters = await resolveRagFilters(req.body);
        if (resolvedFilters) {
            console.log(`🧠 Orchestrator: Aktivní filtry pro RAG: ${JSON.stringify(resolvedFilters.fileNames)}`);
        }
        const result = await ChiefOrchestrator.orchestrate(prompt, context || "", selectedModel, null, resolvedFilters);

        logEvent('LexisEditor', 'Chief Orchestrator', `Orchestrace: ${prompt.substring(0, 40)}`, {
            model: selectedModel,
            durationMs: result.durationMs,
            stepsCount: result.steps.length,
            success: true,
            spisId: spisId || null
        });

        // Volitelné bezpečné uložení konceptu do složky spisu (fail-closed).
        // Aktivuje se jen když klient pošle spisId + saveDraft. Odmítnutí kvůli
        // nedostatku podkladů se NEUKLÁDÁ jako koncept.
        if (spisId && saveDraft && result && result.finalOutput) {
            const txt = String(result.finalOutput);
            const refused = /^\s*Nedostatek podkladů/i.test(txt);
            if (refused) {
                result.draftSkipped = 'refused-insufficient-material';
            } else {
                try {
                    const spis = spisy.getSpis(spisId);
                    if (spis) spisFolders.ensureSpisFolder(spis); // známý spis → zajisti jeho složku
                    result.draft = spisFolders.saveDraftToSpis({
                        spisId,
                        fileName: fileName || ('koncept_' + prompt.substring(0, 40) + '.docx'),
                        content: txt
                    });
                } catch (e) {
                    result.draftError = e.message;
                }
            }
        }

        res.json(result);
    } catch (err) {
        console.error("❌ Orchestrace selhala:", err.message);
        res.status(500).json({ error: `Orchestrace selhala: ${err.message}` });
    }
});

module.exports = router;
