# Výměna embedding modelu za `bge-m3` (+ přeindexace)

Cíl: nahradit `nomic-embed-text` (na české právní texty slabý — v evalu semantic 0/10)
multilingválním `bge-m3`, který umí česky. Očekávání: sémantika vyskočí z nuly a
retrieval Rešeršníka se zvedne. Vše se spouští U TEBE (běžící Ollama).

## Kroky

1) **Stáhni model** (~1,2 GB):
```
ollama pull bge-m3
ollama list        # ověř, že bge-m3 je vidět
```

2) **Přepni embedding model v `.env`** (append, ať se nic nepřepíše):
```
cat >> .env <<'EOF'
EMBEDDING_MODEL=bge-m3
EOF
```

3) **Restartuj backend** (ať načte nový `.env`).

4) **Přeindexuj** (re-embeduje spisy i znalostní báze z uloženého textu novým modelem).
   Pozor na pořadí: DOKUD neproběhne, je sémantika mrtvá (staré nomic vektory mají
   jinou dimenzi → kosinus 0; hybrid jede zatím jen z lexikální složky).
   - Buď tlačítkem „Re-indexace" v dashboardu aplikace,
   - nebo přes API (token vypíše server při startu jako „Token pro editor: …"):
```
curl -X POST http://127.0.0.1:4000/api/rag/reindex-all -H "X-API-Token: <TVUJ_TOKEN>"
```
   Počkej, až doběhne (u velkých oborů to chvíli trvá — embeduje se každý chunk).

5) **Změř znovu** — jedním příkazem přes celý sweep (semantic + hybrid přes alphy):
```
node backend/scripts/rag_eval_sweep.js
```
   Vypíše srovnávací tabulku a označí nejlepší konfiguraci dle MRR. Porovnej se stavem
   na nomic (semantic 0 %, hybrid α=0.2 → MRR 0.231).

6) **Přelaď podle nových čísel** (bge-m3 sémantika bude nejspíš užitečná, takže optimum
   alphy se posune VÝŠ než 0.2):
   - alphu vybere už sweep z kroku 5 (řádek „nejlepší dle MRR"),
   - re-kalibruj práh s vybranou alphou (skóre se změní):
```
RAG_HYBRID=1 RAG_HYBRID_ALPHA=<vybrané> node backend/scripts/rag_score_probe.js
```
   - výsledné `RAG_HYBRID_ALPHA` a `RAG_MIN_SCORE` zapiš do `.env`.

## Rollback
Když by bge-m3 zhoršil výsledky nebo byl moc pomalý: v `.env` vrať
`EMBEDDING_MODEL=nomic-embed-text` a znovu proveď krok 4 (reindex).

## Pozn.
- Dimenze vektoru se mění (nomic 768 → bge-m3 1024); kód to zvládá (`cosineSimilarity`
  hlídá shodu délky), ale PROTO je reindex povinný — bez něj semantic vrací 0.
- `bge-m3` je pomalejší než nomic; pro dávkový reindex to nevadí, dotazy zůstávají svižné.
