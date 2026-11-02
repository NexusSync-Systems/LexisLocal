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
bash pilot-cloudshell.sh kancelar --zkratka novak --email kontakt@nexusstack.eu --rozpocet 30 --strop 50 --ref <commit>
bash pilot-cloudshell.sh klic --zkratka novak
```

- `kancelar` založí ze šablony [`bedrock-eu-kancelar.yaml`](../scripts/aws/bedrock-eu-kancelar.yaml) stack
  `lexislocal-pilot-novak`: IAM uživatele, který smí **jen** Claude přes EU profil a rerankery v EU (vše mimo EU
  výslovně zakázané), a měsíční rozpočet s e-mailem při 80 % a 100 %. **Náklady účtu tento uživatel nevidí**
  (`CteniNakladu=ne`) — útratu hlídá dodavatel příkazem `stav`. **Potvrdit e-mail od AWS** (odběr upozornění).
- Šablona se stáhne z commitu `--ref` (hash z GitHubu; bez něj z větve `release-prep` s varováním) a **před nasazením
  skript ukáže, co se v IAM změní, a čeká na „ano“** (bezpečnostní revize 2. 11. 2026).
- `--strop` = **tvrdý strop v AWS**: po vyčerpání (USD za Clauda/Bedrock v měsíci, počítá celý účet) AWS Budgets
  uživateli automaticky zakáže Bedrock — platí i pro případ odcizeného klíče. `stav` ukáže, zda je strop vyčerpaný;
  odblokování: AWS Budgets → rozpočet `…-claude-strop` → Actions → Reverse.
- Pilotní uživatel smí volat **jen jeden model** (parametr šablony `ModelId`, výchozí `eu.anthropic.claude-sonnet-4-6`)
  a rerankery — s odcizeným klíčem tak nejde volat dražší model mimo strop.
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

**C3. LexisLocal — varianta A (doporučeno): balíček z GitHubu**, bez gitu a bez instalace Node.js. Balíček
(`lexislocal-macos-arm64.tar.gz`, Apple Silicon) sestaví GitHub Actions ke každému tagu `v*` (`.github/workflows/pilot-balicek.yml`):

```bash
curl -fsSLO https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/release-prep/scripts/mac/instaluj-balicek.sh
bash instaluj-balicek.sh instaluj --sha256 <ověřený součet>   # stáhne, ověří, rozbalí do ~/Applications/LexisLocal, založí .env a službu
```

Ověřený součet připravit předem na svém Macu (GitHub CLI): stáhnout `lexislocal-macos-arm64.tar.gz` z release a
`gh attestation verify lexislocal-macos-arm64.tar.gz --repo NexusSync-Systems/LexisLocal` (balíček sestavil náš workflow
z našeho repa) → `shasum -a 256 lexislocal-macos-arm64.tar.gz`. Bez `--sha256` se kontroluje jen součet ze stejného release.

Nastavení je pak v `~/Library/Application Support/LexisLocal/.env` (skript ho založí s blokem z C4 — kroky C4 a C6 „služba“
odpadají). Skripty spouštět přibaleným Node.js: `~/Applications/LexisLocal/aktualni/node/bin/node
~/Applications/LexisLocal/aktualni/backend/scripts/…`. Aktualizace: `bash instaluj-balicek.sh aktualizuj` (když nová verze
nenaběhne, vrátí předchozí), návrat `zpet`, přehled `stav`. Stahovat přes `curl` v Terminálu (ne prohlížečem) — soubory
pak nemají karanténní značku macOS.

**C3. Varianta B: ze zdrojů** — Node.js 22 LTS (instalátor z nodejs.org), pak:

```bash
cd ~ && git clone https://github.com/NexusSync-Systems/LexisLocal.git && cd LexisLocal && git checkout release-prep && npm ci
```

> Varianta C — podepsaná aplikace z `.dmg` (release.yml, Developer ID + notarizace): nastavení v datové složce funguje
> a modely ONNX se od 2. 11. ukládají do datové složky (ne do app.asar). Instalace báze a testy z aplikace zatím neověřené —
> pro pilot varianta A.
>
> Instalace z `.dmg` (od 1. 11. 2026): nastavení patří do `~/Library/Application Support/LexisLocal/.env`
> (server ho čte, když v pracovní složce `.env` není; v logu po startu „⚙️ Nastavení (.env): …“). Skripty v kroku C5–C6
> (báze, testy) zatím potřebují zdrojovou složku — pro pilot proto dál instalace ze zdrojů.

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
RAG_QUERY_TERMS=1
LEXIS_AWS_BILLING_SYNC=0         # pilotní klíč nevidí náklady účtu (CteniNakladu=ne)
EOF
```

Cohere Rerank 3.5 vybralo měření `pilot-hledani` 1. 11. (správný § mezi pasážemi 96,8 % vs. 90,3 % u Amazon Rerank; viz `REZIM_JEN_CLOUD.md`).

**C5. Báze zákonů a judikatury** — balíček `lexis-baze-<datum>.tar.gz` přinést na disku (~30 min, server neběží):

```bash
node backend/scripts/kb-balicek.js --info ~/Downloads/lexis-baze-*.tar.gz
node backend/scripts/kb-balicek.js --instaluj ~/Downloads/lexis-baze-*.tar.gz
```

**C6. Kontroly a první start**

```bash
node backend/scripts/bedrock-check.js --volat      # nastavení + 1 syntetický dotaz (zlomek centu)
node backend/scripts/aws-pilot-test.js --bez-ce    # celý test proti AWS (bez Cost Exploreru), protokol v scratch/aws-test-<datum>.md
bash scripts/mac/lexislocal-sluzba.sh instaluj     # služba macOS: start po přihlášení, restart po pádu, odkaz na ploše
node backend/scripts/readiness.js                  # vyhledávací model se při 1. startu stáhne (~2,2 GB)
```

`aws-pilot-test.js` musí projít včetně: povolený dotaz → Bedrock, spis stupně A / bez souhlasu → nic neodejde,
volání mimo EU → odepřeno v AWS (F), přeřazení přes Bedrock (R1) a u spisu stupně A bez volání (R2).

**C7. V aplikaci** (prohlížeč, dashboard):

1. Manažerský přehled → **Režim AI kanceláře** → „Jen cloud — připraveno“.
2. Manažerský přehled → **Náklady na cloudovou AI** → měsíční rozpočet 30 USD, **tvrdý strop zapnutý**.
3. Prvních 14 dní jen **☁️ Obecný dotaz** (rešerše bez klientských údajů); spisy až po souhlasech klientů
   (spis → panel ☁️ Cloudová AI → stupeň a souhlas).

**C8. Služba a aktualizace**

```bash
bash scripts/mac/lexislocal-sluzba.sh stav          # běží? poslední řádky logu (~/Library/Logs/LexisLocal/server.log)
bash scripts/mac/lexislocal-sluzba.sh restart       # po změně .env
bash scripts/mac/lexis-aktualizuj.sh --kontrola     # co je nového na GitHubu (nic nemění)
bash scripts/mac/lexis-aktualizuj.sh                # zastaví službu, stáhne, otestuje, spustí; když testy neprojdou, vrátí předchozí verzi
```

Aktualizovat mimo pracovní dobu (server je ~3–6 min nedostupný). `.env`, data, báze a klíče se aktualizací nemění.

**Balíček báze:** `scratch/kb-balicek/lexis-baze-2026-10-26.tar.gz` (1,4 GB; 30 003 dokumentů, 297 163 pasáží s hotovými
vektory; zkušební instalace 26. 10. bez chyb za ~5 min) — na šifrovaný USB disk, na Macu do `~/Downloads`. Stejná báze
jako v měřeních vyhledávání a v generálce.

**C9. Úkoly e-mailem (volitelně)** — advokát pošle zadání ze své adresy do schránky asistentů, LexisLocal na Macu
ji vybírá (IMAP) a odpoví mu zpět. Zpracuje Claude přes Bedrock **podle pravidel spisu**:

1. Nastavení → E-mail: vyplnit **autorizovaný e-mail advokáta** (bez něj se nezpracuje nic), IMAP a SMTP schránky
   asistentů, zapnout příjem, interval (min.). Port 993 = TLS; jiný port jen se STARTTLS (bez šifrování se nepřipojí).
2. Zadání projde jen s **DKIM/DMARC pass** pro doménu advokáta (hlavička `Authentication-Results` od serveru
   schránky; podvržený odesílatel se zahodí). Volitelně `email_authserv_id` (např. `mx.google.com`) — pak se věří jen
   hlavičce od toho serveru. Když schránka hlavičku nepřidává: `LEXIS_EMAIL_OVERENI=0` v `.env` (nedoporučeno).
3. **Sp. zn. v předmětu** (např. `12 C 34/2026`) → zadání se váže ke spisu a platí jeho stupeň a souhlas klienta.
   Bez sp. zn. jen obecný dotaz **bez osobních údajů**; jinak odpověď vysvětlí, že se v cloudu nezpracoval.
   Podpis a citovaná korespondence se před kontrolou i před odesláním Claudovi odříznou.
4. Výstup = koncept ve spisu (03_Koncepty) a odpověď **jen** na autorizovaný e-mail. Klientům se nic neposílá.
5. **Kdo smí zadávat:** advokát a **důvěryhodné adresy** (koncipient, asistentka — také s DKIM/DMARC; odpověď jde jim).
   **E-maily od cizích adres** (Nastavení → E-mail, lze kdykoli změnit):
   - *Ke schválení* (výchozí) — zpráva čeká v dashboardu (E-mailové úkoly → „Čeká na schválení“), agenti ji zpracují
     až po kliknutí **Zpracovat** (sp. zn. zadá advokát); **Zamítnout** = nic se nestane,
   - *Ignorovat* — jen záznam v auditu,
   - *Zpracovat automaticky* — jen s ověřeným původem, jinak ke schválení (riziko: úkol může zadat kdokoli).
   Cizímu se nikdy nic neodesílá, výsledek dostane advokát; spis se podle textu cizího nepřiřadí a schůzka se sama nerezervuje.
6. **Filtr příjemce** (Cílová adresa asistentů, např. `dias+asistenti@…`): zpracují se jen e-maily poslané na ni, ostatní
   pošta ve schránce zůstane nepřečtená a nedotčená. Prázdné = celá schránka.

Server musí běžet (služba, C8) a Mac nesmí spát — jinak se pošta vybere až po probuzení.
E-mailový agent, který běží 24/7 v AWS (jen obecné dotazy, bez spisů): **docs/EMAIL_AGENT_AWS.md**.

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
