#!/bin/bash
# =============================================================================
# LexisLocal — jednorázový benchmark modelů na GPU instanci v AWS (EC2 user-data)
#
# Vlož celý soubor do „Advanced details → User data“ při spuštění instance.
# AMI:       Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04/24.04)
# Instance:  g6.xlarge (NVIDIA L4, 24 GB VRAM), region eu-central-1 (Frankfurt)
# Disk:      200 GB gp3 (modely mají dohromady ~100 GB)
# Shutdown behavior: TERMINATE  → po skončení se instance sama smaže a neplatí se.
# IAM role:  s právem s3:PutObject do RESULTS_BUCKET (jinak výsledky zůstanou jen na disku).
#
# Instance se VŽDY vypne nejpozději po MAX_MINUTES (pojistka proti spálení kreditu).
# Do benchmarku nikdy nedávat skutečné klientské spisy — jen syntetická data.
# =============================================================================
set -uo pipefail

RESULTS_BUCKET="lexislocal-bench-results-485237569555"   # S3 bucket na výsledky ("" = nenahrávat)
MODELS=""                   # prázdné = výchozí kandidáti ze skriptu; jinak "llama3,qwen2.5:7b,…"
JUDGE="qwen2.5:32b"         # soudce (známka 1–5); "" = bez soudce
MAX_MINUTES=240             # tvrdý limit běhu instance
REPO="https://github.com/Zdenekdi/LexisLocal.git"

exec > >(tee -a /var/log/lexis-bench.log) 2>&1
echo "=== LexisLocal bench start $(date -Is)"

# 1) Pojistka: vypnout nejpozději za MAX_MINUTES (s TERMINATE = instance zmizí).
shutdown -h +"$MAX_MINUTES" "LexisLocal bench: časový limit"

finish() {
  echo "=== konec $(date -Is), vypínám za 2 minuty"
  if [ -n "$RESULTS_BUCKET" ] && [ -d /opt/bench-results ]; then
    cp /var/log/lexis-bench.log /opt/bench-results/ 2>/dev/null
    aws s3 cp /opt/bench-results "s3://$RESULTS_BUCKET/$(date +%Y-%m-%d_%H%M)/" --recursive || echo "!! upload do S3 selhal"
  fi
  shutdown -c 2>/dev/null; shutdown -h +2 "LexisLocal bench hotov"
}
trap finish EXIT

# 2) Ollama + Node.js 22
curl -fsSL https://ollama.com/install.sh | sh
systemctl enable --now ollama
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
for i in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
nvidia-smi || echo "!! nvidia-smi nenalezeno — běží to na GPU AMI?"

# 3) Repo (jen skript a sada úloh, žádné npm install není potřeba)
git clone --depth 1 "$REPO" /opt/LexisLocal
cd /opt/LexisLocal

# 4) Benchmark
ARGS=(--out /opt/bench-results --timeout 900)
[ -n "$MODELS" ] && ARGS+=(--models "$MODELS")
[ -n "$JUDGE" ]  && ARGS+=(--judge "$JUDGE")
node backend/scripts/model_bench.js "${ARGS[@]}"
echo "=== benchmark doběhl (exit $?)"
