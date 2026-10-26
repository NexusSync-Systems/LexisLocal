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

- Stahování Sbírky NS: opakování při přechodné chybě serveru (5xx).
- Instalace báze: názvy souborů s diakritikou sjednocené (NFC) — tar na macOS je rozbaluje rozložené.

## Známá omezení

- Web Sbírky NS (sbirka.nsoud.cz) vracel 26. 10. 2026 trvale HTTP 500 na `sitemap_index.xml` — aktualizace
  NS do jeho opravy neproběhne (ostatní zdroje ano).
- Kaskádové mazání při skartaci čeká na schválení pravidel (`docs/kancelar/6_Pravidla_skartace_navrh.docx`).
- Bedrock otestován proti specifikaci a testovacím vektorům AWS, ne proti živému účtu.
