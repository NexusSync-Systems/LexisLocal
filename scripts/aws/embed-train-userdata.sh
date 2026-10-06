#!/bin/bash
# =============================================================================
# LexisLocal — doladění modelu vyhledávání (bge-m3) na českých zákonech (EC2 user-data)
#
# Postup (vše na jedné GPU instanci, pak se sama vypne a smaže):
#   1) lokální qwen2.5:7b napíše k paragrafům OZ/OSŘ/ZOK dotazy advokáta (training/embed/build_pairs.py)
#      — dotazy se uloží do S3, další běh je použije znovu (generování se neopakuje),
#   2) doladění BAAI/bge-m3 (training/embed/train.py),
#   3) srovnání původní vs. doladěný model na odložených a ručních dotazech (evaluate.py),
#   4) převod do GGUF + kontrola v Ollamě (export_gguf.sh),
#   5) výsledky do s3://…/_models/lexis-bge-m3-ft/<běh>/ (gguf, Modelfile, report.md, metrics.json).
#
# Spuštění: g5.xlarge nebo g6.xlarge (24 GB GPU; g4dn.xlarge jde taky, jen pomaleji),
#           AMI Deep Learning Base OSS Nvidia Driver GPU (Ubuntu 22.04), disk 150 GB,
#           Shutdown behavior TERMINATE, IAM lexis-bench-ec2. Síť: žádné příchozí porty.
# User data:  #!/bin/bash
#             curl -fsSL https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/embed-train-userdata.sh -o /root/t.sh && bash /root/t.sh
# Data: jen veřejné zákony z repozitáře. Žádné klientské spisy.
# =============================================================================
set -uo pipefail
export HOME="${HOME:-/root}"

RESULTS_BUCKET="lexislocal-bench-results-485237569555"
REPO="https://github.com/NexusSync-Systems/LexisLocal.git"
BRANCH="release-prep"
GEN_MODEL="${GEN_MODEL:-qwen2.5:7b}"      # píše tréninkové dotazy (Apache 2.0)
PER_PAR="${PER_PAR:-3}"                     # dotazů na paragraf
EPOCHS="${EPOCHS:-1}"
MAX_MINUTES="${MAX_MINUTES:-330}"           # pojistka: pak se instance vypne v každém případě
GEN_MAX_MINUTES="${GEN_MAX_MINUTES:-120}"   # psaní dotazů max. N minut; další běh naváže (dotazy jsou v S3)
TRAIN_MAX_LEN="${TRAIN_MAX_LEN:-384}"
MODEL_NAME="lexis-bge-m3-ft"

RUN_ID="$(date +%Y-%m-%d_%H%M)_embed_train"
S3_DEST="s3://$RESULTS_BUCKET/$RUN_ID/"
S3_MODEL="s3://$RESULTS_BUCKET/_models/$MODEL_NAME/$RUN_ID/"
S3_PAIRS="s3://$RESULTS_BUCKET/_training/embed/pairs/"
OUT=/opt/embed-results; WORK=/opt/embed-work
mkdir -p "$OUT" "$WORK"
exec > >(tee -a /var/log/lexis-embed.log) 2>&1
echo "=== LexisLocal embed-train start $(date -Is)"
if [ -f "$OUT/_run_id" ]; then echo "=== opakovaný start → vypínám"; shutdown -h +1; exit 0; fi
echo "$RUN_ID" > "$OUT/_run_id"
shutdown -h +"$MAX_MINUTES" "LexisLocal embed-train: časový limit"

AWS=$(command -v aws || true)
if [ -z "$AWS" ]; then apt-get update -qq && apt-get install -y -qq awscli || snap install aws-cli --classic || true; AWS=$(command -v aws || true); fi
upload() {
  [ -n "$AWS" ] || return 0
  cp /var/log/lexis-embed.log "$OUT/" 2>/dev/null
  "$AWS" s3 cp "$OUT" "$S3_DEST" --recursive --only-show-errors || echo "!! upload selhal $(date -Is)"
  # Rozpracované dotazy průběžně do S3 — při vypnutí instance se nic neztratí a další běh naváže.
  [ -s "$WORK/pairs/questions_raw.jsonl" ] && "$AWS" s3 cp "$WORK/pairs/questions_raw.jsonl" "$S3_PAIRS" --only-show-errors 2>/dev/null
  return 0
}
( while sleep 300; do upload; done ) & SYNC_PID=$!
finish() { kill "$SYNC_PID" 2>/dev/null; nvidia-smi > "$OUT/nvidia-smi.txt" 2>&1; upload; shutdown -h +1 "LexisLocal embed-train: hotovo"; }
trap finish EXIT
nvidia-smi --query-gpu=name,memory.total --format=csv | tee "$OUT/_gpu.txt"

# 1) Kód
git clone --depth 1 -b "$BRANCH" "$REPO" /opt/LexisLocal
cd /opt/LexisLocal
echo "commit: $(git rev-parse --short HEAD) — $(git log -1 --format='%s (%ci)')" | tee "$OUT/_version.txt"
ARCH=/opt/LexisLocal/backend/eval/kb/zakony.tar.gz
T=/opt/LexisLocal/training/embed

# 2) Python prostředí (torch s CUDA z PyPI)
# 5. 10. 2026: na DLAMI chyběl python3.10-venv (ensurepip) → venv nevznikl a „python“ neexistoval.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq python3-venv python3.10-venv python3-pip >/dev/null 2>&1 || true
if python3 -m venv /opt/venv && [ -x /opt/venv/bin/python ]; then
  . /opt/venv/bin/activate; PY=/opt/venv/bin/python
else
  echo "!! venv nejde vytvořit — použiju systémový python3"; PY=$(command -v python3)
fi
export PY
"$PY" -m pip install -q --upgrade pip
# Torch musí sedět na ovladač: nejnovější kola z PyPI chtějí CUDA 13 (ovladač ≥ 580), jinak kola cu126.
DRV=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | cut -d. -f1)
echo "ovladač NVIDIA: $DRV" | tee -a "$OUT/_gpu.txt"
if [ "${DRV:-0}" -ge 580 ]; then "$PY" -m pip install -q torch || { echo "!! pip torch selhal"; exit 1; }
else "$PY" -m pip install -q torch --index-url https://download.pytorch.org/whl/cu126 || { echo "!! pip torch (cu126) selhal"; exit 1; }; fi
"$PY" -m pip install -q sentence-transformers datasets accelerate numpy || { echo "!! pip selhal"; exit 1; }
"$PY" -c "import torch;print('torch', torch.__version__, 'cuda', torch.cuda.is_available())" | tee -a "$OUT/_gpu.txt"
"$PY" -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)" || { echo "!! torch nevidí GPU"; exit 1; }

# 3) Ollama (generování dotazů + na konci kontrola GGUF)
curl -fsSL https://ollama.com/install.sh | sh
mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment=OLLAMA_NUM_PARALLEL=4\nEnvironment=OLLAMA_KEEP_ALIVE=5m\n' > /etc/systemd/system/ollama.service.d/override.conf
systemctl daemon-reload; systemctl enable --now ollama; systemctl restart ollama
for i in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done

# 4) Dotazy: z S3 (minulý běh), jinak vygenerovat a uložit do S3
mkdir -p "$WORK/pairs"
"$AWS" s3 cp "$S3_PAIRS" "$WORK/pairs/" --recursive --only-show-errors 2>/dev/null || true
# 5. 10. 2026 (2. běh): na T4 trvalo psaní dotazů ~8 s/paragraf → ~10 h pro všech 4 400 §.
# Proto: max. GEN_MAX_MINUTES generování, pak trénink s tím, co je hotové; další běh naváže.
[ "${REGEN_PAIRS:-0}" = "1" ] && rm -f "$WORK/pairs/questions_raw.jsonl"
if [ "${SKIP_GEN:-0}" = "1" ] && [ -s "$WORK/pairs/pairs_train.jsonl" ]; then
  echo "=== dotazy z S3 (SKIP_GEN): $(wc -l < "$WORK/pairs/pairs_train.jsonl") trénovacích dvojic"
else
  echo "=== dotazy z minulých běhů: $( [ -s "$WORK/pairs/questions_raw.jsonl" ] && wc -l < "$WORK/pairs/questions_raw.jsonl" || echo 0) paragrafů"
  curl -sf http://127.0.0.1:11434/api/pull -d "{\"model\":\"$GEN_MODEL\",\"stream\":false}" >/dev/null && echo "model $GEN_MODEL stažen"
  echo "=== generování dotazů start $(date -Is) (limit $GEN_MAX_MINUTES min)"
  "$PY" "$T/build_pairs.py" --archive "$ARCH" --out "$WORK/pairs" --model "$GEN_MODEL" --per-par "$PER_PAR" --workers 4 \
    --deadline-min "$GEN_MAX_MINUTES" || { echo "!! generování dotazů selhalo"; exit 1; }
  "$AWS" s3 cp "$WORK/pairs/" "$S3_PAIRS" --recursive --only-show-errors && echo "=== dotazy uloženy do S3"
  curl -sf http://127.0.0.1:11434/api/generate -d "{\"model\":\"$GEN_MODEL\",\"keep_alive\":0}" >/dev/null || true  # uvolnit GPU
fi
cp "$WORK/pairs/stats.json" "$OUT/pairs_stats.json" 2>/dev/null; upload

# 5) Trénink
# Ollama drží v GPU paměti qwen (≈5 GB) — na T4 by na trénink nezbylo (6. 10. 2026: OOM).
systemctl stop ollama 2>/dev/null; sleep 3
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader | sed 's/^/GPU paměť před tréninkem: /'
echo "=== trénink start $(date -Is)"
"$PY" "$T/train.py" --archive "$ARCH" --pairs "$WORK/pairs" --out "$WORK/model" --epochs "$EPOCHS" --max-len "$TRAIN_MAX_LEN" \
  2>&1 | grep -v -i "warn" || { echo "!! trénink selhal"; exit 1; }
[ -f "$WORK/model/config.json" ] || { echo "!! model se neuložil"; exit 1; }
cp "$WORK/model/train_info.json" "$OUT/" 2>/dev/null
echo "=== trénink hotov $(date -Is)"; upload

# 6) Srovnání: původní vs. doladěný
"$PY" "$T/evaluate.py" --archive "$ARCH" --pairs "$WORK/pairs" --models BAAI/bge-m3 "$WORK/model" --report "$OUT" \
  2>&1 | grep -v -i "warn"
echo "=== hodnocení hotovo $(date -Is)"; upload

# 7) GGUF + Ollama + kontrola shody vektorů
systemctl start ollama; for i in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
if bash "$T/export_gguf.sh" "$WORK/model" "$WORK/gguf" "$MODEL_NAME"; then
  cp "$WORK/gguf/gguf_check.json" "$OUT/" 2>/dev/null
  "$AWS" s3 cp "$WORK/gguf/" "$S3_MODEL" --recursive --only-show-errors \
    && cp "$OUT/report.md" "$OUT/metrics.json" "$OUT/train_info.json" "$WORK/gguf/" 2>/dev/null \
    && "$AWS" s3 cp "$WORK/gguf/" "$S3_MODEL" --recursive --only-show-errors \
    && echo "=== model uložen: $S3_MODEL"
else
  echo "!! převod do GGUF / kontrola v Ollamě selhaly — HF model nahrávám jako tar"
fi
tar -C "$WORK" -czf "$WORK/model-hf.tar.gz" model && "$AWS" s3 cp "$WORK/model-hf.tar.gz" "$S3_MODEL" --only-show-errors
echo "=== hotovo $(date -Is)"
