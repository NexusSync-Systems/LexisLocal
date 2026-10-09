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

## Vyzkoušení na serverovém testu

User data serverového testu (šablona `lexis-kompletni`) doplnit o řádek před stažením skriptu:

```
export EMBED_MODEL_S3=s3://lexislocal-bench-results-485237569555/_models/lexis-bge-m3-ft/<běh>/
```

Server pak místo `bge-m3` použije doladěný model (cache vektorů se pro něj vypne).

## Licence

bge-m3: MIT. qwen2.5:7b (generování dotazů): Apache 2.0. Dotazy negeneruje žádná placená
služba, jejíž podmínky by trénink zakazovaly.
