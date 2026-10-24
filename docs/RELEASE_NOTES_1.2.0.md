# LexisLocal 1.2.0 — poznámky k vydání (návrh)

Větev `release-prep`, změny od verze 1.1.4 (28. 8. 2026), 127 commitů.
Verze v `package.json` zvýšena na 1.2.0 (24. 10. 2026).

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
- Rešeršník dostane vždy **znění zákona i rozhodnutí** (u 3 pasáží dva paragrafy a jedno rozhodnutí).
  Bez toho by judikatura (30× víc textu) paragrafy vytlačila: správný § v top 3 by klesl z 82 % na 51 %;
  takhle 85 % (měření 24. 10., zlatá sada dotazů na paragraf).
- Hledání v bázi s judikaturou trvá ~0,4 s (dřív 10–20 s) a báze zabírá ~0,85 GB paměti (dřív ~2,8 GB + swap).
- **Upozornění, že odpovídá AI** (EU AI Act čl. 50): pod chatem, v odpovědích API (`aiGenerated`, `aiNotice`),
  v e-mailové odpovědi na úkol a v mobilním editoru. Koncepty od AI mají v exportu do Wordu strojově
  čitelné označení ve vlastnostech dokumentu (AIGenerated, AIHumanApproved…).

**Právní zdroje**
- Zákony přímo z e-Sbírky po paragrafech (sada 23 zákonů pro advokacii) — `fetch-esbirka.js`.
- Judikatura v bázi rešeršníka (~21 tis. rozhodnutí):
  - **Nejvyšší soud** — Sbírka soudních rozhodnutí a stanovisek, 9 801 rozhodnutí (`fetch-ns-sbirka.js`),
  - **Ústavní soud** — všechny nálezy a stanoviska pléna 1993–2026, 6 637 rozhodnutí (dataset CCC z let
    1993–2023 + NALUS od 2024, `fetch-us.js`; nové nálezy se doplňují `--nalus --od <datum>`),
  - **Nejvyšší správní soud** — Sbírka rozhodnutí NSS od 2003, 4 752 rozhodnutí (`fetch-nss-sbirka.js`).
  Každé rozhodnutí má hlavičku se sp. zn., datem, ECLI, právní větou a zdrojem (viz `docs/PRAVNI_ZDROJE.md`).
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
- Báze znalostí (RAG): přírůstkový zápis (přepíše se jen změněný shard), cache v paměti, kompaktní podoba velkých
  bází (texty UTF-8, vektory Int8), předehřátí po startu serveru. Nové proměnné: `RAG_HYBRID_POOL` (400),
  `RAG_HYBRID_POOL_LAWS` (100), `RAG_KB_LAW_SHARE` (0.6), `RAG_KB_JUD_RE`, `RAG_COMPACT_MIN` (2000),
  `RAG_VEC_INT8` (1), `RAG_WARMUP` (1), `RAG_PARTITION_CACHE` (1).
- Paměť: s plnou judikaturou počítejte pro server ~1 GB na bázi navíc k jazykovému modelu; načtení po startu ~20 s.
- Měření báze: `node backend/scripts/kb_regression.js` (kvalita zákonů vs. judikatury, latence, paměť).
- Spouštěč schválených úloh pro práci na dálku: `node backend/scripts/task-runner.js` (jen pevný seznam úloh).

## Známá omezení

- Skartace maže jen záznam spisu (viz výše).
- SMTP poskytovatel kanceláře je zpracovatel osobních údajů v souhrnech pro klienta — uvést v dokumentaci kanceláře.
- Cílová odezva zatím není stanovená; serverový test (1 GPU, 14. 10.): p50 13 s při jednom dotazu, 24–25 s při 4–8 souběžných.
  Měřeno před nahráním judikatury — serverový test s plnou bází je potřeba zopakovat.
- Kontrola „neznámého rozhodnutí“ porovnává spisové značky bez ohledu na senát; u NS a NSS jsou čísla v rámci
  agendy a roku jedinečná, u ÚS se odlišuje jen plénum.
