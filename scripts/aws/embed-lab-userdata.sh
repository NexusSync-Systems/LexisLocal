#!/bin/bash
# =============================================================================
# LexisLocal — laboratoř vyhledávání, 2. měření (EC2 user-data), BEZ tréninku a beze změny serveru
#
# training/embed/search_lab.py: měří jako server (kousky ~700 znaků, hybrid 0,8, nejlepší kousek z §):
#   A) členění (celé § / kousky / kousky s hlavičkou), B) přepis dotazu chat modelem qwen2.5:7b,
#   C) rerankery bge-reranker-v2-m3, gte-multilingual-reranker-base, mmarco-mMiniLMv2 — přesnost
#      i rychlost na GPU a CPU (fp32 / int8), D) přepis + reranker.
# Model vyhledávání: doladěný mix-0.3 (GGUF z S3) v Ollamě jako na serveru.
# Výsledek: s3://lexislocal-bench-results-485237569555/<běh>_embed_lab/ (search_lab.md, search_lab.json, rewrites.json, log).
#
# Spuštění: g4dn.xlarge (~75 min). Rerankery potřebují GPU (torch CUDA).
#           AMI Deep Learning Base OSS Nvidia Driver GPU (Ubuntu 22.04), disk 60 GB,
#           Shutdown behavior TERMINATE, IAM lexis-bench-ec2. Síť: žádné příchozí porty.
# User data:  #!/bin/bash
#             export FT_MODEL_S3=s3://lexislocal-bench-results-485237569555/_models/lexis-bge-m3-ft/<běh>/   (volitelné)
#             curl -fsSL https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/embed-lab-userdata.sh -o /root/e.sh && bash /root/e.sh
# Data: jen veřejné zákony z repozitáře. Žádné klientské spisy.
# =============================================================================
set -uo pipefail
export HOME="${HOME:-/root}"

RESULTS_BUCKET="lexislocal-bench-results-485237569555"
REPO="https://github.com/NexusSync-Systems/LexisLocal.git"
BRANCH="${BRANCH:-release-prep}"
FT_MODEL_S3="${FT_MODEL_S3:-s3://$RESULTS_BUCKET/_models/lexis-bge-m3-ft/2026-10-09_1451_embed_train/}"
CHAT_MODEL="${CHAT_MODEL:-qwen2.5:7b}"
BASE_MODEL="${BASE_MODEL:-bge-m3}"
FT_NAME="lexis-bge-m3-ft"
MAX_MINUTES="${MAX_MINUTES:-180}"

RUN_ID="$(date +%Y-%m-%d_%H%M)_embed_lab"
S3_DEST="s3://$RESULTS_BUCKET/$RUN_ID/"
S3_PAIRS="s3://$RESULTS_BUCKET/_training/embed/pairs/"
OUT=/opt/embed-lab; WORK=/opt/embed-lab-work
mkdir -p "$OUT" "$WORK"
exec > >(tee -a /var/log/lexis-embed-lab.log) 2>&1
echo "=== LexisLocal embed-lab start $(date -Is)"
if [ -f "$OUT/_run_id" ]; then echo "=== opakovaný start → vypínám"; shutdown -h +1; exit 0; fi
echo "$RUN_ID" > "$OUT/_run_id"
shutdown -h +"$MAX_MINUTES" "LexisLocal embed-lab: časový limit"

AWS=$(command -v aws || true)
if [ -z "$AWS" ]; then apt-get update -qq && apt-get install -y -qq awscli || snap install aws-cli --classic || true; AWS=$(command -v aws || true); fi
upload() {
  [ -n "$AWS" ] || return 0
  cp /var/log/lexis-embed-lab.log "$OUT/" 2>/dev/null
  "$AWS" s3 cp "$OUT" "$S3_DEST" --recursive --only-show-errors || echo "!! upload selhal $(date -Is)"
  return 0
}
( while sleep 300; do upload; done ) & SYNC_PID=$!
finish() { kill "$SYNC_PID" 2>/dev/null; upload; shutdown -h +1 "LexisLocal embed-lab: hotovo"; }
trap finish EXIT
nvidia-smi --query-gpu=name,memory.total --format=csv 2>/dev/null | tee "$OUT/_gpu.txt" || { echo "!! bez GPU — reranker potřebuje GPU"; exit 1; }

# 1) Kód
git clone --depth 1 -b "$BRANCH" "$REPO" /opt/LexisLocal
cd /opt/LexisLocal
echo "commit: $(git rev-parse --short HEAD) — $(git log -1 --format='%s (%ci)')" | tee "$OUT/_version.txt"
ARCH=/opt/LexisLocal/backend/eval/kb/zakony.tar.gz
T=/opt/LexisLocal/training/embed

# 2) Python prostředí (torch s CUDA z PyPI) — reranker běží v sentence-transformers
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

# 3) Ollama + oba modely
curl -fsSL https://ollama.com/install.sh | sh
mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment=OLLAMA_NUM_PARALLEL=2\nEnvironment=OLLAMA_MAX_LOADED_MODELS=2\n' > /etc/systemd/system/ollama.service.d/override.conf
systemctl daemon-reload; systemctl enable --now ollama; systemctl restart ollama
for i in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
for m in "$CHAT_MODEL"; do
  for t in 1 2 3; do
    curl -sf http://127.0.0.1:11434/api/pull -d "{\"model\":\"$m\",\"stream\":false}" >/dev/null && { echo "model $m stažen"; break; }
    echo "!! stažení $m selhalo (pokus $t)"; sleep 15
  done
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
"$AWS" s3 cp "${S3_PAIRS}pairs_test_klient.jsonl" "$WORK/pairs/pairs_test_klient.jsonl" --only-show-errors 2>/dev/null || true
"$AWS" s3 cp "${S3_PAIRS}pairs_test.jsonl" "$WORK/pairs/pairs_test.jsonl" --only-show-errors 2>/dev/null \
  && echo "=== testovací dotazy: $(wc -l < "$WORK/pairs/pairs_test.jsonl")" || echo "!! testovací dotazy nejsou — jen zlatá sada"

# 5) Měření (Ollama: vektory + přepis dotazů; rerankery v torch na stejné GPU — T4 16 GB stačí)
"$PY" -m pip install -q einops "sentence-transformers>=3.4,<6" "transformers>=4.44,<5" 2>/dev/null || true   # gte-multilingual-reranker: vlastní kód modelu nejde s transformers 5 (11. 10. 2026)
echo "=== měření start $(date -Is)"
"$PY" "$T/search_lab.py" --archive "$ARCH" --pairs "$WORK/pairs" --model "$FT_NAME" --chat-model "$CHAT_MODEL" \
  --ollama http://127.0.0.1:11434 --report "$OUT" || { echo "!! měření selhalo"; exit 1; }
echo "=== hotovo $(date -Is)"
