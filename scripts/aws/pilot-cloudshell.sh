#!/bin/bash
# pilot-cloudshell.sh — nastavení AWS pro pilot LexisLocalu (režim jen cloud) z AWS CloudShellu.
#
# Spouští SPRÁVCE účtu v CloudShellu (konzole AWS → tlačítko CloudShell vlevo dole, region Frankfurt).
# CloudShell běží pod jeho přihlášením do konzole — žádné klíče na disku. Nic tajného skript neukládá;
# přístupový klíč vypíše jen příkaz `klic`, a to jednou na obrazovku.
#
#   curl -fsSLO https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/pilot-cloudshell.sh
#   bash pilot-cloudshell.sh ucet                         # 1× za účet: kontroly (a s --opravit nulové ukládání dat)
#   bash pilot-cloudshell.sh kancelar --zkratka novak --email kontakt@nexusstack.eu [--rozpocet 30]
#   bash pilot-cloudshell.sh klic --zkratka novak         # nový přístupový klíč pro Mac advokáta (zobrazí se jednou)
#   bash pilot-cloudshell.sh stav --zkratka novak         # stack, klíče (jen ID a stav), rozpočet
#   bash pilot-cloudshell.sh konec --zkratka novak [--smazat]   # konec pilotu: klíče vypnout (a se --smazat vše smazat)
#
# Viz docs/PILOT_CLOUDSHELL.md. Region je pevně eu-central-1 (Frankfurt), model Claude přes EU profil.
set -euo pipefail

REGION=eu-central-1
MODEL_ID="${BEDROCK_MODEL_ID:-eu.anthropic.claude-sonnet-4-6}"
RERANK_MODELY="cohere.rerank-v3-5:0 amazon.rerank-v1:0"
SABLONA_URL="https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/bedrock-eu-kancelar.yaml"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
chyba(){ printf '  \033[31m✗\033[0m %s\n' "$*"; CHYB=$((CHYB+1)); }
pozor(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
nadpis(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
CHYB=0

PRIKAZ="${1:-}"; shift || true
ZKRATKA=""; EMAIL=""; ROZPOCET=30; OPRAVIT=0; SMAZAT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --zkratka) ZKRATKA="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --rozpocet) ROZPOCET="${2:-}"; shift 2 ;;
    --opravit) OPRAVIT=1; shift ;;
    --smazat) SMAZAT=1; shift ;;
    *) echo "Neznámý přepínač: $1"; exit 2 ;;
  esac
done

potrebuj_zkratku() {
  [[ "$ZKRATKA" =~ ^[a-z0-9][a-z0-9-]{1,19}$ ]] || { echo "Zadejte --zkratka (malá písmena, číslice, pomlčka; 2–20 znaků), např. --zkratka novak"; exit 2; }
  UZIVATEL="lexislocal-pilot-$ZKRATKA"; STACK="lexislocal-pilot-$ZKRATKA"
}

UCET=$(aws sts get-caller-identity --query Account --output text)
KDO=$(aws sts get-caller-identity --query Arn --output text)
echo "Účet $UCET · přihlášen $KDO · region $REGION"

case "$PRIKAZ" in
# ---------------------------------------------------------------------------------------------------------
ucet)
  nadpis "1. Uchovávání dat Bedrocku (musí být „none“ — AWS dotazy neukládá)"
  MODE=$(aws bedrock get-account-data-retention --region "$REGION" --query mode --output text 2>/dev/null || echo "?")
  if [ "$MODE" = "none" ]; then ok "mode = none"
  elif [ "$OPRAVIT" = "1" ]; then
    aws bedrock put-account-data-retention --mode none --region "$REGION" >/dev/null
    MODE=$(aws bedrock get-account-data-retention --region "$REGION" --query mode --output text)
    [ "$MODE" = "none" ] && ok "nastaveno: mode = none" || chyba "nepodařilo se nastavit (mode = $MODE)"
  else chyba "mode = $MODE → spusťte znovu s --opravit (nastaví none)"; fi

  nadpis "2. Model invocation logging (musí být vypnuté — jinak by se ukládal obsah dotazů)"
  LOG=$(aws bedrock get-model-invocation-logging-configuration --region "$REGION" --query loggingConfig --output json 2>/dev/null || echo "?")
  if [ "$LOG" = "null" ] || [ -z "$LOG" ]; then ok "vypnuté"; else chyba "zapnuté: $LOG — vypnout v konzoli Bedrock → Settings"; fi

  nadpis "3. CloudTrail (záznam, kdo a kdy volal Bedrock — bez obsahu)"
  TRAILS=$(aws cloudtrail describe-trails --region "$REGION" --query 'length(trailList)' --output text)
  if [ "$TRAILS" != "0" ]; then ok "trailů: $TRAILS"; else pozor "žádný trail — historie událostí 90 dní je k dispozici i tak; pro delší evidenci založit trail"; fi

  nadpis "4. EU profil modelu $MODEL_ID míří jen do EU regionů"
  ARNS=$(aws bedrock get-inference-profile --region "$REGION" --inference-profile-identifier "$MODEL_ID" --query 'models[].modelArn' --output text 2>&1) || true
  if echo "$ARNS" | grep -q "arn:aws:bedrock"; then
    MIMO=$(echo "$ARNS" | tr '\t' '\n' | grep -v '^arn:aws:bedrock:eu-' || true)
    [ -z "$MIMO" ] && ok "$(echo "$ARNS" | tr '\t' '\n' | cut -d: -f4 | sort -u | tr '\n' ' ')" || chyba "mimo EU: $MIMO"
  else chyba "profil nelze přečíst: $ARNS"; fi

  nadpis "5. Claude odpovídá (syntetický dotaz, zlomek centu; první použití založí předplatné na Marketplace)"
  ODP=$(aws bedrock-runtime converse --region "$REGION" --model-id "$MODEL_ID" \
        --messages '[{"role":"user","content":[{"text":"Odpověz jedním slovem: kolik let trvá obecná promlčecí lhůta?"}]}]' \
        --query 'output.message.content[0].text' --output text 2>&1) || true
  if echo "$ODP" | grep -qiE 'error|exception|denied'; then chyba "$ODP"; else ok "odpověď: $ODP"; fi

  nadpis "6. Rerankery v EU (přeřazení výsledků vyhledávání; Cohere první volání správcem povolí pro celý účet)"
  for M in $RERANK_MODELY; do
    R=$(aws bedrock-agent-runtime rerank --region "$REGION" \
      --queries '[{"type":"TEXT","textQuery":{"text":"Jak dlouhá je promlčecí lhůta?"}}]' \
      --sources '[{"type":"INLINE","inlineDocumentSource":{"type":"TEXT","textDocument":{"text":"Promlčecí lhůta trvá tři roky."}}},{"type":"INLINE","inlineDocumentSource":{"type":"TEXT","textDocument":{"text":"Nájemce platí nájemné měsíčně."}}}]' \
      --reranking-configuration "{\"type\":\"BEDROCK_RERANKING_MODEL\",\"bedrockRerankingConfiguration\":{\"numberOfResults\":2,\"modelConfiguration\":{\"modelArn\":\"arn:aws:bedrock:$REGION::foundation-model/$M\"}}}" \
      --query 'results[0].index' --output text 2>&1) || true
    [ "$R" = "0" ] && ok "$M: správná věta na 1. místě" || chyba "$M: $R"
  done
  ;;
# ---------------------------------------------------------------------------------------------------------
kancelar)
  potrebuj_zkratku
  [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "Zadejte --email pro upozornění na rozpočet"; exit 2; }
  [[ "$ROZPOCET" =~ ^[0-9]+$ ]] || { echo "--rozpocet je celé číslo v USD"; exit 2; }
  nadpis "Stack $STACK (uživatel $UZIVATEL, rozpočet $ROZPOCET USD/měsíc, upozornění na $EMAIL)"
  curl -fsSL "$SABLONA_URL" -o bedrock-eu-kancelar.yaml
  aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file bedrock-eu-kancelar.yaml \
    --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset \
    --parameter-overrides "NazevUzivatele=$UZIVATEL" "MesicniRozpocetUSD=$ROZPOCET" "EmailUpozorneni=$EMAIL" "CteniNakladu=ne" \
    --tags aplikace=LexisLocal pilot="$ZKRATKA"
  ok "hotovo — uživatel $UZIVATEL smí jen Claude přes EU profil a rerankery v EU (náklady účtu NEvidí), rozpočet s upozorněním"
  echo "  Na Macu advokáta v .env: LEXIS_AWS_BILLING_SYNC=0 a test spouštět s --bez-ce (útratu hlídá: bash pilot-cloudshell.sh stav)"
  pozor "AWS pošle na $EMAIL potvrzení odběru upozornění rozpočtu — je potřeba ho potvrdit"
  echo "Další krok: bash pilot-cloudshell.sh klic --zkratka $ZKRATKA"
  ;;
# ---------------------------------------------------------------------------------------------------------
klic)
  potrebuj_zkratku
  POCET=$(aws iam list-access-keys --user-name "$UZIVATEL" --query 'length(AccessKeyMetadata)' --output text)
  if [ "$POCET" -ge 2 ]; then echo "Uživatel už má 2 klíče (maximum). Starý vypněte: bash pilot-cloudshell.sh konec --zkratka $ZKRATKA"; exit 1; fi
  [ "$POCET" = "1" ] && pozor "uživatel už jeden klíč má — po zadání nového na Macu starý vypněte (příkaz konec vypne všechny)"
  nadpis "Nový přístupový klíč pro $UZIVATEL — ZOBRAZÍ SE JEN JEDNOU"
  echo "Opište ho rovnou do ~/.aws/credentials na Macu advokáta. Nefotit, neposílat e-mailem ani chatem."
  read -r -p "Zobrazit klíč teď? (ano/ne) " A
  [ "$A" = "ano" ] || { echo "Nic nevytvořeno."; exit 0; }
  aws iam create-access-key --user-name "$UZIVATEL" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text \
    | awk '{ printf "\n[lexislocal-pilot]\naws_access_key_id = %s\naws_secret_access_key = %s\n\n", $1, $2 }'
  read -r -p "Až ho máte na Macu, stiskněte Enter (obrazovka se vymaže)…" _
  clear
  ;;
# ---------------------------------------------------------------------------------------------------------
stav)
  potrebuj_zkratku
  nadpis "Stack"; aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].[StackStatus,LastUpdatedTime||CreationTime]' --output text
  nadpis "Přístupové klíče (jen ID a stav)"; aws iam list-access-keys --user-name "$UZIVATEL" --query 'AccessKeyMetadata[].[AccessKeyId,Status,CreateDate]' --output table
  nadpis "Poslední použití klíčů"
  for K in $(aws iam list-access-keys --user-name "$UZIVATEL" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
    aws iam get-access-key-last-used --access-key-id "$K" --query '[AccessKeyLastUsed.LastUsedDate,AccessKeyLastUsed.ServiceName,AccessKeyLastUsed.Region]' --output text | sed "s/^/  $K  /"
  done
  nadpis "Rozpočet (USD)"; aws budgets describe-budget --account-id "$UCET" --budget-name "$UZIVATEL-mesicni" \
    --query 'Budget.[BudgetLimit.Amount,CalculatedSpend.ActualSpend.Amount,CalculatedSpend.ForecastedSpend.Amount]' --output text 2>/dev/null \
    | awk '{ printf "  limit %s · utraceno %s · odhad za měsíc %s\n", $1, $2, $3 }' || pozor "rozpočet nenalezen"
  ;;
# ---------------------------------------------------------------------------------------------------------
konec)
  potrebuj_zkratku
  nadpis "Vypnutí přístupových klíčů $UZIVATEL"
  for K in $(aws iam list-access-keys --user-name "$UZIVATEL" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
    aws iam update-access-key --user-name "$UZIVATEL" --access-key-id "$K" --status Inactive && ok "$K vypnut"
  done
  if [ "$SMAZAT" = "1" ]; then
    read -r -p "Opravdu SMAZAT uživatele $UZIVATEL, jeho klíče a rozpočet (stack $STACK)? Nelze vrátit. Napište: smazat " A
    [ "$A" = "smazat" ] || { echo "Nic nesmazáno (klíče zůstávají vypnuté)."; exit 0; }
    for K in $(aws iam list-access-keys --user-name "$UZIVATEL" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
      aws iam delete-access-key --user-name "$UZIVATEL" --access-key-id "$K"
    done
    aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
    aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK" && ok "stack $STACK smazán"
  else
    echo "Klíče jsou vypnuté (lze znovu zapnout v IAM). Úplné smazání: přidejte --smazat."
  fi
  ;;
# ---------------------------------------------------------------------------------------------------------
*)
  sed -n '2,17p' "$0"; exit 2 ;;
esac

[ "$CHYB" = "0" ] || { printf '\n\033[31m%s problém(ů) — viz ✗ výše.\033[0m\n' "$CHYB"; exit 1; }
printf '\n\033[32mV pořádku.\033[0m\n'
