require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
// Doménová logika je vytažená do routes/*.js; server.js drží už jen bootstrap,
// autentizaci, montáž routerů, /api/status a background úlohy.
const { WATCH_DIR } = require('./lib/config');
const { loadAgents } = require('./lib/agents');
const HearingsWatcher = require('./lib/hearings');
const pairing = require('./lib/pairing'); // LexisLink párování (LAN)
const aiProvider = require('./lib/ai_provider'); // AI backend + pojistka mlčenlivosti (local-only)

// Preflight: varuj na nepodporovanou verzi Node.js (25+ opakovaně nativně padal).
// Jen varování, nikdy neblokuje běh.
require('./lib/node_check').warnIfUnsupported();

const app = express();
const PORT = process.env.PORT || 4000;
// Vazba na rozhraní: VÝCHOZÍ loopback (127.0.0.1) — bezpečné pro solo režim,
// nedostupné z LAN. Firemní/vícouživatelský režim vědomě nastaví BIND_HOST=0.0.0.0
// (nebo konkrétní IP) a MUSÍ zapnout vynucení tokenu + TLS.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

// API token je vždy k dispozici (z prostředí, jinak vygenerovaný a perzistovaný
// mimo datovou složku). VYNUCENÍ je nově ZAPNUTÉ VE VÝCHOZÍM STAVU — dashboard i editor
// si token berou automaticky, takže běžný uživatel nic nevkládá. Nouzový vypínač:
// spustit s LEXIS_ENFORCE_TOKEN=0 (jen pro lokální ladění).
const { resolveApiToken } = require('./lib/api_token');
const API_TOKEN = resolveApiToken();
const ENFORCE_TOKEN = process.env.LEXIS_ENFORCE_TOKEN !== '0';
if (ENFORCE_TOKEN && !process.env.API_TOKEN) {
    // Dashboard token dostane automaticky (vstřikuje se); editor si ho čte ze souboru.
    console.log(`🔑 Vynucení API tokenu ZAPNUTO (výchozí). Token pro editor: ${API_TOKEN}`);
    console.log('   Nouzové vypnutí: spusťte backend s LEXIS_ENFORCE_TOKEN=0');
} else if (!ENFORCE_TOKEN) {
    console.warn('⚠️  Vynucení API tokenu VYPNUTO (LEXIS_ENFORCE_TOKEN=0) — API je bez tokenu, jen pro lokální ladění.');
}

// --- CORS allowlist + ochrana proti DNS-rebindingu -----------------------------
// Wildcard CORS je nebezpečný: cizí web v prohlížeči jede přes loopback, takže by
// mohl číst odpovědi (a při vloženém tokenu ho ukrást). Povolujeme jen same-origin,
// loopback originy a Electron (Origin 'null'); ostatní bez CORS hlaviček → prohlížeč
// zablokuje čtení. Další originy přes LEXIS_CORS_ORIGINS (čárkou oddělené).
const _extraCorsOrigins = String(process.env.LEXIS_CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
function _isLoopbackHostname(h) { return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || (typeof h === 'string' && h.startsWith('127.')); }
function _corsOrigin(origin, cb) {
    if (!origin) return cb(null, true);            // same-origin / nativní fetch bez Origin
    if (origin === 'null') return cb(null, true);  // Electron file:// (editor)
    try { if (_isLoopbackHostname(new URL(origin).hostname)) return cb(null, true); } catch (e) {}
    if (_extraCorsOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);                         // cizí origin → bez ACAO
}
app.use(cors({ origin: _corsOrigin }));

// Ochrana proti DNS-rebindingu: v loopback režimu (výchozí) přijmeme jen požadavky
// s Host = localhost/127.* ; rebinding cizí domény na 127.0.0.1 pošle cizí Host → 403.
// V síťovém režimu (BIND_HOST != loopback) Host neřešíme (řídí síť/proxy/allowlist).
const _bindIsLoopback = _isLoopbackHostname(BIND_HOST);
const _allowedHosts = String(process.env.LEXIS_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
app.use((req, res, next) => {
    if (!_bindIsLoopback) return next();
    const host = String(req.headers.host || '').toLowerCase();
    const hostname = host.split(':')[0];
    if (_isLoopbackHostname(hostname) || _allowedHosts.includes(host) || _allowedHosts.includes(hostname)) return next();
    return res.status(403).json({ error: 'Neplatná hlavička Host (ochrana proti DNS-rebindingu).' });
});
// --- Bezpečnostní hlavičky (CSP + anti-clickjacking) ---------------------------
// Inline onclick/styly jsou v dashboardu všudypřítomné → script/style-src musí
// povolit 'unsafe-inline'. Zbytek ale zamykáme: connect-src omezuje, KAM může
// případné reziduální XSS odeslat data (jen self + lokální Ollama) → nelze token
// vyexfiltrovat na cizí server; object-src/base-uri/frame-ancestors = další obrana.
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'"
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Je požadavek z loopbacku (stejný stroj)? Jen tehdy je bezpečné vstříknout
// token přímo do HTML — přes LAN by to byl únik tokenu komukoli na síti.
// Pozn.: běžíme bez reverzní proxy, takže se díváme na skutečnou remoteAddress
// (ne na X-Forwarded-For, které lze podvrhnout). IPv4-mapped ::ffff:127.x počítáme taky.
const isLoopbackReq = (req) => {
    const a = (req.socket && req.socket.remoteAddress) || req.connection?.remoteAddress || '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.');
};

// HTML shell + (jen na loopbacku) vstříknutý API token. Přes LAN se servíruje
// čistý statický soubor bez tokenu — telefon si token dodá přes ⚙ Připojení
// nebo LexisLink párování. Musí být PŘED express.static.
const serveWithToken = (fileRelPath) => (req, res, next) => {
    try {
        const html = fs.readFileSync(path.join(__dirname, 'public', fileRelPath), 'utf8');
        // Token vložíme jen z loopbacku A jen když požadavek NENÍ cross-origin
        // (cizí web přes fetch posílá Origin → nedostane token, i když jede z loopbacku).
        const _o = req.headers.origin;
        let _sameOrigin = !_o;
        if (_o) { try { _sameOrigin = _isLoopbackHostname(new URL(_o).hostname); } catch (e) { _sameOrigin = false; } }
        if (!isLoopbackReq(req) || !_sameOrigin) return next(); // LAN/cross-origin → statika bez tokenu
        const inject = `<script>window.LEXIS_API_TOKEN=${JSON.stringify(API_TOKEN)};</script>`;
        res.type('html').send(html.includes('</head>') ? html.replace('</head>', inject + '</head>') : inject + html);
    } catch (e) {
        next();
    }
};
app.get(['/', '/index.html'], serveWithToken('index.html'));
app.get(['/m', '/m/', '/m/index.html'], serveWithToken(path.join('m', 'index.html')));
// Párovací stránka (QR) — jen loopback dostane vstříknutý token, kterým si vyžádá kód.
app.get(['/pair', '/pair.html'], serveWithToken('pair.html'));
app.use(express.static(path.join(__dirname, 'public')));

// ─── LexisLink párování ──────────────────────────────────────────────────────
// claim MUSÍ být PŘED authenticate: telefon token teprve získává, takže tento
// bootstrap endpoint token nevyžaduje. Bezpečnost stojí na tom, že kód je
// jednorázový, krátkodobý a náhodný (viz lib/pairing.js).
app.post('/api/pair/claim', (req, res) => {
    const token = pairing.claim(req.body && req.body.code);
    if (!token) return res.status(404).json({ error: 'Neplatný nebo expirovaný párovací kód.' });
    res.json({ token });
});

// --- Ochrana proti path traversal (sdílený helper) ---
const { safePathInWatchDir, sanitizeFileName } = require('./lib/pathsafe');

// Secure API Token Middleware — rozhodovací logika je v lib/auth.js (čistá,
// bezstavová, pokrytá testy). Vynucení je opt-in (ENFORCE_TOKEN, viz výše).
const { checkAuth } = require('./lib/auth');
const { resolvePrincipal } = require('./lib/principal');
const authenticate = (req, res, next) => {
    // Aditivně: určíme „kdo volá" (identita + scopy) pro budoucí per-user logiku.
    // Nemění rozhodnutí allow/deny níže — solo = implicitní uživatel s plnými právy.
    req.principal = resolvePrincipal(req, { apiToken: API_TOKEN, enforceToken: ENFORCE_TOKEN });
    if (!ENFORCE_TOKEN) return next();
    if (checkAuth(API_TOKEN, req).allowed) return next();
    console.warn(`🔒 Nepovolený přístup k API: ${req.method} ${req.path}`);
    return res.status(401).json({ error: "Přístup odepřen: Neplatný nebo chybějící API token." });
};

app.use(authenticate);

// Vytvoření párovacího kódu — ZA authenticate, takže o kód smí požádat jen
// klient s tokenem (v praxi dashboard/pair na loopbacku). Vrací kód + hotové
// URL do QR (http://<LAN-IP>:PORT/m?pair=<kód>). Token v odpovědi NENÍ.
app.post('/api/pair/new', (req, res) => {
    const { code, ttl } = pairing.createCode(API_TOKEN);
    res.json({ code, ttl, urls: pairing.buildUrls(PORT, code) });
});

// ─── Modulární routery (postupné rozbití monolitu) ───────────────────────────
// Domény se vytahují ze server.js do samostatných souborů v routes/.
app.use('/api/agents', require('./routes/agents'));
app.use('/api/document', require('./routes/document'));
app.use('/api/workflows', require('./routes/workflows'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/conflicts', require('./routes/conflicts'));
app.use('/api/judikatura', require('./routes/judikatura'));
app.use('/api/managerial', require('./routes/managerial'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/rag', require('./routes/rag'));
app.use('/api/readiness', require('./routes/readiness'));
app.use('/api/watcher', require('./routes/watcher'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/models', require('./routes/models'));
app.use('/api/system', require('./routes/system'));
app.use('/api/registry', require('./routes/registry'));
app.use('/api/registries', require('./routes/registries'));
app.use('/api/paperless', require('./routes/paperless'));
app.use('/api/email', require('./routes/email'));
app.use('/api/case', require('./routes/case'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/spisy', require('./routes/spisy'));
app.use('/api/citations', require('./routes/citations'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/lhutnik', require('./routes/lhutnik'));
app.use('/api/skartace', require('./routes/skartace'));
app.use('/api/fakturace', require('./routes/fakturace'));
app.use('/api/aml', require('./routes/aml'));
app.use('/api/agent', require('./routes/agent'));
app.use('/api/agent-swarm', require('./routes/agentSwarm'));
app.use('/api/agent-knowledge', require('./routes/agentKnowledge'));
app.use('/api/knowledge', require('./routes/knowledge')); // oborová báze (dělený RAG)

// Root Status
app.get('/api/status', (req, res) => {
    const agents = loadAgents();
    res.json({
        status: "online",
        project: "LexisLocal AI Ecosystem",
        version: "1.2.0",
        watcherDir: WATCH_DIR,
        activeAgents: Object.keys(agents),
        aiProvider: aiProvider.providerInfo() // { chat, embed, localOnly, compliant } — indikátor mlčenlivosti v UI
    });
});

// Spouštět kontrolu změn soudních jednání na pozadí (každou hodinu).
// Pod testy (JEST_WORKER_ID) NEspouštět — jinak timer drží event loop a jest
// nemůže korektně skončit. V produkci timer .unref(), ať nikdy neblokuje ukončení.
if (typeof process.env.JEST_WORKER_ID === 'undefined') {
    const _hearingsTimer = setInterval(() => {
        HearingsWatcher.checkAllHearings(WATCH_DIR).catch(err => {
            console.error("⚠️ Background monitored hearings check error:", err.message);
        });
    }, 60 * 60 * 1000);
    if (_hearingsTimer && typeof _hearingsTimer.unref === 'function') _hearingsTimer.unref();
}

const USE_HTTPS = process.env.USE_HTTPS === 'true';

const SSL_KEY_PATH = process.env.SSL_KEY_PATH || 'key.pem';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || 'cert.pem';

if (require.main === module) {
    // Pojistka mlčenlivosti: v lokálním/pilotním režimu (LEXIS_PILOT_LOCAL_ONLY)
    // NESMÍ běžet cloudový AI provider — jinak by klientská data (vč. RAG chunků)
    // odešla mimo stroj. Fail-fast: raději nenastartovat než tiše porušit mlčenlivost.
    const _aiComp = aiProvider.assertLocalCompliance();
    if (!_aiComp.compliant) {
        console.error('\n🛑 LOKÁLNÍ REŽIM (LEXIS_PILOT_LOCAL_ONLY) je zapnutý, ale AI je nastavené na CLOUD:');
        for (const v of _aiComp.violations) {
            console.error(`   • ${v.kind}: provider „${v.provider}" — klientská data by opustila stroj (mlčenlivost).`);
        }
        console.error('   Oprava: AI_CHAT_PROVIDER=ollama a AI_EMBED_PROVIDER=ollama (lokální model), nebo vypni LEXIS_PILOT_LOCAL_ONLY.');
        console.error('   Server se z bezpečnostních důvodů NESPUSTÍ.\n');
        process.exit(1);
    }
    if (_aiComp.localOnly) {
        console.log('🔒 Lokální režim mlčenlivosti AKTIVNÍ — AI běží jen lokálně (chat: ' + _aiComp.chat + ', embed: ' + _aiComp.embed + '). Klientská data neopouští stroj.');
    } else if (_aiComp.chat !== 'ollama' || _aiComp.embed !== 'ollama') {
        console.warn('⚠️  AI běží přes CLOUD (chat: ' + _aiComp.chat + ', embed: ' + _aiComp.embed + '). Pro advokátní mlčenlivost bez smlouvy o zpracování zapni LEXIS_PILOT_LOCAL_ONLY=1 (vynutí lokální Ollamu).');
    }

    // #6: Preflight modelů — hlasitě varuj, když role-model není v Ollamě stažený
    // (jinak agenti tiše spadnou na simulovaný fallback). Best-effort, neblokuje start.
    try {
        require('./lib/model_preflight').preflightModels().catch(() => {});
    } catch (e) { console.warn('⚠️ Preflight modelů se nepodařilo spustit:', e.message); }

    // IMAP příjem e-mailů (jen při přímém spuštění serveru; nikdy pod testy).
    try {
        const db = require('./lib/database');
        const imapIntake = require('./lib/imapIntake');
        const _getEmailSettings = () => { const l = db.get('email_settings') || []; return l[0] || {}; };
        const _pollMs = Math.max(60, parseInt((_getEmailSettings().imap_poll_minutes || 5), 10)) * 60 * 1000;
        imapIntake.startPolling(_getEmailSettings, _pollMs);
    } catch (e) { console.error('⚠️ IMAP poller se nepodařilo spustit:', e.message); }

    // Bezpečnostní pojistka: vazba na síť (ne-loopback) BEZ ochrany je nebezpečná —
    // API s klientskými daty by bylo na LAN dostupné komukoli. Hlasitě varujeme.
    const _isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(BIND_HOST);
    if (!_isLoopback) {
        if (!ENFORCE_TOKEN) {
            console.warn('\n🛑 NEBEZPEČNÁ KONFIGURACE: backend je vázán na ' + BIND_HOST + ' (dostupné ze sítě), ale VYNUCENÍ TOKENU JE VYPNUTÉ.');
            console.warn('   Kdokoli na síti může číst klientská data přes API. Nastavte LEXIS_ENFORCE_TOKEN=1 (a rozdejte token jen klientům).');
        }
        if (!USE_HTTPS) {
            console.warn('⚠️  Backend na síti BEZ TLS (USE_HTTPS != true) — data jdou po síti nešifrovaně. Pro firemní/LAN nasazení zapněte USE_HTTPS=true.');
        }
        if (ENFORCE_TOKEN && USE_HTTPS) {
            console.log('🔐 Síťové (LAN) nasazení s vynuceným tokenem i TLS — OK.');
        }
    }

    if (USE_HTTPS && fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH)) {
        try {
            const https = require('https');
            const sslOptions = {
                key: fs.readFileSync(SSL_KEY_PATH),
                cert: fs.readFileSync(SSL_CERT_PATH)
            };
            https.createServer(sslOptions, app).listen(PORT, BIND_HOST, () => {
                console.log(`🚀🔒 LexisLocal AI ZABEZPEČENÝ backend (HTTPS) běží na https://${BIND_HOST}:${PORT}`);
            });
        } catch (httpsErr) {
            console.error("❌ Nepodařilo se spustit HTTPS server, padám zpět na HTTP:", httpsErr.message);
            app.listen(PORT, BIND_HOST, () => {
                console.log(`🚀 LexisLocal AI backend běží na http://${BIND_HOST}:${PORT}`);
            });
        }
    } else {
        if (USE_HTTPS) {
            console.warn(`⚠️ V konfiguraci je vyžadováno HTTPS, ale chybí soubory certifikátu (${SSL_KEY_PATH} / ${SSL_CERT_PATH}). Spouštím na HTTP.`);
        }
        app.listen(PORT, BIND_HOST, () => {
            console.log(`🚀 LexisLocal AI backend běží na http://${BIND_HOST}:${PORT}`);
        });
    }
}

module.exports = app;
