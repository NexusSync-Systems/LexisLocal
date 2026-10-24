# Serverový test verze 1.2.0 (plná báze s judikaturou)

Cíl: ověřit 1.2.0 na čistém stroji se **stejnou bází jako na Macu** (23 zákonů + judikatura
NS, ÚS, NSS; ~297 tis. pasáží) a s nastavením pilotu na Mac mini (bge-m3, bez rerankeru,
agent K=3). Výsledky:

- `kb_regression` na serveru (hit@1/3/5 zákonů, podíl judikatury v top 3, latence hledání),
- studený start a **paměť backendu s plnou bází** → podklad pro velikost RAM Mac mini (`pamet.log`),
- celý `server_suite` (A–Z, agenti 2×, zátěž, pokrytí API) + záloha se zkouškou obnovy.

Jen veřejná data (zákony, judikatura) a syntetické dotazy. Profil `judikatura` ve
`scripts/aws/remote-office-userdata.sh`.

## Postup

1. **Archiv báze** (z kořene repozitáře; Claude ho připravil do `scratch/aws-upload/kb-1.2.0.tar.gz`, ~145 MB):
   ```bash
   tar --exclude='.DS_Store' -czf scratch/aws-upload/kb-1.2.0.tar.gz zakony judikatura-ns judikatura-us judikatura-nss
   ```
2. **Nahrát do S3:** konzole S3 → bucket `lexislocal-bench-results-485237569555` → složka `_kb/`
   → Upload `kb-1.2.0.tar.gz` (nebo `aws s3 cp scratch/aws-upload/kb-1.2.0.tar.gz s3://lexislocal-bench-results-485237569555/_kb/`).
3. **Commit + push** větve `release-prep` (instance stahuje skript z GitHubu).
4. **Spustit instanci** jako u minulých testů: g6.xlarge, AMI Deep Learning Base OSS Nvidia Driver
   GPU (Ubuntu 22.04), **disk 200 GB**, Shutdown behavior TERMINATE, IAM role `lexis-bench-ec2`,
   security group bez příchozích pravidel (test běží přes loopback). User data: obsah
   `scratch/aws-upload/userdata-judikatura.sh`.
5. Výsledky v S3 `…/<datum>_remote_judikatura/` (průběžně každých 5 min): `lexis-remote.log`,
   `pamet.log`, `kb_regression.log` + `kb_regression_*.md`, `suite/*report.md`, `_zaloha.txt`.
   Instance se po testech sama vypne a smaže (nejpozději po 7 h).

## Na co se dívat

| Soubor | Co | Srovnání s Macem (24. 10.) |
|---|---|---|
| `kb_regression_*.md` | hit@3 agent mix, jen zákony, hledání p50 | 85 % · 87,5 % · 0,39 s |
| `pamet.log` | backend RSS po studeném startu a po testech | Mac: RSS 849 MB, načtení 18 s |
| `suite/*report.md` | nálezy podle závažnosti | 1.1.x: viz minulé reporty |

## Poznámky

- První běh počítá vektory celé báze na GPU (odhad 1–2 h) a cache (~1,5 GB) uloží do
  `_cache/embeddings-bge-m3.jsonl.gz`; další běh plní bázi z cache v minutách.
- Pokud role `lexis-bench-ec2` nemá čtení z `_kb/`, log ukáže „archiv báze … nejde stáhnout“
  a test poběží jen se zákony z repozitáře — pak přidat `s3:GetObject` na `…/_kb/*`.
- Proměnné pro jiný běh (v user data před `bash /root/r.sh`): `RERANK_JUD=1`, `RAG_AGENT_K_JUD=5`,
  `SUITE_REPEAT=1`, `EMBED_MODEL_S3=<doladěný model>`.
