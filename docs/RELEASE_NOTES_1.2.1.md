# LexisLocal 1.2.1 — poznámky k vydání (návrh)

Změny od 1.2.0 (25. 10. 2026). Verze v `package.json` zatím 1.2.0 — zvýšit před vydáním.

## Pro kancelář

- **Instalační balíček znalostní báze**: zákony + judikatura NS, ÚS, NSS s hotovými vektory v jednom
  souboru (~1,4 GB). Na novém počítači se celá báze (30 tis. dokumentů, 297 tis. pasáží) naplní
  za ~6 minut místo hodin až dnů (`kb-balicek.js`, `docs/INSTALACE_BAZE.md`).
- **Usnesení Ústavního soudu publikovaná ve Sbírce nálezů a usnesení** (743) — k nálezům a stanoviskům pléna.
- **Měsíční aktualizace judikatury**: nové nálezy a publikovaná usnesení ÚS, Sbírka NS a NSS;
  nahrání do báze rešeršníka a souhrn (`aktualizace-judikatury.js`, úloha spouštěče `aktualizace_judikatury`).
- **Dokumenty pro kancelář (návrhy ke kontrole advokátem)** v `docs/kancelar/`: zpracovatelská smlouva,
  DPIA, informace pro klienty o AI, školení AI gramotnosti (čl. 4 AI Act), vnitřní pravidla AI,
  pravidla skartace.
- **Vzdálený přístup** k Mac mini přes Tailscale/WireGuard (`docs/VZDALENY_PRISTUP.md`).
- **Plán skartace spisu**: `GET /api/spisy/:id/skartace-plan` — konkrétní položky (ID, dokumenty, úseky
  v indexu), které by skartace smazala / ponechala / pseudonymizovala. Jen čte; kaskádové mazání
  se doplní po schválení pravidel advokátem.

## Volitelné

- **Claude přes Amazon Bedrock v EU** (`AI_CHAT_PROVIDER=bedrock`): bez AWS SDK, zámek na `eu-*`
  regiony a EU inference profily v kódu, klientské pasáže ke cloudovému modelu jen anonymizované,
  režim „jen lokálně“ ho zakáže. Šablona CloudFormation pro účet kanceláře (`scripts/aws/bedrock-eu-kancelar.yaml`)
  a návod `docs/BEDROCK_EU.md`. Ve výchozím stavu vypnuto.
- **Kontrola dlouhých smluv po částech souběžně**: `AGENT_CHUNK_CONCURRENCY` (výchozí 1 = beze změny),
  `AGENT_CHUNK_NUM_PREDICT`. Doporučené hodnoty po měření na serveru.

## Opravy

- **Spisové značky s rejstříkem o více slovech** („19 P a Nc 57/2026“ — opatrovnické věci) se
  rozpoznají; dřív dokument zůstal bez spisu. „Sp. zn.“ s tečkou se nově bere jako označení
  (přednost před první zmínkou jiné věci v textu). Společně pro doručenou poštu, Paperless a datové
  zprávy (`lib/case_number.js`).
- **Nahraný dokument se zpracuje jen jednou**: nahrání přes aplikaci a hlídání složky dřív zpracovalo
  tentýž soubor dvakrát (2× vytěžení přes AI, 2× indexace, 2× záznam v auditu) — zdvojená zátěž
  modelu při každém nahrání.
- **Firemní režim — úroveň přístupu „podatelna“** (asistentka): vidí spis, zařazuje do něj došlé dokumenty,
  označuje vyřízené, potvrzuje lhůty, sleduje jednání a fakturuje; spis, koncepty ani dokumenty ve spisu
  neupravuje a nemaže. Kdo založí spis pro jiného advokáta, dostane podatelnu automaticky (dřív k založenému
  spisu ztratil přístup). Při sdílení lze zvolit „jen čtení / podatelna / čtení i úpravy“; nastavení úrovně
  ji nahradí (dřív „čtení“ nesnížilo „úpravy“).
- **Sken se špatně přečtenou sp. zn.** („35 P a Ne“ místo „35 P a Nc“) se zařadí do existujícího spisu, pokud
  po opravě typických záměn OCR (c/e, l/1, O/0…) sedí právě na jeden; opravená značka je u dokumentu
  vidět (`caseNumberOcr`). Dřív vznikl spis navíc.
- **Kontrola smluv** nově najde zálohu 100 % a krátkou záruku i bez zmínky o spotřebiteli (s poznámkou
  „je-li klient spotřebitel; jinak obchodní riziko“), krátkou lhůtu k oznámení vad, vyloučení odpovědnosti
  za vady, vzdání se práva odstoupit a vysokou denní smluvní pokutu (simulace: kontrolor přehlédl 8 z 51).
- **Záloha** ověřuje i hlavní auditní log (dřív jen záznamy AI, vypisované jako „záznamy auditu“).
- Faktura s `spisId` vyžaduje přístup ke spisu (podatelna stačí).
- Stahování Sbírky NS: opakování při přechodné chybě serveru (5xx).
- Instalace báze: názvy souborů s diakritikou sjednocené (NFC) — tar na macOS je rozbaluje rozložené.

## Testování

- **Simulace dne v kanceláři** (`backend/scripts/office_day.js`, `docs/SIMULACE_KANCELARE.md`): zavedení
  (účty, firemní režim, import spisů, digitalizace) a celý pracovní den 5 lidí nad syntetickými daty
  (150 spisů, 400 dokumentů) s kontrolou dat, oprávnění, lhůt, auditu a odezvy. Na serveru profil
  `kancelar` (úloha spouštěče `aws_spust_test` s `{"profil":"kancelar"}`).

## Známá omezení

- Web Sbírky NS (sbirka.nsoud.cz) vracel 26. 10. 2026 trvale HTTP 500 na `sitemap_index.xml` — aktualizace
  NS do jeho opravy neproběhne (ostatní zdroje ano).
- Kaskádové mazání při skartaci čeká na schválení pravidel (`docs/kancelar/6_Pravidla_skartace_navrh.docx`).
- Bedrock otestován proti specifikaci a testovacím vektorům AWS, ne proti živému účtu.
- Firemní režim: **nezařazený dokument** (bez sp. zn., např. smlouva od klienta) vidí v doručené poště
  a ve vyhledávání všichni, dokud ho někdo nezařadí do spisu („sdílená podatelna“).
- Podatelna zatím **nesmí zakládat koncepty** ve spisu (otevřená otázka — rozhodne kancelář).
