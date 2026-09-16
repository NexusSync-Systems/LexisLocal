# Podpis a distribuce — LexisEditor / LexisLocal

Kompletní, ověřený postup podepisování desktopových buildů. Platí pro **oba**
repozitáře (LexisEditor i LexisLocal) — liší se jen názvy artefaktů a číselné
repo ID u Azure federace (viz níže).

- **macOS** — Developer ID podpis + notarizace, automaticky přes CI. ✅ funkční
- **Windows** — Azure Artifact Signing (Trusted Signing) přes OIDC, přes CI. ✅ zapojeno

---

## 1. macOS — Developer ID + notarizace (hotovo, přes CI)

Ostré macOS buildy vznikají **podepsané (Developer ID Application) a notarizované**
automaticky ve workflow `.github/workflows/release.yml` při pushnutí tagu `v*`.

Konfigurace (`package.json` → `build.mac`): `hardenedRuntime: true`,
`entitlements: build/entitlements.mac.plist`, `notarize: true`, cíl `dmg` (arm64 + x64).

Potřebné **repo/org secrets** (GitHub → Settings → Secrets and variables → Actions):

| Secret | Význam |
| --- | --- |
| `CSC_LINK` | Developer ID Application certifikát (.p12) v **base64** |
| `CSC_KEY_PASSWORD` | heslo k tomu .p12 |
| `APPLE_ID` | Apple ID pro notarizaci |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password (ne běžné heslo!) |
| `APPLE_TEAM_ID` | Team ID |

Ve workflow jsou `CSC_LINK`/`CSC_KEY_PASSWORD` **scoped jen na macOS runner**
(`runner.os == 'macOS'`), aby se Apple cert nepokusil použít na Windows build.

Ověření po stažení DMG: `spctl -a -vv "dist/mac/LexisEditor.app"` → musí hlásit
`accepted, source=Notarized Developer ID`.

---

## 2. Windows — Azure Artifact Signing (Trusted Signing) přes OIDC

Podpis běží ve workflow `.github/workflows/windows-sign.yml` (**ruční** spuštění,
`workflow_dispatch`, musí být na větvi **`main`**, jinak ho GitHub k „Run workflow"
nenabídne). Build (electron-builder → NSIS) se **nejdřív sestaví bez publikování**,
pak podepíše a nahraje jako artefakt `*-windows-signed`.

Klíčové: **žádný certifikát ani .pfx nikde v repu.** Přihlášení do Azure jede přes
**OIDC federaci** — GitHub Actions si vyžádá krátkodobý token, Azure ho ověří proti
app registraci. Timestamping je **povinný** (certifikáty Trusted Signing platí jen
~3 dny; bez časového razítka by podpis po vypršení přestal platit).

### 2a. Jednorázové nastavení — GitHub secrets (org-level)

Organizace **NexusSync-Systems** → Settings → Secrets and variables → Actions →
**New organization secret**. U každého nastav **Repository access → Selected
repositories → LexisEditor + LexisLocal** (ne „All repositories").

| Secret | Kde se bere (Azure Portal) |
| --- | --- |
| `AZURE_CLIENT_ID` | App registrations → **github-signing** → Overview → *Application (client) ID* |
| `AZURE_TENANT_ID` | tamtéž → *Directory (tenant) ID* |
| `AZURE_SUBSCRIPTION_ID` | Subscriptions → dané předplatné → *Subscription ID* |

> Chyba `AADSTS...` / `Ensure 'client-id' and 'tenant-id' are supplied` = secrets
> nejsou vyplněné nebo scope nezahrnuje daný repo. Pozor: repo/org secrets se při
> **transferu/migraci repa nepřenášejí** — proto jsou org-level.

### 2b. Jednorázové nastavení — Azure federated credential (POZOR: immutable subject)

App registrace **github-signing** → Manage → **Certificates & secrets** →
záložka **Federated credentials** → **+ Add credential**.

NexusSync-Systems má na GitHubu zapnutý **immutable subject** — do OIDC tokenu
přidává **číselná ID** org i repa. Standardní jménový subject
`repo:NexusSync-Systems/LexisEditor:ref:refs/heads/main` se proto **neshodne** a
login spadne s:

```
AADSTS700213: No matching federated identity record found for presented assertion
subject 'repo:NexusSync-Systems@322198156/LexisEditor@1237747198:ref:refs/heads/main'
```

Řešení: credential vytvoř přes scénář **„Other issuer"** (ne GitHub Actions wizard,
ten vnutí jménový subject) a vyplň **přesně** to, co token posílá:

- **Issuer:** `https://token.actions.githubusercontent.com`
- **Subject identifier:** zkopíruj z logu spadlého běhu, včetně `@čísel`, např.
  `repo:NexusSync-Systems@322198156/LexisEditor@1237747198:ref:refs/heads/main`
- **Audience:** `api://AzureADTokenExchange`

Číselná ID jsou stálá (org ID `322198156` je společné; **repo ID se liší podle repa**),
takže credential dál platí. Jak subject zjistit, když ještě neběžel: spusť workflow,
on spadne na `Azure login` a v logu vypíše `subject claim - repo:...` — to vlož.

**Každý repo = vlastní credential** (jiné repo ID). Pro jiné větve/tagy (`:ref:refs/tags/v...`)
přibude další credential; pro pilot stačí `main`.

App registrace navíc potřebuje na Trusted Signing účtu roli **Trusted Signing
Certificate Profile Signer** (jinak login projde, ale podpis selže na oprávnění).

### 2c. Parametry podpisu (jsou už v `windows-sign.yml` — needit bez důvodu)

```
endpoint:                 https://neu.codesigning.azure.net/
signing-account-name:     nexusstack-signing
certificate-profile-name: nexusstack-public
file-digest:              SHA256
timestamp-rfc3161:        http://timestamp.acs.microsoft.com
timestamp-digest:         SHA256
```

Job má `runs-on: windows-latest` a `permissions: id-token: write` + `contents: read`
(bez `id-token: write` OIDC token nevznikne).

### 2d. Spuštění a ověření

1. GitHub → **Actions** → „Windows build + Azure Artifact Signing" → **Run workflow**
   → větev `main` → Run.
2. Sleduj kroky **Azure login (OIDC)** a **Sign Windows installer** — oba zelené.
3. Nahoře v **Artifacts** stáhni `LexisEditor-windows-signed` (resp. `LexisLocal-…`).
4. Na Windows: pravým na `.exe` → **Vlastnosti → Digitální podpisy** → podpis musí
   být platný a **mít časové razítko**.

### 2e. Rychlá diagnostika

| Chyba v logu | Příčina | Náprava |
| --- | --- | --- |
| `Ensure 'client-id' and 'tenant-id' are supplied` | prázdné secrets | vyplnit org secrets, scope na repo (2a) |
| `AADSTS700213 No matching federated identity` | subject nesedí (immutable ID) | credential s přesným subjectem z logu (2b) |
| login OK, `Sign` selže na oprávnění | app nemá roli na signing účtu | přiřadit **Trusted Signing Certificate Profile Signer** |
| workflow není v „Run workflow" | soubor není na `main` | dostat `windows-sign.yml` na výchozí větev |

---

## 3. Test zálohy a obnovy šifrovacího klíče (proveď před pilotem)

Cíl: klient nesmí přijít o data ani o šifrovací klíč.

1. V appce vytvoř dokument → **Nastavení → Záloha klíče → exportuj** na bezpečné místo.
2. Na **čistém** macOS profilu (nebo po přeinstalaci) nainstaluj podepsaný build.
3. **Obnov klíč ze zálohy**, otevři aplikaci → původní dokument musí být čitelný.
4. Negativně: bez klíče data zůstávají šifrovaná / nečitelná.
5. Postup zálohy zdokumentuj do quick-startu pro AK (kam klíč uložit, jak často).

---

## 4. Poznámky

- **Auto-update na macOS** funguje spolehlivě jen u podepsané+notarizované appky
  (electron-updater). Windows Trusted Signing zlepší i důvěru SmartScreenu.
- Chceš-li podepsat i **vnitřní** binárky appky (ne jen instalátor, kvůli reputaci
  SmartScreenu), je potřeba electron-builder sign hook, který volá Trusted Signing
  per-file **před** zabalením — to je nad rámec tohoto post-build podpisu.
- Tento postup je společný pro oba repozitáře; jediný per-repo rozdíl je **repo ID**
  v Azure federated credentialu (2b).
