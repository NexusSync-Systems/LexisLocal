#!/bin/bash
# email-agent-cloudshell.sh — e-mailový agent LexisLocal v AWS (24/7, bez přístupu ke spisům), z AWS CloudShellu.
#
# Spouští SPRÁVCE účtu v CloudShellu (region Frankfurt). Nic tajného se neukládá ani nevypisuje.
#
#   curl -fsSLO https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/<commit>/scripts/aws/email-agent-cloudshell.sh
#   bash email-agent-cloudshell.sh nasad --domena ukoly.nexusstack.eu --adresa asistent@ukoly.nexusstack.eu \
#        --povoleni advokat@kancelar.cz [--limit 40] --ref <commit>     # stack (change set + potvrzení) a kód funkce
#   bash email-agent-cloudshell.sh dns                 # záznamy, které je třeba přidat do DNS (MX + 3× DKIM)
#   bash email-agent-cloudshell.sh odesilatele         # v SES sandboxu: ověřovací e-mail povoleným advokátům
#   bash email-agent-cloudshell.sh aktivuj             # po ověření DNS zapne příjem (aktivní sada pravidel SES)
#   bash email-agent-cloudshell.sh stav                # ověření domény, příjem, dnešní počet, poslední rozhodnutí
#   bash email-agent-cloudshell.sh kod --ref <commit>  # jen nový kód funkce
#   bash email-agent-cloudshell.sh vypni               # okamžitě zastaví příjem (stack zůstane)
#   bash email-agent-cloudshell.sh smaz                # vypne příjem a smaže stack i uloženou poštu (potvrzuje se)
#
# Viz docs/EMAIL_AGENT_AWS.md.
set -euo pipefail

REGION=eu-central-1
STACK=lexislocal-email-agent
SADA=lexislocal-email-agent
REF=""
DOMENA=""; ADRESA=""; POVOLENI=""; LIMIT=40

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
chyba(){ printf '  \033[31m✗\033[0m %s\n' "$*"; }
pozor(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
nadpis(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

PRIKAZ="${1:-}"; shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --domena) DOMENA="${2:-}"; shift 2 ;;
    --adresa) ADRESA="${2:-}"; shift 2 ;;
    --povoleni) POVOLENI="${2:-}"; shift 2 ;;
    --limit) LIMIT="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    *) echo "Neznámý přepínač: $1"; exit 2 ;;
  esac
done

vystup() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
parametr() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue" --output text; }
potrebuj_ref() {
  [[ "$REF" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Zadejte --ref <hash commitu> (šablona a kód se nasazují pod správcem — jen z pevného commitu)"; exit 2; }
  RAW="https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/$REF"
}

nahraj_kod() {
  potrebuj_ref
  local D; D="$(mktemp -d)"
  curl -fsSL "$RAW/scripts/aws/email-agent/index.js" -o "$D/index.js"
  curl -fsSL "$RAW/backend/lib/anonymizer.js" -o "$D/anonymizer.js"
  curl -fsSL "$RAW/backend/lib/email_text.js" -o "$D/email_text.js"
  (cd "$D" && node -e "require('./index.js'); console.log('  kód načten')" && zip -q -X agent.zip index.js anonymizer.js email_text.js)
  echo "  kód $REF · SHA-256 $(sha256sum "$D/agent.zip" | cut -c1-16)…"
  aws lambda update-function-code --region "$REGION" --function-name "$STACK" --zip-file "fileb://$D/agent.zip" >/dev/null
  aws lambda wait function-updated-v2 --region "$REGION" --function-name "$STACK"
  rm -rf "$D"
  ok "kód funkce $STACK nahrán"
}

UCET=$(aws sts get-caller-identity --query Account --output text)
echo "Účet $UCET · region $REGION · stack $STACK"

case "$PRIKAZ" in
# ---------------------------------------------------------------------------------------------------------
nasad)
  potrebuj_ref
  [[ "$DOMENA" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "Zadejte --domena (subdoména jen pro agenta, např. ukoly.nexusstack.eu)"; exit 2; }
  [[ "$ADRESA" =~ ^[a-z0-9._+-]+@${DOMENA//./\\.}$ ]] || { echo "Zadejte --adresa v doméně $DOMENA (např. asistent@$DOMENA)"; exit 2; }
  POVOLENI="$(echo "$POVOLENI" | tr 'A-Z' 'a-z' | tr -d ' ')"
  [[ "$POVOLENI" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}(,[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})*$ ]] || { echo "Zadejte --povoleni (e-maily advokátů oddělené čárkou)"; exit 2; }
  [[ "$LIMIT" =~ ^[0-9]+$ ]] && [ "$LIMIT" -ge 1 ] && [ "$LIMIT" -le 500 ] || { echo "--limit 1–500"; exit 2; }
  nadpis "E-mailový agent: $ADRESA · povoleno: $POVOLENI · limit $LIMIT zadání/den"
  if DNES=$(aws ses describe-active-receipt-rule-set --region "$REGION" --query Metadata.Name --output text 2>/dev/null) && [ -n "$DNES" ] && [ "$DNES" != "None" ] && [ "$DNES" != "$SADA" ]; then
    pozor "v regionu je aktivní jiná sada pravidel příjmu SES ($DNES) — aktivace agenta by ji nahradila (řeší se u kroku aktivuj)"
  fi
  curl -fsSL "$RAW/scripts/aws/email-agent/sablona.yaml" -o email-agent.yaml
  echo "  šablona $REF · SHA-256 $(sha256sum email-agent.yaml | cut -c1-16)…"
  PARAMS="$(mktemp)"   # čárky v seznamu adres → parametry jako JSON (ne zkrácený zápis CLI)
  jq -n --arg d "$DOMENA" --arg a "$ADRESA" --arg p "$POVOLENI" --arg l "$LIMIT" --arg s "$SADA" \
    '[{ParameterKey:"DomenaPrijmu",ParameterValue:$d},{ParameterKey:"AdresaAgenta",ParameterValue:$a},{ParameterKey:"Povoleni",ParameterValue:$p},{ParameterKey:"DenniLimit",ParameterValue:$l},{ParameterKey:"NazevSadyPravidel",ParameterValue:$s}]' > "$PARAMS"
  if aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" >/dev/null 2>&1; then TYP=UPDATE; else TYP=CREATE; fi
  CS="lexis-$(date +%Y%m%d%H%M%S)"
  aws cloudformation create-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CS" --change-set-type "$TYP" \
    --template-body file://email-agent.yaml --capabilities CAPABILITY_IAM \
    --parameters "file://$PARAMS" \
    --tags Key=aplikace,Value=LexisLocal Key=soucast,Value=email-agent >/dev/null
  if ! aws cloudformation wait change-set-create-complete --region "$REGION" --stack-name "$STACK" --change-set-name "$CS" 2>/dev/null; then
    DUVOD=$(aws cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CS" --query StatusReason --output text)
    aws cloudformation delete-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CS" >/dev/null 2>&1 || true
    if echo "$DUVOD" | grep -qi "didn't contain changes"; then ok "stack beze změn"; nahraj_kod; exit 0; fi
    chyba "change set se nevytvořil: $DUVOD"; exit 1
  fi
  nadpis "Co se vytvoří / změní (zkontrolujte — vzniká role IAM a příjem pošty)"
  aws cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CS" \
    --query 'Changes[].ResourceChange.[Action,ResourceType,LogicalResourceId,Replacement]' --output table
  read -r -p "Nasadit? (ano/ne) " A
  if [ "$A" != "ano" ]; then
    aws cloudformation delete-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CS" >/dev/null
    [ "$TYP" = "CREATE" ] && aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK" 2>/dev/null || true
    echo "Nic nenasazeno."; exit 0
  fi
  aws cloudformation execute-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CS"
  if [ "$TYP" = "CREATE" ]; then aws cloudformation wait stack-create-complete --region "$REGION" --stack-name "$STACK"
  else aws cloudformation wait stack-update-complete --region "$REGION" --stack-name "$STACK"; fi
  ok "stack hotový"
  nahraj_kod
  echo
  echo "Příjem zatím NENÍ zapnutý. Další kroky:"
  echo "  1) bash email-agent-cloudshell.sh dns          → přidat záznamy do DNS domény"
  echo "  2) bash email-agent-cloudshell.sh odesilatele  → advokát potvrdí ověřovací e-mail od AWS (jen v SES sandboxu)"
  echo "  3) bash email-agent-cloudshell.sh aktivuj"
  ;;
# ---------------------------------------------------------------------------------------------------------
kod) nahraj_kod ;;
# ---------------------------------------------------------------------------------------------------------
dns)
  DOMENA=$(parametr DomenaPrijmu)
  nadpis "Do DNS domény $DOMENA přidat (u registrátora / správce DNS):"
  echo "  $(vystup MX)"
  echo "  $(vystup Dkim1)"
  echo "  $(vystup Dkim2)"
  echo "  $(vystup Dkim3)"
  echo "  _dmarc.$DOMENA. TXT \"v=DMARC1; p=reject; adkim=s; aspf=s\"     (doporučeno: nikdo nebude psát „za agenta“)"
  echo
  echo "  MX mění jen subdoménu $DOMENA — běžná pošta kanceláře na hlavní doméně se nemění."
  nadpis "Stav ověření domény v SES"
  aws sesv2 get-email-identity --region "$REGION" --email-identity "$DOMENA" --query '[VerificationStatus,DkimAttributes.Status]' --output text
  ;;
# ---------------------------------------------------------------------------------------------------------
odesilatele)
  POVOLENI=$(parametr Povoleni)
  if [ "$(aws sesv2 get-account --region "$REGION" --query ProductionAccessEnabled --output text)" = "True" ]; then
    ok "SES není v sandboxu — ověřovat příjemce odpovědí není potřeba"; exit 0
  fi
  pozor "SES je v sandboxu: odpovědi smí jít jen na ověřené adresy (max. 200 zpráv/den) — to pro agenta stačí"
  for E in ${POVOLENI//,/ }; do
    if aws sesv2 get-email-identity --region "$REGION" --email-identity "$E" --query VerificationStatus --output text 2>/dev/null | grep -q SUCCESS; then
      ok "$E už je ověřená"
    else
      aws sesv2 create-email-identity --region "$REGION" --email-identity "$E" >/dev/null 2>&1 || true
      ok "$E — AWS poslalo ověřovací e-mail, advokát v něm klikne na odkaz (platí 24 h)"
    fi
  done
  ;;
# ---------------------------------------------------------------------------------------------------------
aktivuj)
  DOMENA=$(parametr DomenaPrijmu)
  DK=$(aws sesv2 get-email-identity --region "$REGION" --email-identity "$DOMENA" --query DkimAttributes.Status --output text)
  [ "$DK" = "SUCCESS" ] || { chyba "doména $DOMENA ještě není ověřená (DKIM: $DK) — zkontrolujte DNS (příkaz dns) a zkuste za chvíli"; exit 1; }
  MX=$( (dig +short MX "$DOMENA" || nslookup -type=MX "$DOMENA") 2>/dev/null || true)
  if echo "$MX" | grep -q "inbound-smtp.$REGION.amazonaws.com"; then ok "MX vede do SES"
  else pozor "MX záznam $DOMENA zatím nevidím (DNS se může šířit) — bez něj pošta nedorazí"; fi
  VEL=$(aws lambda get-function --region "$REGION" --function-name "$STACK" --query Configuration.CodeSize --output text)
  [ "$VEL" -gt 2000 ] || { chyba "funkce má jen zástupný kód — nejdřív: bash email-agent-cloudshell.sh kod --ref <commit>"; exit 1; }
  DNES=$(aws ses describe-active-receipt-rule-set --region "$REGION" --query Metadata.Name --output text 2>/dev/null || echo None)
  if [ -n "$DNES" ] && [ "$DNES" != "None" ] && [ "$DNES" != "$SADA" ]; then
    pozor "aktivní je jiná sada pravidel příjmu ($DNES). V regionu smí být aktivní jen jedna — její pravidla by přestala platit."
    read -r -p "Přesto přepnout na $SADA? (ano/ne) " A; [ "$A" = "ano" ] || { echo "Nic nezměněno."; exit 0; }
  fi
  aws ses set-active-receipt-rule-set --region "$REGION" --rule-set-name "$SADA"
  ok "příjem zapnutý — zadání na $(parametr AdresaAgenta) zpracuje agent (odpověď do ~1 min)"
  echo "  Zkouška: advokát pošle ze své adresy obecný dotaz bez osobních údajů. Pak: bash email-agent-cloudshell.sh stav"
  ;;
# ---------------------------------------------------------------------------------------------------------
stav)
  DOMENA=$(parametr DomenaPrijmu)
  nadpis "Doména a příjem"
  aws sesv2 get-email-identity --region "$REGION" --email-identity "$DOMENA" --query '[VerificationStatus,DkimAttributes.Status]' --output text | sed 's/^/  ověření domény, DKIM: /'
  echo "  aktivní sada pravidel: $(aws ses describe-active-receipt-rule-set --region "$REGION" --query Metadata.Name --output text 2>/dev/null || echo žádná)"
  echo "  SES produkční přístup: $(aws sesv2 get-account --region "$REGION" --query ProductionAccessEnabled --output text) (False = sandbox)"
  nadpis "Dnes"
  B=$(vystup Posta)
  aws s3 cp "s3://$B/stav/den-$(date -u +%F).json" - 2>/dev/null | sed 's/^/  /' || echo "  zatím žádné zadání"
  nadpis "Poslední rozhodnutí (bez obsahu zpráv)"
  aws logs filter-log-events --region "$REGION" --log-group-name "/aws/lambda/$STACK" --filter-pattern '"rozhodnuti"' \
    --start-time $(( ($(date +%s) - 7*86400) * 1000 )) --query 'events[-15:].message' --output text 2>/dev/null | tr '\t' '\n' | sed 's/^/  /' || true
  ;;
# ---------------------------------------------------------------------------------------------------------
vypni)
  DNES=$(aws ses describe-active-receipt-rule-set --region "$REGION" --query Metadata.Name --output text 2>/dev/null || echo None)
  if [ "$DNES" = "$SADA" ]; then aws ses set-active-receipt-rule-set --region "$REGION"; ok "příjem vypnutý (žádná aktivní sada pravidel)";
  else ok "příjem agenta není aktivní (aktivní: $DNES)"; fi
  ;;
# ---------------------------------------------------------------------------------------------------------
smaz)
  B=$(vystup Posta)
  pozor "Smaže se stack $STACK, funkce, role, ověřená doména v SES a VŠECHNA uložená pošta v s3://$B (nevratné)."
  read -r -p "Opravdu smazat? Napište: smazat " A; [ "$A" = "smazat" ] || { echo "Nic nesmazáno."; exit 0; }
  DNES=$(aws ses describe-active-receipt-rule-set --region "$REGION" --query Metadata.Name --output text 2>/dev/null || echo None)
  [ "$DNES" = "$SADA" ] && aws ses set-active-receipt-rule-set --region "$REGION"
  aws s3 rm "s3://$B" --recursive --quiet
  aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
  aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK"
  ok "smazáno — záznamy MX a DKIM v DNS můžete odebrat"
  ;;
*) sed -n '2,17p' "$0"; exit 2 ;;
esac
