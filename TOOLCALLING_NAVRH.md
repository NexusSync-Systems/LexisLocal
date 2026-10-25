# Návrh: tool-calling pro interní agenty (roj)

## Stav teď
Interní agenti (rešeršník, spisovatel, kontrolor, stylista, sekretářka) běží na
**RAG + system prompt + pár napevno zadrátovaných akcí** v orchestrátoru (lustrace IČO
regexem, kalendářový engine). Model si **nevybírá nástroje** — dostane RAG kontext a
napíše text. „Skills"/MCP nástroje (`mcp/lib/tools.js`, 11 tools) existují jen NAVENEK
pro externího Clauda (Cowork/Claude Code), ne pro interní roj.

Cíl: nechat interní agenty **samostatně volat nástroje** (např. rešeršník si zpřesní
`search_rag`, sekretářka založí `add_calendar_event`), s tvrdým gate dle oprávnění.

## Architektura

1. **Interní tool-registry** (`backend/lib/agent_tools.js`) — každý tool: `name`,
   `description`, `parameters` (JSON schema), `impl(args, ctx)` volající LIB PŘÍMO
   (bez HTTP/MCP round-tripu):
   - `search_rag` → `rag.searchSimilar`
   - `get_document` → `watcher`/inbox
   - `check_registry` → `registries.checkSubject`
   - `add_calendar_event` → kalendářový engine (navrhne; engine potvrdí — fail-closed)
   - `anonymize_text` → `anonymizer`
   Schémata a mapování se dají převzít z `mcp/lib/tools.js` (jen impl místo REST volání).

2. **Per-agent allow-list z `agent.permissions`** (bezpečnostní brána):
   - `read_files` → `search_rag`, `get_document`
   - `query_registries` → `check_registry`
   - `manage_calendar` → `add_calendar_event`
   - `write_desktop` → zápisové tools (upload/log) — až fáze 2
   Agentovi se do modelu pošlou JEN tools, na které má právo.

3. **Tool-loop** v `routes/agent.js` a v kroku orchestrátoru:
   ```
   for (i < MAX_TOOL_ITERS) {
     resp = ollama.chat({ model, messages, tools: allowed, options })
     if (!resp.message.tool_calls?.length) { final = resp.message.content; break }
     messages.push(resp.message)
     for (call of resp.message.tool_calls) {
       assertPermission(agent, call.name)         // druhá kontrola za běhu
       result = await execTool(agent, call.name, call.arguments)   // + validace schématu (zod)
       messages.push({ role:'tool', content: JSON.stringify(result) })
     }
   }
   ```
   Bounded (`MAX_TOOL_ITERS = 3`), plný fallback na dnešní bez-toolovou cestu při chybě.

4. **`ai_provider.chat`** — na ollama větvi propustit `params.tools` (dnes projde beze
   změny, jen doplnit tools do volání) a číst `message.tool_calls`. OpenAI/Anthropic
   větev má jiný tvar → mimo pilotní rozsah (pilot je stejně local-only).

5. **Přepínač** `AGENT_TOOLS=1` (default VYP) — opt-in, reverzibilní jako vše ostatní.

6. **Audit** — každé volání toolu do transparency ledgeru (AI Act). Zápisové tools
   navíc dvojitě gated (permission + potvrzení/engine).

## Rizika
- **3B model je na tool-calling slabý** — může halucinovat volání, zacyklit se nebo
  poslat vadné JSON argumenty. Mitigace: validace schématu, bounded loop, fallback.
  Reálně: na `qwen2.5:3b` to bude nespolehlivé → **tahle featura naplno dává smysl až
  s A1 (silnější/oddělené modely)**, hlavně na REVIEW/DRAFT tieru.
- **Zápisy přes rozhodnutí LLM** jsou v právní appce citlivé → pilot READ-ONLY.
- Dotýká se jádra (agent route + orchestrátor) → za přepínačem + testy.

## Rozsah (odhad)
- `lib/agent_tools.js` (registry + lib adaptéry): ~150 ř.
- permission→tools mapování: ~30 ř.
- tool-loop v agent.js: ~60 ř.; v orchestrátoru: ~40 ř.
- `ai_provider` tools pass-through: ~10 ř.
- testy (mock ollama vrací tool_calls; exec + gating + fallback): ~120 ř.
- env flag + dokumentace.
≈ **půlden práce, střední riziko** (jádro, ale za flagem).

## Doporučené fáze
- **Fáze 1 (pilot, nízké riziko):** READ-only tools (`search_rag` se zpřesněním,
  `get_document`, `check_registry`) za `AGENT_TOOLS=1`, pro rešeršníka + kontrolora +
  sekretářku(registry). Bounded loop, fallback, audit. Změřit, jestli 3B tools reálně
  používá.
- **Fáze 2 (po A1 / silnějších modelech):** zápisové tools (kalendář, upload) s
  potvrzením, pro spisovatele/sekretářku.

## Závěr
Technicky přímočaré (schémata i lib funkce existují), ale **největší efekt až po A1** —
na 3B je tool-calling nespolehlivý. Proto doporučuji A1 udělat dřív než Fázi 1, nebo je
udělat společně.
