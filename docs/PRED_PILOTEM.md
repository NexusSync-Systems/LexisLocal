# Před pilotem — kroky, které dělá Zdeněk

Pořadí je důležité: šablona IAM se nasazuje z konkrétního commitu, takže nejdřív commit a push.
Nic z toho neposílá data klientů — jen syntetická data, řádově haléře až desetníky USD.

## 1. Commit, push, tag (Mac, kořen projektu)

```bash
cd ~/Projects/LexisLocal
git status --short            # zkontrolovat, že jsou tam jen očekávané soubory
git add -u                    # změněné sledované soubory
git add backend/tests/*.test.js docs/*.md   # nové testy a návody (ne scratch, judikatura-*, __pycache__)
git commit -m "Před pilotem: bezpečnostní review 2 (skupiny 2–5)"
git push
REF=$(git rev-parse HEAD); echo "$REF"     # tento commit použít v kroku 2
git tag v1.2.3 && git push origin v1.2.3   # spustí sestavení balíčku (workflow pilot-balicek)
```

## 2. Aktualizace IAM (AWS CloudShell, region Frankfurt)

```bash
curl -fsSLO https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/<REF>/scripts/aws/pilot-cloudshell.sh
bash pilot-cloudshell.sh ucet
bash pilot-cloudshell.sh kancelar --zkratka <zkratka> --email kontakt@nexusstack.eu --rozpocet 30 --strop 50 --ref <REF>
bash pilot-cloudshell.sh stav --zkratka <zkratka>
```

Skript před nasazením ukáže, co se změní (change set), a čeká na potvrzení. `klic` spouštět jen když
je potřeba nový přístupový klíč pro Mac advokáta.

## 3. Test proti skutečnému AWS (Mac)

```bash
cd ~/Projects/LexisLocal
AWS_PROFILE=lexislocal-bedrock node backend/scripts/aws-pilot-test.js --bez-ce
```

Projít musí všechny části A–G a R. Protokol se uloží do `scratch/aws-test-<datum>.md` (příloha k DPIA).
`--bez-ce` vynechá Cost Explorer; až bude zapnutý, pustit znovu bez přepínače (část H).
Část F (zámek v IAM) ověřuje oprávnění toho uživatele, jehož klíč profil používá. Aby se ověřil uživatel
advokáta (`lexislocal-pilot-<zkratka>`), pustit test ještě jednou s profilem, ve kterém je jeho klíč.

## 4. Balíček v1.2.3 (Mac)

Po doběhnutí workflow stáhnout balíček z GitHub Releases a vyzkoušet `instaluj-balicek.sh` na čistém
uživateli / složce. Ověřit, že aplikace naběhne a v Nastavení → AI je režim jen cloud (Bedrock EU).

## 5. LLM-judge (Mac)

1. Otevřít `backend/eval/spis_eval/judge/kalibrace_k_oznaceni.csv` (Numbers / Excel), do sloupce
   „hodnocení“ napsat ANO / NE podle vlastního úsudku (podporuje citované místo tvrzení?), uložit jako CSV se středníkem.
2. Restartovat task runner (aby viděl úlohy `spis_eval` a `spis_eval_judge`) — obnovit kopii
   (`node backend/scripts/runner-kopie.js --obnov`) a spustit ji:
   `node ~/.lexislocal/runner/kopie/backend/scripts/task-runner.js`.
3. Kalibrace (~0,05–0,15 USD):
   `node backend/scripts/spis_eval_judge.js --provider bedrock --model eu.anthropic.claude-sonnet-4-6 --aws-profile lexislocal-bedrock`
4. Judge je použitelný při shodě ≥ 90 % a nejvýš 1 falešném ANO na kontrolní sadě.

## 6. E-mail (až bude schránka asistentů)

Nastavení → E-mail: autorizovaný e-mail advokáta, IMAP/SMTP schránky, cílová adresa (filtr příjemce).
Pak tři testovací zprávy — může je poslat Claude (Spacemail jako advokát, Gmail jako cizí adresa),
stačí mu říct adresu schránky:

| # | Od | Předmět | Očekávaný výsledek |
|---|---|---|---|
| 1 | advokát | obecný dotaz bez osobních údajů | odpověď advokátovi, koncept |
| 2 | cizí adresa | libovolný | „Čeká na schválení“ v dashboardu, nic se neodešle |
| 3 | advokát | se sp. zn. syntetického spisu (např. `12 C 34/2026`) | podle stupně spisu: zpracováno, nebo vysvětlení, proč ne |

## Co je nové po review 2 (k vědomí)

- Ruční nahrání `.zfo`: musí sedět podpis souboru; upravené nebo nepodepsané `.zfo` se odmítne.
  Vystavitel certifikátu se neověřuje → u nahrané zprávy se zobrazí „Datum doručení ověřte v Datovce“.
- Podpisy PDF: „deklaruje kvalifikovaný podpis (QES) — vystavitel neověřen“ (dřív „kvalifikovaný (QES)“).
- `BEDROCK_MODEL_ID` jako ARN: ARN globálního / US profilu se odmítne i v EU regionu; profil aplikace jen s
  `BEDROCK_POVOLIT_PROFIL_APLIKACE=1` po ověření cílových regionů.
- Rozpočet: model bez řádku v ceníku se počítá podle nejdražšího řádku (tvrdý strop nejde obejít).
- Task runner: `aws_spust_test` jen se schváleným AMI; nové přidat do `.env` jako `LEXIS_RUNNER_AMI=ami-…`.
- Task runner běží z kopie mimo projekt (`~/.lexislocal/runner/kopie`, zakládá `runner-kopie.js --obnov`);
  ze složky projektu, do které vidí agenti, se spustit odmítne. Kopie je z posledního commitu, takže po
  každém commitu je potřeba `--obnov`; jinak spouštěč při startu upozorní, že je kopie starší.
- Docker: porty jen na `127.0.0.1`, kontejner backendu bez roota.
