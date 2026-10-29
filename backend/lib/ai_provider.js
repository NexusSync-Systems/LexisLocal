/**
 * ai_provider.js — poskytovatel AI nezávislý na jednom backendu.
 *
 * Sjednocuje generování (chat) a embeddingy za JEDNO rozhraní, KOMPATIBILNÍ s
 * knihovnou `ollama` (stejné tvary vstupu i výstupu):
 *   chat({ model, messages, options })      → { message: { content } }
 *   embeddings({ model, prompt })           → { embedding: [...] }
 *
 * Na volajících místech tak stačí prohodit `require('ollama')` /
 * `require('./ollama_client')` za `require('./ai_provider')` — beze změny logiky.
 *
 * Volba backendu přes env (výchozí = ollama, takže stávající chování se nemění):
 *   AI_PROVIDER            společný default pro chat i embeddingy
 *   AI_CHAT_PROVIDER       'ollama' | 'openai' | 'anthropic' | 'bedrock'
 *   AI_EMBED_PROVIDER      'ollama' | 'openai'
 * OpenAI / OpenAI-kompatibilní (OpenAI, LM Studio, LocalAI, …):
 *   OPENAI_BASE_URL (def. https://api.openai.com/v1), OPENAI_API_KEY,
 *   OPENAI_CHAT_MODEL (def. gpt-4o-mini), OPENAI_EMBED_MODEL (def. text-embedding-3-small)
 * Amazon Bedrock v EU (jen chat; Claude přes Converse API, zámek na eu-* regiony a eu.* profily):
 *   BEDROCK_REGION, BEDROCK_MODEL_ID, AWS přístup — viz lib/bedrock.js
 * Anthropic (jen chat; embeddings API nemá):
 *   ANTHROPIC_API_KEY, ANTHROPIC_MODEL (def. claude-3-5-sonnet-latest), ANTHROPIC_VERSION
 *
 * PRAVIDLA SPISU (lib/cloud_policy.js): chat mimo lokální model projde jen tehdy, když to
 * dovolí stupeň citlivosti a souhlas klienta u všech spisů, které do dotazu přispěly.
 * Přímé API (Anthropic, veřejné OpenAI) je pro klientská data zakázané vždy; OpenAI-kompatibilní
 * server na loopbacku / v LAN kanceláře je lokální model. Odepřený cloud → lokální Ollama
 * (LEXIS_CLOUD_ODEPRENI=chyba → chyba), vše v auditu „Cloud AI“.
 */
'use strict';

const ollama = require('./ollama_client'); // Ollama backend + správa modelů (list/pull)

function _env(k, d) { return process.env[k] || d; }
function _chatProvider() { return String(process.env.AI_CHAT_PROVIDER || process.env.AI_PROVIDER || 'ollama').toLowerCase(); }
function _embedProvider() { return String(process.env.AI_EMBED_PROVIDER || process.env.AI_PROVIDER || 'ollama').toLowerCase(); }

// --- Pilotní pojistka mlčenlivosti: LOCAL-ONLY ---------------------------------
// Když je zapnutý lokální/pilotní režim (LEXIS_PILOT_LOCAL_ONLY / AI_LOCAL_ONLY),
// SMÍ běžet jen lokální provider (ollama). Cloud (openai/anthropic) by poslal
// klientská data (vč. RAG chunků) mimo stroj → porušení advokátní mlčenlivosti.
function _truthy(v) { const t = String(v == null ? '' : v).trim().toLowerCase(); return t !== '' && t !== '0' && t !== 'false' && t !== 'no' && t !== 'off'; }
function _localOnly() { return _truthy(process.env.LEXIS_PILOT_LOCAL_ONLY) || _truthy(process.env.AI_LOCAL_ONLY); }

// Stav souladu s lokálním režimem: { localOnly, chat, embed, compliant, violations }.
function assertLocalCompliance() {
    const localOnly = _localOnly();
    const chat = _chatProvider();
    const embed = _embedProvider();
    const violations = [];
    if (localOnly) {
        if (chat !== 'ollama') violations.push({ kind: 'chat', provider: chat });
        if (embed !== 'ollama') violations.push({ kind: 'embed', provider: embed });
    }
    return { localOnly: localOnly, chat: chat, embed: embed, compliant: violations.length === 0, violations: violations };
}
function _guardLocalOnly(kind, provider) {
    if (_localOnly() && provider !== 'ollama') {
        const env = kind === 'chat' ? 'AI_CHAT_PROVIDER' : 'AI_EMBED_PROVIDER';
        throw new Error('LEXIS_PILOT_LOCAL_ONLY: ' + kind + ' přes cloud (' + provider + ') je v lokálním režimu zakázán — klientská data nesmí opustit stroj (mlčenlivost). Použij lokální Ollama (' + env + '=ollama).');
    }
}
function _openaiBase() { return _env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''); }
function _openaiHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (process.env.OPENAI_API_KEY) h['Authorization'] = 'Bearer ' + process.env.OPENAI_API_KEY;
    return h;
}

// --- OpenAI / OpenAI-kompatibilní ------------------------------------------
async function _openaiChat(messages, options) {
    const res = await fetch(_openaiBase() + '/chat/completions', {
        method: 'POST',
        headers: _openaiHeaders(),
        body: JSON.stringify({
            model: _env('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
            messages: messages || [],
            temperature: options && options.temperature != null ? options.temperature : undefined
        })
    });
    if (!res.ok) throw new Error('OpenAI chat ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    const content = (((data.choices || [])[0] || {}).message || {}).content || '';
    return { message: { content: content } };
}
async function _openaiEmbeddings(input) {
    const res = await fetch(_openaiBase() + '/embeddings', {
        method: 'POST',
        headers: _openaiHeaders(),
        body: JSON.stringify({ model: _env('OPENAI_EMBED_MODEL', 'text-embedding-3-small'), input: String(input == null ? '' : input) })
    });
    if (!res.ok) throw new Error('OpenAI embeddings ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    const emb = ((data.data || [])[0] || {}).embedding;
    if (!emb) throw new Error('OpenAI vrátil prázdný embedding.');
    return { embedding: emb };
}

// --- Anthropic (chat) -------------------------------------------------------
async function _anthropicChat(messages, options) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY není nastaven.');
    const system = (messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n') || undefined;
    const msgs = (messages || []).filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content == null ? '' : m.content) }));
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': _env('ANTHROPIC_VERSION', '2023-06-01') },
        body: JSON.stringify({
            model: _env('ANTHROPIC_MODEL', 'claude-3-5-sonnet-latest'),
            system: system,
            messages: msgs.length ? msgs : [{ role: 'user', content: '' }],
            max_tokens: parseInt(_env('ANTHROPIC_MAX_TOKENS', '4096'), 10),
            temperature: options && options.temperature != null ? options.temperature : undefined
        })
    });
    if (!res.ok) throw new Error('Anthropic ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    const content = (data.content || []).map(b => b.text || '').join('');
    return { message: { content: content } };
}

// --- Veřejné API (kompatibilní s ollama lib) --------------------------------
// Lokální Ollama se stropem délky odpovědi.
function _ollamaChat(params) {
    // Strop délky odpovědi: bez num_predict může model „utéct“ a generovat minuty. Ollama
    // (stream:false) pošle hlavičky až po dogenerování, takže po 300 s spadne spojení
    // (serverový test 4. 10. 2026: souběh 8, jeden dotaz Sekretářky 313 s, „fetch failed“).
    // AGENT_NUM_PREDICT (tokeny, výchozí 3072; 0 = bez stropu). Explicitní hodnota volajícího má přednost.
    const cap = parseInt(process.env.AGENT_NUM_PREDICT == null ? '3072' : process.env.AGENT_NUM_PREDICT, 10);
    if (cap > 0 && !params.stream && !(params.options && params.options.num_predict != null)) {
        params = Object.assign({}, params, { options: Object.assign({}, params.options, { num_predict: cap }) });
    }
    return ollama.chat(params); // ollama default (respektuje params.model i options)
}

// --- Veřejné API (kompatibilní s ollama lib) --------------------------------
// Každý dotaz mimo lokální model projde pravidly spisu (lib/cloud_policy.js): stupeň
// citlivosti + souhlas klienta. Odepřený cloud → lokální model (nebo chyba, viz
// LEXIS_CLOUD_ODEPRENI); obojí se zapíše do auditu.
// Jedna statistika na požadavek (lokálně / cloud / odepřeno) — lib/ai_usage.js.
function _countRequest(druh) {
    try {
        const st = require('./request_context').current();
        if (!st || st._aiCount) return;
        st._aiCount = druh;
        require('./ai_usage').pocitej(druh);
    } catch (e) { /* statistika nesmí shodit dotaz */ }
}

async function chat(params) {
    params = params || {};
    const p = _chatProvider();
    _guardLocalOnly('chat', p);
    const policy = require('./cloud_policy');
    let decision = policy.rozhodni(p);
    if (decision.druh === 'lokalni') {
        _countRequest('lokalne');
    } else {
        const usage = require('./ai_usage');
        const cloudModel = p === 'bedrock' ? (process.env.BEDROCK_MODEL_ID || null) : p === 'anthropic' ? _env('ANTHROPIC_MODEL', null) : _env('OPENAI_CHAT_MODEL', null);
        // Rozpočet: s tvrdým stropem po vyčerpání měsíčního rozpočtu už nic do cloudu.
        if (decision.allowed) {
            const b = usage.kontrolaRozpoctu();
            if (!b.ok) decision = Object.assign({}, decision, { allowed: false, code: 'rozpocet', duvody: [b.duvod] });
        }
        if (!decision.allowed) {
            const fallback = policy.rezimOdepreni() === 'lokalne';
            policy.zaznamenej(decision, { provider: p, model: cloudModel, fallback });
            _countRequest('odepreno');
            if (!fallback) {
                const e = new Error('Cloud AI odepřen: ' + decision.duvody.join(' '));
                e.code = 'CLOUD_POLICY'; e.status = 403; e.decision = decision;
                throw e;
            }
            const local = Object.assign({}, params);
            if (process.env.LEXIS_CLOUD_FALLBACK_MODEL) local.model = process.env.LEXIS_CLOUD_FALLBACK_MODEL;
            const r = await _ollamaChat(local);
            if (r && typeof r === 'object') r.lexisCloud = { cloud: false, odepreno: true, provider: 'ollama', code: decision.code, duvody: decision.duvody };
            return r;
        }
        policy.zaznamenej(decision, { provider: p, model: cloudModel });
        let r;
        try {
            if (p === 'openai') r = await _openaiChat(params.messages, params.options);
            else if (p === 'anthropic') r = await _anthropicChat(params.messages, params.options);
            else if (p === 'bedrock') r = await require('./bedrock').chat(params.messages, params.options);
            else throw new Error('Neznámý poskytovatel AI: ' + p);
        } catch (cloudErr) {
            // Cloud nedostupný (síť, oprávnění, model nepovolen, výpadek AWS): dotaz dokončí lokální model —
            // dřív to skončilo „simulovanou“ odpovědí z fallbacku agenta (test rozhraní 29. 10. 2026).
            // Jen výpadek Bedrocku za běhu (HTTP chyba AWS, síť, časový limit). Chybné nastavení (region mimo EU,
            // chybějící klíč nebo model) dál vyhodí chybu — to se má opravit, ne tiše obcházet.
            const vypadek = p === 'bedrock' && /^Bedrock \d{3}:|fetch failed|aborted|abort|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|timeout/i.test(String(cloudErr.message || cloudErr.name));
            if (policy.rezimOdepreni() !== 'lokalne' || !vypadek) throw cloudErr;
            const fail = Object.assign({}, decision, { allowed: false, code: 'chyba_cloudu', duvody: ['Cloudový model je nedostupný (' + String(cloudErr.message).slice(0, 160) + ') — odpověděl lokální model.'] });
            policy.zaznamenej(fail, { provider: p, model: cloudModel, fallback: true });
            _countRequest('odepreno');
            const local = Object.assign({}, params);
            if (process.env.LEXIS_CLOUD_FALLBACK_MODEL) local.model = process.env.LEXIS_CLOUD_FALLBACK_MODEL;
            const lr = await _ollamaChat(local);
            if (lr && typeof lr === 'object') lr.lexisCloud = { cloud: false, odepreno: true, provider: 'ollama', code: 'chyba_cloudu', duvody: fail.duvody };
            return lr;
        }
        _countRequest('cloud');
        // Spotřeba tokenů a odhad ceny (živě) — ke spisům, ze kterých dotaz čerpal.
        const rec = usage.zaznamenej({ provider: p, model: (r && r.model) || cloudModel, usage: r && r.usage, spisIds: (decision.spisy || []).map(x => x.id) });
        policy.pridejNaklady(rec);
        return r;
    }
    if (p === 'openai') return _openaiChat(params.messages, params.options); // OpenAI-kompatibilní server v síti kanceláře
    return _ollamaChat(params);
}
async function embeddings(params) {
    params = params || {};
    const p = _embedProvider();
    _guardLocalOnly('embed', p);
    if (p === 'openai') {
        // Embeddingy počítáme z textu klientských dokumentů — veřejné API (bez EU regionu a smlouvy
        // kanceláře) jen s výslovným LEXIS_POVOLIT_PRIME_API=1 (testy se syntetickými daty).
        if (require('./cloud_policy').druhPoskytovatele('openai') !== 'lokalni' && !_truthy(process.env.LEXIS_POVOLIT_PRIME_API)) {
            throw new Error('Embeddingy přes veřejné OpenAI API jsou zakázané — text klientských dokumentů nesmí odejít mimo kancelář. Použijte lokální model (AI_EMBED_PROVIDER=ollama) nebo OpenAI-kompatibilní server v síti kanceláře (OPENAI_BASE_URL).');
        }
        return _openaiEmbeddings(params.prompt != null ? params.prompt : params.input);
    }
    if (p === 'anthropic' || p === 'bedrock') throw new Error(p + ' nemá embeddings API pro LexisLocal — vyhledávání zůstává lokální: AI_EMBED_PROVIDER=ollama.');
    return ollama.embeddings(params);
}
function providerInfo() { const c = assertLocalCompliance(); return { chat: c.chat, embed: c.embed, localOnly: c.localOnly, compliant: c.compliant }; }

module.exports = {
    chat: chat,
    embeddings: embeddings,
    providerInfo: providerInfo,
    assertLocalCompliance: assertLocalCompliance,
    // Průchod pro správu modelů (jen Ollama je má) — kdyby to někdo volal přes ai_provider.
    list: typeof ollama.list === 'function' ? ollama.list.bind(ollama) : undefined,
    pull: typeof ollama.pull === 'function' ? ollama.pull.bind(ollama) : undefined
};
