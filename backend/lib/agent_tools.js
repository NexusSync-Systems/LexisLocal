'use strict';
/**
 * agent_tools.js — interní tool-registry pro roj agentů (Fáze 1: READ-ONLY).
 *
 * Dnes agenti dostanou RAG kontext a napíšou text; NEvybírají si nástroje. Tenhle modul
 * dává agentům možnost si samostatně „došáhnout" pro fakta (přesnější RAG dotaz, obsah
 * dokumentu, ověření IČO) přes bounded tool-loop nad ollama tool-callingem.
 *
 * Bezpečnost:
 *  - Každý tool je vázán na oprávnění agenta (agent.permissions) → agentovi se do modelu
 *    pošlou JEN tooly, na které má právo, a exec je gated JEŠTĚ JEDNOU za běhu.
 *  - Fáze 1 je READ-ONLY (žádné zápisy). Zápisové tooly (kalendář, upload) až fáze 2.
 *  - Vše za přepínačem AGENT_TOOLS=1 (default VYP) → reverzibilní, nemění stávající chování.
 *  - Impl volají lib PŘÍMO (bez HTTP/MCP round-tripu).
 */
const rag = require('./rag');
let _registries = null, _watcher = null;
function registries() { return _registries || (_registries = require('./registries')); }
function watcher() { return _watcher || (_watcher = require('./watcher')); }
const fs = require('fs');
const path = require('path');

function _num(v, def, min, max) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

// Registry: každý tool { permission, description, parameters (JSON schema), impl(args, ctx) }.
const TOOLS = {
    search_rag: {
        permission: 'read_files',
        description: 'Sémantické vyhledávání v dostupných spisech a znalostní bázi (RAG). ' +
            'Vrátí nejrelevantnější úryvky. Použij pro zpřesnění, když potřebuješ konkrétní pasáž.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Dotaz v přirozeném jazyce (klidně konkrétní právní pojem).' },
                limit: { type: 'integer', description: 'Počet úryvků (1–10, výchozí 5).' }
            },
            required: ['query']
        },
        impl: async (args, ctx) => {
            const query = String(args.query == null ? '' : args.query).trim();
            if (!query) return { error: 'Prázdný dotaz.' };
            const limit = _num(args.limit, 5, 1, 10);
            const filters = (ctx && ctx.ragFilters) || null; // scope/spisAccess řeší volající
            const results = await rag.searchSimilar(query, limit, filters, { lexicalFallback: true });
            return {
                results: (results || []).map(r => ({
                    fileName: r.fileName,
                    score: typeof r.score === 'number' ? Number(r.score.toFixed(3)) : r.score,
                    text: String(r.text == null ? '' : r.text).slice(0, 500)
                }))
            };
        }
    },
    get_document: {
        permission: 'read_files',
        description: 'Vrátí textový obsah dokumentu ze schránky (inbox) podle přesného názvu souboru.',
        parameters: {
            type: 'object',
            properties: { fileName: { type: 'string', description: 'Název souboru vč. přípony (např. zaloba.pdf).' } },
            required: ['fileName']
        },
        impl: async (args) => {
            const fileName = String(args.fileName == null ? '' : args.fileName).trim();
            if (!fileName) return { error: 'Chybí název souboru.' };
            const inbox = await watcher().loadInbox();
            const fileData = inbox && inbox.files && inbox.files[fileName];
            if (!fileData) return { error: 'Soubor nenalezen ve schránce.' };
            const filePath = fileData.filePath;
            if (!filePath || !fs.existsSync(filePath)) return { error: 'Fyzický soubor na disku neexistuje.' };
            let content = '';
            if (path.extname(filePath).toLowerCase() === '.pdf') {
                const pdf = require('pdf-parse');
                content = (await pdf(await fs.promises.readFile(filePath))).text;
            } else {
                content = await fs.promises.readFile(filePath, 'utf-8');
            }
            // Ořez, ať malý model nezahltíme celým spisem (kontext + rychlost).
            return { fileName, content: String(content || '').slice(0, 8000) };
        }
    },
    check_registry: {
        permission: 'query_registries',
        description: 'Ověří subjekt ve veřejných registrech (ARES apod.) podle IČO (8 číslic).',
        parameters: {
            type: 'object',
            properties: { ico: { type: 'string', description: 'IČO subjektu, 8 číslic.' } },
            required: ['ico']
        },
        impl: async (args) => {
            const ico = String(args.ico == null ? '' : args.ico).replace(/\D/g, '');
            if (ico.length !== 8) return { error: 'IČO musí mít 8 číslic.' };
            return await registries().checkSubject(ico);
        }
    }
};

function _agentAllows(agent, permission) {
    return !!(agent && agent.permissions && agent.permissions[permission]);
}

/** Ollama-formát definic nástrojů, které agent SMÍ použít (dle agent.permissions). */
function toolsForAgent(agent) {
    const out = [];
    for (const name of Object.keys(TOOLS)) {
        const t = TOOLS[name];
        if (_agentAllows(agent, t.permission)) {
            out.push({ type: 'function', function: { name, description: t.description, parameters: t.parameters } });
        }
    }
    return out;
}

/** Smí agent tenhle nástroj zavolat? (běhová brána) */
function isToolAllowed(agent, name) {
    const t = TOOLS[name];
    return !!t && _agentAllows(agent, t.permission);
}

/** Spustí nástroj s permission-gate a odchytem chyb. Vrací výsledek nebo { error }. */
async function execTool(agent, name, args, ctx) {
    const t = TOOLS[name];
    if (!t) return { error: `Neznámý nástroj: ${name}` };
    if (!_agentAllows(agent, t.permission)) return { error: `Agent nemá oprávnění (${t.permission}) pro nástroj ${name}.` };
    try {
        const result = await t.impl(args || {}, ctx || {});
        if (ctx && typeof ctx.audit === 'function') {
            try { ctx.audit({ tool: name, args: args || {}, ok: !(result && result.error) }); } catch (e) { /* audit nesmí shodit */ }
        }
        return result;
    } catch (e) {
        return { error: `Nástroj ${name} selhal: ${e && e.message}` };
    }
}

function enabled() {
    const v = String(process.env.AGENT_TOOLS == null ? '' : process.env.AGENT_TOOLS).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
function maxIters() { return _num(process.env.AGENT_TOOLS_MAX_ITERS, 3, 1, 6); }

// Modely, které v Ollamě nepodporují tool-calling (vrací 400 „does not support tools").
// Necháme je odpovědět bez nástrojů místo drahého 400 round-tripu (načtení modelu + chyba).
// Konfigurovatelné přes AGENT_TOOLS_NO_TOOL_MODELS (comma-sep substringy, case-insensitive).
// Default pokrývá gemma2 (nakonfigurovaný REVIEW_MODEL kontrolora) a gemma v1 — ani jeden
// nemá tool šablonu. qwen2.5 / llama3.1+ tool-calling umí.
function _noToolModelPatterns() {
    const raw = process.env.AGENT_TOOLS_NO_TOOL_MODELS;
    if (raw == null || String(raw).trim() === '') return ['gemma2', 'gemma:'];
    return String(raw).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}
function _modelMaySupportTools(model) {
    const m = String(model == null ? '' : model).toLowerCase();
    if (!m) return true;
    return !_noToolModelPatterns().some(pat => m.includes(pat));
}
// Rozpozná ollama chybu „model nepodporuje tool-calling" napříč verzemi knihovny.
function _isNoToolSupportError(e) {
    const msg = String((e && (e.message || e.error)) || e || '').toLowerCase();
    return msg.includes('does not support tools') ||
           (msg.includes('tool') && msg.includes('not support'));
}

/**
 * Bounded tool-loop nad providerem (kompatibilní s ai_provider.chat / ollama.chat).
 * @returns {Promise<{content:string, toolCalls:Array<{name,args}>, iters:number}>}
 *
 * - Agent bez povoleného toolu → jedno bez-toolové volání (žádná změna chování).
 * - Po vyčerpání iterací → vynutí finální odpověď bez nástrojů.
 * - Argumenty modelu se validují proti schématu jen měkce (parse JSON); impl si hlídá vstup.
 */
async function runToolLoop({ provider, model, messages, options, agent, ctx }) {
    const tools = toolsForAgent(agent);
    const calls = [];
    const baseMsgs = Array.isArray(messages) ? messages.slice() : [];

    // Model bez tool-callingu (ollama vrací 400 „does not support tools") NEBO agent bez
    // povolených toolů → jedno bez-toolové volání (reálná odpověď, jen bez nástrojů).
    if (!tools.length || !_modelMaySupportTools(model)) {
        const resp = await provider.chat({ model, messages: baseMsgs, options });
        return { content: (resp && resp.message && resp.message.content) || '', toolCalls: calls, iters: 0 };
    }

    const msgs = baseMsgs;
    const MAX = maxIters();
    let iters = 0;
    for (; iters < MAX; iters++) {
        let resp;
        try {
            resp = await provider.chat({ model, messages: msgs, tools, options });
        } catch (e) {
            // Model tool-calling nepodporuje (ollama 400) → NEshazuj agenta do simulovaného
            // fallbacku; odpověz naposledy BEZ nástrojů (reálný model). Jiné chyby (výpadek
            // Ollamy) probublají dál a řeší je volající (agent.js → offline fallback).
            if (iters === 0 && _isNoToolSupportError(e)) {
                const resp2 = await provider.chat({ model, messages: baseMsgs, options });
                return { content: (resp2 && resp2.message && resp2.message.content) || '', toolCalls: calls, iters: 0 };
            }
            throw e;
        }
        const msg = (resp && resp.message) ? resp.message : {};
        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!toolCalls.length) {
            return { content: msg.content || '', toolCalls: calls, iters };
        }
        msgs.push(msg);
        for (const call of toolCalls) {
            const fn = (call && call.function) || {};
            const name = fn.name;
            let args = fn.arguments;
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
            if (!args || typeof args !== 'object') args = {};
            calls.push({ name, args });
            const result = await execTool(agent, name, args, ctx);
            msgs.push({ role: 'tool', content: JSON.stringify(result).slice(0, 6000) });
        }
    }
    // Vyčerpán loop → poslední volání bez nástrojů, ať model dá závěr.
    const finalResp = await provider.chat({ model, messages: msgs, options });
    return { content: (finalResp && finalResp.message && finalResp.message.content) || '', toolCalls: calls, iters };
}

module.exports = { TOOLS, toolsForAgent, isToolAllowed, execTool, runToolLoop, enabled, maxIters, _modelMaySupportTools, _isNoToolSupportError };
