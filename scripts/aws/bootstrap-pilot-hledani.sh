#!/bin/bash
# User data: měření vyhledávání v konfiguraci PILOTU JEN CLOUD na Macu (1. 11. 2026).
# Spouští ho úloha aws_spust_test spouštěče (backend/scripts/task-runner.js) nebo ručně.
# Neobsahuje žádné tajné údaje; token si instance bere z SSM, přístup k Bedrocku z role instance.
#   Původní bge-m3 (jako model v aplikaci na Macu), BEZ lokálního rerankeru, 5 pasáží; kb_regression navíc
#   měří přeřazení přes Amazon Bedrock Rerank v EU (Cohere Rerank 3.5 a Amazon Rerank 1.0) jako „☁️ Obecný
#   dotaz“ — do AWS jde jen dotaz a veřejné pasáže zákonů a judikatury (syntetické dotazy zlaté a odložených sad).
#   Role lexis-bench-ec2 potřebuje bedrock:Rerank a bedrock:InvokeModel na cohere.rerank-* / amazon.rerank-*
#   (scripts/aws/bedrock-eu-kancelar.yaml), Cohere navíc předplatné v Bedrock → Model access.
#   Srovnat s během 2026-10-31_0538_remote_judikatura (doladěný model + reranker na GPU).
export PROFILE=judikatura
export RERANK_JUD=0
export RAG_AGENT_K_JUD=5
export RAG_RERANK_SPLIT=1
export EMBED_MODEL_S3=none
export OFFICE_CLOUD=1
export KB_REG_PILOT=1
export RUN_SUITE=0
export KB_ARCHIVE_S3=s3://lexislocal-bench-results-485237569555/_cache/kb-1.2.0.tar.gz
exec > >(tee -a /var/log/lexis-bootstrap.log) 2>&1
for i in $(seq 1 20); do
  curl -fsSL --retry 5 --retry-delay 5 https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/remote-office-userdata.sh -o /root/r.sh && break
  echo "bootstrap: stazeni selhalo (pokus $i), cekam 15 s"; sleep 15
done
[ -s /root/r.sh ] || { echo "bootstrap: skript se nestahl, vypinam"; shutdown -h now; exit 1; }
bash /root/r.sh
