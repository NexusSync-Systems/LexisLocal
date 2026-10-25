# LexisLocal 1.2.0 — poznámky k vydání (návrh)

Větev `release-prep`, změny od verze 1.1.4 (28. 8. 2026), 150 commitů.
Verze v `package.json` zvýšena na 1.2.0 (24. 10. 2026). CI zelená (Node 20 a 24), serverový test s plnou bází 25. 10. 2026.

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
- Rešeršník dostane vždy **znění zákona i rozhodnutí**: 4 pasáže = 3 paragrafy + 1 rozhodnutí.
  Bez toho by judikatura (30× víc textu) paragrafy vytlačila: správný § mezi pasážemi by klesl na 51 %;
  takhle 82,3 % — stejně jako při hledání jen v zákonech (měření 25. 10., 124 dotazů na paragraf, plná báze).
- U rozhodnutí v podkladech dostane model soud a spisovou značku a pod odpovědí je seznam
  **„Judikatura v podkladech“** s rozhodnutími, která odpověď sama necitovala (ne v konceptech dopisů).
- Hledání v bázi s judikaturou trvá ~0,4 s na Macu / ~0,8 s na serveru (dřív 10–20 s); backend s plnou bází
  zabírá ~1,1–1,4 GB paměti (dřív ~2,8 GB + swap). Dohledání rozhodnutí podle právní věty: NS 80 %, ÚS 77 %, NSS 97 %.
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
  `RAG_AGENT_K` (5 se zapnutým rerankerem, jinak **4**; dřív 3), `RAG_RERANK`.
- Nové API: `/api/client-updates` (návrh, fronta, schválení), `GET /api/spisy/:id/audit?format=json|csv|docx`.
- Změna chování: `POST /api/email/send` vyžaduje oprávnění „approve“ (advokát/správce); `/api/managerial/*`
  a `GET /api/skartace/protokoly` jen správce.
- CI: testy běží po každém pushi do `main` i `release-prep` (Node 20 a 24).
- Hodnocení výstupů advokátem: `npm run review:lawyer [report.json]` → DOCX k přečtení + CSV k vyplnění,
  `--import vyplneno.csv` → souhrn.
- Báze znalostí (RAG): přírůstkový zápis (přepíše se jen změněný shard), cache v paměti, kompaktní podoba velkých
  bází (texty UTF-8, vektory Int8), předehřátí po startu serveru. Nové proměnné: `RAG_HYBRID_POOL` (400),
  `RAG_HYBRID_POOL_LAWS` (100), `RAG_KB_LAW_SHARE` (**0.75**; agent bez rerankeru dostane 3 zákony + 1 rozhodnutí — správný § mezi pasážemi 75,8 → 82,3 %), `RAG_KB_JUD_RE`, `RAG_COMPACT_MIN` (2000),
  `RAG_VEC_INT8` (1), `RAG_WARMUP` (1), `RAG_PARTITION_CACHE` (1).
- **Rychlejší hromadné plnění bází:** `RAG_KB_SAVE_DEBOUNCE_MS` (výchozí 0 = vypnuto) odloží zápis báze
  agenta na disk na chvíli klidu (nejpozději `RAG_KB_SAVE_MAX_MS`, 30 s) a při zastavení serveru. Dřív se po
  každém nahraném souboru znovu šifroval celý shard 0 (až 6000 kousků) → ~1 soubor/s. Cache vektorů
  (`EMBED_CACHE_FILE`) čte velký soubor po kusech.
- Paměť: s plnou judikaturou počítejte ~1,5 GB pro backend navíc k jazykovému modelu (Mac mini: 16 GB stačí
  pro model 7B, 24 GB s rezervou). Báze se po startu načítá na pozadí (Mac ~20 s, server ~45 s) — server mezitím
  odpovídá. Zastavení serveru ~2 s (dřív až 54 s: při přibytí shardu se přepisovala celá báze).
- Plnění bází: odložený zápis (`RAG_KB_SAVE_DEBOUNCE_MS`) zrychlil nahrání judikatury z ~1 na ~4 soubory/s
  (server: celá báze 30 003 dokumentů za 2 h 15 min, s cache vektorů 23 min).
- Záloha (`backup.js`) zvládne archiv nad 2 GB (záloha s plnou bází má ~2,4 GB; ověřeno i se zkouškou obnovy).
- Měření báze: `node backend/scripts/kb_regression.js` (kvalita zákonů vs. judikatury, latence, paměť).
- Spouštěč schválených úloh pro práci na dálku: `node backend/scripts/task-runner.js` (jen pevný seznam úloh;
  AWS jen čtení výsledků + spuštění serverového testu s pevnými parametry, oprávnění uživatele `lexis-runner`).
- Serverový test s plnou bází: profil `judikatura` (`docs/SERVER_TEST_1.2.0.md`), kontroluje i úplnost báze;
  eval sada má úlohy na rešerši judikatury J1–J3 (`--judikatura`).

## Známá omezení

- Skartace maže jen záznam spisu (viz výše).
- SMTP poskytovatel kanceláře je zpracovatel osobních údajů v souhrnech pro klienta — uvést v dokumentaci kanceláře.
- Cílová odezva zatím není stanovená; serverový test s plnou bází (1 GPU L4, qwen2.5:7b, 25. 10.): p50 16 s při
  jednom dotazu, p95 18 s při 4 a 28 s při 8 souběžných; kontrolor dlouhých smluv až 63 s. Serverová sada 175/177.
- Model 7B spisovou značku z podkladů sám často neopíše (J1/J2) — proto deterministický seznam pod odpovědí;
  hodnocení advokátem (balíček z 25. 10.) teprve proběhne.
- Kontrola „neznámého rozhodnutí“ porovnává spisové značky bez ohledu na senát; u NS a NSS jsou čísla v rámci
  agendy a roku jedinečná, u ÚS se odlišuje jen plénum.
