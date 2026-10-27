#!/bin/bash
# User data pro ZÁTĚŽOVÝ den větší kanceláře — 10 lidí, 300 spisů, 350 příchozích písemností, tempo ×1,5 (profil kancelar, backend/scripts/office_day.js) s plnou bází.
# Spouští ho úloha aws_spust_test spouštěče (backend/scripts/task-runner.js) nebo ručně.
# Neobsahuje žádné tajné údaje; token si instance bere z SSM.
export PROFILE=kancelar
export OFFICE_HOURS=8
export OFFICE_DATASET=backend/eval/office_day/dataset-velka-v1.tar.gz
export OFFICE_INTENZITA=1.5
export OFFICE_UPLOAD_CONC=3
export OFFICE_EXTRA_MIN=90
export KB_ARCHIVE_S3=s3://lexislocal-bench-results-485237569555/_cache/kb-1.2.0.tar.gz
exec > >(tee -a /var/log/lexis-bootstrap.log) 2>&1
for i in $(seq 1 20); do
  curl -fsSL --retry 5 --retry-delay 5 https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/remote-office-userdata.sh -o /root/r.sh && break
  echo "bootstrap: stazeni selhalo (pokus $i), cekam 15 s"; sleep 15
done
[ -s /root/r.sh ] || { echo "bootstrap: skript se nestahl, vypinam"; shutdown -h now; exit 1; }
bash /root/r.sh
