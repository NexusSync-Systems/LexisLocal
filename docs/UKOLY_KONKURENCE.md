# Úkoly — vylepšení po srovnání s Jónsbókem (28. 10. 2026)

Podklad: `docs/SROVNANI_JONSBOK.md`, zátěžový den 27. 10. 2026 (`docs/SIMULACE_KANCELARE.md`).
Priorita: **P0** před pilotem (citace jsou to, v čem nás advokáti budou srovnávat), **P1** během pilotu, **P2** po pilotu.

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

### K7 Rešerše na silnějším modelu (volitelně)
Živý test Claude přes Bedrock v EU (`scripts/bedrock-check.js --volat`) a srovnání s qwen 7B na sadě K3.
- **Hotovo, když:** tabulka kvalita / čas / cena za dotaz pro obě varianty.

## P2 — po pilotu

### K8 Doplněk do Wordu (PoC)
Office add-in (Office.js), připojený k LexisLocalu v kanceláři přes HTTPS a token uživatele (párování jako dashboard
`/?pair=`). Funkce: rešerše k označenému textu, kontrola otevřené smlouvy (kontrolor + `clause_scan`), vložení
schváleného konceptu ze spisu. Žádná data mimo kancelář.
- Ověřit: instalace bez Microsoft Store (sideload / centrální nasazení v M365), Word pro Mac i Windows, self-signed
  certifikát kanceláře.
- **Hotovo, když:** PoC na Macu ve Wordu proti zkušební instalaci; seznam omezení.

### K9 Doplněk do Outlooku
Uložit e-mail a přílohy do spisu (podatelna, rozpoznání sp. zn.), návrh odpovědi Spisovatelem **ke schválení** —
nikdy automatické odeslání klientovi.

### K10 Porovnání více dokumentů vedle sebe
Tabulka „dokumenty × otázky“ (např. 10 smluv: doba trvání, pokuty, rozhodčí doložka) nad dokumenty spisu.

## Hotovo
- 29. 10. 2026 — K1: vzor formátu citace bez čísla (`lib/agents.js`, `prompts.json`, `routes/agent.js`); uložené prompty
  kanceláře (`.agents.json`) se opraví při načtení (`PROMPT_MIGRATIONS`), vlastní úpravy zůstanou.
- 29. 10. 2026 — K2: příznak `outsideContext` u ověřeného § mimo podklady, řádek „Mimo podklady: …“ pod odpovědí,
  `outsideContextCount`; jen když podklady nějaké § obsahují (jinak by šuměly smlouvy). Stav citace i `hallucinationRate` beze změny.
- 29. 10. 2026 — simulace: souhrn citací (neověřeno / mimo podklady) — dřív se neověřené kvůli špatnému názvu stavu nepočítaly;
  vzor rizika „vyloučení odpovědnosti za vady“ přijímá i „vzdání se práv z vadného plnění“ (3 falešné neúspěchy 28. 10.).
- 28. 10. 2026 — keep-alive 65 s (ECONNRESET ze zátěžového dne), K17b v simulaci.
