#!/bin/bash
# =============================================================================
# LexisLocal — srovnání modelů vyhledávání (bge-m3 vs. doladěný) BEZ tréninku (EC2 user-data)
#
# Oba modely běží v Ollamě jako na serveru (doladěný = GGUF z S3), hodnotí se:
#   - zlatá sada (training/embed/gold_queries.json, 124 ručních dotazů, styl klient / advokát),
#   - odložené testovací dotazy (s3://…/_training/embed/pairs/pairs_test.jsonl),
#   - sémantika samotná i hybrid 0,8 × sémantika + 0,2 × lexikální shoda (jako RAG_HYBRID na serveru).
# Výsledek: s3://lexislocal-bench-results-485237569555/<běh>_embed_eval/ (report.md, metrics.json, log).
#
# Spuštění: g4dn.xlarge (s GPU ~20 min). Jde i bez GPU (c7i.2xlarge apod., Ollama na CPU, ~1 h).
#           AMI Deep Learning Base OSS Nvidia Driver GPU (Ubuntu 22.04), disk 60 GB,
#           Shutdown behavior TERMINATE, IAM lexis-bench-ec2. Síť: žádné příchozí porty.
# User data:  #!/bin/bash
#             export FT_MODEL_S3=s3://lexislocal-bench-results-485237569555/_models/lexis-bge-m3-ft/<běh>/   (volitelné)
#             curl -fsSL https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/embed-eval-userdata.sh -o /root/e.sh && bash /root/e.sh
# Data: jen veřejné zákony z repozitáře. Žádné klientské spisy.
# =============================================================================
set -uo pipefail
export HOME="${HOME:-/root}"

RESULTS_BUCKET="lexislocal-bench-results-485237569555"
REPO="https://github.com/NexusSync-Systems/LexisLocal.git"
BRANCH="${BRANCH:-release-prep}"
FT_MODEL_S3="${FT_MODEL_S3:-s3://$RESULTS_BUCKET/_models/lexis-bge-m3-ft/2026-10-06_1035_embed_train/}"
BASE_MODEL="${BASE_MODEL:-bge-m3}"
FT_NAME="lexis-bge-m3-ft"
MAX_MINUTES="${MAX_MINUTES:-120}"

RUN_ID="$(date +%Y-%m-%d_%H%M)_embed_eval"
S3_DEST="s3://$RESULTS_BUCKET/$RUN_ID/"
S3_PAIRS="s3://$RESULTS_BUCKET/_training/embed/pairs/"
OUT=/opt/embed-eval; WORK=/opt/embed-eval-work
mkdir -p "$OUT" "$WORK"
exec > >(tee -a /var/log/lexis-embed-eval.log) 2>&1
echo "=== LexisLocal embed-eval start $(date -Is)"
if [ -f "$OUT/_run_id" ]; then echo "=== opakovaný start → vypínám"; shutdown -h +1; exit 0; fi
echo "$RUN_ID" > "$OUT/_run_id"
shutdown -h +"$MAX_MINUTES" "LexisLocal embed-eval: časový limit"

AWS=$(command -v aws || true)
if [ -z "$AWS" ]; then apt-get update -qq && apt-get install -y -qq awscli || snap install aws-cli --classic || true; AWS=$(command -v aws || true); fi
upload() {
  [ -n "$AWS" ] || return 0
  cp /var/log/lexis-embed-eval.log "$OUT/" 2>/dev/null
  "$AWS" s3 cp "$OUT" "$S3_DEST" --recursive --only-show-errors || echo "!! upload selhal $(date -Is)"
  return 0
}
( while sleep 300; do upload; done ) & SYNC_PID=$!
finish() { kill "$SYNC_PID" 2>/dev/null; upload; shutdown -h +1 "LexisLocal embed-eval: hotovo"; }
trap finish EXIT
nvidia-smi --query-gpu=name,memory.total --format=csv 2>/dev/null | tee "$OUT/_gpu.txt" || echo "bez GPU (Ollama poběží na CPU)" | tee "$OUT/_gpu.txt"

# 1) Kód
git clone --depth 1 -b "$BRANCH" "$REPO" /opt/LexisLocal
cd /opt/LexisLocal
echo "commit: $(git rev-parse --short HEAD) — $(git log -1 --format='%s (%ci)')" | tee "$OUT/_version.txt"
ARCH=/opt/LexisLocal/backend/eval/kb/zakony.tar.gz
T=/opt/LexisLocal/training/embed

# 2) Python: stačí numpy (vektory počítá Ollama)
export DEBIAN_FRONTEND=noninteractive
python3 -c "import numpy" 2>/dev/null || { apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq python3-numpy >/dev/null 2>&1 || python3 -m pip install -q numpy; }
python3 -c "import numpy; print('numpy', numpy.__version__)" || { echo "!! numpy chybí"; exit 1; }

# 3) Ollama + oba modely
curl -fsSL https://ollama.com/install.sh | sh
mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment=OLLAMA_NUM_PARALLEL=2\nEnvironment=OLLAMA_MAX_LOADED_MODELS=2\n' > /etc/systemd/system/ollama.service.d/override.conf
systemctl daemon-reload; systemctl enable --now ollama; systemctl restart ollama
for i in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
for t in 1 2 3; do
  curl -sf http://127.0.0.1:11434/api/pull -d "{\"model\":\"$BASE_MODEL\",\"stream\":false}" >/dev/null && { echo "model $BASE_MODEL stažen"; break; }
  echo "!! stažení $BASE_MODEL selhalo (pokus $t)"; sleep 15
done
# Role nemá s3:ListBucket → konkrétní soubor (stačí s3:GetObject).
FT="${FT_MODEL_S3%/}"
mkdir -p "$WORK/ft" && "$AWS" s3 cp "$FT/lexis-bge-m3-ft.gguf" "$WORK/ft/" --only-show-errors \
  && printf 'FROM ./lexis-bge-m3-ft.gguf\n' > "$WORK/ft/Modelfile" \
  && ( cd "$WORK/ft" && ollama create "$FT_NAME" -f Modelfile ) \
  && echo "=== doladěný model z $FT_MODEL_S3" | tee "$OUT/_models.txt" \
  || { echo "!! doladěný model se nepodařilo načíst z $FT_MODEL_S3"; exit 1; }
"$AWS" s3 cp "$FT/metrics.json" "$OUT/train_metrics.json" --only-show-errors 2>/dev/null || true

# 4) Testovací dotazy z tréninku (odložené paragrafy) — bez nich se hodnotí jen zlatá sada
mkdir -p "$WORK/pairs"
"$AWS" s3 cp "${S3_PAIRS}pairs_test.jsonl" "$WORK/pairs/pairs_test.jsonl" --only-show-errors 2>/dev/null \
  && echo "=== testovací dotazy: $(wc -l < "$WORK/pairs/pairs_test.jsonl")" || echo "!! testovací dotazy nejsou — jen zlatá sada"

# 5) Srovnání
echo "=== hodnocení start $(date -Is)"
python3 "$T/evaluate.py" --archive "$ARCH" --pairs "$WORK/pairs" --models "$BASE_MODEL" "$FT_NAME" \
  --ollama http://127.0.0.1:11434 --batch 16 --report "$OUT" || { echo "!! hodnocení selhalo"; exit 1; }
echo "=== hotovo $(date -Is)"
