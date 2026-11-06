# LexisLocal 1.2.3 — poznámky k vydání

Změny od 1.2.2 (2. 11. 2026). První vydání, ve kterém CI i release workflow instalují z lockfile
(`npm ci`) a mají akce GitHubu připnuté na commit (SHA) — dodavatelský řetězec, review 2, skupina 3.

## Pro kancelář

- **Soudní poplatek z peněžitého plnění počítá program** podle zák. 549/1991 Sb. (sazebník od
  1. 1. 2026); opravena chybná sazba, která se vypisovala pod odpovědí.
- **Právní agenti zdůvodňují doporučení** (který §, a proč) a nabízejí varianty s pro a proti.
  Judikatura, kterou nelze ověřit v bázi (index sp. zn.), se z odpovědi vypouští.
- **Osnova pro rozpory**: citace u každé hodnoty, opora i u návrhů úprav, citace spisu včetně názvu
  dokumentu. Opraven dopis protistraně (číslo smlouvy ≠ číslo účtu).
- **E-mailové úkoly**: cizí odesílatel se schválí, ignoruje, nebo se vyřizuje automaticky; seznam
  důvěryhodných adres; funkční filtr příjemce. Ověření DKIM/DMARC, fail-closed u odesílatele, STARTTLS,
  pravidla cloudu podle sp. zn. Volitelně agent 24/7 v AWS (SES → Lambda → Bedrock).
- **Měření kvality odpovědí v pilotu bez obsahu spisů**: počty po typech úloh, 👍/👎 s důvodem,
  export CSV.
- **Kalendář / ICS, podpis .zfo a popisek u kvalifikovaného podpisu (QES)** — doplnění z review 2.

## Volitelné

- **Claude přes Bedrock EU**: opakování při krátkém výpadku a skutečná příčina v hlášce; v režimu
  „jen cloud“ se vypisuje režim místo matoucího varování; ARN modelu v nastavení.

## Bezpečnost

- **Spouštěč úloh běží z kopie mimo projekt** (`backend/scripts/runner-kopie.js`): kód, který se
  spouští, nejde přepsat ze složky, do které vidí agenti. Kopie je z posledního commitu, read-only;
  s projektem jsou sdílené jen fronta, logy a výstupy. Spuštění přímo z projektu spouštěč odmítne.
- **Přílohy e-mailu jen z evidovaných dokumentů**, ke kterým má odesílající přístup; upload nepřepisuje
  existující soubory ani nebere interní soubory; `get_document` kontroluje ACL; kontext se bere podle
  souboru i u deklarovaného spisu; pilotní IAM povoluje jen jeden model; záloha mimo repozitář.
- **Skrytá hesla e-mailu ve výpisech**, externí rešerše podle pravidel cloudu, ACL u spisové značky
  i při přeřazení dokumentu.
- **ACL přehledů, jen schválené AMI, Docker a workflowy** — doplnění z review 2.

## Opravy

- **Kontrola smlouvy**: vrácena původní osnova — opora u návrhů zhoršila eval z 96 na 80. Nadpis
  „DOPORUČENÍ“ s diakritikou se už nepočítá jako doporučení.
- **Eval**: rozpor v doručení se hlásí jen u otázek na lhůty, navržené znění není doporučení bez opory,
  v cloudu se vypisuje použitý model, přerušení při výpadku, oprava určení dokumentu u citace.
- **aws-pilot-test**: kontrola D3 vyžaduje skutečnou odpověď Bedrocku (dřív prošla i bez ní).

## Testování

- **Spis eval**: 48 případů, katalog chyb, citace jako samostatná metrika; LLM-judge s kalibrací
  (spisy S5–S6, 59 dvojic); úlohy `spis_eval` a `spis_eval_judge` ve spouštěči.
- **Celodenní generálka pilotu „jen cloud“ na AWS** (7 h simulace + spis eval na serveru, 5. 11. 2026):
  61/61 kontrol, 0 chyb, pravidla cloudu K21 všechna ✓, model_bench Sonnet 4.6 98 %, kontrola rozhraní
  5/5, spis eval na serveru 93 (43/48).

## Známá omezení

- **Kalibrace LLM-judge** čeká na ruční označení dvojic
  (`backend/eval/spis_eval/judge/kalibrace_k_oznaceni.csv`), pak `spis_eval_judge.js`.
- **Sonnet 5.5 není na pilotním účtu povolený** (403) — pilot jede na Sonnetu 4.6 v EU.
- **E-mailové testy** proběhnou, až bude schránka asistentů.
- Omezení z 1.2.1 zůstávají v platnosti (viz `docs/RELEASE_NOTES_1.2.1.md`).
