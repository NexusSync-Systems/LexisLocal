# Plán: doučení jazykového modelu pro LexisLocal (K13)

_30. 10. 2026. Navazuje na hotové doladění vyhledávacího modelu (`training/embed/README.md`: bge-m3 → mix-0.3,
R@1 na zlaté sadě 66 → 71 %, s rerankerem 77 %, od 10. 10. výchozí na serveru)._

## Proč a co přesně

Lokální qwen2.5:7b dělá v rešerších chyby ve **formě**, ne ve znalostech: cituje paragraf, který v podkladech není
(zátěžový den 29. 10.: 28 citací „mimo podklady“ z 645, J1 12/20 — § 241/243 o. s. ř. místo § 2051 OZ),
přebírá vzor z promptu a neumí říct „v podkladech to není“. Tohle doučení (LoRA) opravuje dobře.
**Znalost práva se do modelu nedoučuje** — zastarala by s novelou; zákony a judikatura dál přicházejí z báze (RAG)
a citace hlídá ověřovač.

Cíl modelu `lexis-qwen:7b`:
1. citovat **jen** paragrafy a sp. zn. z dodaných pasáží, ve formátu „§ <číslo> <zkratka>“ / „sp. zn. …“;
2. když pasáže odpověď nedávají → „V dodaných podkladech to není…“ + co dohledat;
3. český právní styl kanceláře (stručně, závěr – důvody – zdroje).

## Hotovo, když (měřeno proti dnešnímu qwen2.5:7b na stejném serveru)

| Měřítko | Dnes | Cíl |
|---|---|---|
| J1 (20×) | 12/20 | ≥ 18/20 |
| citace mimo podklady (office_day, rešerše) | 28/645 (4,3 %) | ≤ 2 % |
| neověřené citace | 18/645 | nevzroste |
| `server_suite` + rešeršní sada `model_bench --rag` | — | žádné zhoršení, rešerše ≥ +5 bodů |
| odmítnutí „není v podkladech“ na sadě bez odpovědi | neměřeno | ≥ 80 % správně, ≤ 5 % zbytečných odmítnutí |
| rychlost (p50 rešerše) | 18–26 s | ± 10 % |

Nasadit jen když vyjde lépe ve všem a pak i v běhu `kancelar-3h`. Jinak zůstává qwen2.5:7b.

## Data (jen veřejné a syntetické — nikdy spisy klientů)

- **Dotazy:** hotové z `training/embed` (qwen dotazy k § + klientský styl + 124 ručních `gold_queries.json`),
  doplnit dotazy k judikatuře (právní věty NS/NSS/ÚS).
- **Kontext:** pasáže, které k dotazu skutečně vrací server (stejný RAG, mix-0.3, kousky 700 znaků) — včetně
  „rušivých“ sousedních paragrafů, aby se model naučil vybírat.
- **Cílové odpovědi — samoučení s filtrem (bez cizího modelu):** qwen2.5:7b napíše k dotazu 4–8 odpovědí,
  ponechá se ta, kde ověřovač citací (`citation_verifier`) najde všechny citace ověřené **a v podkladech**
  a cituje hledaný §. Zbytek se zahodí. ~3–5 tis. příkladů.
- **Negativní příklady (~15 %):** kontext bez hledaného § → cílová odpověď „v podkladech není“.
- **Odpovědi Clauda jako vzor: zatím NE.** Podmínky Anthropicu (platí i přes Bedrock) omezují použití výstupů
  k vývoji konkurenčních modelů — před případným použitím ověřit podmínky / právník.
- Odložit 10 % dotazů (jiné §) na test; J1 a zlatá sada se do tréninku nedávají.

## Trénink a balení

- Unsloth QLoRA nad `Qwen/Qwen2.5-7B-Instruct` (licence Apache 2.0 — ověřit u konkrétní verze, přiložit NOTICE),
  r = 16, 2 epochy, max. délka 4096 tokenů; g6.xlarge / g5.xlarge ~1–2 h.
- Sloučení LoRA → GGUF Q4_K_M (llama.cpp, jako `training/embed/export_gguf.sh`) → `Modelfile` se stejnou šablonou
  chatu jako qwen2.5 v Ollamě → `ollama create lexis-qwen:7b`; kontrola, že Ollama model načte a odpovídá.
- Výsledek do `s3://…/_models/lexis-qwen-ft/<běh>/` (gguf, Modelfile, report.md, metrics.json).
- Serverový test vybírá model proměnnou `CHAT_MODEL_S3` (obdoba `EMBED_MODEL_S3`).

## Kroky (soubory k vytvoření)

1. `training/llm/build_sft.py` — dotazy + kontext ze serverového RAG + samoučení s filtrem ověřovače → `sft.jsonl`.
2. `training/llm/train_lora.py` — QLoRA (Unsloth), uloží adaptér + sloučený model.
3. `training/llm/export_gguf.sh` — GGUF Q4_K_M, Modelfile, kontrola v Ollamě.
4. `training/llm/evaluate.py` — J1, sada „bez odpovědi“, rešeršní sada (volá `model_bench.js`) → `report.md`.
5. `scripts/aws/llm-train-userdata.sh` + profil spouštěče `llm_train` (instance se po skončení sama smaže).
6. Vyhodnocení → případně `kancelar-3h` s `CHAT_MODEL_S3` → rozhodnutí.

**Odhad:** 1 běh přípravy dat (~2 h GPU) + trénink (~1–2 h) + vyhodnocení (~1 h) ≈ 10–20 USD z kreditů AWS.

## Další krok u vyhledávání (souběžně)

Doladění bge-m3 zatím viděla jen zákony. Přidat páry **dotaz ↔ právní věta / odůvodnění** z judikatury NS/NSS/ÚS
(stejný postup jako `training/embed`, nová zlatá sada ~60 dotazů na judikaturu) — zlepší rešerše ve všech režimech
včetně cloudu.

## Údržba

Nová verze qwen / Ollamy = znovu doučit a otestovat (skripty jsou opakovatelné). Doučený model se šíří s balíčkem
báze / aktualizací, offline, s číslem verze v `Modelfile` a v kontrole připravenosti.
