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
MODELS="qwen2.5:7b,qwen2.5:32b"    # prázdné = výchozí kandidáti ze skriptu
JUDGE=""                    # soudce (známka 1–5), např. "qwen2.5:32b" — prodlouží běh o ~1 h; "" = bez soudce
MAX_MINUTES=120             # tvrdý limit běhu instance
# Režim: "plain" = jen znalosti modelu | "rag" = se zdroji (zákony z KB) | "both" = obojí
MODE="rag"
# Zátěžový test (load_bench.js): úrovně souběhu = kolik advokátů se ptá naráz; "" = nespouštět
LOAD_LEVELS=""
LOAD_MODELS="qwen2.5:14b"   # modely pro zátěžový test (32b se s 8 souběžnými sloty do 24 GB nevejde)
RAG_KS="3,5"                # počty pasáží k porovnání (každý = samostatný běh do podsložky k<N>)
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
  # Diagnostika: verze a log samotné Ollamy (proč se model načítá pomalu / padá).
  { ollama -v 2>&1; nvidia-smi 2>&1; journalctl -u ollama --no-pager 2>&1 | tail -n 400; } \
    > /opt/bench-results/ollama-diag.log 2>/dev/null
  upload
  shutdown -c 2>/dev/null; shutdown -h +2 "LexisLocal bench hotov"
}
trap finish EXIT
trap 'echo "!! přijat signál, ukončuji"; exit 143' TERM INT

# 2) Ollama + Node.js 22
curl -fsSL https://ollama.com/install.sh | sh
# Ollama vzdá načtení modelu po 5 min (OLLAMA_LOAD_TIMEOUT). První načtení na čerstvém
# serveru trvá i 4–5 min → prodloužit na 15 min.
mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment=OLLAMA_LOAD_TIMEOUT=15m\n' > /etc/systemd/system/ollama.service.d/load-timeout.conf
systemctl daemon-reload
systemctl enable --now ollama
systemctl restart ollama
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
# undici: srovnávače jím vypnou 300s limit Node fetch na odpověď (pomalé první načtení modelu).
OLLAMA_VER=$(node -e 'const p=require("./package-lock.json").packages||{};console.log((p["node_modules/ollama"]||{}).version||"0.5")')
npm install --prefix /opt/nodeps --no-audit --no-fund "ollama@$OLLAMA_VER" dotenv undici
export NODE_PATH=/opt/nodeps/node_modules
if [ "$MODE" != "plain" ]; then
  # stažení přes API (nezávislé na CLI/$HOME); čeká, až je model celý stažený
  curl -sf http://127.0.0.1:11434/api/pull -d "{\"model\":\"$EMBEDDING_MODEL\",\"stream\":false}" >/dev/null \
    && echo "embedding $EMBEDDING_MODEL stažen" || echo "!! stažení $EMBEDDING_MODEL selhalo"
  [ -f "$KB" ] || echo "!! $KB v repu chybí — režim se zdroji nepůjde"
fi

# 5) Modely stahuje sám srovnávač (streamovaně, 3 pokusy). Dřívější předstažení a zahřátí
#    curlem se neosvědčilo — po něm se každý model načítal přes 5 min.

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
  for K in ${RAG_KS//,/ }; do
    LEFT=$(( BENCH_SECONDS - ($(date +%s) - START_TS) )); [ "$LEFT" -lt 120 ] && LEFT=120
    mkdir -p "/opt/bench-results/k$K"
    timeout "$LEFT" node backend/scripts/model_bench.js "${ARGS[@]}" --kb-dir "$KB" --rag-k "$K" --out "/opt/bench-results/k$K"
    echo "=== benchmark se zdroji (k=$K) doběhl (exit $?; 124 = vypršel čas)"
  done
fi

# 7) Zátěžový test — kolik souběžných uživatelů zvládne jedna GPU. Kontext každého
#    dotazu = jiný úsek zákonů z KB (≈ RAG pasáže), žádná klientská data.
if [ -n "$LOAD_LEVELS" ]; then
  tar -xzf "$KB" -O 2>/dev/null | head -c 400000 > /opt/ctx.txt
  # Až TEĎ zapnout souběžné sloty (Ollama vyhradí paměť num_ctx × sloty — kdyby to platilo
  # už pro benchmark kvality, 14b by se nevešel celý do VRAM). num_ctx 4096 stačí:
  # ~2000 tokenů kontextu + 400 odpovědi.
  MAXPAR=$(echo "$LOAD_LEVELS" | tr ',' '\n' | sort -n | tail -1)
  mkdir -p /etc/systemd/system/ollama.service.d
  printf '[Service]\nEnvironment=OLLAMA_NUM_PARALLEL=%s\nEnvironment=OLLAMA_MAX_LOADED_MODELS=1\n' "$MAXPAR" \
    > /etc/systemd/system/ollama.service.d/parallel.conf
  systemctl daemon-reload && systemctl restart ollama
  for i in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
  export OLLAMA_NUM_PARALLEL="$MAXPAR"
  LEFT=$(( BENCH_SECONDS - ($(date +%s) - START_TS) )); [ "$LEFT" -lt 120 ] && LEFT=120
  timeout "$LEFT" node backend/scripts/load_bench.js --models "${LOAD_MODELS:-$MODELS}" --levels "$LOAD_LEVELS" \
    --context-file /opt/ctx.txt --out /opt/bench-results --rounds 2 --num-ctx 4096
  echo "=== zátěžový test doběhl (exit $?; 124 = vypršel čas)"
fi
