# Instalační balíček znalostní báze

Báze rešeršníka (23 zákonů + judikatura NS, ÚS, NSS; ~30 tis. dokumentů, ~300 tis. pasáží)
se na novém počítači kanceláře naplní z **balíčku s hotovými vektory** — bez stahování ze
soudních webů a bez hodin počítání vektorů. Jen veřejná data (úřední díla), žádné spisy.

## Instalace v kanceláři (Mac mini)

1. Nainstalovat LexisLocal 1.2.0 a Ollamu s modelem `bge-m3` (stejný model jako v balíčku;
   `EMBEDDING_MODEL=bge-m3`). Ollama je potřeba jen pro texty, které v cache nejsou.
2. **Zastavit server LexisLocalu** (instalace zapisuje přímo do šifrované báze).
3. Z kořene aplikace:
   ```bash
   node backend/scripts/kb-balicek.js --info lexis-baze-2026-10-26.tar.gz      # co balíček obsahuje
   node backend/scripts/kb-balicek.js --instaluj lexis-baze-2026-10-26.tar.gz  # ~30 min
   ```
4. Spustit server. Báze se po startu načte na pozadí (~20 s), server mezitím odpovídá.

Instalace je **idempotentní** — po přerušení stačí spustit znovu, hotové dokumenty přeskočí.
Skript ověří kontrolní součet cache, model vyhledávání a velikost kousků; při nesouladu
upozorní (vektory se pak spočítají znovu — funguje, jen pomaleji). Nezašifrovaná cache se
rozbalí do dočasné složky a po instalaci se smaže; v bázi jsou data šifrovaná klíčem kanceláře.

## Sestavení balíčku (u nás)

```bash
# cache vektorů z posledního serverového testu (S3, ~1,2 GB)
aws s3 cp s3://lexislocal-bench-results-485237569555/_cache/embeddings-bge-m3.jsonl.gz scratch/kb-balicek/
node backend/scripts/kb-balicek.js --vytvor --out scratch/kb-balicek/lexis-baze-$(date +%F).tar.gz \
     --cache scratch/kb-balicek/embeddings-bge-m3.jsonl.gz
```

Přes spouštěč úloh: `aws_stahni_cache`, `kb_balicek_vytvor`, `kb_balicek_test`
(zkušební instalace do dočasné datové složky — skutečná báze se nemění).

Po měsíční aktualizaci judikatury: serverový test (profil `judikatura`) dopočítá vektory
nových rozhodnutí a uloží cache do S3 → nový balíček.
