# Simulace dne v kanceláři (`office_day.js`)

Delší test celé aplikace tak, jak ji bude používat kancelář: zavedení a jeden plný pracovní den
pěti lidí. Vše přes HTTP API, každý uživatel svým tokenem, jen **syntetická data**
(`backend/eval/office_day/dataset-v1.tar.gz`, generátor `generate_dataset.py`, seed 20261103).

## Co se simuluje

| Fáze | Co dělá | Co se kontroluje |
|---|---|---|
| 0 Zavedení | správce založí 3 advokáty, koncipienta a asistentku, zapne firemní režim; každý advokát naimportuje své spisy z CSV (150); vlastníci nasdílí spisy (asistentka všechny, koncipient ~40 %, kolegové občas ke čtení); interní postupy do báze rešeršníka; asistentka digitalizuje 250 dokumentů (PDF, DOCX, skeny, e-maily), smlouvy bez sp. zn. ručně zařadí | import, sdílení, rychlost digitalizace, zařazení do spisu podle sp. zn., délka lhůty, datum doručení, OCR, žádné duplicitní spisy |
| 1 Den 8:00–16:30 | podatelna přijímá 150 písemností (datové zprávy .zfo s rozsudky, výzvami, platebními rozkazy, předvoláními; e-maily klientů; smlouvy; skeny; písemnosti k neznámým věcem), ranní špička; asistentka (úroveň podatelna) zakládá 8 nových věcí po kontrole střetu zájmů (2 se střetem), rezervuje schůzky, fakturuje, hlídá lhůtník, připravuje se Spisovatelem rutinní korespondenci ke schválení; advokáti a koncipient dělají rešerše (i nad spisem), kontroly smluv, koncepty podání, schvalují koncepty, odpovídají klientům, otevírají spisy; prohlížeče se dotazují na novinky. Každý člověk čeká na odpověď, než udělá další krok. V poledne restart serveru | výpadek a obnova dat, chyby 5xx / spadlá spojení, neočekávaná odmítnutí, odezvy po hodinách, fronta práce po 16:30 |
| 2 Konec dne | — | úplnost dokumentů, lhůty a konec lhůty (pracovní den), střet zájmů (odhalen / falešný poplach / „nelze prověřit“), spisy (duplicity, chybějící, navíc), kdo co vidí (seznam spisů, doručená pošta, vyhledávání, přímý odkaz na cizí spis), koncepty (vznik, schválení, koncipient nesmí schválit), anonymizace, auditní řetězec, záznamy transparentnosti AI, deaktivace účtu |

Kvalita odpovědí AI se hodnotí automaticky: rešerše ze sady `server_suite/cases.json` podle vzorů
(must / anyOf / mustNot), kontrola smlouvy podle toho, kolik vložených rizikových klauzulí
(záloha 100 %, jednostranné zvýšení ceny, rozhodce jmenovaný jednou stranou, pokuta bez limitu,
automatické prodloužení, vyloučení odpovědnosti za vady…) kontrolor našel.

## Spuštění

Na serveru (GPU, plná báze, ~10 h, vypne se sám) — úloha spouštěče, **stojí peníze**:

```json
{"uloha": "aws_spust_test", "parametry": {"profil": "kancelar", "az": "b"}}
```

Profily (`"profil"` v úloze):

| Profil | Kancelář | Den | Instance běží |
|---|---|---|---|
| `kancelar` | 5 lidí, 150 spisů, 250 + 150 dokumentů | 8 h | ~10 h |
| `kancelar-3h` | totéž | zhuštěný do 3 h | ~4,5 h |
| `kancelar-bedrock` | 5 lidí jako `kancelar-3h`, server navíc s **Claude přes Bedrock EU** (role instance, Sonnet 4.6); souhlas klienta u ~1/3 spisů, obecné rešerše jako veřejné; K21 ověří, že do cloudu nejde nic bez souhlasu | zhuštěný do 3 h | ~4,5 h (+ řádově jednotky USD za Claude) |
| `kancelar-velka` | **zátěžový den**: 6 advokátů, 2 koncipienti, 2 asistentky, 300 spisů, 400 + 350 dokumentů, tempo práce ×1,5 (`--intenzita 1.5`) | 8 h | ~11 h |

Simulace ověřuje i dashboard: název a logo kanceláře (Z12), že každý účet vidí sebe (K19) a připojení
dalšího zařízení odkazem `/?pair=` s přihlášením vlastním účtem a zrušením zařízení (K20).

Když g6.xlarge nemá kapacitu (`InsufficientInstanceCapacity`), lze zvolit `"typ": "g5.xlarge"` (A10G, rychlejší)
nebo `"g4dn.xlarge"` (T4, pomalejší) — časy odezvy pak nejdou přímo srovnat s běhy na g6.

Profil `kancelar` (`scripts/aws/remote-office-userdata.sh`): stejná báze a nastavení jako pilot na
Mac mini (bge-m3, bez rerankeru, K=4), studený start bez cache vektorů, paměť backendu a GPU každých
5 min do `pamet.log`, po simulaci záloha se zkouškou obnovy. `OFFICE_HOURS=3` zhustí den (levnější).
Výsledky: `s3://…/<běh>_remote_kancelar/kancelar/office_day_*.md` (+ `.json` se všemi odpověďmi).

Lokálně proti běžícímu serveru (čistá instalace — účty simulace nesmí existovat):

```bash
node backend/scripts/office_day.js --base http://127.0.0.1:4000 --token <token správce> --smoke
node backend/scripts/office_day.js --base https://<server> --token <token> --insecure --hours 8 \
  --restart-cmd "systemctl restart lexislocal" --restart-at 4.5
```

`--smoke` = 20 min den, 30 + 30 dokumentů. Tokeny uživatelů jsou jen v paměti procesu.

Na Macu (jako budoucí Mac mini) v ODDĚLENÉ dočasné instalaci — skutečná data aplikace se nemění:

```json
{"uloha": "office_day_mac", "parametry": {"hodiny": 3}}
```

`backend/scripts/office_day_local.js`: ověří Ollamu, nainstaluje bázi z `scratch/kb-balicek/lexis-baze-*.tar.gz`,
spustí vlastní backend na 127.0.0.1:4199, `caffeinate` drží Mac vzhůru, paměť backendu každou minutu, po skončení
instanci zastaví a dočasná data smaže. Výsledky: `scratch/ukoly/office_day_mac/<čas>/`. Zastavení: `{"uloha":"stop"}`.

## Nová datová sada

```bash
python3 backend/eval/office_day/generate_dataset.py --out /tmp/ds --spisy 150 --onboarding 250 --den 150
tar -czf backend/eval/office_day/dataset-v1.tar.gz -C /tmp/ds .
```

Potřebuje reportlab, python-docx, Pillow a font DejaVu Serif (jen pro generování, ne pro běh testu).

## Co simulace našla

Zkušební běh 26. 10. 2026 (lokálně, náhrada modelu):
- sp. zn. „19 P a Nc 57/2026“ se nerozpoznala → dokumenty opatrovnických věcí bez spisu (opraveno, `lib/case_number.js`),
- nahrání dokumentu se zpracovalo dvakrát (nahrání + hlídání složky) → 2× vytěžení AI (opraveno, `lib/watcher.js`).

Server 26. 10. 2026 (g4dn.xlarge / T4, qwen2.5:7b, plná báze, 8 h): 41/43 kontrol, 6 185 požadavků bez chyby,
restart bez ztráty dat, paměť backendu 1,1–1,3 GB celý den. Opraveno 27. 10.:
- kontrolor přehlédl 8 z 51 rizikových klauzulí (záloha 100 %, krátká záruka, vyloučení odpovědnosti) → doplněno do `lib/clause_scan.js`,
- OCR „P a Nc“ → „P a Ne“ vytvořilo spis navíc → oprava podle existujícího spisu (`spisy.findByCaseOcr`),
- asistentka ztratila přístup ke spisu, který založila → úroveň **podatelna** (`lib/access.js`),
- záloha ověřovala jen záznamy AI → ověřuje i hlavní auditní log (`scripts/backup.js`).

Zátěžový den 27. 10. 2026 (`kancelar-velka`, g4dn.xlarge / T4, 10 lidí, tempo ×1,5, 8 h): 49/50 kontrol, 12 775 požadavků,
fronta po 16:30 0 min, AI p50 19–31 s (p95 ráno 135 s, jinak do 60 s), digitalizace 22,9 dok./min, paměť backendu 1,1–1,3 GB.
Opraveno 28. 10.:
- 6× přerušené spojení (ECONNRESET) při vytížení serveru — server držel volné spojení jen 5 s jako klient → keep-alive
  65 s (`lib/http_timeouts.js`, `HTTP_KEEPALIVE_TIMEOUT_MS`); simulace čtení (GET) po přerušení jednou zopakuje a počítá zvlášť (K17b),
- popisek Z2 podle počtu účtů v sadě, kontrola smlouvy ukládá, které rizikové klauzule chyběly (`chybi` v .json).
