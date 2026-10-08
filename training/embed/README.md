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
| 4 | `export_gguf.sh` | GGUF pro Ollamu + kontrola, že vektory v Ollamě sedí (kosinus > 0,99) | ~5 min |

Výsledek: `s3://lexislocal-bench-results-485237569555/_models/lexis-bge-m3-ft/<běh>/`
(`lexis-bge-m3-ft.gguf`, `Modelfile`, `report.md`, `metrics.json`). Log a report průběžně
v `s3://…/<běh>_embed_train/`.

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
