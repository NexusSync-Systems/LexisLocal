#!/usr/bin/env node
'use strict';
/**
 * ai-check.js — PREFLIGHT lokální AI (Ollama) pro LexisLocal.
 *
 * Rychle ověří, že je AI připravená K PROVOZU: běží Ollama, jsou stažené správné
 * modely, a reálně odpovídá (embedding + krátký chat) + naměří latenci. Nic
 * neinstaluje, jen diagnostikuje a poradí přesnou nápravu. Bez závislostí.
 *
 * Spuštění:
 *   node backend/scripts/ai-check.js
 *
 * Respektuje stejné proměnné jako aplikace:
 *   OLLAMA_HOST       (default http://127.0.0.1:11434)
 *   CHAT_MODEL        (default llama3)
 *   EMBEDDING_MODEL   (default nomic-embed-text)
 *   AI_PROVIDER / AI_CHAT_PROVIDER / AI_EMBED_PROVIDER (default ollama)
 */

const HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const CHAT = process.env.CHAT_MODEL || 'llama3';
const EMBED = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const PROVIDER = String(process.env.AI_CHAT_PROVIDER || process.env.AI_PROVIDER || 'ollama').toLowerCase();

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[1m', X = '\x1b[0m';
const ok = m => console.log(`  ${G}✅${X} ${m}`);
const bad = m => console.log(`  ${R}❌${X} ${m}`);
const warn = m => console.log(`  ${Y}⚠️${X}  ${m}`);
let problems = 0;

function fetchT(url, opts, ms) {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), ms);
    return fetch(url, Object.assign({ signal: ac.signal }, opts)).finally(() => clearTimeout(id));
}

async function main() {
    console.log(`\n${B}LexisLocal — kontrola lokální AI (Ollama)${X}`);
    console.log(`Endpoint: ${HOST}   Provider: ${PROVIDER}`);
    console.log(`Chat model: ${CHAT}   Embedding model: ${EMBED}\n`);

    if (PROVIDER !== 'ollama') {
        warn(`Provider není „ollama" (${PROVIDER}) — jedeš na cloudovém poskytovateli, ne 100 % lokálně. Pro pilot doporučeno ollama.`);
    }

    // 1) Dostupnost + seznam modelů
    let models = [];
    try {
        const t0 = Date.now();
        const res = await fetchT(`${HOST}/api/tags`, {}, 4000);
        if (!res.ok) { bad(`Ollama odpověděla HTTP ${res.status}`); problems++; return summary(); }
        const data = await res.json();
        models = (data.models || []).map(m => m.name);
        ok(`Ollama běží a odpovídá (${Date.now() - t0} ms). Nainstalováno modelů: ${models.length}`);
        if (models.length) console.log(`     ${models.join(', ')}`);
    } catch (e) {
        bad(`Ollama nedostupná na ${HOST}  (${e.name === 'AbortError' ? 'timeout' : e.message})`);
        console.log(`\n  Náprava: spusť Ollamu → ${B}ollama serve${X}  (nebo otevři aplikaci Ollama).`);
        console.log(`  Instalace: ${B}https://ollama.com/download${X}`);
        problems++;
        return summary();
    }

    const has = name => models.some(m => m === name || m.split(':')[0] === name.split(':')[0]);

    // 2) Chat model stažený?
    if (has(CHAT)) ok(`Chat model „${CHAT}" je stažený.`);
    else { bad(`Chat model „${CHAT}" chybí →  ${B}ollama pull ${CHAT}${X}`); problems++; }

    // 3) Embedding model stažený?
    if (has(EMBED)) ok(`Embedding model „${EMBED}" je stažený.`);
    else { bad(`Embedding model „${EMBED}" chybí →  ${B}ollama pull ${EMBED}${X}`); problems++; }

    // 4) Reálný embedding (funkčnost + latence)
    if (has(EMBED)) {
        try {
            const t0 = Date.now();
            const res = await fetchT(`${HOST}/api/embeddings`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: EMBED, prompt: 'kontrola připravenosti' })
            }, 20000);
            const d = await res.json();
            const dim = (d.embedding || []).length;
            if (dim) ok(`Embedding funguje (${dim}-dim, ${Date.now() - t0} ms).`);
            else { bad('Embedding vrátil prázdný vektor.'); problems++; }
        } catch (e) { warn(`Embedding test selhal: ${e.name === 'AbortError' ? 'timeout' : e.message}`); problems++; }
    }

    // 5) Reálný krátký chat (funkčnost + latence → indikace výkonu HW)
    if (has(CHAT)) {
        try {
            const t0 = Date.now();
            const res = await fetchT(`${HOST}/api/generate`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: CHAT, prompt: 'Odpověz jedním slovem: ahoj', stream: false })
            }, 120000);   // 120 s — velký model se při prvním (studeném) volání natahuje do RAM
            const d = await res.json();
            const ms = Date.now() - t0;
            if (d.response !== undefined) {
                ok(`Chat funguje (${ms} ms na krátkou odpověď).`);
                if (ms > 15000) warn('Krátká odpověď trvala přes 15 s — na tomto stroji zvaž menší model (např. qwen2.5:3b nebo gemma2:2b).');
            } else { bad('Chat nevrátil odpověď.'); problems++; }
        } catch (e) { warn(`Chat test selhal: ${e.name === 'AbortError' ? 'timeout (model se možná načítá)' : e.message}`); problems++; }
    }

    summary();
}

function summary() {
    console.log('');
    if (problems === 0) console.log(`${G}${B}AI je připravená pro LexisLocal.${X}`);
    else console.log(`${Y}${B}AI zatím není plně připravená — vyřeš body ❌ výše (${problems}).${X}`);
    process.exit(problems === 0 ? 0 : 1);
}

main().catch(e => { console.error('Neočekávaná chyba:', e.message); process.exit(1); });
