# CLAUDE.md — LexisLocal

Kontext pro Claude Code. LexisLocal je lokální AI ekosystém pro advokacii (Express API + Electron tray).
Hlavní části: `backend/server.js` (Express bootstrap, ~130 řádků — jen autentizace, montáž routerů,
`/api/status` a background úlohy), `backend/routes/*.js` (22 doménových routerů), `backend/lib/*`
(orchestrator, rag, watcher, ocr, anonymizer, database, audit, api_token, pathsafe, green_monitor…),
`backend/public/*` (dashboard), Docker compose (paperless-ngx + postgres + redis).
Sesterský projekt: **LexisEditor** (desktop editor).

Build/test: `npm run dev` (nodemon), `npm test` (jest), `npm run electron:dev`, `npm run dist:mac|win`.

---

## TODO / Známé problémy

### 🔵 Backlog (nápady na později)

- [ ] **Guided intake u generování dokumentů.** U obecného zadání (napr. „napis smlouvu o dilo")
  by agent (Spisovatel) mel NEJDRIV vest kratky intake — typ stran (FO / PFO / PO a jejich kombinace),
  predmet dila, cena, terminy, zaruka — a teprve pak generovat. Zvedne to kvalitu vic nez vetsi model
  a odstrani zaplavu [Doplnit...]. Vetsina prace je v agentnim promptu/orchestraci (backend) + chat UI
  v editoru. Funguje i na slabem HW.

- [x] **HOTOVO — Per-agent RAG + úrovně přístupu ke spisům.** Každý agent má vlastní
  IZOLOVANOU znalostní bázi `_kb_<id>` (rešeršník = judikatura/legislativa, spisovatel =
  vzory, kontrolor = checklisty…) — šifrovaná partition mimo klientské složky, takže se
  NEplete do obecného vyhledávání ani do `conflicts.js`/AML. `rag.js`:
  `indexKnowledge`/`deleteKnowledge`/`listKnowledge` (izolovaný round-trip), searchSimilar
  nově bere `filters.scopes` (přidá KB agenta) a `filters.clientAccess` (lze vypnout čtení
  klientských spisů). Registr KB scope zajišťuje přešifrování při rotaci klíče. Agent má
  pole **`knowledgeScope`** a **`spisAccess`** (`full`/`none`, default dle `permissions.read_files`
  — tím se konečně VYNUCUJE dřív jen deklarovaný `read_files`: Stylista bez přístupu už
  reálně nečte klientská data). `rag_request.applyAgentScope` sestaví efektivní filtr;
  napojeno v `routes/agent.js` a `routes/agentSwarm.js` (debata = sjednocené báze, přístup
  omezen když ho nemá kterýkoli účastník). Správa bází: `routes/agentKnowledge.js`
  (`GET/POST/DELETE /api/agent-knowledge/:agentId`). Skóre ani práh 0.70 se NEMĚNÍ (KB
  chunky se skórují stejně kosinově). Kryto `ragKnowledge.test.js` (13 testů). Vedlejší
  úklid: `rag_request` načítá `watcher` líně. **UI HOTOVO:** v editaci asistenta je panel
  „📚 Vlastní znalostní báze" (přidat/smazat dokument, `public/app-agent-kb.js` — samostatný
  soubor obalující `showAgentEditor`, bez zásahu do `app-agents.js`), a úroveň přístupu ke
  spisu řídí stávající checkbox „📂 Přístup ke spisům RAG" (= `read_files`, teď reálně
  vynucený přes `spisAccess`; doplněn vysvětlující popisek). Volá `/api/agent-knowledge/:id`.
  **Re-embedding bází:** `rag.reindexKnowledge(scope)`/`reindexAllKnowledge()` přepočítá
  vektory uložených KB chunků NA MÍSTĚ (KB nemají soubor, tak je `reindex-all` z inboxu
  míjel — teď je `POST /api/rag/reindex-all` zahrnuje). Per-agent `POST
  /api/agent-knowledge/:id/reindex` + tlačítko „🔄 Přegenerovat vektory" v panelu báze
  (nutné po změně embedding modelu / po přidání textu bez běžícího modelu). Kryto
  `ragReindexKnowledge.test.js` (mock embeddings, ověří přepis vektorů).
- [x] **HOTOVO — 3. úroveň přístupu `redacted` (anonymizovaný spis).** `spisAccess` nově
  `full` | `redacted` | `none`. Při `redacted` agent klientský spis ČTE, ale pasáže se
  před předáním do LLM anonymizují (`anonymizeText`) — vlastní znalostní báze (`scope=_kb_*`)
  zůstává beze změny. searchSimilar vrací u výsledků `scope` (KB vs klient = null),
  `applyAgentScope` řeší precedenci **none > redacted > full** (nejpřísnější napříč debatou
  vyhrává) a nastaví `redactClient`; anonymizaci aplikuje `agent.js` i `agentSwarm.js` jen
  na klientské pasáže. UI: v editaci asistenta místo checkboxu **select „Přístup ke spisům"**
  (Plný / Anonymizovaný / Žádný) — `app-agents.js` upraven, aby `spisAccess` ukládal.
  Skóre/práh 0.70 beze změny. Kryto testy v `ragKnowledge.test.js` (redacted precedence,
  scope pole). (Záloha `app-agents.js` před úpravou v `_to_delete/`.)
- [~] **Doladit RAG — CHUNKING hotovo, prahy/top-k záměrně ponechány.**
  ✅ **Chunking (`rag.js chunkText`) přepsán:** dlouhé odstavce (typické u smluv/podání)
  se dělí na věty místo jednoho obřího chunku → přesnější embeddingy a cílenější
  dohledání; mezi chunky je PŘEKRYV (fakt na hranici se neztratí); patologicky dlouhá
  „slova" bez mezer se sekají po znacích. Laditelné bez zásahu do kódu přes env
  `RAG_CHUNK_MAX_CHARS` (def. 700) a `RAG_CHUNK_OVERLAP_CHARS` (def. 120). Kryto
  `ragChunking.test.js` (7 testů). **Projeví se AŽ PO re-indexaci** existujících spisů:
  `POST /api/rag/reindex-all` (nové/změněné soubory se chunkují nově automaticky).
  ⚠️ **Top-k a prah podobnosti 0.70 jsem NEMĚNIL záměrně:** stejný práh a stejné
  kosinové skóre používá i `conflicts.js` (detekce střetu zájmů / AML) ve fail-closed
  režimu — změna škály skóre by tiše posunula, co se počítá jako „konflikt". Ladit prahy
  má smysl jen s měřením na reálných spisech (ground-truth), ne naslepo.
  ➡️ Zbývá (potřebuje reálná data/měření): re-index po změně chunkingu, případné
  doladění top-k a prahu, volba embedding modelu, prefixy nomic (`search_query:` /
  `search_document:` — vyžadují re-index a jsou model-specifické).


> 🏗️ **Připraveno pro firemní (multiuživatelský) režim — 4 švy (viz `ARCHITECTURE.md`):**
> (1) `lib/principal.js` — auth jako principal se scopy (solo = implicitní uživatel s plnými právy;
> `req.principal` aditivně); (2) `lib/store.js` — datová vrstva za rozhraním (`LEXIS_STORE=json|sqlite|postgres`,
> dnes deleguje na JSON); (3) `BIND_HOST` v `server.js` — VÝCHOZÍ loopback 127.0.0.1 (dřív bez hosta =
> vazba na 0.0.0.0/LAN — OPRAVENO), LAN jen vědomě + pak povinně token+TLS; (4) klíč přes `LEXIS_KEY_DIR`
> jako šev pro server-side klíč. Solo chování beze změny. Testy: `principal.test.js`, `store.test.js`.


> ✅ **Vyřešeno (orchestrator + GDPR):** RAG text z klientských spisů se do `transparency_logs`
> ukládá ANONYMIZOVANÝ (`anonymizeText` nad system promptem, hash z anonymizované verze); model
> nadále dostává plný kontext (kvalita zachována). Volba dle rozhodnutí: „jen v transparency_logs".
> ✅ **Vyřešeno (pipeline lhůt):** `watcher.js` i `paperless.js` nově deterministicky detekují lhůty
> v měsících/týdnech/letech (`detectDeadlines` + `calculateDeadlineByUnit`) a ukládají je do
> `detectedDeadlines[]` s `needsReview:true` (advokát potvrzuje; denní tok beze změny).


Seřazeno podle priority. Frontendové položky (LexisEditor) jsou v CLAUDE.md tamního repa.

### 🔴 Kritické (bezpečnost)

- [x] **HOTOVO — Klíč mimo data + AES-GCM.** Nový `backend/lib/secure_crypto.js` je jediný zdroj:
  klíč se ukládá do `~/.lexislocal/lexis.key` (0600) mimo `WATCH_DIR`, starý klíč od dat se při startu
  ZMIGRUJE (přesune) a z datové složky smaže. Šifrování je nově **AES-256-GCM** (autentizační tag →
  integrita); starý CBC formát se stále přečte (zpětná kompatibilita), nové zápisy jsou GCM (data se
  přemigrují při prvním uložení). Napojeno v `database.js` i `rag.js` (partitions). Umístění klíče lze
  přepsat přes `LEXIS_KEY_DIR`. Pokryto testy (round-trip, legacy CBC, detekce manipulace, migrace).

### 🟠 Vysoké

- [x] **HOTOVO — Zúžení sítě + auto-provisioning tokenu + vynucení ZAPNUTO ve výchozím stavu.**
  `backend/server.js` se váže na **`127.0.0.1`** (nedostupné z LAN; LAN jen vědomě přes `BIND_HOST`),
  CORS je omezený na localhost originy (+ požadavky bez Originu pro Electron) a je tu **Host-guard** proti
  DNS-rebindingu. Token je teď **vždy k dispozici**: `lib/api_token.js` ho vezme z `API_TOKEN`, jinak
  vygeneruje (`crypto.randomBytes(32).hex`) a perzistuje mimo data (`<keydir>/api_token`, 0600, atomicky).
  Dashboard ho dostane automaticky (vstřikuje se `window.LEXIS_API_TOKEN` před `express.static`), editor
  ho čte přímo ze souboru přes IPC (`get-lexislocal-token`). **Vynucení je nově výchozí ZAPNUTO** (nouzový vypínač `LEXIS_ENFORCE_TOKEN=0`; `ENFORCE_TOKEN`
  = `API_TOKEN` v env, nebo `LEXIS_ENFORCE_TOKEN=1`) — jádro je hotové, chybí jen reálný smoke test editoru
  (`LEXIS_ENFORCE_TOKEN=1`, spustit editor, vyzkoušet AI dotaz; nouzový vypínač `LEXIS_ENFORCE_TOKEN=0`)
  a pak přepnout na výchozí zapnuto. Pokryto testy (`apiToken.test.js`, `auth.test.js`).
  Přidán skript **`scripts/smoke-token.sh`**, který 401/200 ověří automaticky — zbývá ho jen spustit
  na Macu a otevřít editor s AI dotazem.

### 🟡 Střední

- [x] **HOTOVO — Startup pojistka + config.** `server.js` hlasitě varuje při vazbě na síť (BIND_HOST mimo loopback) bez vynuceného tokenu nebo bez TLS. `.env.example` doplněn o BIND_HOST, LEXIS_ENFORCE_TOKEN, LEXIS_KEY_DIR, LEXIS_STORE, USE_HTTPS, SSL_* aj. s bezpecnymi vychozimi.

- [x] **HOTOVO — Secrety z `docker-compose.yml`.** Hesla (`PAPERLESS_DB_PASSWORD`) a `PAPERLESS_SECRET_KEY`
  se načítají z `.env` (`${VAR:?...}` — bez nastavení `docker compose up` selže s hláškou). Přidán
  `.env.example`; `.env` je v `.gitignore`. (Historii commitů se starým heslem zvaž přepsat zvlášť.)

- [x] **HOTOVO — Šifrování auditního logu.** `.audit_log.json` se nově šifruje **AES-256-GCM** přes
  sdílený `secure_crypto` (stejný klíč jako DB, mimo `WATCH_DIR`); legacy plaintext se stále přečte a
  přemigruje při zápisu.

- [x] **Rozbít monolity — HOTOVO (server.js i dashboard).** `backend/server.js` je rozbitý z ~2254
  na ~130 řádků: všechny domény jsou v **22 routerech** v `backend/routes/*.js` (agents, document, workflows,
  audit, activity, conflicts, judikatura, managerial, alerts, rag, watcher, calendar, models, system,
  registry, registries, paperless, email, campaigns, inbox, agent, agentSwarm). Sdílené helpery vytažené do
  `lib/` (`pathsafe`, `rag_request`, `ollama_client`, `agent_fallback`, `api_token`). **Dashboard `backend/public/app.js` rozbit z 3942 na ~580 řádků** — 88 metod vytaženo do 7
  prototype-mixin modulů (`app-inbox`, `app-chat`, `app-alerts-audit`, `app-agents`, `app-calendar`,
  `app-managerial`, `app-email`), načítaných v `index.html` po `app.js`. Rozbití přes AST (@babel/parser)
  s kontrolou úplnosti, ověřeno `node --check` + vm-harnessem (prototyp má všech 96 metod).
  Pozn.: dashboard byl v jednu chvíli mrtvý (uklouzlá `}` uzavřela třídu předčasně) — opraveno a zajištěno
  regresním testem `frontend_syntax.test.js` (`node --check` nad `public/*.js`).

### 🟢 Nízké (hygiena)

- [x] **HOTOVO — Sjednotit verze.** `/api/status` v `server.js` nově čte verzi z `package.json`
  (jeden zdroj pravdy).

- [x] **HOTOVO — Oprava judikatura: ceske desetinne carky v compliance vzorech.** badPatterns pro smluvni pokutu matchovaly jen desetinnou TECKU (0.5%), ne ceskou CARKU (0,5%) → nesoulad v dolozce proklouzl neodhaleny. Opraveno na [.,] a doplnen rozsah 0,06–0,09 % (>0,05 %); mez 0,05 % zustava nekolizni. Testy.

- [x] **HOTOVO — Oprava timetracking: presny soucet hodin pro fakturaci.** Denni totalHours se scital z UZ zaokrouhlenych hodin po dokumentech (3x50s davalo 0.03 misto 0.04 hod) a zaval float sum (napr. 2.8500000000000001 hod ve vykazu klientovi). Nove se pocita z celkovych sekund a zaokrouhli jednou (totalHoursFromSummary). Guard na chybejici timestamp. Testy.

- [x] **HOTOVO — Mailer: vynuceni TLS.** Na STARTTLS ceste (587) chybelo requireTLS → pri SMTP serveru bez STARTTLS by se duverny e-mail poslal v PLAINTEXTU. Nove requireTLS=true jako vychozi (opt-out smtp_allow_insecure), konfigurace transportu vytazena do testovatelne buildTransportConfig + testy.

- [x] **HOTOVO — Oprava hearings: reschedule na budouci udalost.** Pri 'presunuti' jednani bral modul slepe udalosti[0]; API vsak muze vratit i minula jednani → hrozilo posunuti jednani do MINULOSTI, oznaceni 'past' a ukonceni hlidani = zmeskane jednani. Nove vybira nejblizsi BUDOUCI udalost a do minulosti neposouva. Vypadek API i prazdny seznam dal jednani neru​si (bezpecne). Pridan fetch-mock test pro dosud netestovany checkAllHearings.

- [x] **HOTOVO — Oprava conflicts: selhani vyhledavani != bezpecne.** Kdyz RAG vyhledavani selhalo (model offline), modul vracel riskLevel 'none' s popisem 'onboarding je bezpecny' — tj. nemoznost proverit se tvarila jako absence konfliktu. Nove pri selhani vraci riskLevel 'unknown' (konflikt nelze vyloucit, overit rucne) a priznak searchIncomplete; uspesne prazdne hledani dal vraci 'none'. Testy.

- [x] **HOTOVO — Oprava citation_verifier: prirazeni zakona k paragrafu.** Heuristika brala nejblizsi PREDCHAZEJICI zakon; u ceskeho pořadi '§ X zakona c. Y' s vice zakony priradila paragraf ke spatnemu (drivejsimu) zakonu → falesne 'neexistuje'/'overeno'. Zmeneno na nejblizsi zakon dle absolutni vzdalenosti (pokryva oba bezne zapisy). Doplneny testy.

- [x] **HOTOVO — Oprava anonymizeru (GDPR) + testy.** Pravidlo pro telefon bralo i penezni castky seskupene po tisicich (napr. castka v Kc se prepsala na [TELEFON]). Zuzeno na ceske telefonni prefixy [2-9] a s negativnim lookaheadem na menu/dalsi cislice — castky i spisove znacky zustavaji nedotcene, PII (e-mail, rodne cislo, telefon, jmeno) se dal rediguje. Pridan dedikovany `anonymizer.test.js`.

- [x] **HOTOVO — Behaviorální testy dashboardu.** XSS-kritický `escapeHtml` vytažen z `public/app.js`
  do `public/app-helpers.js` (jeden zdroj pravdy, načítá se před `app.js`) a pokryt testy
  `tests/appHelpers.test.js` (escapování, `<script>` payload, atributový breakout).

- [x] **HOTOVO — Rozšířené testy.** Přibyly testy kolem nových/kritických míst: `frontend_syntax.test.js`
  (`node --check` nad `public/*.js`), `pathsafe.test.js`, `mutex.test.js`, `ragRequest.test.js`,
  `hearings.test.js`, `apiToken.test.js`. Živé ARES testy jsou gatované (`RUN_LIVE_ARES`), aby CI nezávisel
  na síti.

---

## Nasazení / build (body 2 a 4)

- [x] **Onboarding Ollama (setup.js) vyladěn.** setup.js volí chat model dle RAM
  (`<=10 GB` → `qwen2.5:3b`, jinak `llama3`), lze přepsat `CHAT_MODEL`, zvolený model
  zapíše do `.env` (nepřepisuje existující). Stahuje embedding + chat model. Závěrečné
  pokyny nově zmiňují tray (`npm run electron:dev`) i nutnost běžící Ollamy.
- [x] **Jediný přepínač modelu — `backend/lib/model_config.js`.** `CHAT_MODEL`
  (default `llama3`) + `EMBEDDING_MODEL` (default `nomic-embed-text`). Nahradilo natvrdo
  zadané `"llama3"` na výchozích/fallback místech (orchestrator, agents, extraction,
  timetracking, routy activity/agentSwarm/agent/email). Bez env se chování nemění.
  `kontrolor` si ponechává `mistral` (záměrná diverzita). Kryto `modelConfig.test.js`.
- [x] **AI nezávislé na jednom backendu — `backend/lib/ai_provider.js`.** Jednotné
  rozhraní kompatibilní s knihovnou `ollama` (`chat`/`embeddings` stejné tvary), za nímž
  lze přes env přepnout na OpenAI (i OpenAI-kompatibilní servery: LM Studio, LocalAI) nebo
  Anthropic. Přepínače: `AI_PROVIDER` (společný), `AI_CHAT_PROVIDER`, `AI_EMBED_PROVIDER`
  (`ollama`|`openai`|`anthropic`). OpenAI: `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
  `OPENAI_CHAT_MODEL`, `OPENAI_EMBED_MODEL`. Anthropic (jen chat): `ANTHROPIC_API_KEY`,
  `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`. **Výchozí = Ollama, takže bez env se nic
  nemění** (local-first zůstává). Napojeno v `rag`, `extraction`, `orchestrator`,
  `timetracking` a routách `agent`/`agentSwarm`/`email`. Kryto `ai_provider.test.js`
  (11 testů, mock `fetch` + `ollama_client`, žádná síť). POZOR: přepnutí
  `AI_EMBED_PROVIDER` (jiný embedding model = jiná dimenze vektoru, nomic 768 vs.
  OpenAI 1536) vyžaduje REINDEX RAG archivu — staré a nové vektory nejsou srovnatelné.
  Model management (list/pull v UI) míří stále na Ollamu; `chat` s cloud providerem
  posílá obsah spisů mimo lokální stroj — pro citlivá data zvaž ponechání Ollamy.
- [x] **Build integrita: ikona opravena.** `assets/icon.png` byl JPEG přejmenovaný na
  `.png` (build ikon by selhal) → přeuložen jako skutečné PNG 1024×1024.
- [x] **`RELEASE_CHECKLIST.md`** — postup buildu/vydání, smoke test, bezpečnost, mezery.
  Pozn.: chybí `electron-updater` (žádný in-app auto-update).

### Bez dev účtů / bez podpisu (přidáno)
- [x] **Vynucení API tokenu ZAPNUTO ve výchozím stavu** (`server.js`: `ENFORCE_TOKEN =
  LEXIS_ENFORCE_TOKEN !== '0'`). Ověřeno, že dashboard (`getHeaders`) i editor
  (`getLexisLocalConnection`) posílají token na VŠECH `fetch` voláních → nic se nerozbije.
  Nouzový vypínač `LEXIS_ENFORCE_TOKEN=0`.
- [x] **Build bez podpisu:** `build.mac.identity=null` + `notarize=false`; `release.yml`
  má `CSC_IDENTITY_AUTO_DISCOVERY=false`. `INSTALL_UNSIGNED.md` = návod pro betatestery.
- [x] **CI:** `.github/workflows/ci.yml` (node --check + `npm test` při push/PR na ubuntu).
- Pozn.: lokální jest hlásí chybu jest-circus kvůli rozjetému `node_modules`
  (i `package-lock.json` je změněný) → spustit `npm ci` na Macu; CI dělá čistý install.

## Práce z cloudu přes most k Macu (doplněno 9/2026)
- Jest nejde spustit nad namountovanou složkou: resolver modulů padá přes FUSE mount (`jest-circus/build/runner.js ... was not found`), i když soubor existuje. Chyba tedy nemusí znamenat rozbité `node_modules`. Logiku ověřuj čistým `node` skriptem, plnou sadu (`npm test`) pusť na Macu nebo nech na CI.
- V testech je `NODE_ENV=test`, takže `secure_crypto.resolveKeyDir()` míří do temp. Klíč lze přebít `LEXIS_KEY_DIR`.
- Git příkazy, které zapisují do `.git` (commit, ale i `git status`), z cloudu nespouštěj, zůstane `index.lock`. Commit a push dělá Zdeněk na Macu.
- `.env` i `.env.*` (včetně záloh `.env.bak.*`) jsou v `.gitignore`, šablona `.env.example` zůstává trackovaná.
