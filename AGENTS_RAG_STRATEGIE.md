# Agenti LexisLocal — RAG vs. kontext (strategie)

Hodnocení jednotlivých AI agentů kanceláře a doporučení, kam u každého z nich
investovat: do **kvalitního RAG** (retrieval z judikatury / vlastní báze / spisů),
nebo do **úpravy kontextu** (system prompt, few-shot, model). Rozhodnutí je záměrně
**per-agent** — architektura to už umožňuje (každý agent má `knowledgeScope`,
`spisAccess`, `useJudikatura`, `preferredModel`).

> Rozhodovací pravidlo: **RAG se vyplatí jen tam, kde je úkol faktově ukotvený a
> korpus velký/měnící se. U úkolů typu „dovednost/styl/formát/routing" je páka
> model + prompt, ne retrieval.** Na malém lokálním modelu (3B) navíc platí, že
> šum z nepřesného RAG škodí víc než u velkého modelu → preferuj **přesnost**
> retrievalu před recall.

---

## Kontext, který rozhodnutí předurčuje

1. **Modelové tiery jsou složené do jednoho 3B modelu.** V `.env` je
   `CHAT_MODEL = DRAFT_MODEL = FAST_MODEL = REVIEW_MODEL = qwen2.5:3b`. Architektura
   je přitom navržená na tiering (`lib/agents.js` → `ROLE_MODEL`). Důsledek:
   **Kontrolor není nezávislý oponent** (běží na stejném modelu jako Spisovatel),
   a malý model je citlivý na šum v kontextu.
2. **Retrieval bez re-rankingu, tvrdý práh.** `nomic-embed-text` embeddingy, čistá
   kosinová podobnost, top-3, dřív hard `>= 0.70`. Na české právní texty je 0.70
   rizikově vysoko. → Zavedeno `RAG_MIN_SCORE` (viz „Provedené změny", default 0.60).
3. **Vlastní báze agentů jsou zpravidla prázdné.** Naplněná je jen judikatura
   (`backend/judikatura/`, ~2000 rozhodnutí), a to nerovnoměrně (viz níže).
   `_kb_spisovatel` / `_kb_stylista` / `_kb_kontrolor` se dnes nikde neplní.

---

## Doporučení po agentech

| Agent | Úkol | Primární páka | RAG | Kontext | Poznámka |
|---|---|---|---|---|---|
| 📚 **Rešeršník** | rešerše zákonů/judikatury | **RAG** | ★★★ | ★ | jediný agent, jehož hodnota = kvalita retrievalu |
| 📝 **Spisovatel** | tvorba dokumentů | hybrid | ★★ | ★★★ | prompt řeší strukturu; RAG jen vlastní vzory kanceláře |
| ⚖️ **Kontrolor** | oponentura, rizika | **model + prompt** | ★ | ★★★ | potřebuje JINÝ model než drafter, ne RAG |
| ✍️ **Stylista** | klonování stylu | **kontext (few-shot)** | ½ | ★★★ | styl z fixních ukázek v promptu, ne top-k retrieval |
| ⏰ **Sekretářka** | routing, kalendář | **prompt** | – | ★★★ | čisté následování instrukcí; RAG nedávat |

**📚 Rešeršník → RAG-first.** Prompt je dostatečný. Investovat do RAG: doplnit
prázdné obory judikatury, sjednotit taxonomii složek, přidat re-ranking
(cross-encoder nad top-20 → top-3), zapojit `citation_verifier.js`.

**📝 Spisovatel → hybrid, těžiště v kontextu.** Prompt (rozpoznání typu dokumentu,
zákaz vymýšlet §, `[Doplnit...]`) je nejlepší v systému a řeší strukturu i
antihalucinaci. Přínos RAG je úzký, ale reálný: `_kb_spisovatel` naplněný
**vlastními vzory a dřívějšími podáními** → few-shot dohledání vzoru.
`useJudikatura=false` je správně (§ řeší Rešeršník/Kontrolor).

**⚖️ Kontrolor → context-first + jiný model.** Jeho práce je uvažování, ne
vyhledávání. Dominantní páka: (a) **jiný/silnější model než Spisovatel**
(`REVIEW_MODEL`), (b) ostřejší prompt (checklist rizik, formát nálezů). Malá báze
typických vad pomůže, ale je druhotná.

**✍️ Stylista → context-first (few-shot).** Klonování stylu se dělá nejlíp
vložením hrstky reálných odstavců advokáta do promptu, ne sémantickým retrievalem.
`spisAccess=none` je správně.

**⏰ Sekretářka → prompt, bez RAG.** Routing + delegace + tón; kalendář je
deterministický engine. Investovat do promptu (pravidla delegace, strukturovaný
výstup úkolů) a nechat na FAST modelu. `useJudikatura=false`, `spisAccess=none`
správně.

---

## Provedené změny (bezpečná várka)

Commit obsahuje tři nízkorizikové úpravy + testy (23 testů zeleně: 2 nové sady +
`ragKnowledge`):

- **A2 — konfigurovatelný práh `RAG_MIN_SCORE`** (`lib/model_config.js`, default
  0.60; validace 0..1). Nahrazuje zadrátovaných `0.70` v `routes/agent.js`,
  `routes/agentSwarm.js`, `lib/orchestrator.js`. Test: `tests/ragMinScore.test.js`.
- **B1 — per-agent scope v orchestrátoru** (`lib/orchestrator.js`). `ChiefOrchestrator`
  dřív volal `searchSimilar` s holými `ragFilters` → agenti NEčerpali z vlastní KB
  ani judikatury (na rozdíl od přímých rout). Nově per krok `applyAgentScope`.
  Test: `tests/orchestratorAgentScope.test.js`.
- **B2 — RAG scope pro e-mailový vstup** (`lib/emailTask.js`). Volání
  `orchestrate(..., null)` doplněno o auto-detekci oboru z těla e-mailu
  (`obor_detect`) → obor + judikatura i pro automaticky zpracované e-maily.

### Várka 2 (kvalita výstupu agentů)

- **#4 — teplota per agent** (`lib/agents.js` + tři routy). Nové pole `temperature`
  s defaultem dle role (Rešeršník/Kontrolor 0.1, Spisovatel 0.2, Sekretářka 0.3,
  Stylista 0.5); helper `agentTemperature()`. Nahrazuje fixní 0.3/0.2 v
  `agent.js`, `agentSwarm.js`, `orchestrator.js`. Test: `tests/agentsTemperature.test.js`.
- **#2 — citační ověření v single-agent routě** (`routes/agent.js`). Po vygenerování
  výstupu běží `verifyCitationsWithSources` (dřív jen v orchestrátoru); vrací se
  `citationCheck`. Best-effort, chyba nezhodí odpověď.
- **#7 — KB-only retrieval** (`lib/orchestrator.js`). Retrieval povolen i agentovi
  bez přístupu ke spisům, pokud má vlastní `knowledgeScope` (čte JEN svou KB,
  `clientAccess:false`). Test: `tests/orchestratorKbOnly.test.js`.

### Várka 3 (provoz)

- **#6 — preflight modelů** (`lib/model_preflight.js` + hook v `server.js` +
  `GET /api/models/preflight`). Při startu porovná role-modely
  (CHAT/FAST/DRAFT/REVIEW/EMBEDDING) se seznamem z `ollama list` a hlasitě
  varuje u chybějících (vč. návrhu náhrady) — ať tichá degradace na simulovaný
  fallback není neviditelná. Nemutuje konfiguraci. Test: `tests/modelPreflight.test.js`.

Testy: 37 zeleně (6 sad).

### Várka 4 (kvalita výstupu — kritika→revize)

- **#3 — smyčka kritika→revize** (`lib/orchestrator.js`). Po dílčích krocích, má-li
  plán koncept od Spisovatele, Kontrolor ho oponuje (číslované vady, jinak
  „BEZ VÝHRAD") a Spisovatel vytvoří JEDNU revidovanou verzi, která jde do syntézy.
  Dřív se výstupy jen zřetězily a připomínky se nikam nezapracovaly. Bounded (1×),
  best-effort, přepínatelné `AGENT_REVISE_LOOP=0`. Nové pole `revision` ve výstupu
  (pro měření/UI). Nové logy v transparency ledgeru. Test: `tests/orchestratorReviseLoop.test.js`.

Testy: 40 zeleně (7 sad).

### Várka 5 (měření)

- **#8 — RAG-report** (`lib/rag_report.js` + `GET /api/system/rag-report`). Z transparency
  ledgeru spočítá per-agent: kolik % volání reálně dostalo aspoň jednu RAG pasáž,
  průměr zdrojů na volání a podíl simulovaného fallbacku (chybějící model). Dává tvrdá
  data pro rozhodnutí „kde se RAG vyplatí". `?days=N` omezí okno. Čistá funkce
  `buildRagReport()`. Test: `tests/ragReport.test.js`.

Testy: 45 zeleně (8 sad).

### Várka 6 (spolehlivost routingu)

- **#1 — deterministický router** (`lib/agent_router.js` + napojení v `orchestrator.decomposeQuery`).
  `sanitizeSteps()` očistí a zvaliduje kroky z LLM (zahodí neznámé agenty, doplní
  tier, ořízne na 1..4) — LLM výstup se dá bezpečně použít. `routeByIntent()` odvodí
  kroky z klíčových slov zadání, když LLM selže → fallback respektuje záměr (dřív
  slepý lineární plán). Test: `tests/agentRouter.test.js` (+ aktualizace `orchestrator.test.js`).

Testy: 56 zeleně (10 sad, cílené).

### Várka 7 (retrieval — opt-in)

- **#5 — hybridní retrieval** (`lib/rag.js`). `searchSimilar` umí blend sémantického
  a lexikálního skóre (`blendScore`), aby přesné tokeny (§, čísla zákonů, sp. zn.)
  neztrácely na váze proti embeddingům. **OPT-IN, default VYPNUTO** (`RAG_HYBRID=1`,
  váha `RAG_HYBRID_ALPHA`, default 0.7) — chování beze změny, dokud nezměříš přínos
  přes `rag_eval.js` a nezapneš. Po zapnutí dolaď `RAG_MIN_SCORE`. Test: `tests/ragHybrid.test.js`.

Testy: 67 zeleně (11 sad, cílené).

### Eval baseline (C2) + postup pro #5

Golden set nad reálnou judikaturou je hotový: **`backend/eval/rag_eval_judikatura.json`**
(10 dotazů odvozených z metadat konkrétních rozhodnutí, cílených na `_kb_obor_*`).
Měř takto (s běžící Ollamou, na svém stroji):

```
# 1) baseline (semantic)
node backend/scripts/rag_eval.js backend/eval/rag_eval_judikatura.json

# 2) hybrid
RAG_HYBRID=1 node backend/scripts/rag_eval.js backend/eval/rag_eval_judikatura.json

# 3) porovnej SOUHRN (hit-rate / recall@k / MRR); případně dolaď váhu
RAG_HYBRID=1 RAG_HYBRID_ALPHA=0.6 node backend/scripts/rag_eval.js backend/eval/rag_eval_judikatura.json
```

Pozn.: měří se jen obory, které jsou reálně naseedované (viz `naplnit-judikaturu.sh`);
celoobora-miss = spíš „nenaseedováno" než špatný retrieval. `RAG_HYBRID` zapni
natrvalo jen když se metriky zlepší, a pak dolaď `RAG_MIN_SCORE`.

Testy: 29 zeleně (5 sad). Zbývající nápady na agenty (router, kritika→revize
smyčka, hybridní retrieval, preflight modelů, RAG-report z transparency_logs) —
viz níže.

---

## Co zbývá (pořadí dle návratnosti)

1. **A1 — oddělit modelové tiery** (`.env`): dát Kontrolorovi `REVIEW_MODEL` ≠
   `DRAFT_MODEL` (např. `mistral`/`llama3.1:8b`, dle RAM). Bez tohoto je „nezávislý
   oponent" iluzorní. *(mění modely → na uživateli)*
2. **C2 — baseline eval**: spustit `lib/rag_eval.js` na ~20 reálných dotazech
   s očekávanými judikáty; měřit každou změnu proti němu (recall@k / MRR).
3. **C1 — over-fetch + re-rank** pro Rešeršníka (top-20 → re-rank `lexicalScore`
   → top-3). Levné, měřitelně zvedá MRR.
4. **D — korpus judikatury**: doplnit prázdné obory (Obchodní/korporátní, IP,
   Správní, Trestní) přes `naplnit-judikaturu.sh`; sjednotit dvě taxonomie složek
   (`judikatura/` vs `backend/judikatura/`).
5. **E — naplnit vlastní báze**: `seed-kb.js --agent spisovatel --dir <vzory>`;
   pro Stylistu spíš exempláře přímo do promptu.
