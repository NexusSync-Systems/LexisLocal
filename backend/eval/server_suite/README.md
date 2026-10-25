# Serverový test LexisLocal (`server_suite.js`)

End-to-end test celé aplikace běžící na serveru, přístupné vzdáleně. Všechna data jsou smyšlená. Testuje se jen vlastní testovací server, nedestruktivně. Testovací objekty mají prefix `E2E-`.

## Spuštění

```
# z Macu proti serveru (token z S3 *_remote/_connect.txt)
node backend/scripts/server_suite.js --base https://<IP> --token <token> --insecure --label po-opravach

# jen některé fáze, srovnání s minulým během, úklid
node backend/scripts/server_suite.js ... --only A,B,C,D --baseline backend/eval/server_suite/reports/<předchozí>.json --cleanup

# s LLM-judge (volitelné, silnější model hodnotí odpovědi agentů)
JUDGE_API_KEY=... JUDGE_MODEL=... node backend/scripts/server_suite.js ... --only E,H
```

Na nové AWS instanci (`scripts/aws/remote-office-userdata.sh`) se sada spustí sama po naplnění báze (krok 7). Report se nahraje do S3 do `*_remote/suite/`. Vypnutí: `RUN_SUITE=0`.

Výstup: `reports/<čas>_<label>.md` obsahuje nálezy podle závažnosti, skóre po kategoriích, zátěž a regrese proti baseline. Vedle je `.json` se surovými odpověďmi agentů. Token se do reportu nikdy nezapisuje. Při kritickém nálezu skončí skript s kódem 1.

## Co se testuje

| Fáze | Obsah | Počet kontrol |
|---|---|---|
| A infrastruktura | /api/status, HSTS, CSP, X-Frame-Options, nosniff, X-Powered-By, token se nevkládá do HTML vzdáleně | 8 |
| B přístup | ~40 API cest bez tokenu a se špatným tokenem → 401; Bearer; token v URL odmítnut; regrese přípon .js/.css/.ico; 401 bez detailů | 6 |
| C funkce | spisy (CRUD, PATCH, stav, události → časová osa), střet zájmů, anonymizace (r. č., účet, telefon, e-mail, jméno, adresa), ověření citací (§ 2254 vs. § 9999), judikatura, kalendář (+ kolize, mimo pracovní dobu), fakturace (+ záporná částka), AML, integrita auditního řetězce, transparenční log, RAG (status, vyhledání § 2254, detekce oboru), readiness (judikatura), znalostní báze agenta (vlastní dokument → agent ho použije), lhůtník, manažerské přehledy, skartace, green metriky, e-mail (odvození, simulace), nevalidní JSON | 37 |
| D doručená pošta | nahrání 10 dokumentů (TXT/PDF/DOCX/PNG sken), sp. zn., lhůty od doručení (30. 9., 2. 10., 19. 10.), rozpor dat, OCR, žádní vymyšlení účastníci, čitelnost textu, poškozené PDF → viditelná chyba, název s cestou | ~45 |
| E agenti | 22 úloh z `cases.json`: kontrola smluv, lhůty (včetně opakování 5×), rešerše, negativní testy (neexistující §, judikát), cizí jazyk, návrh podání bez vymyšlených údajů, osobní údaje, styl, prompt injection, únik systémového promptu/tokenu; dále embedding model → 400, neexistující agent, prázdný prompt, obří vstup | 26 |
| F více agentů | Oponentní diskuse, orchestrace (hierarchický swarm) a věcná správnost výsledku | 4 |
| G zátěž | souběh 1/4/8, chybovost, p50/p95 | 4 |
| H LLM-judge | volitelně: rubrika 1–5 (správnost, úplnost, nevymýšlení, použitelnost) | — |

## Ručně v prohlížeči (zbytek, který skript nevidí)

1. Doručené spisy: dokumenty bez sp. zn. se zobrazují samostatně („Dokument bez sp. zn.: …“), kritická lhůta (≤ 3 dny) má červené označení.
2. Spis s názvem `<img src=x onerror=alert(1)>` (vytvořit přes API) se zobrazí jako text, nespustí se.
3. Konzultace s AI: přepínač modelu neobsahuje bge-m3; pod odpovědí je blok „Automatická kontrola LexisLocal“, pokud strážce něco zachytil.
4. Patička ukazuje skutečnou adresu serveru, ne „Port 4000“.
5. Nastavení tokenu: srozumitelné bez hledání v nápovědě (známý UX nález).
6. Oponentní diskuse, Hierarchický Swarm a AI scénáře doběhnou bez „Simulovaného fallbacku“.
7. Nahrání DOCX a PNG přes tlačítko v UI (atribut accept).

## Známá omezení

- Skóre agentů závisí na modelu. Porovnávej běhy se stejným modelem (`--model`) a se stejnou bází.
- Při malých rozdílech pusť E víckrát (`--repeat 3`), než prohlásíš zlepšení.
- Lokálně bez Ollamy a sítě selžou C22–C25, E a F (simulovaný fallback). To je očekávané, slouží jen k ladění skriptu.
