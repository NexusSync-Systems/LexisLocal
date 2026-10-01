#!/bin/bash
# =============================================================================
# LexisLocal — test „server v kanceláři, advokát přistupuje vzdáleně“ (EC2 user-data)
#
# Na GPU instanci rozjede CELÝ backend LexisLocalu v síťovém (firemním) režimu:
# HTTPS (self-signed), vynucený API token, lokální Ollama, báze zákonů. Advokát se
# pak připojí z prohlížeče přes internet. Měří se i základ bez sítě (loopback).
#
# Spuštění:  g6.xlarge, AMI Deep Learning Base OSS Nvidia Driver GPU (Ubuntu 22.04),
#            disk 100–200 GB, Shutdown behavior TERMINATE, IAM lexis-bench-ec2.
# Síť:       Security group: HTTPS (443) JEN z „My IP“, SSH vypnuté.
# Data:      jen veřejné zákony a syntetické dotazy. NIKDY skutečné klientské spisy.
# Přístupové údaje (URL + token + otisk certifikátu) se nahrají do S3 (_connect.txt).
# Instance se sama vypne a smaže po MAX_MINUTES.
# =============================================================================
set -uo pipefail
export HOME="${HOME:-/root}"

RESULTS_BUCKET="lexislocal-bench-results-485237569555"
MAX_MINUTES=120                    # jak dlouho server poběží (pak se sám smaže)
CHAT_MODEL="qwen2.5:7b"            # model agentů; 32b: "qwen2.5:32b" (pomalejší, 1–2 uživatelé)
NUM_PARALLEL=4                     # kolik dotazů Ollama zpracuje souběžně
KB="backend/eval/kb/zakony.tar.gz" # veřejné zákony (OZ, OSŘ, ZOK)
REPO="https://github.com/Zdenekdi/LexisLocal.git"
BRANCH="release-prep"

exec > >(tee -a /var/log/lexis-remote.log) 2>&1
echo "=== LexisLocal remote-office start $(date -Is)"
RUN_ID="$(date +%Y-%m-%d_%H%M)_remote"
S3_DEST="s3://$RESULTS_BUCKET/$RUN_ID/"
OUT=/opt/remote-results
mkdir -p "$OUT"

shutdown -h +"$MAX_MINUTES" "LexisLocal remote test: časový limit"

AWS=$(command -v aws || true)
if [ -z "$AWS" ]; then apt-get update -qq && apt-get install -y -qq awscli || snap install aws-cli --classic || true; AWS=$(command -v aws || true); fi
upload() {
  [ -n "$AWS" ] || return 0
  cp /var/log/lexis-remote.log "$OUT/" 2>/dev/null
  journalctl -u lexislocal --no-pager 2>/dev/null | tail -n 2000 > "$OUT/backend.log"
  "$AWS" s3 cp "$OUT" "$S3_DEST" --recursive --only-show-errors || echo "!! upload selhal $(date -Is)"
}
echo "start $(date -Is)" > "$OUT/_started.txt"; upload
( while sleep 300; do upload; done ) &
SYNC_PID=$!
finish() {
  kill "$SYNC_PID" 2>/dev/null
  { ollama -v 2>&1; nvidia-smi 2>&1; journalctl -u ollama --no-pager 2>&1 | tail -n 300; } > "$OUT/ollama-diag.log" 2>/dev/null
  upload
}
trap finish EXIT

# 1) Ollama (souběh, dlouhý timeout načtení, model držet v paměti)
curl -fsSL https://ollama.com/install.sh | sh
mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment=OLLAMA_LOAD_TIMEOUT=15m\nEnvironment=OLLAMA_NUM_PARALLEL=%s\nEnvironment=OLLAMA_KEEP_ALIVE=-1\n' "$NUM_PARALLEL" \
  > /etc/systemd/system/ollama.service.d/override.conf
systemctl daemon-reload; systemctl enable --now ollama; systemctl restart ollama
for i in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
for m in bge-m3 "$CHAT_MODEL"; do
  for t in 1 2 3; do
    curl -sf http://127.0.0.1:11434/api/pull -d "{\"model\":\"$m\",\"stream\":false}" >/dev/null && { echo "model $m stažen"; break; }
    echo "!! stažení $m selhalo (pokus $t)"; sleep 15
  done
done

# 2) Node.js 22 + aplikace
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs
fi
git clone --depth 1 -b "$BRANCH" "$REPO" /opt/LexisLocal
cd /opt/LexisLocal
npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
echo "=== npm hotovo (exit $?) $(date -Is)"

# 3) TLS certifikát (self-signed na veřejnou IP) + token
IMDS_TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
mkdir -p /opt/lexis-tls
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=$PUBLIC_IP" \
  -addext "subjectAltName=IP:$PUBLIC_IP,IP:127.0.0.1" \
  -keyout /opt/lexis-tls/key.pem -out /opt/lexis-tls/cert.pem 2>/dev/null
FP=$(openssl x509 -in /opt/lexis-tls/cert.pem -noout -fingerprint -sha256 | cut -d= -f2)
TOKEN=$(openssl rand -hex 32)

cat > /opt/LexisLocal/.env <<ENV
BIND_HOST=0.0.0.0
PORT=443
USE_HTTPS=true
SSL_KEY_PATH=/opt/lexis-tls/key.pem
SSL_CERT_PATH=/opt/lexis-tls/cert.pem
API_TOKEN=$TOKEN
LEXIS_PILOT_LOCAL_ONLY=1
AI_CHAT_PROVIDER=ollama
AI_EMBED_PROVIDER=ollama
CHAT_MODEL=$CHAT_MODEL
EMBEDDING_MODEL=bge-m3
RAG_HYBRID=1
RAG_HYBRID_ALPHA=0.8
RAG_MIN_SCORE=0.14
ENV

cat > /etc/systemd/system/lexislocal.service <<UNIT
[Unit]
Description=LexisLocal backend (remote test)
After=network-online.target ollama.service
[Service]
WorkingDirectory=/opt/LexisLocal
ExecStart=$(command -v node) backend/server.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload; systemctl enable --now lexislocal
for i in $(seq 1 60); do curl -sfk -H "X-API-Token: $TOKEN" https://127.0.0.1/api/status >/dev/null && break; sleep 3; done
if curl -sfk -H "X-API-Token: $TOKEN" https://127.0.0.1/api/status >/dev/null; then echo "=== backend běží (HTTPS) $(date -Is)"
else echo "!! backend nenaběhl — viz backend.log"; upload; fi

# 4) Přístupové údaje do S3 (bucket je soukromý; server po testu zanikne i s tokenem)
cat > "$OUT/_connect.txt" <<CONN
Adresa:   https://$PUBLIC_IP/
Token:    $TOKEN
Otisk certifikátu (SHA-256): $FP
Model:    $CHAT_MODEL   ·   server se sám vypne: $(date -d "+$MAX_MINUTES min" -Is)
Prohlížeč ukáže varování (self-signed certifikát) → Pokročilé → Pokračovat. Ověř, že otisk sedí.
Token vlož v aplikaci do nastavení připojení (pole API token).
CONN
upload

# 5) Báze zákonů → znalostní báze rešeršníka (přes API, jako u skutečné instalace)
mkdir -p /opt/zakony && tar -xzf "$KB" -C /opt/zakony
for d in /opt/zakony/*/; do
  echo "=== seed $(basename "$d") $(date -Is)"
  NODE_TLS_REJECT_UNAUTHORIZED=0 node backend/scripts/seed-kb.js --agent resersnik --dir "$d" \
    --api https://127.0.0.1 --token "$TOKEN" --delay 0 2>&1 | tail -n 3
done
echo "=== báze naplněna $(date -Is)"
echo "Báze zákonů naplněna: $(date -Is)" >> "$OUT/_connect.txt"
upload

# 6) Základ bez sítě: stejný test přes loopback (pro srovnání se vzdáleným přístupem)
node backend/scripts/remote_probe.js --base https://127.0.0.1 --token "$TOKEN" --insecure \
  --levels 1,2,4 --rounds 2 --label server-loopback --out "$OUT" || echo "!! loopback test selhal"
upload
echo "=== připraveno pro vzdálený test, server běží do vypnutí $(date -Is)"
wait "$SYNC_PID"
