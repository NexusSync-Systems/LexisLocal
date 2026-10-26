# Claude přes Amazon Bedrock v EU (volitelné)

Ve výchozím stavu běží LexisLocal **jen lokálně** (Ollama). Kancelář může pro náročnější úlohy
zapnout Claude přes Amazon Bedrock — **ve vlastním účtu AWS kanceláře a jen v EU**.
Před zapnutím: aktualizovat DPIA (AWS jako zpracovatel, CLOUD Act) a informace pro klienty
(`docs/kancelar/`). Vyhledávání (embeddingy) a znalostní báze zůstávají vždy lokální.

## Co je zajištěno v LexisLocalu

- **Zámek na EU v kódu** (`backend/lib/bedrock.js`): region jen `eu-*`, model jen EU inference
  profil `eu.…` nebo model přímo v EU regionu; `us.`, `global.`, `apac.` aj. odmítne ještě před odesláním.
- **Režim „jen lokálně“** (`LEXIS_PILOT_LOCAL_ONLY=1`) Bedrock zakáže úplně.
- **Klientské pasáže** ze spisů, které RAG přidá k dotazu, jdou ke cloudovému modelu **anonymizované**
  (rodná čísla, účty, kontakty, jména); kontext dokumentu se pseudonymizuje jako dosud. Zákony
  a judikatura (veřejná data) jdou beze změny.
- Bez AWS SDK — podpis požadavků (SigV4) ověřený oficiálním testovacím vektorem AWS.

## Nastavení v AWS (správce kanceláře)

1. Účet AWS kanceláře (ne dodavatele). Doporučeno MFA na root účtu a samostatný účet jen pro LexisLocal.
2. V konzoli Bedrock (region **eu-central-1**) povolit přístup k modelům Anthropic (Model access),
   vyplnit formulář pro Anthropic, pokud ho konzole vyžaduje.
3. CloudFormation → Create stack → šablona `scripts/aws/bedrock-eu-kancelar.yaml` (region eu-central-1).
   Vytvoří IAM uživatele `lexislocal-bedrock` s politikou jen na Claude přes EU profily, explicitní
   zákaz Bedrocku mimo EU a měsíční rozpočet s upozorněním e-mailem.
4. IAM → Users → `lexislocal-bedrock` → Security credentials → Create access key
   („Application running outside AWS“). Klíč uložit **jen** na Mac mini (viz níže), nikam neposílat.
5. Volitelně (AWS Organizations): SCP, které zakáže Bedrock mimo `eu-*` pro celý účet — druhá pojistka.

## Nastavení na Mac mini

`~/.aws/credentials` (práva 600):
```
[lexislocal-bedrock]
aws_access_key_id = …
aws_secret_access_key = …
```

`.env` LexisLocalu:
```
LEXIS_PILOT_LOCAL_ONLY=0
AI_CHAT_PROVIDER=bedrock
AI_EMBED_PROVIDER=ollama
AWS_PROFILE=lexislocal-bedrock
BEDROCK_REGION=eu-central-1
BEDROCK_MODEL_ID=eu.anthropic.claude-…   # přesné ID EU profilu z konzole Bedrock (Model catalog)
# BEDROCK_MAX_TOKENS=4096
```

Restartovat server. Ověření: dotaz na rešeršníka → v transparenčním logu je model `eu.anthropic…`;
v CloudTrail (eu-central-1) jsou volání `Converse` pod uživatelem `lexislocal-bedrock`.

**Ověřit cílové regiony profilu** (AWS upozorňuje, že prefix `eu.` sám nestačí):
```
aws bedrock get-inference-profile --region eu-central-1 \
  --inference-profile-identifier <BEDROCK_MODEL_ID> --query 'models[].modelArn'
```
Všechny ARN musí být v `eu-*` regionech.

## Vypnutí

`AI_CHAT_PROVIDER=ollama` (nebo `LEXIS_PILOT_LOCAL_ONLY=1`) a restart. V AWS deaktivovat přístupový klíč.
