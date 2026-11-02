#!/bin/bash
# instaluj-balicek.sh — LexisLocal na Macu z balíčku na GitHubu (bez gitu, bez instalace Node.js).
#
#   curl -fsSLO https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/mac/instaluj-balicek.sh
#   bash instaluj-balicek.sh instaluj [--verze v1.2.1] [--sha256 <součet>]   # stáhne, ověří, rozbalí, založí .env a službu
#   bash instaluj-balicek.sh aktualizuj [--verze …]      # novější balíček; když nová verze nenaběhne, vrátí předchozí
#   bash instaluj-balicek.sh zpet                         # přepne na předchozí nainstalovanou verzi
#   bash instaluj-balicek.sh stav                         # nainstalované verze, která běží
#
# Balíček (lexislocal-macos-arm64.tar.gz) sestavuje GitHub Actions (.github/workflows/pilot-balicek.yml) pro Apple
# Silicon: aplikace, závislosti a vlastní Node.js. Verze leží v ~/Applications/LexisLocal/verze/<verze>,
# odkaz ~/Applications/LexisLocal/aktualni ukazuje na běžící. Nastavení (.env), data, báze a klíče jsou mimo
# (~/Library/Application Support/LexisLocal, ~/.aws) — aktualizace je nemění. Viz docs/PILOT_CLOUDSHELL.md.
#
# Ověření (revize 2. 11. 2026): součet .sha256 z téhož release chrání jen před poškozeným stažením. Proti podvrženému
# release: dodavatel ověří atestaci původu (gh attestation verify … --repo NexusSync-Systems/LexisLocal) a součet předá
# instalaci přes --sha256 — ta pak balíček s jiným obsahem odmítne. Karanténa macOS se neruší (curl ji nenastavuje).
set -euo pipefail

REPO="NexusSync-Systems/LexisLocal"
ASSET="lexislocal-macos-arm64.tar.gz"
BASE="$HOME/Applications/LexisLocal"
AKT="$BASE/aktualni"
DATA="$HOME/Library/Application Support/LexisLocal"
PONECHAT=3

[ "$(uname -s)" = "Darwin" ] || { echo "Jen pro macOS."; exit 2; }
[ "$(uname -m)" = "arm64" ] || { echo "Balíček je pro Apple Silicon (arm64), tento Mac je $(uname -m)."; exit 2; }

PRIKAZ="${1:-}"; shift || true
VERZE=""; SHA_OVERENY=""
while [ $# -gt 0 ]; do case "$1" in --verze) VERZE="${2:-}"; shift 2 ;; --sha256) SHA_OVERENY="${2:-}"; shift 2 ;; *) echo "Neznámý přepínač: $1"; exit 2 ;; esac; done
[ -z "$SHA_OVERENY" ] || [[ "$SHA_OVERENY" =~ ^[0-9a-f]{64}$ ]] || { echo "--sha256 musí být 64 hex znaků"; exit 2; }
[ -z "$VERZE" ] || [[ "$VERZE" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || { echo "Neplatná verze: $VERZE"; exit 2; }

url() { if [ -n "$VERZE" ]; then echo "https://github.com/$REPO/releases/download/$VERZE/$1"; else echo "https://github.com/$REPO/releases/latest/download/$1"; fi; }
sluzba() { bash "$AKT/scripts/mac/lexislocal-sluzba.sh" "$@"; }

stahni() {   # → do $NOVA rozbalená nová verze
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  echo "… stahuji $(url "$ASSET")"
  curl -fL --retry 3 -o "$TMP/$ASSET" "$(url "$ASSET")"
  curl -fsSL --retry 3 -o "$TMP/$ASSET.sha256" "$(url "$ASSET.sha256")"
  OCEK=$(awk '{print $1}' "$TMP/$ASSET.sha256"); SKUT=$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
  [ "$OCEK" = "$SKUT" ] || { echo "✗ Kontrolní součet nesedí ($SKUT ≠ $OCEK) — balíček nepoužiji."; exit 1; }
  if [ -n "$SHA_OVERENY" ]; then
    [ "$SKUT" = "$SHA_OVERENY" ] || { echo "✗ Balíček neodpovídá ověřenému součtu (--sha256) — nepoužiji ho."; exit 1; }
    echo "✓ SHA-256 sedí s ověřeným součtem (--sha256)"
  else
    echo "✓ SHA-256 sedí se součtem v release  (! bez --sha256 není ověřeno, že release je od nás — viz hlavička skriptu)"
  fi
  tar -xzf "$TMP/$ASSET" -C "$TMP"
  [ -f "$TMP/lexislocal/VERSION" ] && [ -x "$TMP/lexislocal/node/bin/node" ] || { echo "✗ Balíček nemá očekávaný obsah."; exit 1; }
  V="$(head -1 "$TMP/lexislocal/VERSION" | tr -cd 'A-Za-z0-9._-')"
  mkdir -p "$BASE/verze"
  NOVA="$BASE/verze/$V"
  if [ -d "$NOVA" ]; then echo "  verze $V už je nainstalovaná — použiji ji"; else mv "$TMP/lexislocal" "$NOVA"; fi
  "$NOVA/node/bin/node" -v >/dev/null || { echo "✗ Přibalený Node.js nejde spustit."; exit 1; }
}

prepni() { ln -sfn "$1" "$AKT.novy" && mv -fh "$AKT.novy" "$AKT"; }

uklid() {
  local akt; akt="$(readlink "$AKT" || true)"
  # nejstarší verze nad limit (kromě běžící)
  ls -1t "$BASE/verze" 2>/dev/null | tail -n +$((PONECHAT + 1)) | while read -r v; do
    [ "$BASE/verze/$v" = "$akt" ] && continue
    rm -rf "${BASE:?}/verze/$v" && echo "  odstraněna stará verze $v"
  done
}

env_sablona() {
  mkdir -p "$DATA"; chmod 700 "$DATA"
  if [ -f "$DATA/.env" ]; then echo "✓ nastavení $DATA/.env už existuje — nechávám"; return; fi
  umask 077
  cat > "$DATA/.env" <<'EOF'
# LexisLocal — pilot „jen cloud“ (docs/PILOT_CLOUDSHELL.md, C4). Přístup k AWS je v ~/.aws/credentials [lexislocal-pilot].
LEXIS_PILOT_LOCAL_ONLY=0
LEXIS_JEN_CLOUD=1
AI_CHAT_PROVIDER=bedrock
AI_EMBED_PROVIDER=onnx
EMBEDDING_MODEL=bge-m3
AWS_PROFILE=lexislocal-pilot
BEDROCK_REGION=eu-central-1
BEDROCK_MODEL_ID=eu.anthropic.claude-sonnet-4-6
RAG_RERANK=1
RAG_RERANK_PROVIDER=bedrock
BEDROCK_RERANK_MODEL=cohere.rerank-v3-5:0
BEDROCK_RERANK_RPM=3
RAG_QUERY_TERMS=1
LEXIS_AWS_BILLING_SYNC=0
EOF
  echo "✓ založeno nastavení $DATA/.env (pilot jen cloud)"
}

case "$PRIKAZ" in
instaluj)
  stahni
  prepni "$NOVA"
  env_sablona
  [ -f "$HOME/.aws/credentials" ] && grep -q '^\[lexislocal-pilot\]' "$HOME/.aws/credentials" \
    || echo "  ! v ~/.aws/credentials chybí [lexislocal-pilot] — doplnit klíč (docs/PILOT_CLOUDSHELL.md, C2), pak: bash \"$AKT/scripts/mac/lexislocal-sluzba.sh\" restart"
  sluzba instaluj
  echo
  echo "✓ LexisLocal $(cat "$AKT/VERSION") nainstalován v $AKT"
  echo "  Báze zákonů:  \"$AKT/node/bin/node\" \"$AKT/backend/scripts/kb-balicek.js\" --instaluj ~/Downloads/lexis-baze-*.tar.gz   (služba musí být zastavená)"
  echo "  Kontrola:     \"$AKT/node/bin/node\" \"$AKT/backend/scripts/aws-pilot-test.js\" --bez-ce"
  ;;
aktualizuj)
  [ -L "$AKT" ] || { echo "LexisLocal z balíčku není nainstalovaný — použijte: instaluj"; exit 1; }
  STARA="$(readlink "$AKT")"
  stahni
  if [ "$NOVA" = "$STARA" ]; then echo "✓ Už je aktuální: $(cat "$AKT/VERSION")"; exit 0; fi
  echo "… $(head -1 "$STARA/VERSION") → $(head -1 "$NOVA/VERSION") (server bude ~1 min nedostupný)"
  sluzba zastav || true
  prepni "$NOVA"
  if sluzba spust && (cd "$AKT" && "$AKT/node/bin/node" backend/scripts/bedrock-check.js >/dev/null); then
    echo "✓ Aktualizováno na $(cat "$AKT/VERSION")"; uklid
  else
    echo "✗ Nová verze nenaběhla nebo neprošla kontrolou — vracím $(head -1 "$STARA/VERSION")"
    sluzba zastav || true; prepni "$STARA"; sluzba spust || true; exit 1
  fi
  ;;
zpet)
  AKTV="$(readlink "$AKT" || true)"
  PRED=""
  # shellcheck disable=SC2045  # názvy verzí jsou očištěné (A-Za-z0-9._-), řadí se podle času
  for d in $(ls -1dt "$BASE"/verze/* 2>/dev/null); do [ "$d" != "$AKTV" ] && { PRED="$d"; break; }; done
  [ -n "$PRED" ] || { echo "Žádná předchozí verze."; exit 1; }
  sluzba zastav || true; prepni "$PRED"; sluzba spust
  echo "✓ Běží $(cat "$AKT/VERSION")"
  ;;
stav)
  echo "Běží: $(cat "$AKT/VERSION" 2>/dev/null || echo '—') ($(readlink "$AKT" 2>/dev/null || echo 'neinstalováno'))"
  echo "Nainstalované verze:"; ls -1t "$BASE/verze" 2>/dev/null | sed 's/^/  /'
  [ -L "$AKT" ] && sluzba stav || true
  ;;
*) sed -n '2,14p' "$0"; exit 2 ;;
esac
