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

## Který spis smí do cloudu (stupeň citlivosti a souhlas klienta)

Zapnutý Bedrock **neznamená, že do cloudu jde všechno.** Mlčenlivost je širší než GDPR
(pseudonymizace řeší osobní údaje, ne důvěrné skutečnosti), proto rozhoduje každý spis
(`backend/lib/cloud_policy.js`, kontrola přímo v `ai_provider.chat`):

| Stupeň | Příklady | Cloud |
|---|---|---|
| A – přísně důvěrné | trestní obhajoba, zdravotní údaje, nezletilí, oznamovatelé | nikdy, ani se souhlasem |
| B – důvěrné (**výchozí**) | civilní spory FO, pracovní, rodinné, dědické věci | jen s výslovným souhlasem klienta pro tento spis |
| C – standardní | obchodní a korporátní věci PO | souhlas pro spis nebo rámcový souhlas ve smlouvě |
| D – veřejné | zákony, judikatura, rešerše bez vazby na klienta | bez souhlasu |

- **Dotaz nad více spisy** (RAG přidá úseky z jiných spisů) musí projít u každého z nich.
- **Dotaz bez spisu** jde do cloudu jen jako výslovně veřejný (`dataClass: "verejne"`); text
  neznámého původu (kontext dokumentu bez spisu, nezařazený dokument) → jen lokálně.
- **Úlohy mimo asistenta** (watcher, e-mail, extrakce, výkazy) nemají kontext spisu → vždy lokálně.
- **Odepřený cloud** → dotaz zpracuje lokální model (Ollama) a odpověď nese `cloudPolicy`
  s důvodem; `LEXIS_CLOUD_ODEPRENI=chyba` místo toho vrátí 403. Lokální model lze určit
  `LEXIS_CLOUD_FALLBACK_MODEL`.
- **Zvýšit stupeň** smí každý se zápisem do spisu; **snížit** jen advokát/správce a s odůvodněním.
  **Souhlas** zaznamenává jen advokát/správce (poznámka: jak byl získán); **odvolat** ho smí
  kdokoli se zápisem a platí okamžitě. AI agent nemění nic.
- **Audit:** každé rozhodnutí v auditu „Cloud AI“ (spisy, stupně, důvod); povolený dotaz
  i do deníku spisu (`cloud_ai`) — přehled pro DPIA, které spisy kdy odešly do cloudu.
- **Přímé API** (Anthropic, veřejné OpenAI) nemá EU region ani smlouvu kanceláře → klientská
  data přes něj nejdou nikdy (veřejný dotaz jen s `LEXIS_POVOLIT_PRIME_API=1`, pro testy);
  embeddingy přes veřejné OpenAI API jsou zakázané. OpenAI-kompatibilní server na loopbacku
  nebo v LAN kanceláře (vLLM, LM Studio) je lokální model.

API: `GET /api/spisy/:id/cloud`, `POST /api/spisy/:id/cloud/stupen` `{ stupen, duvod }`,
`POST /api/spisy/:id/cloud/souhlas` `{ typ: "spis"|"ramcovy", poznamka }`,
`POST /api/spisy/:id/cloud/souhlas/odvolat` `{ duvod }`. Asistenti (`/api/agent/:id`,
`/api/agent-swarm/*`) berou `spisId` / `caseNumber` / `dataClass`.

Jen pro testy se syntetickými daty: `LEXIS_CLOUD_BEZ_KONTEXTU=povolit` pustí do cloudu i dotazy bez kontextu.

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

Restartovat server. Kontrola nastavení: `node backend/scripts/bedrock-check.js` (s `--volat` jeden zkušební
dotaz se syntetickým textem). Ověření: dotaz na rešeršníka → v transparenčním logu je model `eu.anthropic…`;
v CloudTrail (eu-central-1) jsou volání `Converse` pod uživatelem `lexislocal-bedrock`.

**Ověřit cílové regiony profilu** (AWS upozorňuje, že prefix `eu.` sám nestačí):
```
aws bedrock get-inference-profile --region eu-central-1 \
  --inference-profile-identifier <BEDROCK_MODEL_ID> --query 'models[].modelArn'
```
Všechny ARN musí být v `eu-*` regionech.

## Jak zajistit, že data neodejdou do USA (kontrolní seznam)

Každá vrstva sama nestačí — chrání až dohromady:

1. **Kód LexisLocalu** — region jen `eu-*`, model jen `eu.…` profil nebo model v EU regionu; `us.`, `global.`
   odmítne ještě před odesláním. Modely, u kterých AWS ukládá veškerý provoz (Claude Fable 5 / 5.1, až 30 dní
   kvůli odhalování zneužití, s možnou ruční kontrolou AWS), odmítne, pokud kancelář výslovně nenastaví
   `BEDROCK_POVOLIT_UKLADANI=1`. Pro spisy volte model Claude, který umožňuje nulové ukládání.
2. **IAM politika** (šablona `bedrock-eu-kancelar.yaml`) — uživatel smí volat jen Anthropic přes EU profily,
   Bedrock mimo `eu-*` má výslovně zakázaný, globální a jiné profily taky; nesmí přepnout uchovávání dat
   na nic jiného než `none`.
3. **Uchovávání dat v účtu = `none`** — v nastavení Bedrocku (data retention, pro každý EU region zvlášť;
   nenastavený region se řídí výchozím chováním modelu). U modelů, které nulové ukládání umožňují, pak AWS
   nic neukládá; poskytovatel modelu (Anthropic) k dotazům ani odpovědím přístup nemá nikdy.
4. **Model invocation logging vypnuté** (výchozí stav) — jinak by se celé dotazy ukládaly do CloudWatch/S3.
   CloudTrail ukládá jen metadata volání (kdo, kdy, který model, `inferenceRegion`), ne obsah.
5. **Druhá pojistka pro celý účet** (AWS Organizations, SCP) — platí i pro jiné uživatele účtu:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Sid": "BedrockJenEU", "Effect": "Deny", "Action": "bedrock:*", "Resource": "*",
         "Condition": { "StringNotLike": { "aws:RequestedRegion": "eu-*" } } },
       { "Sid": "JenNuloveUkladani", "Effect": "Deny", "Action": "bedrock:PutAccountDataRetention", "Resource": "*",
         "Condition": { "StringNotEquals": { "bedrock:DataRetentionMode": "none" } } }
     ]
   }
   ```
6. **Klientské pasáže anonymizované** (LexisLocal) — i kdyby cokoli selhalo, ke cloudovému modelu jdou
   bez rodných čísel, účtů, kontaktů a jmen; vyhledávání a znalostní báze zůstávají lokální.
7. **Ověření** — `node backend/scripts/bedrock-check.js` (nastavení), s `--volat` jeden zkušební dotaz
   se syntetickým textem; v CloudTrail (eu-central-1) u volání `Converse` zkontrolovat `inferenceRegion` (musí být `eu-*`).

**Co technicky vyřešit nejde:** AWS je americká společnost (CLOUD Act). Data se zpracují v EU a při nulovém
ukládání se neuchovávají, právní riziko přístupu orgánů USA ale posoudí advokát v DPIA a zpracovatelské
smlouvě s AWS (`docs/kancelar/`). Pokud ho kancelář nepřijme, zůstává LexisLocal jen lokální (výchozí stav).

Zdroje (10/2026): AWS Bedrock — Data protection, Data retention, Abuse detection; AWS blog „Cross-region
inference for EU data processing“.

## Vypnutí

`AI_CHAT_PROVIDER=ollama` (nebo `LEXIS_PILOT_LOCAL_ONLY=1`) a restart. V AWS deaktivovat přístupový klíč.
