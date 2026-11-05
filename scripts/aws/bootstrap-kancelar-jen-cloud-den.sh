#!/bin/bash
# User data pro CELODENNÍ simulaci kanceláře (7 h, profil kancelar) v REŽIMU JEN CLOUD — generálka pilotu na celý den
# (5. 11. 2026): stejné nastavení jako bootstrap-kancelar-jen-cloud.sh, delší den a po něm spisový eval na serveru.
# Rozpis: příprava ~35 min · simulace 7 h · pilotní test AWS, srovnání modelů, spis eval (~48 případů), kontrola rozhraní
# ~1,5–2 h → celkem ~9,5–10 h; nejpozději OFFICE_HOURS·60 + OFFICE_EXTRA_MIN + 60 min od začátku simulace se instance vypne.
# Původní hlavička:
# User data pro simulaci dne v kanceláři (3 h, profil kancelar) v REŽIMU JEN CLOUD: kancelář bez lokálního modelu —
# odpovídá jen Claude přes Amazon Bedrock v EU, vyhledávání běží v aplikaci (ONNX), Ollama se po kontrole shody vektorů zastaví.
# Server napojený na Claude přes Amazon Bedrock v EU
# (OFFICE_CLOUD=1: role instance, žádný klíč na disku; jen syntetická data). Roli lexis-bench-ec2 musí správce přidat
# politiku z scripts/aws/bedrock-eu-kancelar.yaml (docs/BEDROCK_EU.md).
# Spouští ho úloha aws_spust_test spouštěče (backend/scripts/task-runner.js) nebo ručně.
# Neobsahuje žádné tajné údaje; token si instance bere z SSM.
export PROFILE=kancelar
export OFFICE_HOURS=7
export OFFICE_CLOUD=1
export OFFICE_JEN_CLOUD=1
export OFFICE_EXTRA_MIN=150   # pilotní test proti AWS, srovnání modelů, spis eval, kontrola rozhraní
export OFFICE_SPIS_EVAL=1     # spis eval (backend/eval/spis_eval) přes Bedrock z role instance
export BEDROCK_MODEL_ID=eu.anthropic.claude-sonnet-4-6
# Generálka pilotu (1. 11. 2026): přeřazení přes Cohere Rerank 3.5 na Bedrocku (měření pilot-hledani: správný § 96,8 %),
# slovník hovorových pojmů, limit podle kvóty účtu (3 volání/min — při souběhu 10 lidí se část hledání obejde bez přeřazení).
export BEDROCK_RERANK_MODEL=cohere.rerank-v3-5:0
export BEDROCK_RERANK_RPM=3
export RAG_QUERY_TERMS=1
export RAG_RERANK_SPLIT=1
export KB_ARCHIVE_S3=s3://lexislocal-bench-results-485237569555/_cache/kb-1.2.0.tar.gz
exec > >(tee -a /var/log/lexis-bootstrap.log) 2>&1
for i in $(seq 1 20); do
  curl -fsSL --retry 5 --retry-delay 5 https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/remote-office-userdata.sh -o /root/r.sh && break
  echo "bootstrap: stazeni selhalo (pokus $i), cekam 15 s"; sleep 15
done
[ -s /root/r.sh ] || { echo "bootstrap: skript se nestahl, vypinam"; shutdown -h now; exit 1; }
bash /root/r.sh
