#!/usr/bin/env bash
#
# doplnit-judikaturu-mezery.sh — CÍLENÉ dohnání 5 pod-témat, která eval našel
# jako prázdná (žádný relevantní judikát ve správném oboru). Doplněk k
# naplnit-judikaturu.sh: nestahuje celé obory znovu, jen chybějící témata
# distinktivním klíčovým slovem přes VÍC ročníků (mezery bývají tenké).
#
# Mezery (label → scope → klíč. slovo v metadatech soudu):
#   daňové — ručení za nezaplacenou DPH   → _kb_obor_danove_a_financni_pravo   → "ručení"
#   insolvenční — neúčinné právní jednání → _kb_obor_insolvencni_pravo         → "neúčinnost" | "odporovatelnost"
#   náhrada škody — vada výrobku          → _kb_obor_nahrada_skody_a_odpovednost→ "vada výrobku" | "výrobce"
#   rodinné — popření otcovství           → _kb_obor_rodinne_pravo             → "otcovství"
#   spotřebitelské — rozhodčí doložka     → _kb_obor_spotrebitelske_pravo      → "rozhodčí"
#
# POZOR: keyword se matchuje jako substring proti METADATŮM (klíčová slova /
# předmět / sp. zn.), NE proti plnému textu → volíme krátké distinktivní tokeny.
# „ručení za DPH" je z drtivé části agenda NSS a ta v open-data obecných soudů
# NENÍ → tenhle obor z tohoto zdroje nejspíš zůstane tenký (ber ze Sbírky/NALUS).
#
# Spouštěj U SEBE (má síť na justice.cz), z adresáře backend/:
#     bash doplnit-judikaturu-mezery.sh
#
set -u

YEARS="${YEARS:-2021 2022 2023 2024}"   # mezery bývají tenké → víc ročníků
LIMIT="${LIMIT:-150}"                   # max. rozhodnutí na JEDEN běh (rok × keyword)
DELAY="${DELAY:-350}"                   # pauza mezi dokumenty (ms) — slušnost k serveru
OUT="${OUT:-./judikatura}"              # stejný kořen jako naplnit-judikaturu.sh
FETCH="scripts/fetch-judikatura.js"
SEED="scripts/seed-kb.js"

if [ ! -f "$FETCH" ]; then
  echo "❌ Nenašel jsem $FETCH — spusť skript z adresáře 'backend/'." >&2
  exit 1
fi

# Obor (= název složky) :: keyword1|keyword2 …  (každý keyword = jeden běh do stejné složky)
GAPS=(
  "Daňové a finanční právo::ručení"
  "Insolvenční právo::neúčinnost|odporovatelnost"
  "Náhrada škody a odpovědnost::vada výrobku|výrobce"
  "Rodinné právo::otcovství"
  "Spotřebitelské právo::rozhodčí"
)

echo "📥 Doháním MEZERY | ročníky: $YEARS | limit $LIMIT/běh | výstup $OUT"
echo "   Témat: ${#GAPS[@]} | zdroj: open-data MSp (obecné soudy)"
echo

for entry in "${GAPS[@]}"; do
  label="${entry%%::*}"
  kws="${entry##*::}"
  mkdir -p "$OUT/$label"
  IFS='|' read -r -a KW <<< "$kws"
  for y in $YEARS; do
    for kw in "${KW[@]}"; do
      echo "→ [$label] rok $y | keyword \"$kw\""
      node "$FETCH" --year "$y" --keyword "$kw" --out "$OUT/$label" --limit "$LIMIT" --delay "$DELAY" \
        || echo "   ⚠️ běh selhal (rok $y, \"$kw\") — pokračuji"
    done
  done
done

echo
echo "✅ Stahování dokončeno. Obsah dotčených složek:"
for entry in "${GAPS[@]}"; do
  label="${entry%%::*}"
  n=$(find "$OUT/$label" -type f 2>/dev/null | wc -l | tr -d ' ')
  printf "   %-38s %s souborů\n" "$label" "$n"
done

cat <<EOF

────────────────────────────────────────────────────────────────
HOTOVO. Naseeduj JEN dotčené obory (idempotentní — nezdvojí):

    node $SEED --obor "Daňové a finanční právo"      --dir "$OUT/Daňové a finanční právo"
    node $SEED --obor "Insolvenční právo"            --dir "$OUT/Insolvenční právo"
    node $SEED --obor "Náhrada škody a odpovědnost"  --dir "$OUT/Náhrada škody a odpovědnost"
    node $SEED --obor "Rodinné právo"                --dir "$OUT/Rodinné právo"
    node $SEED --obor "Spotřebitelské právo"         --dir "$OUT/Spotřebitelské právo"

  (potřebuje-li seed-kb token: přidej --token-file ~/.lexislocal/api_token)

Pak přeměř dopad na golden setu:
    node scripts/rag_eval_sweep.js backend/eval/rag_eval_expanded.json
────────────────────────────────────────────────────────────────
EOF
