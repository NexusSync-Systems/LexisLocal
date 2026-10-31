#!/bin/bash
# User data pro ZÁTĚŽOVÝ den větší kanceláře — 10 lidí, 300 spisů, 350 příchozích písemností, tempo ×1,5 (profil kancelar, backend/scripts/office_day.js) s plnou bází.
# Spouští ho úloha aws_spust_test spouštěče (backend/scripts/task-runner.js) nebo ručně.
# Neobsahuje žádné tajné údaje; token si instance bere z SSM.
export PROFILE=kancelar
# Noční zátěžový test (31. 10. 2026): kancelář 20 lidí (10 advokátů, 5 koncipientů, 5 asistentek), 1000 spisů,
# 3000 dokumentů při zavedení + 1000 během dne, 30 nových věcí. Den roztažený na 10 h, tempo práce ×3 (≈ 3 běžné dny),
# lokální model (qwen 7B), restart v poledne. Sleduje se i výkon v čase (K30) a paměť (pamet.log).
export OFFICE_HOURS=10
export OFFICE_GEN="--noc --spisy 1000 --onboarding 3000 --den 1000 --nove-spisy 30 --seed 20261031"
export OFFICE_INTENZITA=3
export OFFICE_UPLOAD_CONC=4
export OFFICE_EXTRA_MIN=180
export KB_ARCHIVE_S3=s3://lexislocal-bench-results-485237569555/_cache/kb-1.2.0.tar.gz
exec > >(tee -a /var/log/lexis-bootstrap.log) 2>&1
for i in $(seq 1 20); do
  curl -fsSL --retry 5 --retry-delay 5 https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/remote-office-userdata.sh -o /root/r.sh && break
  echo "bootstrap: stazeni selhalo (pokus $i), cekam 15 s"; sleep 15
done
[ -s /root/r.sh ] || { echo "bootstrap: skript se nestahl, vypinam"; shutdown -h now; exit 1; }
bash /root/r.sh
