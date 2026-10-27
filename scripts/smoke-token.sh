#!/usr/bin/env bash
# smoke-token.sh — ověří, že vynucení API tokenu funguje, ANIŽ by hrozilo trvalé
# zamčení aplikace. Spustí backend s LEXIS_ENFORCE_TOKEN=1, otestuje že:
#   • /api/status BEZ tokenu vrátí 401,
#   • /api/status S tokenem vrátí 200,
# a pak backend zase vypne. Výchozí stav appky se NEMĚNÍ.
#
# Použití:   bash scripts/smoke-token.sh
# Nouzový vypínač (kdyby cokoli): vynucení je aktivní jen po dobu běhu tohoto skriptu.
set -u

PORT="${PORT:-4000}"
KEYDIR="${LEXIS_KEY_DIR:-$HOME/.lexislocal}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/backend" || { echo "❌ Nenašel jsem backend/"; exit 1; }

echo "▶ Spouštím backend s vynuceným tokenem (LEXIS_ENFORCE_TOKEN=1, port $PORT)…"
LEXIS_ENFORCE_TOKEN=1 PORT="$PORT" node server.js > /tmp/lexis_smoke.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

# Počkej, až server naběhne (max ~10 s).
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:$PORT/index.html"; then break; fi
  sleep 0.5
done

TOKEN="${API_TOKEN:-}"
[ -z "$TOKEN" ] && [ -f "$KEYDIR/api_token" ] && TOKEN="$(cat "$KEYDIR/api_token")"
if [ -z "$TOKEN" ]; then
  echo "❌ Nepodařilo se získat token (ani z env API_TOKEN, ani z $KEYDIR/api_token)."
  echo "   Log serveru:"; tail -n 20 /tmp/lexis_smoke.log; exit 1
fi
echo "🔑 Token …${TOKEN: -6} (celý v souboru tokenu, nevypisuje se)"

echo "▶ Test 1: /api/status BEZ tokenu (očekávám 401)…"
C1=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/status")
echo "   → HTTP $C1"

echo "▶ Test 2: /api/status S tokenem (očekávám 200)…"
C2=$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Token: $TOKEN" "http://localhost:$PORT/api/status")
echo "   → HTTP $C2"

echo
if [ "$C1" = "401" ] && [ "$C2" = "200" ]; then
  echo "✅ SMOKE OK — vynucení tokenu funguje (401 bez tokenu, 200 s tokenem)."
  echo
  echo "Další (ruční) krok:"
  echo "  1) Nech tenhle backend běžet (nebo ho spusť znovu s LEXIS_ENFORCE_TOKEN=1)."
  echo "  2) Otevři LexisEditor a zkus AI dotaz na LexisLocal (Rešeršník/Kontrolor)."
  echo "     Editor si token bere sám ze souboru — nemělo by být potřeba nic vkládat."
  echo "  3) Když AI dotaz projde, můžeš vynucení zapnout natrvalo:"
  echo "       - buď nastav API_TOKEN v prostředí backendu,"
  echo "       - nebo v server.js přepni default ENFORCE_TOKEN na true."
  echo "     Nouzový vypínač: LEXIS_ENFORCE_TOKEN=0 (nebo API_TOKEN nenastavovat)."
  RC=0
else
  echo "❌ SMOKE SELHAL (čekáno 401/200, dostal jsem $C1/$C2). Vynucení NEZAPÍNEJ."
  echo "   Log serveru:"; tail -n 20 /tmp/lexis_smoke.log
  RC=1
fi
echo "▶ Vypínám testovací backend."
exit $RC
