# Simulace dne v kanceláři (`office_day.js`)

Delší test celé aplikace tak, jak ji bude používat kancelář: zavedení a jeden plný pracovní den
pěti lidí. Vše přes HTTP API, každý uživatel svým tokenem, jen **syntetická data**
(`backend/eval/office_day/dataset-v1.tar.gz`, generátor `generate_dataset.py`, seed 20261103).

## Co se simuluje

| Fáze | Co dělá | Co se kontroluje |
|---|---|---|
| 0 Zavedení | správce založí 3 advokáty, koncipienta a asistentku, zapne firemní režim; každý advokát naimportuje své spisy z CSV (150); vlastníci nasdílí spisy (asistentka všechny, koncipient ~40 %, kolegové občas ke čtení); interní postupy do báze rešeršníka; asistentka digitalizuje 250 dokumentů (PDF, DOCX, skeny, e-maily), smlouvy bez sp. zn. ručně zařadí | import, sdílení, rychlost digitalizace, zařazení do spisu podle sp. zn., délka lhůty, datum doručení, OCR, žádné duplicitní spisy |
| 1 Den 8:00–16:30 | podatelna přijímá 150 písemností (datové zprávy .zfo s rozsudky, výzvami, platebními rozkazy, předvoláními; e-maily klientů; smlouvy; skeny; písemnosti k neznámým věcem), ranní špička; asistentka zakládá 8 nových věcí po kontrole střetu zájmů (2 se střetem), rezervuje schůzky, fakturuje, hlídá lhůtník; advokáti a koncipient dělají rešerše (i nad spisem), kontroly smluv, koncepty podání, schvalují koncepty, odpovídají klientům, otevírají spisy; prohlížeče se dotazují na novinky. Každý člověk čeká na odpověď, než udělá další krok. V poledne restart serveru | výpadek a obnova dat, chyby 5xx / spadlá spojení, neočekávaná odmítnutí, odezvy po hodinách, fronta práce po 16:30 |
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
