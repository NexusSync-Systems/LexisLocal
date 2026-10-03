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
MAX_MINUTES=320                    # jak dlouho server poběží (pak se sám vypne); se srovnáním modelů ~+90 min
CHAT_MODEL="qwen2.5:7b"            # model agentů; 32b: "qwen2.5:32b" (pomalejší, 1–2 uživatelé)
NUM_PARALLEL=4                     # kolik dotazů Ollama zpracuje souběžně
# Srovnání modelů stejné třídy na eval sadě agentů (fáze E) po hlavním testu. Prázdné = vypnuto.
COMPARE_MODELS="qwen3.5:9b llama3.1:8b granite4.2:8b mistral-nemo:12b"
KB="backend/eval/kb/zakony.tar.gz" # veřejné zákony (OZ, OSŘ, ZOK)
REPO="https://github.com/NexusSync-Systems/LexisLocal.git"
BRANCH="release-prep"
# Profil (nastaví bootstrap user-data: export PROFILE=integrace):
#   plny      — vše výše (výchozí, ~5 h)
#   integrace — celý server_suite vč. fáze I (živě InfoJednání + ISIR ze serveru), bez srovnání
#               modelů a bez měření vzdálené odezvy; ~2,5–3 h, nejpozději po 4 h se instance vypne
PROFILE="${PROFILE:-plny}"
if [ "$PROFILE" = "integrace" ]; then
  # 3. 10. 2026: samotné nahrání OZ trvalo 43 min → 150 min nestačilo na celý suite.
  MAX_MINUTES=240; COMPARE_MODELS=""; SKIP_PROBE=1
fi

exec > >(tee -a /var/log/lexis-remote.log) 2>&1
echo "=== LexisLocal remote-office start $(date -Is) (profil $PROFILE)"
RUN_ID="$(date +%Y-%m-%d_%H%M)_remote$([ "$PROFILE" = "plny" ] || echo "_$PROFILE")"
S3_DEST="s3://$RESULTS_BUCKET/$RUN_ID/"
OUT=/opt/remote-results
# Opakovaný start (Stop → Start, zamrznutí, ruční restart): cloud-init na DLAMI pouští
# user-data znovu. Testy se NEopakují (backend by běžel se starým tokenem → samé 401);
# jen se dohrají výsledky prvního běhu + logy z předchozího bootu a instance se vypne.
if [ -f "$OUT/_run_id" ]; then
  RUN_ID="$(cat "$OUT/_run_id")"; S3_DEST="s3://$RESULTS_BUCKET/$RUN_ID/"
  echo "=== opakovaný start → jen nahrání výsledků běhu $RUN_ID $(date -Is)"
  journalctl -k -b -1 --no-pager 2>/dev/null | tail -n 400 > "$OUT/kernel-predchozi-boot.log"
  journalctl -u ollama -b -1 --no-pager 2>/dev/null | tail -n 300 > "$OUT/ollama-predchozi-boot.log"
  journalctl -u lexislocal -b -1 --no-pager 2>/dev/null | tail -n 300 > "$OUT/backend-predchozi-boot.log"
  cp /var/log/lexis-remote.log "$OUT/" 2>/dev/null
  systemctl stop lexislocal ollama 2>/dev/null
  AWS=$(command -v aws || true)
  for i in 1 2 3 4 5 6; do [ -n "$AWS" ] && "$AWS" s3 cp "$OUT" "$S3_DEST" --recursive --only-show-errors && break; echo "!! upload selhal (pokus $i) — chybí IAM role?"; sleep 60; done
  shutdown -h +2 "LexisLocal remote test: výsledky dohrány"
  exit 0
fi
mkdir -p "$OUT"
echo "$RUN_ID" > "$OUT/_run_id"

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
printf '[Service]\nEnvironment=OLLAMA_LOAD_TIMEOUT=15m\nEnvironment=OLLAMA_NUM_PARALLEL=%s\nEnvironment=OLLAMA_KEEP_ALIVE=10m\nEnvironment=OLLAMA_MAX_LOADED_MODELS=2\n' "$NUM_PARALLEL" \
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
# Která verze kódu běží + kontrola, že GitHub obsahuje dnešní změny (koncepty, podpisy, audit).
{
  echo "commit: $(git rev-parse --short HEAD) — $(git log -1 --format='%s (%ci)')"
  for f in backend/routes/drafts.js backend/lib/signature_check.js backend/public/app-drafts.js backend/lib/isir_cases.js; do
    [ -f "$f" ] && echo "OK   $f" || echo "CHYBÍ $f  ← na GitHubu nejsou dnešní změny (git push?)"
  done
  echo "nodemailer: $(node -p "require('nodemailer/package.json').version" 2>/dev/null)  express: $(node -p "require('express/package.json').version" 2>/dev/null)"
} > "$OUT/_version.txt"; cat "$OUT/_version.txt"; upload
echo "=== npm hotovo (exit $?) $(date -Is)"

# 3) TLS certifikát (self-signed na veřejnou IP) + token
IMDS_TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
mkdir -p /opt/lexis-tls
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=$PUBLIC_IP" \
  -addext "subjectAltName=IP:$PUBLIC_IP,IP:127.0.0.1" \
  -keyout /opt/lexis-tls/key.pem -out /opt/lexis-tls/cert.pem 2>/dev/null
FP=$(openssl x509 -in /opt/lexis-tls/cert.pem -noout -fingerprint -sha256 | cut -d= -f2)
# Otisk VEŘEJNÉHO KLÍČE (SPKI) pro spárování LexisEditoru (js/core/lexis-server-pin.js)
PIN="sha256/$(openssl x509 -in /opt/lexis-tls/cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')"
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
systemctl daemon-reload; systemctl enable lexislocal; systemctl restart lexislocal
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
LexisEditor: Nastavení → 🔐 Spárovat → vlož tento odkaz (obsahuje token — nesdílet):
lexis://$PUBLIC_IP/?fp=$PIN&token=$TOKEN
CONN
upload

# 5) Báze zákonů → znalostní báze rešeršníka (přes API, jako u skutečné instalace)
mkdir -p /opt/zakony && tar -xzf "$KB" -C /opt/zakony
for d in /opt/zakony/*/; do
  echo "=== seed $(basename "$d") $(date -Is)"
  NODE_TLS_REJECT_UNAUTHORIZED=0 node backend/scripts/seed-kb.js --agent resersnik --dir "$d" \
    --api https://127.0.0.1 --token "$TOKEN" --delay 0 2>&1 | tail -n 3
done
# 5b) Judikatura → oborové báze (_kb_obor_<slug>); podsložka archivu = obor
JUD="backend/eval/kb/judikatura.tar.gz"
if [ -f "$JUD" ]; then
  mkdir -p /opt/judikatura && tar -xzf "$JUD" -C /opt/judikatura
  NODE_TLS_REJECT_UNAUTHORIZED=0 node backend/scripts/seed-kb.js --root /opt/judikatura \
    --api https://127.0.0.1 --token "$TOKEN" --delay 0 2>&1 | tail -n 5
fi
echo "=== báze naplněna $(date -Is)"
echo "Báze zákonů naplněna: $(date -Is)" >> "$OUT/_connect.txt"
upload

# 6) Základ bez sítě: stejný test přes loopback (pro srovnání se vzdáleným přístupem)
# 5c) Dosah na státní systémy ze serveru (InfoJednání, ISIR na portu 8443) — jen HTTP kódy.
{
  echo "== $(date -Is)"
  echo "infojednani: $(curl -s -o /dev/null -w '%{http_code} %{time_total}s' 'https://infojednani.gov.cz/api/v1/organizace/lovkod/jednaci-sin?idOrganizace=OSJIMJI')"
  echo "isir-8443:   $(curl -s -o /dev/null -w '%{http_code} %{time_total}s' 'https://isir.justice.cz:8443/isir_cuzk_ws/IsirWsCuzkService?wsdl')"
} > "$OUT/_dosah.txt"; cat "$OUT/_dosah.txt"; upload

if [ "${SKIP_PROBE:-0}" != "1" ]; then
node backend/scripts/remote_probe.js --base https://127.0.0.1 --token "$TOKEN" --insecure \
  --levels 1,2,4 --rounds 2 --label server-loopback --out "$OUT" || echo "!! loopback test selhal"
upload
fi

# 7) Celý serverový test (server_suite.js) přes loopback → report do S3 (*_remote/suite/).
#    RUN_SUITE=0 vypne. Běží na pozadí serveru; testovací objekty mají prefix E2E-.
if [ "${RUN_SUITE:-1}" = "1" ] && [ -f backend/scripts/server_suite.js ]; then
  echo "=== server_suite start $(date -Is)"
  node backend/scripts/server_suite.js --base https://127.0.0.1 --token "$TOKEN" --insecure --model "$CHAT_MODEL" \
    --label server-loopback --out "$OUT/suite" 2>&1 | tail -n 60 || echo "!! server_suite skončil s chybou"
  echo "=== server_suite hotovo $(date -Is)"
  upload
fi
# 7b) Záloha + zkouška obnovy na serveru. Archiv obsahuje klíč k databázi → zůstává jen
#     na instanci (zanikne s ní), do S3 jde jen výsledek ověření.
( set -a; . /opt/LexisLocal/.env; set +a; node backend/scripts/backup.js --bez-spisovny --out /root/zaloha-test ) > "$OUT/_zaloha.txt" 2>&1 \
  || echo "!! záloha / zkouška obnovy selhala (viz _zaloha.txt)"
cat "$OUT/_zaloha.txt"; upload
# 8) Srovnání modelů (backend/scripts/model_compare.js) → report do S3 (*_remote/suite/*_model-compare.md).
if [ -n "${COMPARE_MODELS:-}" ] && [ -f backend/scripts/model_compare.js ]; then
  echo "=== srovnání modelů start $(date -Is): $CHAT_MODEL $COMPARE_MODELS"
  OK_MODELS="$CHAT_MODEL"
  for m in $COMPARE_MODELS; do
    if curl -sf http://127.0.0.1:11434/api/pull -d "{\"model\":\"$m\",\"stream\":false}" >/dev/null; then
      echo "model $m stažen"; OK_MODELS="$OK_MODELS,$m"
    else
      echo "!! model $m nejde stáhnout — ze srovnání vynechán"
    fi
  done
  # Model po modelu: před každým uvolnit paměť (ollama stop + page cache), zapsat stav
  # paměti, časový limit na model a nahrát po každém — zamrznutí jednoho modelu tak
  # nepřijde o výsledky ostatních (3. 10. 2026 instance zamrzla po 1. modelu).
  for m in $(echo "$OK_MODELS" | tr ',' ' '); do
    for lm in $(ollama ps 2>/dev/null | awk 'NR>1 && $1!="" {print $1}' | grep -v '^bge-m3'); do ollama stop "$lm" 2>/dev/null; done
    sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null
    { echo "== $(date -Is) před $m"; free -m; nvidia-smi --query-gpu=memory.used,memory.total --format=csv 2>/dev/null; } >> "$OUT/pamet.log"
    echo "=== model $m start $(date -Is)"
    timeout 50m node backend/scripts/model_compare.js --base https://127.0.0.1 --token "$TOKEN" --insecure \
      --models "$m" --out "$OUT/suite" 2>&1 | tail -n 15 || echo "!! model $m skončil s chybou nebo vypršel čas"
    { echo "== $(date -Is) po $m"; free -m; } >> "$OUT/pamet.log"
    upload
  done
  echo "=== srovnání modelů hotovo $(date -Is) (souhrn: suite/*_cmp-*.md)"
  upload
fi
echo "=== připraveno pro vzdálený test, server běží do vypnutí $(date -Is)"
wait "$SYNC_PID"
