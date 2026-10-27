# Claude přes Bedrock — nastavení účtu NexusSync (vývoj a test před pilotem)

Stav ke 27. 10. 2026 (zkontrolováno v konzoli, eu-central-1). Pro kancelář platí stejný postup v jejím vlastním účtu.

| Krok | Stav |
|---|---|
| EU profil `eu.anthropic.claude-sonnet-5-5` — cíle jen EU (Stockholm, Paříž, Milán, Španělsko, Irsko, Frankfurt) | ✅ ověřeno |
| Přístup k modelům (AWS povoluje všechny serverless modely automaticky) | ✅ |
| Model invocation logging | ✅ vypnuté |
| Cost Explorer | ✅ zapnutý |
| `.env`: `BEDROCK_REGION`, `BEDROCK_MODEL_ID` | ✅ doplněno (aplikace dál lokální) |
| CloudFormation stack ze `scripts/aws/bedrock-eu-kancelar.yaml` | ⬜ udělat (níže) |
| Přístupový klíč uživatele `lexislocal-bedrock` | ⬜ udělat (níže) |
| `AWS_PROFILE=lexislocal-bedrock` v `.env` | ⬜ odkomentovat po vytvoření klíče |
| Uchovávání dat Bedrocku = „none“ | ⬜ ověřit (v konzoli Settings volba není; ověřit v dokumentaci AWS / CLI) |
| Test proti AWS | ⬜ spustit (níže) |

## 1. CloudFormation (konzole, region Europe (Frankfurt) eu-central-1)

1. CloudFormation → **Create stack** → *With new resources* → *Upload a template file* → `scripts/aws/bedrock-eu-kancelar.yaml`.
2. Název stacku např. `lexislocal-bedrock`; parametry: e-mail pro upozornění, měsíční rozpočet v USD (pro vývoj stačí 20).
3. Na poslední stránce zaškrtnout potvrzení, že šablona vytváří IAM prostředky → **Submit**. Počkat na `CREATE_COMPLETE`.

Vytvoří: IAM uživatele `lexislocal-bedrock` (jen Claude přes EU profily, zákaz Bedrocku mimo EU a globálních profilů,
zákaz změny uchovávání dat, čtení EU profilu a nákladů) a měsíční rozpočet s e-mailem.

## 2. Přístupový klíč (jen ty — klíč nikomu neposílat, nevkládat do chatu ani repa)

1. IAM → Users → `lexislocal-bedrock` → Security credentials → **Create access key** → *Application running outside AWS*.
2. Do `~/.aws/credentials` (práva 600):
   ```
   [lexislocal-bedrock]
   aws_access_key_id = …
   aws_secret_access_key = …
   ```
3. V `.env` odkomentovat `AWS_PROFILE=lexislocal-bedrock`.

## 3. Test

```
cd ~/Projects/LexisLocal
node backend/scripts/bedrock-check.js
node backend/scripts/aws-pilot-test.js --latence 5
```
Očekávání: vše OK; v kroku H se objeví skutečné názvy služeb, pod kterými AWS Clauda účtuje. Protokol v `scratch/aws-test-*.md`.
Kroky F musí skončit „odepřeno v AWS“ — pokud ne, test běží pod jiným klíčem než `lexislocal-bedrock`.

## 4. Až test projde

- Zapnout v aplikaci: `AI_CHAT_PROVIDER=bedrock` v `.env`, restart serveru (`npm run dev`).
- V Manažerském přehledu nastavit rozpočet a ceník (karta „Náklady na cloudovou AI“).
- Spisům, které smí do cloudu, nastavit stupeň a souhlas klienta (`docs/BEDROCK_EU.md`).
