# Podepisování Windows instalátoru (Azure Artifact Signing)

Stav k 8. 11. 2026: **nedokončeno.** Workflowy `windows-sign.yml` a `test-signing.yml` jsou
hotové a čekají jen na nastavení v Azure; zkouška 7. 11. 2026 (běh 42386250740) spadla na
kroku „Azure login“, protože v repozitáři nejsou tajné hodnoty `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID` a `AZURE_SUBSCRIPTION_ID`. Dokud to neproběhne, je `.exe` ve vydáních
nepodepsaný a Windows u něj hlásí neznámého vydavatele. macOS podepsaný i notarizovaný je.

Služba se mezitím přejmenovala: **Trusted Signing → Azure Artifact Signing**. Změnila se
i jména rolí, takže starší návody na webu mluví jinak než portál.

## Než začneš: tři věci, které mohou celé řešení zarazit

1. **Předplatné musí být placené.** Artifact Signing nefunguje na free, trial ani
   sponzorovaném předplatném (ani na kreditech). Portál to odmítne při zakládání účtu.
2. **Platí se celý měsíc, nepoměrně.** SKU Basic je 9,99 USD/měsíc (5 000 podpisů, pak
   0,005 USD za podpis) a fakturuje se celá částka bez ohledu na to, kdy v měsíci účet
   vznikne. Založit účet a nechat ho čekat 20 dní na ověření identity tedy něco stojí.
3. **Ověření identity organizace trvá 1 až 20 pracovních dnů** a nedá se zrychlit. Když
   neprojde, Microsoft onboarding odmítne a zbývá jen komerční OV certifikát od jiné CA.

Veřejně důvěryhodné certifikáty jsou pro organizace z EU dostupné, Česko tedy vyhovuje.

## Co si připravit dopředu

Údaje musí odpovídat veřejnému rejstříku, jinak ověření padá:

- přesný **právní název** NexusSync Systems (ten se dostane do certifikátu jako CN i O —
  vlastní název nejde zadat)
- **IČO** (pole „Business Identifier“) a **adresa sídla**
- **web** na vlastní doméně
- **dva různé e-maily na vlastní doméně**: primární nesmí být rozdělovník, oba musí přijímat
  zprávy s odkazy od externích odesílatelů. Na primární jde potvrzovací odkaz, který
  **platí 7 dní** — po jeho propadnutí se žádost zakládá znovu od začátku.
- **jméno a doklad jedné fyzické osoby**, která za firmu projde osobním ověřením (Verified ID
  přes Microsoft Authenticator + AU10TIX, občanka nebo pas, selfie kontrola). Jméno v žádosti
  se musí přesně shodovat s dokladem.

## Postup

### 1. Registrace poskytovatele prostředků

Portál → Subscriptions → tvoje předplatné → Resource providers → `Microsoft.CodeSigning` → Register.

Nebo z příkazové řádky:

```
az provider register --namespace Microsoft.CodeSigning
az extension add --name artifact-signing
```

### 2. Role pro sebe

Bez role **Artifact Signing Identity Verifier** je v portálu tlačítko „New identity validation“
šedé. Přiřaď si ji na předplatném nebo na účtu (Access control (IAM) → Add role assignment).

### 3. Účet Artifact Signing

Portál → „Artifact Signing Accounts“ → Create. Jméno **`nexusstack-signing`**, region
**North Europe**, SKU **Basic**. Region je důležitý: workflow má endpoint
`https://neu.codesigning.azure.net/`, což je právě North Europe. Jiný region = jiná adresa
a workflow se musí upravit.

```
az group create --name nexusstack-signing-rg --location northeurope
az artifact-signing create -n nexusstack-signing -l northeurope -g nexusstack-signing-rg --sku Basic
```

### 4. Ověření identity (jen v portálu, CLI to neumí)

Účet → Objects → Identity validations → **Organization** → New Identity → **Public**.
Vyplň údaje z přípravy, zkontroluj „Certificate subject preview“ (to je přesně to, co lidi
uvidí ve vlastnostech souboru) a pošli. Stav půjde `In Progress` → `Action Required`
(osobní ověření odkazem z e-mailu) → `In Progress` → `Completed`.

Pokud si Microsoft vyžádá doklady, máš **tři pokusy** na jejich nahrání. Doklady musí být
vydané za posledních 12 měsíců a platné ještě aspoň dva měsíce.

### 5. Certificate profile

Teprve po `Completed`: účet → Objects → Certificate profiles → Create → **Public Trust**.
Jméno **`nexusstack-public`**, u „Verified CN and O“ vyber dokončené ověření.

### 6. Aplikace v Entra ID a federované přihlášení

Portál → Microsoft Entra ID → App registrations → New registration (např.
`github-lexislocal-signing`, single tenant, bez redirect URI). Pak u ní
Certificates & secrets → **Federated credentials** → Add credential → scénář
**GitHub Actions deploying Azure resources**:

| pole | hodnota |
| --- | --- |
| Organization | `NexusSync-Systems` |
| Repository | `LexisLocal` |
| Entity type | Branch |
| Branch | `main` |
| Audience | `api://AzureADTokenExchange` (výchozí, nechat) |

Oba podepisovací workflowy se spouštějí ručně, takže platí ta větev, ze které je pustíš.
Pro `release-prep` přidej druhý údaj se stejným nastavením a větví `release-prep` —
federovaný údaj pro jednu větev na jiné větvi nefunguje.

Žádný client secret nezakládej, o to tu právě jde: v repozitáři nebude klíč, jen ID.

### 7. Role pro tu aplikaci

Účet `nexusstack-signing` → Access control (IAM) → Add role assignment → role
**Artifact Signing Certificate Profile Signer** → „User, group, or service principal“ →
najdi `github-lexislocal-signing` (service principaly se nenabízejí samy, musíš je vyhledat).

```
az role assignment create --assignee <APPLICATION_CLIENT_ID> \
  --role "Artifact Signing Certificate Profile Signer" \
  --scope /subscriptions/<SUBSCRIPTION_ID>/resourceGroups/nexusstack-signing-rg/providers/Microsoft.CodeSigning/codeSigningAccounts/nexusstack-signing
```

### 8. Tajné hodnoty do GitHubu

Tři ID, žádné klíče. Z adresáře projektu:

```
gh secret set AZURE_CLIENT_ID
gh secret set AZURE_TENANT_ID
gh secret set AZURE_SUBSCRIPTION_ID
```

(`gh` se zeptá na hodnotu a nevypíše ji; nedávej je na příkazovou řádku, zůstaly by
v historii shellu.)

### 9. Zkouška

```
gh workflow run test-signing.yml --ref main
```

Podepíše kopii `notepad.exe`, nic nevydává — na ověření celé cesty to stačí. Až projde,
`windows-sign.yml` sestaví a podepíše skutečný instalátor a přiloží ho jako artefakt běhu.

## Zkratka, jak ověřit workflow během čekání na ověření identity

Soukromá důvěra (Private Trust) nepotřebuje veřejné ověření identity — název se bere
z názvu tenanta Entra ID a je hotová hned. Založ tedy soukromé ověření a profil
Private Trust, dočasně v `test-signing.yml` přepiš `certificate-profile-name` a ověř si,
že OIDC, role i akce fungují. Takový podpis **není veřejně důvěryhodný**, Windows ho
nepřijme jako podpis od známého vydavatele — na zkoušku potrubí ale stačí a ušetří to
objevování chyb v nastavení až po dvaceti dnech čekání.

## Co tím nezískáme

- **SmartScreen hned nezmizí.** Artifact Signing nevydává EV certifikáty a reputace
  SmartScreenu se buduje podle počtu stažení daného souboru. Podepsaný instalátor je
  proti nepodepsanému velký rozdíl (zmizí „neznámý vydavatel“), ale u prvních stažení se
  varování ještě objevit může.
- **Certifikát nedostaneme do ruky.** Klíč zůstává ve službě, dostupný jen v okamžiku
  podpisu. Lokálně tedy podepsat nejde, jen přes službu.
- **Přesun jinam později nejde.** Prostředky Artifact Signing se nedají přestěhovat mezi
  předplatnými, tenanty ani resource groupami — při změně se zakládá všechno znovu včetně
  ověření identity. Vyber předplatné a tenanta rozmyšleně.
- **Časové razítko je povinné**, protože podpisové certifikáty služby platí jen pár dní.
  Ve workflow už nastavené je (`http://timestamp.acs.microsoft.com`).

## Odkazy

- [Quickstart: Set up Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/quickstart)
- [Artifact Signing FAQ](https://learn.microsoft.com/azure/artifact-signing/faq)
- [OIDC a federované údaje pro akci](https://github.com/Azure/artifact-signing-action/blob/main/docs/OIDC.md)
- [Ceník](https://azure.microsoft.com/cs-cz/pricing/details/artifact-signing/)
