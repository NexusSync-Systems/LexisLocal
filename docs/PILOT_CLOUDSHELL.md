# Pilot „jen cloud“ — instalace příkazy (AWS CloudShell + Terminál na Macu)

_Stav 1. 11. 2026. Jeden advokát, jeden Mac, odpovědi Claude Sonnet 4.6 přes Amazon Bedrock v EU (účet NexusSync),
spisy, databáze a vyhledávání zůstávají na Macu. Podrobnosti: [`REZIM_JEN_CLOUD.md`](REZIM_JEN_CLOUD.md),
[`BEDROCK_EU.md`](BEDROCK_EU.md)._

Kdo co spouští:

| Kde | Kdo | Přihlášení |
|---|---|---|
| **A, B** AWS CloudShell (konzole AWS → vlevo dole „CloudShell“, region Frankfurt) | správce účtu (Zdeněk) | jeho přihlášení do konzole — žádné klíče na disku |
| **C** Terminál na Macu advokáta | Zdeněk při instalaci | uživatel `lexislocal-pilot-<zkratka>` (jen Claude a rerankery v EU) |

Profil `lexis-runner` (spouštěč testů na našem Macu) na IAM nesahá — a sahat nemá. Správcovské příkazy jen v CloudShellu.

---

## A. Účet AWS — jednou (kontroly ochrany dat)

```bash
curl -fsSLO https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/aws/pilot-cloudshell.sh
bash pilot-cloudshell.sh ucet
```

Zkontroluje: uchovávání dat Bedrocku = `none`, vypnuté logování obsahu dotazů, CloudTrail, že EU profil Clauda míří
jen do EU regionů, že Claude odpovídá, a oba rerankery (Cohere Rerank 3.5, Amazon Rerank 1.0). Jen syntetické věty,
řádově centy. Když hlásí uchovávání dat jiné než `none`: `bash pilot-cloudshell.sh ucet --opravit`.

> První volání Clauda a Cohere správcem povolí model pro celý účet (AWS Marketplace). Stránka „Model access“
> v konzoli už neexistuje — modely se povolují samy prvním voláním.

## B. Pilotní kancelář — uživatel AWS, rozpočet, klíč

```bash
bash pilot-cloudshell.sh kancelar --zkratka novak --email kontakt@nexusstack.eu --rozpocet 30
bash pilot-cloudshell.sh klic --zkratka novak
```

- `kancelar` založí ze šablony [`bedrock-eu-kancelar.yaml`](../scripts/aws/bedrock-eu-kancelar.yaml) stack
  `lexislocal-pilot-novak`: IAM uživatele, který smí **jen** Claude přes EU profil a rerankery v EU (vše mimo EU
  výslovně zakázané), a měsíční rozpočet s e-mailem při 80 % a 100 %. **Potvrdit e-mail od AWS** (odběr upozornění).
- `klic` vytvoří přístupový klíč a **jednou** ho zobrazí ve tvaru pro `~/.aws/credentials`. Opsat rovnou na Mac
  advokáta (krok C2), nefotit, neposílat. Po Enteru se obrazovka vymaže.
- Kdykoli: `bash pilot-cloudshell.sh stav --zkratka novak` — stav stacku, klíče (jen ID a stav), poslední použití,
  rozpočet a útrata.

## C. Mac advokáta (Terminál)

**C1. Kontrola počítače** — Apple Silicon, 16 GB RAM, FileVault zapnutý:

```bash
uname -m; echo "$(( $(sysctl -n hw.memsize) / 1073741824 )) GB RAM"; fdesetup status
```

Očekávání: `arm64`, `16 GB` a víc, `FileVault is On.` Zálohy: Time Machine na šifrovaný disk.

**C2. Přístup k AWS** — soubor jen pro uživatele (práva 600), klíč z kroku B vložit v TextEditu:

```bash
mkdir -p ~/.aws && chmod 700 ~/.aws && touch ~/.aws/credentials && chmod 600 ~/.aws/credentials && open -e ~/.aws/credentials
```

Do souboru vložit tři řádky z `klic` (`[lexislocal-pilot]`, `aws_access_key_id`, `aws_secret_access_key`), uložit.

**C3. LexisLocal** — Node.js 22 LTS (instalátor z nodejs.org), pak:

```bash
cd ~ && git clone https://github.com/NexusSync-Systems/LexisLocal.git && cd LexisLocal && git checkout release-prep && npm ci
```

> Instalace z `.dmg`: kde aplikace čte `.env`, je zatím otevřená otázka — pro pilot instalace ze zdrojů (výše).

**C4. Nastavení** (`.env` v kořeni LexisLocalu):

```bash
cat >> .env <<'EOF'
LEXIS_PILOT_LOCAL_ONLY=0
LEXIS_JEN_CLOUD=1
AI_CHAT_PROVIDER=bedrock
AI_EMBED_PROVIDER=onnx
EMBEDDING_MODEL=bge-m3
AWS_PROFILE=lexislocal-pilot
BEDROCK_REGION=eu-central-1
BEDROCK_MODEL_ID=eu.anthropic.claude-sonnet-4-6
RAG_RERANK=1
RAG_RERANK_PROVIDER=bedrock
BEDROCK_RERANK_MODEL=cohere.rerank-v3-5:0
BEDROCK_RERANK_RPM=3            # kvóta účtu (Service Quotas); po zvýšení upravit
EOF
```

`BEDROCK_RERANK_MODEL` upřesní měření `pilot-hledani` (Cohere, nebo `amazon.rerank-v1:0`).

**C5. Báze zákonů a judikatury** — balíček `lexis-baze-<datum>.tar.gz` přinést na disku (~30 min, server neběží):

```bash
node backend/scripts/kb-balicek.js --info ~/Downloads/lexis-baze-*.tar.gz
node backend/scripts/kb-balicek.js --instaluj ~/Downloads/lexis-baze-*.tar.gz
```

**C6. Kontroly a první start**

```bash
node backend/scripts/bedrock-check.js --volat      # nastavení + 1 syntetický dotaz (zlomek centu)
node backend/scripts/aws-pilot-test.js             # celý test proti AWS, protokol v scratch/aws-test-<datum>.md
npm start                                          # server; vyhledávací model se při 1. startu stáhne (~2,2 GB)
node backend/scripts/readiness.js                  # v druhém okně Terminálu
```

`aws-pilot-test.js` musí projít včetně: povolený dotaz → Bedrock, spis stupně A / bez souhlasu → nic neodejde,
volání mimo EU → odepřeno v AWS (F), přeřazení přes Bedrock (R1) a u spisu stupně A bez volání (R2).

**C7. V aplikaci** (prohlížeč, dashboard):

1. Manažerský přehled → **Režim AI kanceláře** → „Jen cloud — připraveno“.
2. Manažerský přehled → **Náklady na cloudovou AI** → měsíční rozpočet 30 USD, **tvrdý strop zapnutý**.
3. Prvních 14 dní jen **☁️ Obecný dotaz** (rešerše bez klientských údajů); spisy až po souhlasech klientů
   (spis → panel ☁️ Cloudová AI → stupeň a souhlas).

## D. Konec pilotu (CloudShell)

```bash
bash pilot-cloudshell.sh konec --zkratka novak            # vypne klíče (lze znovu zapnout)
bash pilot-cloudshell.sh konec --zkratka novak --smazat   # smaže uživatele, klíče a rozpočet (nevratné, ptá se)
```

Na Macu: smazat `~/.aws/credentials` (nebo jen sekci `[lexislocal-pilot]`); data kanceláře zůstávají na Macu.

## Volitelně: správcovské příkazy z Macu místo CloudShellu

IAM Identity Center (dočasné klíče, MFA) — `aws configure sso` → profil `nexus-admin`, přihlášení
`aws sso login --profile nexus-admin`, pak např. `AWS_PROFILE=nexus-admin bash scripts/aws/pilot-cloudshell.sh stav --zkratka novak`.
**Nikdy** přístupové klíče roota. Profil `lexis-runner` zůstává omezený.
