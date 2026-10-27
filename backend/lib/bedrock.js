/**
 * lib/bedrock.js — Claude přes Amazon Bedrock (Converse API) v EU, bez AWS SDK.
 *
 * Zapnutí (jen mimo lokální režim LEXIS_PILOT_LOCAL_ONLY):
 *   AI_CHAT_PROVIDER=bedrock
 *   BEDROCK_REGION=eu-central-1             # povinně EU region (eu-*)
 *   BEDROCK_MODEL_ID=eu.anthropic.claude-…   # EU inference profile (eu.*) nebo model přímo v regionu
 *   AWS přístup: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN),
 *                nebo ~/.aws/credentials (AWS_PROFILE, výchozí „default“)
 *   BEDROCK_MAX_TOKENS (4096), BEDROCK_TIMEOUT_MS (120000)
 *
 * ZÁMEK NA EU (rozhodnutí 10/2026, viz dokumentace pro kancelář): kód odmítne region mimo eu-*
 * a profily „us.“, „global.“, „apac.“ apod. — data klienta nesmí odejít mimo EU, i když by
 * to IAM v účtu dovolilo. Druhou pojistkou je SCP/IAM v účtu AWS kanceláře.
 * Konkrétní ID modelu se mění — vybírá ho kancelář podle konzole Bedrock (Model catalog).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVICE = 'bedrock';

function region() {
    const r = String(process.env.BEDROCK_REGION || process.env.AWS_REGION || '').trim();
    if (!/^eu-[a-z]+-\d$/.test(r)) throw new Error(`Bedrock: region „${r || '(nenastaven)'}" není v EU — povolené jsou jen eu-* (nastav BEDROCK_REGION, např. eu-central-1).`);
    return r;
}

/** ID modelu: EU inference profile „eu.…“, model v regionu („anthropic.…“) nebo ARN v EU regionu. */
function modelId() {
    const m = String(process.env.BEDROCK_MODEL_ID || '').trim();
    if (!m) throw new Error('Bedrock: chybí BEDROCK_MODEL_ID (EU inference profile, např. „eu.anthropic.claude-…“ z konzole Bedrock).');
    if (/^arn:aws:bedrock:/.test(m)) {
        if (!/^arn:aws:bedrock:eu-[a-z]+-\d:/.test(m)) throw new Error(`Bedrock: ARN modelu „${m}" není v EU regionu.`);
        return m;
    }
    // Modely, u kterých AWS ukládá VEŠKERÝ provoz až 30 dní (odhalování zneužití, možná ruční
    // kontrola AWS) — Claude Fable 5 / 5.1 (dokumentace Bedrock „Abuse detection“, 10/2026).
    // Pro advokátní mlčenlivost je odmítneme, pokud kancelář výslovně nepovolí BEDROCK_POVOLIT_UKLADANI=1.
    if (/fable[-_.]?5/i.test(m) && process.env.BEDROCK_POVOLIT_UKLADANI !== '1') {
        throw new Error(`Bedrock: model „${m}" AWS ukládá až 30 dní (odhalování zneužití) — pro spisy zvolte model Claude, který umožňuje nulové ukládání (data retention „none“), nebo vědomě nastavte BEDROCK_POVOLIT_UKLADANI=1.`);
    }
    if (/^eu\.[a-z0-9-]+\./.test(m)) return m;
    if (/^[a-z]{2,6}\./.test(m) && !/^(anthropic|amazon|meta|mistral|cohere|ai21|deepseek|openai|qwen|writer)\./.test(m)) {
        throw new Error(`Bedrock: profil „${m}" může směrovat mimo EU — použij EU profil („eu.…“).`);
    }
    return m; // model přímo v (EU) regionu
}

function _ini(file) {
    const out = {}; let sec = null;
    for (const raw of String(fs.readFileSync(file, 'utf8')).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const s = /^\[(.+)\]$/.exec(line);
        if (s) { sec = s[1].trim(); out[sec] = out[sec] || {}; continue; }
        const kv = /^([^=]+)=(.*)$/.exec(line);
        if (kv && sec) out[sec][kv[1].trim()] = kv[2].trim();
    }
    return out;
}

function credentials() {
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        return { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN || null };
    }
    const file = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
    const prof = process.env.AWS_PROFILE || 'default';
    if (fs.existsSync(file)) {
        const p = _ini(file)[prof];
        if (p && p.aws_access_key_id && p.aws_secret_access_key) {
            return { accessKeyId: p.aws_access_key_id, secretAccessKey: p.aws_secret_access_key, sessionToken: p.aws_session_token || null };
        }
    }
    throw new Error(`Bedrock: chybí přístup k AWS (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY nebo profil „${prof}" v ~/.aws/credentials).`);
}

const sha256 = d => crypto.createHash('sha256').update(d, 'utf8').digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
// RFC 3986 (AWS): vše kromě A–Z a–z 0–9 - _ . ~
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * AWS Signature V4. Vrací hlavičky k odeslání. `pathSegments` = nekódované části cesty.
 * Mimo S3 se segmenty v kanonické cestě kódují DVAKRÁT (dvojtečka v ID modelu → %253A),
 * v samotném požadavku jednou.
 */
function sign({ method, host, pathSegments, query = '', headers = {}, body = '', service, region: reg, creds, date = new Date() }) {
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const h = Object.assign({}, headers, { host, 'x-amz-date': amzDate });
    if (creds.sessionToken) h['x-amz-security-token'] = creds.sessionToken;
    const names = Object.keys(h).map(k => k.toLowerCase()).sort();
    const lower = {}; for (const k of Object.keys(h)) lower[k.toLowerCase()] = String(h[k]).trim().replace(/\s+/g, ' ');
    const canonPath = '/' + pathSegments.map(s => enc(enc(s))).join('/');
    const canonical = [method, canonPath, query, names.map(n => `${n}:${lower[n]}\n`).join(''), names.join(';'), sha256(body)].join('\n');
    const scope = `${day}/${reg}/${service}/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac('AWS4' + creds.secretAccessKey, day), reg), service), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
    const out = Object.assign({}, h, { authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` });
    delete out.host; // fetch doplní sám
    return { headers: out, path: '/' + pathSegments.map(enc).join('/'), signature, canonical };
}

/** Zprávy ve tvaru ollama → Converse (system zvlášť, sloučené po sobě jdoucí role). */
function toConverse(messages) {
    const system = (messages || []).filter(m => m.role === 'system').map(m => String(m.content || '')).filter(Boolean);
    const msgs = [];
    for (const m of (messages || []).filter(x => x.role !== 'system')) {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        const text = String(m.content == null ? '' : m.content);
        if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content.push({ text });
        else msgs.push({ role, content: [{ text }] });
    }
    if (!msgs.length || msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: [{ text: '.' }] });
    return { system: system.map(text => ({ text })), messages: msgs };
}

async function chat(messages, options = {}) {
    const reg = region(), model = modelId(), creds = credentials();
    const host = `bedrock-runtime.${reg}.amazonaws.com`;
    const conv = toConverse(messages);
    const inferenceConfig = { maxTokens: parseInt(process.env.BEDROCK_MAX_TOKENS || '4096', 10) };
    if (options && options.temperature != null) inferenceConfig.temperature = options.temperature;
    const body = JSON.stringify(Object.assign({ messages: conv.messages, inferenceConfig }, conv.system.length ? { system: conv.system } : {}));
    const s = sign({ method: 'POST', host, pathSegments: ['model', model, 'converse'], headers: { 'content-type': 'application/json' }, body, service: SERVICE, region: reg, creds });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), parseInt(process.env.BEDROCK_TIMEOUT_MS || '120000', 10));
    let res;
    try { res = await fetch(`https://${host}${s.path}`, { method: 'POST', headers: s.headers, body, signal: ctl.signal }); }
    finally { clearTimeout(t); }
    if (!res.ok) throw new Error(`Bedrock ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const content = ((data.output && data.output.message && data.output.message.content) || []).map(b => b.text || '').join('');
    return { message: { content }, model, usage: data.usage || null, stopReason: data.stopReason || null };
}

module.exports = { chat, sign, toConverse, region, modelId, credentials };
