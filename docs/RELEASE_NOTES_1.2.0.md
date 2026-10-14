# LexisLocal 1.2.0 — poznámky k vydání (návrh)

Větev `release-prep`, změny od verze 1.1.4 (28. 8. 2026), 127 commitů.
Před vydáním: zvýšit `version` v `package.json` (na `release-prep` je dosud 1.1.2, poslední vydaná je 1.1.4).

## Pro advokáty a kancelář

**Kancelář s více lidmi (firemní režim)**
- Vlastní účty a zařízení pro každého, role (správce, advokát, koncipient, asistent/ka, jen čtení); schvalovat smí advokát.
- Spis má vlastníka a sdílení (čtení / zápis). Kolega bez sdílení nevidí spis, jeho dokumenty, lhůty, faktury, AML prověrky
  ani úryvky v odpovědích asistentů. Manažerské přehledy a skartační protokoly vidí jen správce.
- Auditní stopa spisu: kdo spis otevřel, četl dokument, použil ho v asistentovi, co změnil a co odeslal.
  Export do Excelu (CSV) nebo jako protokol ve Wordu. Historie se už neztrácí (starší záznamy se archivují).

**Klient**
- E-mail klienta ve spisu a **souhrny o stavu věci**: sekretářka připraví návrh (jen události určené klientovi,
  bez interních poznámek), advokát zkontroluje a „Schválí a odešle“. Nic neodchází automaticky.
- Odeslat e-mail klientovi smí jen advokát nebo správce.

**Asistenti (AI)**
- Přesnější vyhledávání v zákonech a judikatuře (doladěný model vyhledávání, hybridní hledání, přeřazení výsledků).
  Na serverovém testu 10× opakovaném: úlohy asistentů 220/220, neověřené citace 1 %.
- Každý paragraf v odpovědi se ověřuje proti bázi zákonů; neověřené citace jsou označené.
- Judikatura rozdělená podle oborů (obor se pozná ze spisu nebo z dotazu), zapíná se u jednotlivých asistentů.
- Pojistka mlčenlivosti: režim, ve kterém AI smí běžet jen lokálně (`LEXIS_PILOT_LOCAL_ONLY=1`).
- Lhůty, data a příslušnost soudu počítá program, ne model (víkendy a svátky podle § 57 odst. 2 OSŘ).
- Dopisy protistraně a předžalobní výzvy: oslovení a údaje z podkladů doslovně, nic vymyšleného.
- Kontrola smluv najde typická nevyvážená ustanovení (rozhodčí doložka, záloha, sankce) i v dlouhých smlouvách.
- Odolnost proti „pokynům pro AI“ schovaným v dokumentech a proti vyzrazení nastavení.

**Právní zdroje**
- Zákony přímo z e-Sbírky po paragrafech (sada 23 zákonů pro advokacii) a judikatura ze Sbírky rozhodnutí
  Nejvyššího soudu — skripty `fetch-esbirka.js` a `fetch-ns-sbirka.js` (viz `docs/PRAVNI_ZDROJE.md`).
- Volitelné napojení na **CODEXIS AI** pro kanceláře s vlastní licencí: rešeršník se zeptá jejich databáze,
  ven jde jen obecná otázka bez údajů klienta, každý dotaz v auditu. Vypnuto, zapíná správce.

**Pošta, datové schránky, soudy**
- Datová schránka: příjem zpráv a .zfo, úkol k písemnosti, systémové zprávy bez falešných lhůt.
- Hlídač jednání (InfoJednání) a insolvencí (ISIR) podle spisové značky.
- Ověření elektronických podpisů u doručených PDF.
- Koncepty: webový editor s verzemi, zámky, připomínkami, schválením a exportem do Wordu.

**Vzhled**
- Světlý/tmavý motiv, vlastní dialogová okna, srozumitelnější české popisky.

## Pro správce / technické

- Skartace: `GET /api/spisy/:id/skartace-inventar` ukáže, co o spisu zůstává (deník, souhrny, dokumenty…).
  Kaskádové mazání zatím **není** — viz `docs/PRIVACY-MAP.md`.
- Nové proměnné: `AUDIT_READS` (audit čtení; výchozí zapnuto ve firemním režimu), `AUDIT_READ_WINDOW_MIN` (15),
  `AUDIT_LOG_CAP` (1000 záznamů v aktivním logu, zbytek do šifrovaného archivu `.audit_archiv/`),
  `RAG_AGENT_K` (5 se zapnutým rerankerem, jinak 3), `RAG_RERANK`.
- Nové API: `/api/client-updates` (návrh, fronta, schválení), `GET /api/spisy/:id/audit?format=json|csv|docx`.
- Změna chování: `POST /api/email/send` vyžaduje oprávnění „approve“ (advokát/správce); `/api/managerial/*`
  a `GET /api/skartace/protokoly` jen správce.
- CI: testy běží po každém pushi do `main` i `release-prep` (Node 20 a 24).
- Hodnocení výstupů advokátem: `npm run review:lawyer [report.json]` → DOCX k přečtení + CSV k vyplnění,
  `--import vyplneno.csv` → souhrn.

## Známá omezení

- Skartace maže jen záznam spisu (viz výše).
- SMTP poskytovatel kanceláře je zpracovatel osobních údajů v souhrnech pro klienta — uvést v dokumentaci kanceláře.
- Cílová odezva zatím není stanovená; serverový test (1 GPU, 14. 10.): p50 13 s při jednom dotazu, 24–25 s při 4–8 souběžných.
