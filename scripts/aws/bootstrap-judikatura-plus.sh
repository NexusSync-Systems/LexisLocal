#!/bin/bash
# User data pro serverový test verze 1.2.0 s plnou bází (profil judikatura).
# Spouští ho úloha aws_spust_test spouštěče (backend/scripts/task-runner.js) nebo ručně.
# Neobsahuje žádné tajné údaje; token si instance bere z SSM.
export PROFILE=judikatura
# K17 krok 1 (30. 10. 2026): konfigurace pilotu + vylepšení vyhledávání, srovnat s během 2026-10-26_1023_remote_judikatura.
#   doladěný vyhledávací model mix-0.3 (vektory báze se poprvé přepočítají, ~2,5 h na T4; pak cache v S3),
#   reranker bge-reranker-v2-m3 a 5 pasáží pro agenta. Paměť a rychlost → pamet.log, server_suite.
export RERANK_JUD=1
export RAG_AGENT_K_JUD=5
# K17 krok 2 (30. 10. odpoledne): přeřazení zákonů a judikatury zvlášť + slovník hovorových pojmů a zvýhodnění
#   zmíněného zákona; kb_regression měří i jednotlivé varianty na zlaté a odložené sadě.
export RAG_RERANK_SPLIT=1
export RAG_QUERY_TERMS=1
export EMBED_MODEL_S3=s3://lexislocal-bench-results-485237569555/_models/lexis-bge-m3-ft/2026-10-09_1451_embed_train/
export KB_ARCHIVE_S3=s3://lexislocal-bench-results-485237569555/_cache/kb-1.2.0.tar.gz
exec > >(tee -a /var/log/lexis-bootstrap.log) 2>&1
for i in $(seq 1 20); do
  curl -fsSL --retry 5 --retry-delay 5 https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/remote-office-userdata.sh -o /root/r.sh && break
  echo "bootstrap: stazeni selhalo (pokus $i), cekam 15 s"; sleep 15
done
[ -s /root/r.sh ] || { echo "bootstrap: skript se nestahl, vypinam"; shutdown -h now; exit 1; }
bash /root/r.sh
