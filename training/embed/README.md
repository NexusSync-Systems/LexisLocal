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
- **gold** — 25 ručně psaných dotazů (`gold_queries.json`), ověřených proti textu zákonů.
- Měří se jen sémantické vyhledávání. LexisLocal k němu přidává lexikální složku (hybrid,
  α = 0,8), takže skutečný dopad ukáže až serverový test.

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
