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
# cloud-init spouští user-data bez $HOME — ollama CLI pak spadne („panic: $HOME is not defined“).
export HOME="${HOME:-/root}"

RESULTS_BUCKET="lexislocal-bench-results-485237569555"   # S3 bucket na výsledky ("" = nenahrávat)
MODELS="llama3.1:8b,gemma3:12b"   # prázdné = výchozí kandidáti ze skriptu
JUDGE=""                    # soudce (známka 1–5), např. "qwen2.5:32b" — prodlouží běh o ~1 h; "" = bez soudce
MAX_MINUTES=240             # tvrdý limit běhu instance
# Režim: "plain" = jen znalosti modelu | "rag" = se zdroji (zákony z KB) | "both" = obojí
MODE="rag"
KB="backend/eval/kb/zakony.tar.gz"   # archiv .txt souborů (split-zakon.js) — veřejné zákony, žádná klientská data
# Vyhledávání nastav STEJNĚ jako v .env aplikace (jinak se výsledky neporovnají):
export EMBEDDING_MODEL="bge-m3" RAG_HYBRID=1 RAG_HYBRID_ALPHA=0.8 RAG_MIN_SCORE=0.14
REPO="https://github.com/Zdenekdi/LexisLocal.git"

exec > >(tee -a /var/log/lexis-bench.log) 2>&1
echo "=== LexisLocal bench start $(date -Is)"
RUN_ID="$(date +%Y-%m-%d_%H%M)"
S3_DEST="s3://$RESULTS_BUCKET/$RUN_ID/"
mkdir -p /opt/bench-results

# 1) Pojistka: vypnout nejpozději za MAX_MINUTES (s TERMINATE = instance zmizí).
#    Benchmark sám dostane o 15 min méně, aby se výsledky stihly nahrát.
shutdown -h +"$MAX_MINUTES" "LexisLocal bench: časový limit"
BENCH_SECONDS=$(( (MAX_MINUTES - 15) * 60 ))
START_TS=$(date +%s)

# Nahrání do S3 — PRŮBĚŽNĚ (každých 5 min) i na konci. Poučení z 1. běhu: výsledky se
# nahrávaly jen v EXIT trapu, a když instanci vypnul časový limit, zmizely i s ní.
AWS=$(command -v aws || true)
if [ -z "$AWS" ] && [ -n "$RESULTS_BUCKET" ]; then
  apt-get update -qq && apt-get install -y -qq awscli || snap install aws-cli --classic || true
  AWS=$(command -v aws || true)
fi
upload() {
  [ -n "$RESULTS_BUCKET" ] && [ -n "$AWS" ] || return 0
  cp /var/log/lexis-bench.log /opt/bench-results/ 2>/dev/null
  # cp --recursive (ne sync): role smí jen s3:PutObject, sync by potřeboval i ListBucket.
  if "$AWS" s3 cp /opt/bench-results "$S3_DEST" --recursive --only-show-errors; then return 0; fi
  echo "!! upload do S3 selhal $(date -Is)"; return 1
}
# Ověř zápis do S3 hned na začátku (chyba práv / CLI se ukáže v prvních minutách, ne po 4 h).
echo "start $(date -Is)" > /opt/bench-results/_started.txt
if upload; then echo "S3 OK → $S3_DEST"; else echo "!! S3 nejde — výsledky zůstanou jen na instanci"; fi
( while sleep 300; do upload; done ) &
SYNC_PID=$!

finish() {
  echo "=== konec $(date -Is), nahrávám a vypínám za 2 minuty"
  kill "$SYNC_PID" 2>/dev/null
  upload
  shutdown -c 2>/dev/null; shutdown -h +2 "LexisLocal bench hotov"
}
trap finish EXIT
trap 'echo "!! přijat signál, ukončuji"; exit 143' TERM INT

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
git clone --depth 1 -b release-prep "$REPO" /opt/LexisLocal
cd /opt/LexisLocal

# 4) Režim se zdroji potřebuje z npm jen klienta Ollamy (lib/rag.js) — bez celého
#    `npm install` aplikace (canvas, tesseract…). Verze z package-lock.json.
if [ "$MODE" != "plain" ]; then
  OLLAMA_VER=$(node -e 'const p=require("./package-lock.json").packages||{};console.log((p["node_modules/ollama"]||{}).version||"0.5")')
  npm install --prefix /opt/nodeps --no-audit --no-fund "ollama@$OLLAMA_VER" dotenv
  export NODE_PATH=/opt/nodeps/node_modules
  # stažení přes API (nezávislé na CLI/$HOME); čeká, až je model celý stažený
  curl -sf http://127.0.0.1:11434/api/pull -d "{\"model\":\"$EMBEDDING_MODEL\",\"stream\":false}" >/dev/null \
    && echo "embedding $EMBEDDING_MODEL stažen" || echo "!! stažení $EMBEDDING_MODEL selhalo"
  [ -f "$KB" ] || echo "!! $KB v repu chybí — režim se zdroji nepůjde"
fi

# 5) Předem stáhnout modely s opakováním — stahování z registry Ollamy občas spadne
#    („terminated“) a srovnávač by model jen přeskočil.
IFS=',' read -ra _MS <<< "$MODELS"
for m in "${_MS[@]}"; do
  for try in 1 2 3; do
    curl -sf --max-time 3600 http://127.0.0.1:11434/api/pull -d "{\"model\":\"$m\",\"stream\":false}" >/dev/null \
      && { echo "model $m stažen"; break; } || { echo "!! stažení $m selhalo (pokus $try)"; sleep 20; }
  done
done

# 5b) Zahřát každý model jednou předem (bez časového limitu). První načtení z čerstvého
#     disku může trvat přes 300 s a Node fetch pak spojení utne („fetch failed“).
for m in "${_MS[@]}"; do
  t=$(date +%s)
  curl -s --max-time 1800 http://127.0.0.1:11434/api/generate \
    -d "{\"model\":\"$m\",\"prompt\":\"ano\",\"stream\":false,\"options\":{\"num_predict\":1,\"num_ctx\":8192}}" >/dev/null \
    && echo "model $m zahřát za $(( $(date +%s) - t )) s" || echo "!! zahřátí $m selhalo"
done

# 6) Benchmark
ARGS=(--out /opt/bench-results --timeout 900)
[ -n "$MODELS" ] && ARGS+=(--models "$MODELS")
[ -n "$JUDGE" ]  && ARGS+=(--judge "$JUDGE")
if [ "$MODE" = "plain" ] || [ "$MODE" = "both" ]; then
  LEFT=$(( BENCH_SECONDS - ($(date +%s) - START_TS) )); [ "$LEFT" -lt 120 ] && LEFT=120
  timeout "$LEFT" node backend/scripts/model_bench.js "${ARGS[@]}"
  echo "=== benchmark bez zdrojů doběhl (exit $?; 124 = vypršel čas)"
fi
if [ "$MODE" = "rag" ] || [ "$MODE" = "both" ]; then
  LEFT=$(( BENCH_SECONDS - ($(date +%s) - START_TS) )); [ "$LEFT" -lt 120 ] && LEFT=120
  timeout "$LEFT" node backend/scripts/model_bench.js "${ARGS[@]}" --kb-dir "$KB"
  echo "=== benchmark se zdroji doběhl (exit $?; 124 = vypršel čas)"
fi
