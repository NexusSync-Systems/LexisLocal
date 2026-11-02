#!/bin/bash
# lexislocal-sluzba.sh — LexisLocal jako služba macOS (launchd): start po přihlášení, restart po pádu.
#
#   bash scripts/mac/lexislocal-sluzba.sh instaluj     # založí službu, spustí ji a dá na plochu odkaz na dashboard
#   bash scripts/mac/lexislocal-sluzba.sh stav         # běží? PID, poslední řádky logu
#   bash scripts/mac/lexislocal-sluzba.sh restart      # např. po změně .env
#   bash scripts/mac/lexislocal-sluzba.sh zastav       # do příštího přihlášení / spuštění
#   bash scripts/mac/lexislocal-sluzba.sh spust
#   bash scripts/mac/lexislocal-sluzba.sh log          # průběžný log (Ctrl+C ukončí)
#   bash scripts/mac/lexislocal-sluzba.sh odinstaluj   # odebere službu (data a nastavení zůstávají)
#
# Server běží pod uživatelem, který službu nainstaloval (LaunchAgent, žádná práva správce). Pracovní složka =
# kořen LexisLocalu, takže se načte jeho .env (backend/lib/env_load.js). Zastavení posílá SIGTERM → server
# dopíše odložené zápisy báze. Log: ~/Library/Logs/LexisLocal/server.log. Viz docs/PILOT_CLOUDSHELL.md.
set -euo pipefail

LABEL="eu.nexusstack.lexislocal"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/LexisLocal"
DOMAIN="gui/$(id -u)"

[ "$(uname -s)" = "Darwin" ] || { echo "Jen pro macOS."; exit 2; }

DATAENV="$HOME/Library/Application Support/LexisLocal/.env"   # balíček z GitHubu / aplikace z .dmg (backend/lib/env_load.js)
env_hodnota() { cat "$ROOT/.env" "$DATAENV" 2>/dev/null | grep -E "^$1=" | head -1 | cut -d= -f2 | tr -d '"' || true; }
port_url() {
  local port https
  port=$(env_hodnota PORT)
  https=$(env_hodnota USE_HTTPS)
  [ -n "$port" ] || port=4000
  if [ "$https" = "true" ]; then echo "https://127.0.0.1:$port"; else echo "http://127.0.0.1:$port"; fi
}

bezi() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

cekej_na_api() {
  local url; url="$(port_url)"
  for _ in $(seq 1 60); do
    code=$(curl -sk -o /dev/null -w '%{http_code}' "$url/api/status" || true)
    case "$code" in 200|401|403) echo "  ✓ server odpovídá na $url (HTTP $code)"; return 0 ;; esac
    sleep 2
  done
  echo "  ✗ server do 2 min neodpověděl — viz: bash scripts/mac/lexislocal-sluzba.sh log"; return 1
}

case "${1:-}" in
instaluj)
  # Balíček z GitHubu má vlastní Node.js (node/bin/node); instalace ze zdrojů používá systémový.
  if [ -x "$ROOT/node/bin/node" ]; then NODE="$ROOT/node/bin/node"; else NODE="$(command -v node || true)"; fi
  [ -n "$NODE" ] || { echo "Chybí Node.js (nodejs.org, verze 22 LTS)."; exit 1; }
  V=$("$NODE" -v | cut -c2- | cut -d. -f1)
  { [ "$V" -ge 20 ] && [ "$V" -lt 25 ]; } || { echo "Node.js $("$NODE" -v) — podporované 20–24 (doporučeno 22 LTS)."; exit 1; }
  [ -f "$ROOT/backend/server.js" ] || { echo "Nenalezen backend/server.js v $ROOT"; exit 1; }
  [ -d "$ROOT/node_modules" ] || { echo "Chybí node_modules — nejdřív: cd \"$ROOT\" && npm ci"; exit 1; }
  [ -f "$ROOT/.env" ] || [ -f "$DATAENV" ] || echo "  ! chybí .env (v $ROOT ani v datové složce) — server poběží s výchozím nastavením (docs/PILOT_CLOUDSHELL.md, C4)"
  mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>--max-old-space-size=8192</string><string>$ROOT/backend/server.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string><key>NODE_ENV</key><string>production</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOGDIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/server.log</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
  bezi && launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "✓ služba $LABEL nainstalovaná (start po přihlášení, restart po pádu)"
  cekej_na_api || true
  URL="$(port_url)"
  cat > "$HOME/Desktop/LexisLocal.webloc" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>$URL/</string></dict></plist>
EOF
  echo "✓ na ploše je odkaz LexisLocal → $URL (přetáhnout do Docku)"
  ;;
stav)
  if bezi; then
    launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code|runs) ' | sed 's/^\s*/  /'
    cekej_na_api || true
  else echo "Služba neběží / není nainstalovaná."; fi
  [ -f "$LOGDIR/server.log" ] && { echo "--- poslední řádky logu"; tail -n 15 "$LOGDIR/server.log"; }
  ;;
restart) launchctl kickstart -k "$DOMAIN/$LABEL" && cekej_na_api ;;
zastav)  launchctl bootout "$DOMAIN/$LABEL" && echo "✓ zastaveno (znovu: spust, nebo po příštím přihlášení)" ;;
spust)   bezi || launchctl bootstrap "$DOMAIN" "$PLIST"; cekej_na_api ;;
log)     tail -n 50 -f "$LOGDIR/server.log" ;;
odinstaluj)
  bezi && launchctl bootout "$DOMAIN/$LABEL" || true
  [ -f "$PLIST" ] && mv "$PLIST" "$PLIST.odebrano"
  echo "✓ služba odebrána (data, .env a báze zůstávají; plist přejmenován na $PLIST.odebrano)"
  ;;
*) sed -n '2,15p' "$0"; exit 2 ;;
esac
