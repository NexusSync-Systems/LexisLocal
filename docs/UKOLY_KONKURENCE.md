# Úkoly — vylepšení po srovnání s Jónsbókem (28. 10. 2026)

Podklad: `docs/SROVNANI_JONSBOK.md`, zátěžový den 27. 10. 2026 (`docs/SIMULACE_KANCELARE.md`).
Priorita: **P0** před pilotem (citace jsou to, v čem nás advokáti budou srovnávat), **P1** během pilotu, **P2** po pilotu.

## Pořadí (29. 10. 2026, po ověření údajů o Jónsbóku)

Pozice: nesoutěžit „kdo má lepší chat“, ale „celá kancelář na jednom místě, data neopustí kancelář“. Dohnat to,
kde prohráváme (kvalita modelu, Word/Outlook, hromadná analýza, důvěra bez ISO).

1. **Hned:** K7 — živý test Bedrocku, pak „chytřejší režim“ pro rešerše bez klientských dat.
2. **Během pilotu:** K10 Review Grid, K11 balíček podle stanoviska ČAK, K12 stránka „pokrytí českého práva“.
3. **Souběžně s pilotem:** K8 prototyp doplňku do Wordu.
4. **Po pilotu:** K9 Outlook — podle odezvy advokátů (K6).

## P0 — správnost citací

### K1 Prompty: pryč s konkrétním „§ 2248 OZ“ v příkladu — ✅ 29. 10. (čeká na ověření během)
Systémové prompty rešeršníka a oponenta (`lib/agents.js` 2×, `routes/agent.js` 1×) dávají jako vzor formátu
„§ 2248 OZ“. Zátěžový den: § 2248 (zvýšení nájemného) se objevil ve 40 z 284 odpovědí, u dotazu J1 na moderaci smluvní
pokuty 7× z 20 místo § 2051 OZ. Model si vzor bere jako obsah.
- Vzor formátu bez skutečného čísla: „§ <číslo> <zkratka zákona>, např. OZ, o. s. ř., ZOK“.
- Test: žádný systémový prompt agenta neobsahuje konkrétní číslo paragrafu (`tests/agentPrompts…`).
- **Hotovo, když:** J1 na serveru ≥ 19/20; § 2248 jen v odpovědích k nájmu.

### K2 Ověřovač: skutečný §, který není v podkladech → „mimo podklady“ — ✅ 29. 10. (čeká na ověření během)
Dnes `citation_verifier` přijme § 2248 OZ, protože v bázi existuje (J1: 2 citace, 0 neověřených). Chybí kontrola,
že paragraf byl v pasážích, které RAG k dotazu dodal.
- Nový stav `outside_context` (⚠ „mimo podklady — ověřte“), v UI jinou barvou než neexistující citace; počítat zvlášť
  (`outsideContextRate`) v transparenčním logu i v `office_day`.
- **Hotovo, když:** odpověď J1 s § 2248 má citaci označenou; na sadě `server_suite` nevzroste počet falešných varování
  u správných odpovědí o víc než 5 %.

### K3 Eval: věcně špatný paragraf jako chyba — rozpracováno (J1 `mustNot`)
- `server_suite/cases.json`: doplnit `mustNot` se špatnými, ale „blízkými“ §§ (J1: `2248`), dalších ~20 dotazů
  s typickými záměnami (smluvní pokuta × úrok z prodlení, odstoupení × výpověď, vady u koupě × díla).
- `office_day.js`: v souhrnu „věcně špatný §“ u rešerší.
- **Hotovo, když:** sada běží v `kb_regression` a výsledek je v release notes.

### K4 Klik na citaci → text zdroje
Advokát musí jedním klikem vidět znění § (z lokální báze zákonů) nebo rozhodnutí podle sp. zn. Ověřit, co dnes UI
umí, a doplnit chybějící (rešerše, koncept, kontrola smlouvy).
- **Hotovo, když:** každá ověřená citace v odpovědi je odkaz; neověřená/„mimo podklady“ má vysvětlení.

## P1 — pilot

### K5 Srovnávací list pro advokáty
Z `docs/SROVNANI_JONSBOK.md` krátká verze pro kancelář (1 strana, bez interních poznámek), přiložit k
`docs/kancelar/3_Informace_pro_klienty_AI.docx` / školení. Před předáním aktualizovat fakta o Jónsbóku (ceník, model).

### K6 Měřit v pilotu, co advokátům chybí
Do dotazníku pilotu: „Chybí vám práce přímo ve Wordu / Outlooku?“, „Jak často opravujete citace?“, „Kdy byste
zapnuli cloudový model?“. Výsledek rozhodne o pořadí K8–K10.

### K7 Silnější model pro rešerše — **P0, ✅ ověřeno 29.–30. 10.**
Pravidla pro cloud už jsou hotová (`lib/cloud_policy.js`: stupně citlivosti spisu A–D, souhlas klienta, dotaz bez spisu
jen jako „D – veřejné“), napojení na Bedrock EU taky (`lib/bedrock.js`) — chybí ověření naostro a cesta v rozhraní.
- **K7a Živý test Bedrocku:** správce v AWS povolí modely Claude (eu-central-1), nasadí `scripts/aws/bedrock-eu-kancelar.yaml`,
  nastaví uchovávání dat Bedrocku na „none“; pak `scripts/bedrock-check.js --volat` a rešeršní sada (vč. J1) na Claude
  i qwen 7B. **Hotovo, když:** tabulka kvalita / čas / cena za dotaz pro obě varianty.
- **K7b „Chytřejší režim“ — ✅ 29. 10. (volba „☁️ Obecný dotaz“ v asistentovi, pod odpovědí kdo odpovídal; ověří běh `kancelar-bedrock`):** obecné právní otázky bez klientských dat → Claude (Bedrock EU), cokoli se spisem lokálně podle
  `cloud_policy`; advokát vidí, který model odpovídal (transparenční log). **Hotovo, když:** J1 ≥ 19/20 na Claude,
  dotaz se spisem stupně B bez souhlasu nikdy neodejde (test).
- **K7c Alternativa bez cloudu:** větší lokální model (qwen 14B/32B) podle paměti Mac mini pro pilot; srovnání na stejné sadě.

## P2 — souběžně s pilotem / po pilotu

### K8 Doplněk do Wordu (PoC) — souběžně s pilotem
Office add-in (Office.js), připojený k LexisLocalu v kanceláři přes HTTPS a token uživatele (párování jako dashboard
`/?pair=`). Funkce: rešerše k označenému textu, kontrola otevřené smlouvy (kontrolor + `clause_scan`), vložení
schváleného konceptu ze spisu. Žádná data mimo kancelář.
- Ověřit: instalace bez Microsoft Store (sideload / centrální nasazení v M365), Word pro Mac i Windows.
- **Hlavní riziko — certifikát:** Word nepřijme certifikát podepsaný sám sebou; instalátor musí vytvořit certifikační
  autoritu kanceláře a přidat ji do systému (stránku doplňku servíruje přímo LexisLocal → stejný origin, CORS beze změn).
- **Hotovo, když:** PoC na Macu ve Wordu proti zkušební instalaci; seznam omezení.

### K9 Doplněk do Outlooku
Uložit e-mail a přílohy do spisu (podatelna, rozpoznání sp. zn.), návrh odpovědi Spisovatelem **ke schválení** —
nikdy automatické odeslání klientovi.

### K10 Porovnání více dokumentů vedle sebe (Review Grid) — **přesunuto do P1**
Tabulka „dokumenty × otázky“ (např. 10 smluv: doba trvání, pokuty, rozhodčí doložka, omezení odpovědnosti, výpověď)
nad dokumenty spisu; buňka = odpověď + článek smlouvy; export do Excelu a Wordu. Staví na kontrolorovi a `clause_scan`,
běží lokálně. **Hotovo, když:** 10 smluv ze sady simulace < 10 min na Mac mini, export funguje.

### K11 Balíček pro kancelář podle stanoviska ČAK (místo ISO 27001) — P1
Kontrolní seznam „požadavek ze stanoviska ČAK k AI (20. 10. 2026) → jak to řeší LexisLocal → kde je důkaz“ + přehled
zabezpečení (šifrování databáze, auditní řetězec, zálohy se zkouškou obnovy, role a práva, cloud jen podle `cloud_policy`),
odkazy na DPIA, zpracovatelskou smlouvu a vnitřní pravidla v `docs/kancelar/`.

### K12 Stránka „pokrytí českého práva“ — P1
Jónsbók nezveřejňuje, které české soudy indexuje. My přesně: zákony (stav k datu), NS, NSS, ÚS, počty rozhodnutí,
datum poslední aktualizace — v aplikaci (správce i advokát) a na webu nexusstack.eu.

### K13 Doučený lokální model `lexis-qwen:7b` (formát citací, „jen z podkladů“) — P1
Plán: `docs/PLAN_DOUCENI_MODELU.md`. QLoRA nad qwen2.5:7b na veřejných datech se samoučením přes ověřovač citací,
GGUF pro Ollamu, šíření s balíčkem. **Hotovo, když:** J1 ≥ 18/20, citace mimo podklady ≤ 2 %, bez zhoršení
`server_suite` a `kancelar-3h`.

### K14 Časová působnost a novely — P1
Dnes jedno znění k datu stažení. Doplnit: datum znění u každé pasáže a v odpovědi („podle znění účinného k …“),
přehled novel paragrafu z e-Sbírky, volitelně znění k datu (dotaz „ke dni skutku“) — e-Sbírka umí znění k datu
(`fetch-esbirka.js --datum`). **Hotovo, když:** odpověď uvádí znění a u § změněného novelou za poslední 3 roky
upozorní; test na 10 dotazech s rozhodným datem v minulosti.

### K15 Rozšířit prameny v balíčku báze — P1
Prováděcí předpisy (nejčastější vyhlášky: advokátní tarif 177/1996, …), rozhodnutí obecných soudů z open dat MSp
(skript hotový), evropské právo z EUR-Lex (nařízení a směrnice nejčastěji používané v advokacii, judikatura SDEU
— úřední díla). Výsledek promítnout do K12 („pokrytí českého práva“). **Hotovo, když:** balíček obsahuje všechny
tři skupiny a rešeršní sada má dotazy na každou.

### K15b Další formáty ve spisovně — P1
Sledování složky spisu bere PDF, DOCX, TXT, HTML a obrázky. Doplnit .doc, .rtf, .odt a e-maily uložené jako .eml / .msg
(text + přílohy), aby šly do spisu i bez IMAP.

### K16 Vlastní vzory kanceláře (.docx) — P2
Advokát nahraje svůj vzor (.docx), Spisovatel doplní údaje ze spisu a zachová formát; nevyplněné → [Doplnit: …].

### K17 Lepší vyhledávání v pilotu — P0/P1 (krok 1 a 3 ✅ 30. 10.)
Pilot na Mac mini dnes: původní bge-m3, bez rerankeru, 4 pasáže. Laboratoř (`training/embed/README.md`), správný §
na 1. místě (zlatá sada): bge-m3 66 % → doladěný mix-0.3 71 % → + reranker 77 %; v top 5 pasážích ~95 %.
1. **Serverový běh `judikatura-plus`** (pilot + mix-0.3 + reranker bge + K=5) proti `2026-10-26_1023_remote_judikatura`:
   server_suite, neověřené citace, rychlost odpovědí, paměť (`pamet.log`). Pozn.: vektory báze se poprvé přepočítají (~2,5 h).
2. Podle výsledku: nový balíček báze s vektory mix-0.3; mix-0.3 do ONNX pro režim jen cloud (`lib/local_embed.js`);
   reranker na Mac mini (MPS: bge ~1,2 s, mmarco ~0,17 s), v režimu jen cloud mmarco int8 na CPU (~1,1 s).
3. **Slovník hovorových pojmů** („vyhodit z bytu“ → výpověď z nájmu…) pro dotazy běžnou řečí (zlatá klient 61–72 %).
4. **§ → judikatura:** k nalezenému § nabídnout rozhodnutí, která ho citují.
5. **Skutečné dotazy z pilotu** (se souhlasem kanceláře jen znění otázek, anonymizovaně) → nová zlatá sada.
**Hotovo, když:** serverový běh bez zhoršení kontrol a citací, rešerše rychlejší nebo do +3 s, Mac mini to paměťově
utáhne; pak výchozí v pilotu.

## Hotovo
- 30. 10. 2026 — K17: přeřazení zákonů a judikatury zvlášť + slovník hovorových pojmů jako výchozí; správný § mezi pasážemi
  agenta 88,7 → 91,9 %, na 1. místě 50,8 → 75,0 %, odložená sada 43 → 86 % (`training/embed/README.md`). Další: rozbor zbylých
  dotazů, rychlost na Mac mini (5 pasáží zpomaluje odpovědi), ověření slovníku na dotazech z pilotu.
- 30. 10. 2026 — režim „jen cloud“ (`docs/REZIM_JEN_CLOUD.md`): Claude přes Bedrock bez Ollamy, vyhledávací model bge-m3
  v aplikaci (`lib/local_embed.js`), odepření/výpadek bez náhradní odpovědi, pošta jen pravidla, profil `kancelar-jen-cloud`
  (čeká na serverový běh a `embed_compat`).
- 30. 10. 2026 — K7 ověřeno na serveru (`kancelar-bedrock`, Claude Sonnet 4.6 přes Bedrock EU z role instance): 54/55 kontrol,
  K21a/d/e/f/g bez porušení (nic bez souhlasu, nic ze spisu stupně A, nic po odvolání souhlasu, strop rozpočtu drží,
  30 dotazů v cloudu = 30 v auditu = 30 v evidenci, 1,00 USD za den); obecné rešerše 19/19, J1 2/2. Srovnání na GPU:
  Claude 95 % / 9,5 s, qwen 7B 85 % / 13,4 s. Rozhraní v Chromiu: volba „☁️ Obecný dotaz“ a štítek modelu fungují.
  Opravy testů: K21b nepočítá odpovědi bez volání modelu, párování v kontrole rozhraní přes kontext prohlížeče,
  cloudový model ve srovnání s limitem 4096 tokenů.
- 30. 10. 2026 — výpadek Bedrocku za běhu → odpoví lokální model s důvodem (dřív „simulovaná“ odpověď).
- 29. 10. 2026 — K1: vzor formátu citace bez čísla (`lib/agents.js`, `prompts.json`, `routes/agent.js`); uložené prompty
  kanceláře (`.agents.json`) se opraví při načtení (`PROMPT_MIGRATIONS`), vlastní úpravy zůstanou.
- 29. 10. 2026 — K2: příznak `outsideContext` u ověřeného § mimo podklady, řádek „Mimo podklady: …“ pod odpovědí,
  `outsideContextCount`; jen když podklady nějaké § obsahují (jinak by šuměly smlouvy). Stav citace i `hallucinationRate` beze změny.
- 29. 10. 2026 — simulace: souhrn citací (neověřeno / mimo podklady) — dřív se neověřené kvůli špatnému názvu stavu nepočítaly;
  vzor rizika „vyloučení odpovědnosti za vady“ přijímá i „vzdání se práv z vadného plnění“ (3 falešné neúspěchy 28. 10.).
- 28. 10. 2026 — keep-alive 65 s (ECONNRESET ze zátěžového dne), K17b v simulaci.
