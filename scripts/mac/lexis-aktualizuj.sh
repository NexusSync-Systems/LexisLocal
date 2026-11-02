#!/bin/bash
# lexis-aktualizuj.sh — aktualizace LexisLocalu na Macu v pilotu (instalace ze zdrojů + služba launchd).
#
#   bash scripts/mac/lexis-aktualizuj.sh              # stáhne novou verzi, otestuje, restartuje službu
#   bash scripts/mac/lexis-aktualizuj.sh --kontrola   # jen ukáže, co je nového (nic nemění)
#
# Postup: kontrola, že instalace nemá ručně změněné soubory → zastavení služby → git (jen fast-forward z větve,
# na které instalace je) → npm ci jen při změně závislostí → testy → start. Když testy neprojdou, vrátí se
# předchozí verze (i závislosti) a spustí se ta. .env, data, báze a klíče se nemění (nejsou v gitu).
# Spouštět mimo pracovní dobu — server je během aktualizace (~3–6 min) nedostupný. Log: ~/Library/Logs/LexisLocal/aktualizace.log
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SLUZBA="$ROOT/scripts/mac/lexislocal-sluzba.sh"
LOG="$HOME/Library/Logs/LexisLocal/aktualizace.log"
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
echo "=== aktualizace $(date '+%Y-%m-%d %H:%M:%S') v $ROOT"
cd "$ROOT"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✗ V instalaci jsou ručně změněné soubory — aktualizaci nespouštím:"; git status --short --untracked-files=no; exit 1
fi
OLD=$(git rev-parse HEAD)
git fetch --quiet origin
NEW=$(git rev-parse '@{u}')
if [ "$OLD" = "$NEW" ]; then echo "✓ Už je aktuální: $(git log -1 --format='%h %s (%cd)' --date=short)"; exit 0; fi
echo "Nové změny ($(git rev-list --count "$OLD..$NEW")):"; git log --oneline "$OLD..$NEW" | head -20
[ "${1:-}" = "--kontrola" ] && exit 0

ZAVISLOSTI=0
git diff --quiet "$OLD" "$NEW" -- package.json package-lock.json || ZAVISLOSTI=1

bash "$SLUZBA" zastav || true
vrat() {
  echo "✗ $1 — vracím předchozí verzi ${OLD:0:7}"
  git reset --quiet --hard "$OLD"
  [ "$ZAVISLOSTI" = "1" ] && npm ci --no-audit --no-fund >/dev/null
  bash "$SLUZBA" spust || true
  echo "✗ Aktualizace se nepovedla, běží původní verze. Log: $LOG"; exit 1
}
git merge --quiet --ff-only '@{u}' || vrat "git merge selhal"
if [ "$ZAVISLOSTI" = "1" ]; then echo "… změnily se závislosti, npm ci"; npm ci --no-audit --no-fund >/dev/null || vrat "npm ci selhal"; fi
echo "… testy (několik minut)"
npx jest --silent >"$HOME/Library/Logs/LexisLocal/aktualizace-testy.log" 2>&1 || { tail -n 30 "$HOME/Library/Logs/LexisLocal/aktualizace-testy.log"; vrat "testy neprošly"; }
grep -E '^Tests:' "$HOME/Library/Logs/LexisLocal/aktualizace-testy.log" || true
bash "$SLUZBA" spust || vrat "nová verze nenaběhla"
echo "✓ Aktualizováno ${OLD:0:7} → ${NEW:0:7}: $(git log -1 --format='%s')"
