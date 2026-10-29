#!/bin/bash
# User data pro simulaci dne v kanceláři (3 h, profil kancelar) se serverem napojeným na Claude přes Amazon Bedrock v EU
# (OFFICE_CLOUD=1: role instance, žádný klíč na disku; jen syntetická data). Roli lexis-bench-ec2 musí správce přidat
# politiku z scripts/aws/bedrock-eu-kancelar.yaml (docs/BEDROCK_EU.md).
# Spouští ho úloha aws_spust_test spouštěče (backend/scripts/task-runner.js) nebo ručně.
# Neobsahuje žádné tajné údaje; token si instance bere z SSM.
export PROFILE=kancelar
export OFFICE_HOURS=3
export OFFICE_CLOUD=1
export BEDROCK_MODEL_ID=eu.anthropic.claude-sonnet-4-6
export KB_ARCHIVE_S3=s3://lexislocal-bench-results-485237569555/_cache/kb-1.2.0.tar.gz
exec > >(tee -a /var/log/lexis-bootstrap.log) 2>&1
for i in $(seq 1 20); do
  curl -fsSL --retry 5 --retry-delay 5 https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/remote-office-userdata.sh -o /root/r.sh && break
  echo "bootstrap: stazeni selhalo (pokus $i), cekam 15 s"; sleep 15
done
[ -s /root/r.sh ] || { echo "bootstrap: skript se nestahl, vypinam"; shutdown -h now; exit 1; }
bash /root/r.sh
