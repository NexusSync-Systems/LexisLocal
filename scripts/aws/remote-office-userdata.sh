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
# Profil (nastaví bootstrap user-data, např. export PROFILE=kompletni):
#   plny      — vše výše (výchozí, ~5 h)
#   integrace — celý server_suite vč. fáze I (živě InfoJednání + ISIR ze serveru), bez srovnání
#               modelů a bez měření vzdálené odezvy; ~2,5–3 h, nejpozději po 4 h se instance vypne
#   kompletni — kontrola VŠEHO, co aplikace umí: měření odezvy, celý server_suite (A–Z vč. agentů,
#               zátěže, InfoJednání + ISIR živě, pilotního toku a pokrytí všech čtecích cest)
#               a záloha se zkouškou obnovy; bez srovnání modelů. Agenti 3× (SUITE_REPEAT) kvůli
#               spolehlivosti; po dohrání výsledků se instance SAMA VYPNE (nečeká na limit).
#               ~3,5 h, vypne se nejpozději po 5,5 h.
#   judikatura — test verze 1.2.0 s PLNOU bází rešeršníka jako na Macu (23 zákonů + judikatura
#               NS, ÚS, NSS; ~297 tis. pasáží) a s nastavením pilotu na Mac mini (bge-m3, bez
#               rerankeru, agent K=3): kb_regression na serveru, studený start a paměť backendu
#               (podklad pro velikost RAM Mac mini), pak celý server_suite. Báze se bere z archivu
#               KB_ARCHIVE_S3 (jen veřejná data; nahrát z Macu, viz docs/SERVER_TEST_1.2.0.md).
#               První běh ~4–5 h (vektory se počítají), další s cache z S3 výrazně kratší.
PROFILE="${PROFILE:-plny}"
# Reranker (cross-encoder) nad výsledky RAG — VÝCHOZÍ ZAPNUTÝ (vypnutí: export RERANK=0). Lokální služba
# scripts/rerank_server.py na GPU, backend ho volá přes RAG_RERANK_URL (lib/rerank_service.js).
# Měření 10. 10. 2026: zlatá sada R@1 70 → 77 %, ~0,2 s na dotaz na T4.
# Test 13. 10. 2026 (RERANK=0 vs 11. 10. RERANK=1, oba chunky 2000): bez rerankeru neověřené
# citace 24 % vs 20 % a agent W3 (dopis, osobní údaje) 0/3 vs 3/3 → reranker neškodí, zapnuto.
RERANK="${RERANK:-1}"
RERANK_MODEL="${RERANK_MODEL:-BAAI/bge-reranker-v2-m3}"   # levnější: cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 (training/embed/README.md)
# Počet pasáží z RAG pro agenta. Laboratoř 13. 10. 2026 (chunky 2000 + bge reranker): správný § v top 3 / top 5
# — zlatá sada 91,9 / 95,2 %, klientské dotazy 88,2 / 94,1 %, test_klient 57,7 / 64,7 %. Práh RAG_MIN_SCORE
# relevantní od nerelevantních neoddělí (skóre se překrývají; 0,40 ztratí 2,5 % relevantních) → zůstává 0,14.
RAG_AGENT_K="${RAG_AGENT_K:-5}"
if [ "$PROFILE" = "kompletni" ]; then
  MAX_MINUTES=330; COMPARE_MODELS=""; SUITE_REPEAT="${SUITE_REPEAT:-3}"; STOP_AFTER_TESTS="${STOP_AFTER_TESTS:-1}"
fi
if [ "$PROFILE" = "judikatura" ]; then
  MAX_MINUTES=480; COMPARE_MODELS=""; SKIP_PROBE=1; SUITE_REPEAT="${SUITE_REPEAT:-2}"; STOP_AFTER_TESTS="${STOP_AFTER_TESTS:-1}"
  RERANK="${RERANK_JUD:-0}"; RAG_AGENT_K="${RAG_AGENT_K_JUD:-3}"      # jako pilot na Mac mini
  EMBED_MODEL_S3="${EMBED_MODEL_S3:-none}"                            # původní bge-m3 (jako na Macu)
  KB_ARCHIVE_S3="${KB_ARCHIVE_S3:-s3://$RESULTS_BUCKET/_kb/kb-1.2.0.tar.gz}"
  NODE_HEAP="${NODE_HEAP:-8192}"
  KB_SAVE_DEBOUNCE="${KB_SAVE_DEBOUNCE:-3000}"   # odložený zápis báze při plnění (24. 10.: bez něj ~1 soubor/s)
  MAX_MINUTES=480
fi
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
# Model vyhledávání: výchozí je doladěný bge-m3 z embed tréninku 5 (mix-0.3, 10. 10. 2026:
# zlatá sada R@1 66 → 71 %, serverový test 174/174, agenti 68/68 — training/embed/README.md).
#   jiný běh:        export EMBED_MODEL_S3=s3://lexislocal-bench-results-485237569555/_models/lexis-bge-m3-ft/<běh>/
#   původní bge-m3:  export EMBED_MODEL_S3=none
EMBED_MODEL_S3_DEFAULT="s3://$RESULTS_BUCKET/_models/lexis-bge-m3-ft/2026-10-09_1451_embed_train/"
EMBED_MODEL_S3="${EMBED_MODEL_S3:-$EMBED_MODEL_S3_DEFAULT}"
EMBED_MODEL="bge-m3"; EMB_CACHE_TAG="bge-m3"
if [ "$EMBED_MODEL_S3" != "none" ] && [ -n "$AWS" ]; then
  # 7. 10. 2026 (run 7): role lexis-bench-ec2 nemá s3:ListBucket → --recursive padá na AccessDenied.
  # Proto stahujeme konkrétní soubory (stačí s3:GetObject) a Modelfile si napíšeme sami.
  EMS3="${EMBED_MODEL_S3%/}"
  mkdir -p /opt/lexis-embmodel && "$AWS" s3 cp "$EMS3/lexis-bge-m3-ft.gguf" /opt/lexis-embmodel/ --only-show-errors \
    && printf 'FROM ./lexis-bge-m3-ft.gguf\n' > /opt/lexis-embmodel/Modelfile \
    && ( cd /opt/lexis-embmodel && ollama create lexis-bge-m3-ft -f Modelfile ) \
    && EMBED_MODEL="lexis-bge-m3-ft" && EMB_CACHE_TAG="lexis-bge-m3-ft_$(basename "$EMS3")" \
    && echo "=== model vyhledávání: doladěný z $EMBED_MODEL_S3 (cache vektorů: $EMB_CACHE_TAG)" \
    || echo "!! doladěný model vyhledávání se nepodařilo načíst — používám bge-m3"
fi
for m in "$EMBED_MODEL" "$CHAT_MODEL"; do
  [ "$m" = "lexis-bge-m3-ft" ] && continue
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
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
AWS_REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
# Pevná adresa: Elastic IP se štítkem Name=lexis-test (když existuje a role smí ec2:AssociateAddress).
# Stejná adresa = stejný „origin“ v prohlížeči → token uložený v LexisLocal vydrží mezi běhy.
ADDR_NOTE="dočasná veřejná IP (Elastic IP lexis-test nenalezena)"
if [ -n "$AWS" ]; then
  EIP_ALLOC=$("$AWS" ec2 describe-addresses --region "$AWS_REGION" --filters Name=tag:Name,Values=lexis-test \
      --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)
  if [ -n "$EIP_ALLOC" ] && [ "$EIP_ALLOC" != "None" ]; then
    if "$AWS" ec2 associate-address --region "$AWS_REGION" --allocation-id "$EIP_ALLOC" --instance-id "$INSTANCE_ID" \
         --allow-reassociation >/dev/null 2>&1; then
      EIP=$("$AWS" ec2 describe-addresses --region "$AWS_REGION" --allocation-ids "$EIP_ALLOC" --query 'Addresses[0].PublicIp' --output text 2>/dev/null || true)
      if [ -n "$EIP" ] && [ "$EIP" != "None" ]; then PUBLIC_IP="$EIP"; ADDR_NOTE="pevná Elastic IP (lexis-test)"; fi
    else ADDR_NOTE="Elastic IP nalezena, ale přiřazení selhalo (oprávnění ec2:AssociateAddress?)"; fi
  fi
fi
echo "=== adresa: $PUBLIC_IP — $ADDR_NOTE"
mkdir -p /opt/lexis-tls
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=$PUBLIC_IP" \
  -addext "subjectAltName=IP:$PUBLIC_IP,IP:127.0.0.1" \
  -keyout /opt/lexis-tls/key.pem -out /opt/lexis-tls/cert.pem 2>/dev/null
FP=$(openssl x509 -in /opt/lexis-tls/cert.pem -noout -fingerprint -sha256 | cut -d= -f2)
# Otisk VEŘEJNÉHO KLÍČE (SPKI) pro spárování LexisEditoru (js/core/lexis-server-pin.js)
PIN="sha256/$(openssl x509 -in /opt/lexis-tls/cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')"
# Pevný token z SSM Parameter Store (/lexislocal/test-token, SecureString), jinak náhodný.
# Hodnota se nikam nevypisuje; v _connect.txt je jen poznámka, odkud token je.
TOKEN=""; TOKEN_NOTE="náhodný pro tento běh"
if [ -n "$AWS" ]; then
  TOKEN=$("$AWS" ssm get-parameter --region "$AWS_REGION" --name /lexislocal/test-token --with-decryption \
      --query 'Parameter.Value' --output text 2>/dev/null | tr -d '[:space:]' || true)
  if [ ${#TOKEN} -ge 32 ]; then TOKEN_NOTE="pevný z SSM /lexislocal/test-token (stejný jako minule)"; else TOKEN=""; fi
fi
[ -z "$TOKEN" ] && TOKEN=$(openssl rand -hex 32)
echo "=== token: $TOKEN_NOTE"

# Cache vektorů báze zákonů z minulého běhu (S3). Plnění báze pak netrvá ~1,5 h, ale minuty:
# vektory stejných textů se nepočítají znovu (lib/embed_cache.js; jen veřejné zákony/judikatura).
# Doladěný model má cache podle běhu tréninku (stejný název v Ollamě, ale jiné váhy → jiný soubor).
EMB_DIR=/opt/lexis-embcache; EMB_FILE="$EMB_DIR/embeddings-$EMB_CACHE_TAG.jsonl"
EMB_S3="s3://$RESULTS_BUCKET/_cache/embeddings-$EMB_CACHE_TAG.jsonl.gz"
mkdir -p "$EMB_DIR"
if [ -n "$AWS" ] && [ "${EMBED_CACHE:-1}" = "1" ] && "$AWS" s3 cp "$EMB_S3" "$EMB_FILE.gz" --only-show-errors 2>/dev/null; then
  gunzip -f "$EMB_FILE.gz" && echo "=== cache vektorů: $(wc -l < "$EMB_FILE") záznamů z S3"
elif [ "${EMBED_CACHE:-1}" != "1" ]; then echo "=== cache vektorů: vypnutá (EMBED_CACHE=0) — vektory se spočítají znovu a do S3 se neukládají"
else echo "=== cache vektorů: v S3 zatím není (první běh) — vektory se spočítají a po naplnění uloží"; fi
EMB_BEFORE=$( [ -f "$EMB_FILE" ] && wc -l < "$EMB_FILE" || echo 0)

# Volitelný reranker: Python + torch (CUDA) + sentence-transformers, služba jen na 127.0.0.1:8081.
RERANK_OK=0
if [ "$RERANK" = "1" ]; then
  apt-get install -y -qq python3-venv python3.10-venv python3-pip >/dev/null 2>&1 || true
  if python3 -m venv /opt/rerank-venv && [ -x /opt/rerank-venv/bin/python ]; then
    RPY=/opt/rerank-venv/bin/python; "$RPY" -m pip install -q --upgrade pip
    DRV=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | cut -d. -f1)
    if [ "${DRV:-0}" -ge 580 ]; then "$RPY" -m pip install -q torch; else "$RPY" -m pip install -q torch --index-url https://download.pytorch.org/whl/cu126; fi
    "$RPY" -m pip install -q einops "sentence-transformers>=3.4,<6" "transformers>=4.44,<5" && "$RPY" -c "import sentence_transformers" || echo "!! reranker: sentence-transformers nejde importovat"
    cat > /etc/systemd/system/lexis-reranker.service <<UNIT
[Unit]
Description=LexisLocal reranker (lokální, jen 127.0.0.1)
After=network-online.target
[Service]
Environment=RERANK_MODEL=$RERANK_MODEL
ExecStart=$RPY /opt/LexisLocal/scripts/rerank_server.py --host 127.0.0.1 --port 8081
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload; systemctl enable --now lexis-reranker
    for i in $(seq 1 120); do curl -sf http://127.0.0.1:8081/health >/dev/null && break; sleep 5; done
  fi
  if curl -sf http://127.0.0.1:8081/health >/dev/null; then
    RERANK_OK=1; echo "=== reranker: $RERANK_MODEL běží ($(curl -sf http://127.0.0.1:8081/health))"
  else echo "!! reranker se nepodařilo spustit — server poběží bez něj"; journalctl -u lexis-reranker --no-pager -n 30 2>/dev/null | tail -n 30; fi
else echo "=== reranker: vypnutý (RERANK=0)"; fi

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
EMBEDDING_MODEL=$EMBED_MODEL
RAG_HYBRID=1
RAG_HYBRID_ALPHA=0.8
RAG_MIN_SCORE=0.14
RAG_AGENT_K=$RAG_AGENT_K
EMBED_CACHE_FILE=$EMB_FILE
ENV
if [ "$RERANK_OK" = "1" ]; then
  printf 'RAG_RERANK=1\nRAG_RERANK_URL=http://127.0.0.1:8081\nRAG_RERANK_K=20\nRAG_RERANK_WEIGHT=0.85\nRAG_RERANK_TIMEOUT_MS=8000\n' >> /opt/LexisLocal/.env
fi

[ -n "${KB_SAVE_DEBOUNCE:-}" ] && echo "RAG_KB_SAVE_DEBOUNCE_MS=$KB_SAVE_DEBOUNCE" >> /opt/LexisLocal/.env
cat > /etc/systemd/system/lexislocal.service <<UNIT
[Unit]
Description=LexisLocal backend (remote test)
After=network-online.target ollama.service
[Service]
WorkingDirectory=/opt/LexisLocal
Environment=NODE_OPTIONS=${NODE_HEAP:+--max-old-space-size=$NODE_HEAP}
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
Adresa je: $ADDR_NOTE
Token:    $( [ "$TOKEN_NOTE" = "náhodný pro tento běh" ] && echo "$TOKEN" || echo "$TOKEN_NOTE — v prohlížeči už je uložený, pokud jde i o stejnou adresu" )
Otisk certifikátu (SHA-256): $FP
Model:    $CHAT_MODEL   ·   server se sám vypne: $(date -d "+$MAX_MINUTES min" -Is)
Prohlížeč ukáže varování (self-signed certifikát) → Pokročilé → Pokračovat. Ověř, že otisk sedí.
Token vlož v aplikaci do nastavení připojení (pole API token).
LexisEditor: Nastavení → 🔐 Spárovat → vlož tento odkaz (obsahuje token — nesdílet):
lexis://$PUBLIC_IP/?fp=$PIN&token=$( [ "$TOKEN_NOTE" = "náhodný pro tento běh" ] && echo "$TOKEN" || echo "<token z SSM>" )
CONN
upload

# 5) Báze zákonů → znalostní báze rešeršníka (přes API, jako u skutečné instalace)
KB_LAWS=/opt/zakony
if [ -n "${KB_ARCHIVE_S3:-}" ] && [ -n "$AWS" ]; then
  # Plná báze z archivu (zakony/<zákon>/, judikatura-ns/, judikatura-us/, judikatura-nss/)
  mkdir -p /opt/kb && "$AWS" s3 cp "$KB_ARCHIVE_S3" /opt/kb/kb.tar.gz --only-show-errors \
    && tar -xzf /opt/kb/kb.tar.gz -C /opt/kb && rm -f /opt/kb/kb.tar.gz \
    && KB_LAWS=/opt/kb/zakony && echo "=== báze z archivu $KB_ARCHIVE_S3: $(ls /opt/kb/zakony | wc -l) zákonů, $(find /opt/kb -name '*.txt' | wc -l) souborů" \
    || echo "!! archiv báze $KB_ARCHIVE_S3 nejde stáhnout — jen zákony z repozitáře"
fi
[ "$KB_LAWS" = /opt/zakony ] && mkdir -p /opt/zakony && tar -xzf "$KB" -C /opt/zakony
for d in "$KB_LAWS"/*/; do
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
# 5c) Judikatura NS, ÚS, NSS z archivu → báze rešeršníka (jako na Macu: seed-kb --dir ./judikatura-…)
for d in /opt/kb/judikatura-ns /opt/kb/judikatura-us /opt/kb/judikatura-nss; do
  [ -d "$d" ] || continue
  echo "=== seed $(basename "$d") ($(ls "$d" | wc -l) souborů) $(date -Is)"
  NODE_TLS_REJECT_UNAUTHORIZED=0 node backend/scripts/seed-kb.js --agent resersnik --dir "$d" \
    --api https://127.0.0.1 --token "$TOKEN" --delay 0 2>&1 | tail -n 3
  upload
done
echo "=== báze naplněna $(date -Is)"
EMB_AFTER=$( [ -f "$EMB_FILE" ] && wc -l < "$EMB_FILE" || echo 0)
echo "=== cache vektorů: nově spočítáno $((EMB_AFTER - EMB_BEFORE)), celkem $EMB_AFTER"
if [ -n "$AWS" ] && [ "${EMBED_CACHE:-1}" = "1" ] && [ "$EMB_AFTER" -gt "$EMB_BEFORE" ]; then
  gzip -c "$EMB_FILE" > "$EMB_FILE.up.gz" && "$AWS" s3 cp "$EMB_FILE.up.gz" "$EMB_S3" --only-show-errors \
    && echo "=== cache vektorů uložena do S3 ($(du -h "$EMB_FILE.up.gz" | cut -f1))" || echo "!! cache vektorů: upload selhal"
  rm -f "$EMB_FILE.up.gz"
fi
echo "Báze zákonů naplněna: $(date -Is)" >> "$OUT/_connect.txt"
upload

if [ "$PROFILE" = "judikatura" ]; then
  # Studený start BEZ cache vektorů (ta drží ~300 tis. vektorů v paměti a zkreslila by měření):
  # kolik paměti backend s plnou bází opravdu potřebuje → velikost RAM Mac mini.
  mem() { local p; p=$(systemctl show -p MainPID --value lexislocal); { echo "== $(date -Is) $1"; free -m; echo "backend RSS MB: $(( $(ps -o rss= -p "$p" 2>/dev/null || echo 0) / 1024 ))"; } >> "$OUT/pamet.log"; }
  mem "po naplnění (s cache vektorů)"
  sed -i '/^EMBED_CACHE_FILE=/d' /opt/LexisLocal/.env
  T0=$(date +%s); systemctl restart lexislocal
  for i in $(seq 1 120); do curl -sfk -H "X-API-Token: $TOKEN" https://127.0.0.1/api/status >/dev/null && break; sleep 2; done
  echo "=== studený start: API po $(( $(date +%s) - T0 )) s" | tee -a "$OUT/pamet.log"
  sleep 120; mem "studený start + předehřátí báze (2 min)"
  echo "=== kb_regression start $(date -Is)"
  ( cd /opt/LexisLocal && EMBED_CACHE_FILE= NODE_OPTIONS=--max-old-space-size=8192 timeout 90m \
      node backend/scripts/kb_regression.js --limit 0 --sample 30 --pool-compare 15 ) > "$OUT/kb_regression.log" 2>&1 \
    || echo "!! kb_regression skončil s chybou (viz kb_regression.log)"
  cp /opt/LexisLocal/bench-results/kb_regression_* "$OUT/" 2>/dev/null
  tail -n 25 "$OUT/kb_regression.log"; mem "po kb_regression"
  upload
fi

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
    --label server-loopback --out "$OUT/suite" --repeat "${SUITE_REPEAT:-1}" 2>&1 | tail -n 60 || echo "!! server_suite skončil s chybou"
  echo "=== server_suite hotovo $(date -Is)"
  [ "$PROFILE" = "judikatura" ] && mem "po server_suite"
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
    for lm in $(ollama ps 2>/dev/null | awk 'NR>1 && $1!="" {print $1}' | grep -v "^$EMBED_MODEL"); do ollama stop "$lm" 2>/dev/null; done
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
if [ "${STOP_AFTER_TESTS:-0}" = "1" ]; then
  # 4. 10. 2026: profil kompletni pak 2,5 h jen čekal na limit (bez tokenu ho nikdo nepoužil).
  echo "=== testy hotové, výsledky nahrány — instance se vypne a smaže $(date -Is)"
  upload
  shutdown -h +3 "LexisLocal remote test: testy hotové"
else
  echo "=== připraveno pro vzdálený test, server běží do vypnutí $(date -Is)"
fi
wait "$SYNC_PID"
