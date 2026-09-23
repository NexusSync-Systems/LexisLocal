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

Testy: 37 zeleně (6 sad). Zbývající nápady: #1 router, #3 kritika→revize, #5 hybridní retrieval, #8 RAG-report.

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
