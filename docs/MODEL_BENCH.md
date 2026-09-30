# Výběr modelu pro pilot — `model_bench.js`

Cíl: rozhodnout na datech, **který model poběží v pilotní kanceláři a na jakém hardwaru**.

Skript projede kandidátní modely (Ollama) přes 10 syntetických právních úloh se skutečnými
prompty agentů (`backend/prompts.json`) a pro každý model změří:

| Co | Jak |
|---|---|
| Kvalita | automatické kontroly: správná fakta (lhůty, §), `[Doplnit...]` místo vymyšlených údajů, žádná angličtina, validní JSON, odmítnutí neexistujícího § |
| Kvalita (volitelně) | známka 1–5 od silnějšího modelu-soudce (`--judge`) |
| Rychlost | tokeny/s, čas do první odpovědi, ⌀ doba úlohy, načtení modelu |
| Paměť | RAM/VRAM modelu podle `ollama ps` |

Výstup: tabulka v konzoli + `bench-results/model_bench_<čas>.md` (pořadí, nesplněné kontroly,
celé odpovědi k přečtení) a `.json`.

> ⚠️ Úlohy jsou **jen syntetické**. Do `backend/eval/model_bench.json` nikdy nedávat skutečné spisy —
> skript se pouští i v cloudu.

## Lokálně (Mac nebo PC kanceláře)

```bash
ollama serve                                  # musí běžet
npm run bench:models                          # výchozí kandidáti
npm run bench:models -- --models llama3,qwen2.5:7b,gemma3:12b
npm run bench:models -- --cpu                 # simulace PC bez grafické karty
npm run bench:models -- --only spisovatel     # jen úlohy jednoho agenta
```

## V AWS na GPU (z kreditu AWS Activate)

Jeden běh všech kandidátů + soudce trvá zhruba 1–2 hodiny na `g6.xlarge` (NVIDIA L4, 24 GB),
tj. řádově **jednotky dolarů**. Instance se po doběhnutí sama smaže.

1. **Kvóta GPU:** nové účty mívají limit 0 vCPU pro G instance. Service Quotas → EC2 →
   *Running On-Demand G and VT instances* → požádat o **8** v `eu-central-1`.
2. **S3 bucket** `lexislocal-bench-results-485237569555` (eu-central-1, bez veřejného přístupu) a
   **IAM role** pro EC2 s `s3:PutObject` do tohoto bucketu.
3. **Spuštění instance** (EC2 → Launch instance):
   - AMI: *Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu)*
   - Typ: `g6.xlarge`, disk 200 GB gp3, IAM role z bodu 2, key pair není potřeba
   - Advanced details → *Shutdown behavior* = **Terminate**, *User data* = obsah
     `scripts/aws/bench-gpu-userdata.sh`
4. Výsledky se objeví v S3 bucketu ve složce s datem (`.md` stáhnout a otevřít).

Pojistky: tvrdé vypnutí po 240 minutách (`MAX_MINUTES`), výsledky se ukládají průběžně po
každém modelu, log je v `/var/log/lexis-bench.log` (a nahraje se do S3).

## Režim se zdroji (`--rag`)

Test na 3B modelech ukázal, že **bez zdrojů si modely paragrafy vymýšlejí**. V aplikaci ale
Rešeršník odpovídá nad svou znalostní bází (`_kb_resersnik`). Režim `--rag` měří právě tohle:
ke každé úloze najde top pasáže v bázi agenta a přidá je modelu do systémového promptu.

1. **Stáhni zákony** z [e-Sbírky](https://e-sbirka.gov.cz) (občanský zákoník 89/2012,
   občanský soudní řád 99/1963, …) jako DOCX, případně ulož jako prostý text.
2. **Rozděl je po paragrafech** (každý § = jeden dokument s přesnou citací):
   ```bash
   node backend/scripts/split-zakon.js --in ~/Downloads/89-2012.docx --zkratka OZ \
        --cislo 89/2012 --nazev "občanský zákoník" --zneni 2026-09-01 --out ./zakony/OZ
   node backend/scripts/split-zakon.js --in ~/Downloads/99-1963.docx --zkratka OSŘ \
        --cislo 99/1963 --nazev "občanský soudní řád" --zneni 2026-09-01 --out ./zakony/OSR
   ```
   Nejdřív s `--dry-run` zkontroluj počet paragrafů a ukázku.
3. **Nahraj do báze Rešeršníka** (běží LexisLocal + Ollama s embedding modelem):
   ```bash
   node backend/scripts/seed-kb.js --agent resersnik --dir ./zakony/OZ
   node backend/scripts/seed-kb.js --agent resersnik --dir ./zakony/OSR
   ```
4. **Porovnej bez a se zdroji:**
   ```bash
   npm run bench:models -- --models llama3.2:3b
   npm run bench:models -- --models llama3.2:3b --rag
   ```
   Report se zdroji má v názvu `_rag` a u každé odpovědi vypisuje, které paragrafy dostala.

Přepínače: `--rag-k 3` (počet pasáží), `--rag-min` (minimální skóre shody, výchozí `RAG_MIN_SCORE` z `.env`).
Úloha může mít vlastní `ragScopes` (např. `["_kb_resersnik", "_kb_obor_…"]`).

### Se zdroji na GPU v AWS (`--kb-dir`)

Tvoje znalostní báze je šifrovaná jen na Macu, proto si srovnávač na instanci postaví
dočasný index z archivu `backend/eval/kb/zakony.tar.gz` (výstup `split-zakon.js`, veřejné
zákony). Dělení na úseky, embedding model (`bge-m3`) i hybridní skórování jsou stejné jako
v `lib/rag.js`. Archiv obnovíš po přidání dalších zákonů:

```bash
tar -czf backend/eval/kb/zakony.tar.gz -C zakony .
```

Ve `scripts/aws/bench-gpu-userdata.sh` pak `MODE="rag"` (jen se zdroji), `"plain"` nebo `"both"`.
Nastavení vyhledávání (`EMBEDDING_MODEL`, `RAG_HYBRID*`, `RAG_MIN_SCORE`) drž stejné jako v `.env`.
Lokálně jde totéž: `npm run bench:models -- --kb-dir ./zakony`.

## Jak číst výsledek

1. Vyřaď modely s kvalitou pod ~70 % nebo s chybou v úloze `halucinace-*` a `spisovatel-*`
   (vymyšlené údaje jsou pro advokáta nejhorší).
2. Z zbývajících vyber nejmenší, který na cílovém HW dává **≥ 15 tok/s** a ⌀ úlohu pod ~30 s.
3. Přečti si odpovědi v `.md` — automatické kontroly nezachytí styl ani jemné právní chyby.
4. Výsledek zapiš do `.env` pilotu: `CHAT_MODEL`, případně `DRAFT_MODEL` / `REVIEW_MODEL` / `FAST_MODEL`.

## Rozšíření sady úloh

Přidej případ do `backend/eval/model_bench.json`:

```json
{
  "id": "resersnik-muj-test",
  "agent": "resersnik",
  "prompt": "…",
  "reference": "co má správná odpověď obsahovat (dostane jen soudce)",
  "checks": {
    "mustInclude": [["alternativa A", "alternativa B"], ["§ 123"]],
    "mustNotInclude": ["regex, který se nesmí objevit"],
    "czech": true,
    "json": { "required": ["klíč"] },
    "maxWords": 200
  }
}
```
