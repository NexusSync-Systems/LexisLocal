#!/usr/bin/env bash
#
# naplnit-judikaturu.sh — hromadné naplnění oborových RAGů judikaturou.
#
# Co dělá:
#   1) pro každý PRÁVNÍ OBOR stáhne z open-data Ministerstva spravedlnosti
#      (obecné soudy: okresní / krajské / vrchní) anonymizovaná rozhodnutí,
#      filtrovaná klíčovým slovem oboru, do složky pojmenované PŘESNĚ podle
#      oboru (název složky → slug → partition `_kb_obor_<slug>`),
#   2) na závěr vypíše jediný příkaz, kterým vše nahraješ do RAGu
#      (scripts/seed-kb.js --root), který si po kontrole spustíš sám.
#
# Spouštěj U SEBE (má síť na justice.cz), z adresáře backend/:
#     bash naplnit-judikaturu.sh
#
# Pozn.: NS / NSS / ÚS v open-data NEJSOU (ber je ze Sbírky / NALUS). Obory
# převážně řešené u NSS/ÚS (daňové, správní, ústavní, GDPR) proto z tohoto
# zdroje vyjdou tenčí — u nich klidně zvyš --year o starší ročníky nebo doplň
# ručně. Nemovitosti/nájem už máš naplněné, proto tu nejsou.

set -u

# ------------------------------------------------------------------ nastavení
YEAR="${YEAR:-2024}"          # ročník (open-data od cca 2020); přepiš: YEAR=2023 bash ...
LIMIT="${LIMIT:-150}"         # max. rozhodnutí na JEDEN běh (na klíčové slovo)
DELAY="${DELAY:-350}"         # pauza mezi dokumenty (ms) — buď slušný k serveru
OUT="${OUT:-./judikatura}"    # kam ukládat (podsložky = obory)
FETCH="scripts/fetch-judikatura.js"
SEED="scripts/seed-kb.js"

if [ ! -f "$FETCH" ]; then
  echo "❌ Nenašel jsem $FETCH — spusť skript z adresáře 'backend/'." >&2
  exit 1
fi

# Obor  =  "Název oboru (= název složky)::klíčové_slovo_1|klíčové_slovo_2"
# Každé klíčové slovo = jeden běh harvesteru do stejné složky (rozšíří záběr).
OBORY=(
  "Občanské právo::promlčení|bezdůvodné obohacení"
  "Rodinné právo::výživné|péče o dítě"
  "Dědické právo::dědictví|závěť"
  "Pracovní právo::pracovní poměr|výpověď"
  "Obchodní a korporátní právo::obchodní korporace|jednatel"
  "Insolvenční právo::insolvence|oddlužení"
  "Trestní právo::trestný čin|obžaloba"
  "Správní právo::správní řízení|přestupek"
  "Náhrada škody a odpovědnost::náhrada škody|nemajetková újma"
  "Spotřebitelské právo::spotřebitel|reklamace"
  "Právo duševního vlastnictví::autorské právo|ochranná známka"
  "Daňové a finanční právo::daňové řízení|daň z příjmů"
  "Ústavní právo a lidská práva::diskriminace|základní práva"
  "Ochrana osobních údajů (GDPR)::osobní údaje|ochrana osobních údajů"
)

echo "📥 Naplňuji judikaturu | ročník $YEAR | limit $LIMIT/běh | výstup $OUT"
echo "   Obory: ${#OBORY[@]} | zdroj: open-data MSp (obecné soudy)"
echo

for entry in "${OBORY[@]}"; do
  label="${entry%%::*}"
  kws="${entry#*::}"
  echo "── ⚖️  $label ───────────────────────────────"
  # rozdel klíčová slova podle '|'
  IFS='|' read -r -a kwarr <<< "$kws"
  for kw in "${kwarr[@]}"; do
    echo "   → klíčové slovo: \"$kw\""
    node "$FETCH" --year "$YEAR" --keyword "$kw" \
         --out "$OUT/$label" --limit "$LIMIT" --delay "$DELAY" \
      || echo "   ⚠️  běh pro \"$kw\" skončil chybou (pokračuji dál)"
  done
  echo
done

echo "✅ Stahování dokončeno. Obsah složek:"
if command -v find >/dev/null 2>&1; then
  for entry in "${OBORY[@]}"; do
    label="${entry%%::*}"
    n=$(find "$OUT/$label" -type f 2>/dev/null | wc -l | tr -d ' ')
    printf "   %-42s %s souborů\n" "$label" "$n"
  done
fi

cat <<EOF

────────────────────────────────────────────────────────────────
HOTOVO. Teď to nahraj do oborových RAGů (zkontroluj a spusť sám):

    node $SEED --root "$OUT"

  • --root: každá PODSLOŽKA = jeden obor → partition _kb_obor_<slug>
  • pokud tvůj seed-kb vyžaduje API token, přidej:  --token-file <cesta>
  • běží idempotentně (stejný soubor přepíše, ne zdvojí)

Kontrola v aplikaci: záložka „AI Asistenti" → panel „⚖️ Pokrytí judikatury"
(tlačítko 🔄). Naplněné obory zezelenají.
────────────────────────────────────────────────────────────────
EOF
