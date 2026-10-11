# Doladění modelu vyhledávání (bge-m3) na českých zákonech

Cíl: aby rešeršník k dotazu advokáta našel správný paragraf OZ / OSŘ / ZOK častěji než
obecný `bge-m3`. Trénuje se jen na veřejných zákonech z `backend/eval/kb/zakony.tar.gz`,
**nikdy na klientských spisech**.

## Jak to běží

Na AWS jednou instancí, která se po skončení sama smaže (`scripts/aws/embed-train-userdata.sh`):

| Krok | Skript | Co dělá | Doba (g5/g6, odhad) |
|---|---|---|---|
| 1 | `build_pairs.py` | qwen2.5:7b napíše ke každému paragrafu 3 dotazy (bez čísla §); 8 % paragrafů se odloží na test | ~1–1,5 h (jen poprvé, pak z S3) |
| 2 | `train.py` | doladí BAAI/bge-m3, těžké negativy z původního modelu | ~20–40 min |
| 3 | `evaluate.py` | původní vs. doladěný model: R@1/5/10, MRR@10 | ~5 min |
| 1b | `build_pairs.py --style klient` | dotazy hovorovou řečí bez slov z textu (2 na §), max. 75 min, další běh naváže | ~75 min |
| 3b | `merge.py` + `choose_model.py` | prolnutí vah s původním modelem (w = 0,3/0,5/0,7), výběr nejlepšího podle zlaté sady + hybridu | ~15 min |
| 4 | `export_gguf.sh` | GGUF vybraného kandidáta pro Ollamu + kontrola, že vektory v Ollamě sedí (kosinus > 0,99) | ~5 min |

Výsledek: `s3://lexislocal-bench-results-485237569555/_models/lexis-bge-m3-ft/<běh>/`
(`lexis-bge-m3-ft.gguf`, `Modelfile`, `report.md`, `metrics.json`). Log a report průběžně
v `s3://…/<běh>_embed_train/`.

## Poučení ze 4. běhu (8. 10. 2026) → změny v 5. běhu

4. běh: na dotazech od qwenu (`test`) R@1 hybridu 67 % → 77 %, na ruční zlaté sadě 65 % → 64 %
(advokátský styl 79 % → 71 %). Model se naučil hlavně styl, jakým se ptá generátor (opisuje znění
zákona), a často přehazoval 1. a 2. místo u sousedních paragrafů. Proto v 5. běhu:

1. **klientské dotazy** (`--style klient`, filtr převzatých slov `--max-overlap 0.5`),
2. **těžké negativy bez sousedů** (±3 § téhož zákona) a bez skoro shodných textů (kosinus ≥ 0,92),
3. **prolnutí vah** s původním modelem; do GGUF jde kandidát s nejlepším MRR@10 na `gold+hybrid`
   (`chosen.json`; `better_than_base` říká, jestli vůbec porazil původní bge-m3).

Pozor: výběr podle zlaté sady ji trochu „opotřebuje“ — u hraničního výsledku ověřit serverovým testem.

## Hodnocení

- **test** — dotazy k paragrafům, které model při tréninku neviděl (poctivé měřítko).
- **gold** — 124 ručně psaných dotazů (`gold_queries.json`), ověřených proti textu zákonů;
  `styl` = `advokat` (odborně, hesly) nebo `klient` (běžnou řečí). Report je ukazuje i zvlášť.
- Ke každé sadě sémantika samotná i **hybrid** 0,8 × sémantika + 0,2 × lexikální shoda —
  stejné skóre jako server (`RAG_HYBRID=1`, `lexicalScore` z `backend/lib/rag.js`), jen nad
  celými paragrafy (server je dělí na kousky ~700 znaků). Plus čistě lexikální základ.
- Na konci reportu dotazy ze zlaté sady, kde se modely nejvíc liší — pro ruční rozbor.

### Srovnání bez tréninku (`scripts/aws/embed-eval-userdata.sh`)

Hotový doladěný model (GGUF z S3) proti `bge-m3`, oba v Ollamě jako na serveru. g4dn.xlarge
~20 min, výsledek v `s3://…/<běh>_embed_eval/report.md`. Model vybírá `FT_MODEL_S3`
(výchozí: běh `2026-10-06_1035_embed_train`).
Lokálně: `python3 evaluate.py --archive … --models bge-m3 lexis-bge-m3-ft --ollama http://127.0.0.1:11434`.

**Nasazovat jen když** doladěný model vyjde lépe na obou sadách a pak i v serverovém testu.

## Výsledky 5. běhu a nasazení (10. 10. 2026)

Vybrán `mix-0.3` (0,7 × bge-m3 + 0,3 × doladěný), hodnoceno s hybridem 0,8/0,2 jako na serveru:

| Sada | bge-m3 R@1 | mix-0.3 R@1 |
|---|---|---|
| zlatá (124 ručních dotazů) | 66,1 % (R@10 95,2) | **71,0 %** (R@10 97,6, MRR 0,807) |
| – styl advokát | 78,6 % | 82,1 % |
| – styl klient | 55,9 % | 61,8 % |
| odložené testovací dotazy | 67,0 % | 74,5 % |

Serverový test (profil kompletní, 2026-10-10_1625): 174/174 kontrol, agenti 68/68 včetně
rešerší R1/R4/X1, neověřené citace ~15 % (27/181) — beze změny nebo lépe než běhy 7–9.

**Od té doby je mix-0.3 výchozí** v `scripts/aws/remote-office-userdata.sh`
(`s3://…/_models/lexis-bge-m3-ft/2026-10-09_1451_embed_train/`). Přepnutí:

```
export EMBED_MODEL_S3=s3://lexislocal-bench-results-485237569555/_models/lexis-bge-m3-ft/<běh>/   # jiný běh
export EMBED_MODEL_S3=none                                                                          # původní bge-m3
```

Cache vektorů se ukládá zvlášť pro každý běh tréninku (`_cache/embeddings-lexis-bge-m3-ft_<běh>.jsonl.gz`),
takže se váhy různých běhů nepomíchají a od druhého spuštění se báze plní během minut.

## Váha hybridu a reranker (`rerank_eval.py`, 10. 10. 2026)

Mix-0.3 v Ollamě, celé paragrafy, R@1 (správný § na 1. místě):

| Sada | bez rerankeru (α 0,8) | bge-reranker-v2-m3, top 20, jen reranker | **mix 0,85 × reranker + 0,15 × hybrid** |
|---|---|---|---|
| zlatá | 70,2 % | 75,0 % | **77,4 %** |
| – advokát | 82,1 % | 82,1 % | 83,9 % |
| – klient | 60,3 % | 69,1 % | **72,1 %** |
| test | 72,3 % | 83,5 % | 83,5 % |
| test_klient | 32,5 % | 42,5 % | 43,2 % |

- α hybridu: u mix-0.3 je 0,75–1,0 v šumu → beze změny 0,8.
- Rychlost bge-reranker-v2-m3: T4 GPU ~0,2–0,3 s/dotaz, **CPU (4 vlákna) ~19 s** → jen s GPU / Apple Silicon.
- Backend: `lib/rerank_service.js` (fáze 2 k `lib/reranker.js`; VYPNUTO, zapíná `RAG_RERANK=1`).
  S `RAG_RERANK_URL` volá lokální službu `scripts/rerank_server.py` (CUDA / MPS / CPU, API jako
  llama.cpp `/v1/rerank`), bez URL běží v procesu přes ONNX q8 (`lib/reranker.js`). Mění jen pořadí,
  `score` a prahy zůstávají; chyba/timeout → původní pořadí. Serverový test: `export RERANK=1`.
- Rychlost na vlastním počítači: `scripts/rerank_bench.py`.

## Laboratoř vyhledávání (`search_lab.py`, 2. měření)

Měří jako server (kousky ~700 znaků s překryvem — přesný port `chunkText`, nejlepší kousek z §):
A) celé § / kousky / kousky s hlavičkou (zákon + § + nadpis), B) přepis dotazu qwen2.5:7b do právních
pojmů (jen přepis / spojený text / fúze skóre), C) rerankery bge-reranker-v2-m3, gte-multilingual-reranker-base,
mmarco-mMiniLMv2 — přesnost + rychlost GPU / CPU fp32 / CPU int8, D) přepis + reranker.
EC2: `scripts/aws/embed-lab-userdata.sh` (g4dn, ~30–45 min).

**1. běh (11. 10. 2026, mix-0.3, R@1 / MRR@10):**

| Členění | gold | gold_klient | test | test_klient |
|---|---|---|---|---|
| celé paragrafy | 70,2 % / 0,803 | 60,3 % / 0,726 | 74,7 % / 0,826 | 35,3 % / 0,450 |
| kousky 700 znaků (= server) | 66,1 % / 0,774 | 57,4 % / 0,701 | 73,7 % / 0,822 | 33,0 % / 0,431 |
| kousky 700 + hlavička | 66,1 % / 0,782 | 57,4 % / 0,706 | 72,0 % / 0,813 | 33,7 % / 0,433 |

- Server kvůli dělení na 700 znaků ztrácí ~4 body na zlaté sadě → 2. běh měří i kousky 1200 / 2000 znaků.
- Přepis dotazu qwen2.5:7b **škodí** všude (gold 66 → 61 % i ve fúzi; přepisy jsou nepřesné, vymýšlí
  zákony) a stojí ~1,1 s → nepoužívat.
- Rerankery v 1. běhu nenaběhly (sentence-transformers 6 + starší huggingface_hub) → opraveno, 2. běh `LAB_ARGS=--skip-rewrite`.

**2. běh (11. 10. 2026, 2026-10-11_1531_embed_lab):**

| | gold | gold_klient | test | test_klient |
|---|---|---|---|---|
| kousky 1200 znaků | 68,5 % | 57,4 % | 74,0 % | 35,0 % |
| kousky 2000 znaků | 69,3 % | 58,8 % | 74,7 % | 35,3 % |
| + bge-reranker-v2-m3, mix 0,85 (top 20) | **76,6 %** | **70,6 %** | **83,3 %** | **44,0 %** |
| + mmarco-mMiniLMv2, mix 0,85 | 73,4 % | 63,2 % | 77,7 % | 32,7 % |
| + gte-multilingual-reranker-base, mix 0,85 | 62,9 % | 50,0 % | 64,3 % | 32,7 % |

Rychlost na dotaz (20 kousků po ~2000 znacích): bge GPU T4 0,21 s / CPU 4 vlákna 74 s; mmarco 0,03 s / 1,5 s;
gte 0,09 s / 21 s. Mac (MPS, kousky ~500 znaků, `scripts/rerank_bench.py`): bge 1,2 s, mmarco 0,17 s.

Závěr: báze zákonů na kousky 2000 znaků (`RAG_KB_CHUNK_MAX_CHARS`, výchozí od 11. 10. 2026);
GPU server → bge-reranker-v2-m3; Mac → bge nebo mmarco; jen CPU → mmarco; gte nepoužívat (zhoršuje).

## Licence

bge-m3: MIT; bge-reranker-v2-m3, gte-multilingual-reranker-base, mmarco-mMiniLMv2: Apache 2.0. qwen2.5:7b (generování dotazů): Apache 2.0. Dotazy negeneruje žádná placená
služba, jejíž podmínky by trénink zakazovaly.
