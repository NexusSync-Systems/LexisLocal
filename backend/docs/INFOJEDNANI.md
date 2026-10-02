# Hlídač soudních jednání — InfoJednání

LexisLocal hlídá nařízená jednání dvěma cestami:

1. **Z doručených dokumentů.** Předvolání nebo vyrozumění („jednání se koná dne … v … hod., jednací síň č. …“) se při zpracování rozpozná. Jednání se založí jako **❓ k potvrzení** a přiřadí se ke spisu a odpovědnému advokátovi.
2. **Z InfoJednání (MSp).** Každou hodinu (`LEXIS_HEARINGS_INTERVAL_MIN`) a 2 minuty po startu serveru hlídač:
   - ověří sledovaná jednání v příštích 30 dnech a pozná přesunutí nebo zrušení,
   - prohledá **všechny aktivní spisy**, které mají sp. zn. a soud, a přidá nově nařízená jednání k potvrzení.

Závazné je vždy předvolání doručené do datové schránky. InfoJednání je jen informativní a data drží asi 30 dní dopředu.

## Výpadek zdroje

Od 1. 10. 2026 jsou InfoSoud a InfoJednání mimo provoz. Výpadek se proto nikdy netváří jako „beze změny“:

- U každého jednání a spisu je vidět **naposledy ověřeno** nebo **neověřeno: důvod**.
- Po `LEXIS_HEARINGS_OUTAGE_ALERT_H` hodinách (výchozí 6) vznikne **jedno** upozornění „InfoJednání nedostupné — ověřte termíny ručně“. V Připravenosti systému je pak červená položka „Hlídač soudních jednání“.
- Po obnovení se upozornění uzavře a vznikne informace „opět dostupné — termíny znovu ověřeny“.

Stav ukazuje `GET /api/calendar/hearings/status`. Ruční spuštění: `POST /api/calendar/sync` (v UI tlačítko synchronizace s portálem).

## Co víme o rozhraní (frontend InfoJednání zachycený 5/2026 v repu LexisEditor)

- `POST https://infojednani.gov.cz/api/v1/jednani/vyhledej` s JSON tělem
  `{druhOrganizace, agenda, okresniSoud, jednaciSin, datumJednani, cisloSenatu, druhVeci, bcVec, rocnik, typHledani:"SPZN"}`.
  U okresního soudu posílá oficiální web `druhOrganizace` = nadřízený KS/MS a `okresniSoud` = kód OS. LexisLocal to dělá stejně.
- Odpověď: `{cislo, druh, bcVec, rocnik, nadrizenaOrganizace, organizace, jednaciSin, datum, typ, platneK, udalosti:[…]}`.
  Události mají pole `datum, cas, jednaciSin, druhJednani, resitel, vysledek, neverejneJednani, jednaniZruseno`.
  Pozor: původní hlídač i LexisEditor četly `jednaciZruseno`, takže zrušení nikdy nepoznaly. Opraveno.
- Číselníky soudů: `/api/v1/organizace/lov` (KS/MS/VS) a `/api/v1/organizace/podrizene/lov` (OS).
  Kopie (96 soudů) je v `backend/data/courts_infojednani_lov.json`. Kód soudu se dohledá z názvu ve spisu („Okresní soud v Jihlavě“ → `OSJIMJI`), i když je název v 6. pádě. Při nejednoznačnosti se nevrátí nic.

Za běhu toto ověřené není: weby jsou od 1. 10. 2026 mimo provoz a 2. 10. rozhraní vracelo HTTP 500.

## Co udělat, až budou justiční weby zase funkční

1. **Zachycení skutečného dotazu**
   - Otevřete web InfoJednání v Chromu a zapněte DevTools (F12) → Network → Fetch/XHR.
   - Vyhledejte libovolnou věc podle sp. zn. u konkrétního soudu (nejlépe takovou, která má jednání v příštích 30 dnech).
   - U dotazu, který vrací seznam jednání, si zapište:
     - **Request URL** a **metodu** (GET/POST),
     - **Payload**, tedy tělo dotazu a názvy polí (sp. zn., kód soudu),
     - **kód soudu**, který web posílá,
     - ukázku **Response** (názvy polí pro datum, čas, síň, zrušení).
2. **Ověření z LexisLocal**
   ```bash
   node backend/scripts/infojednani_probe.js --spis "12 C 45/2026" --court <KÓD> \
        --url "<Request URL>" [--method GET] \
        [--body '{"spisovaZnacka":"{cisloSenatu} {druhVeci} {bcVec}/{rocnik}","soud":"{courtCode}"}']
   ```
   - Ve šabloně `--body` a v URL lze použít `{cisloSenatu} {druhVeci} {bcVec} {rocnik} {courtCode}`.
   - Skript vypíše, kolik jednání z odpovědi přečetl, a doporučené proměnné do `.env`.
   - Pokud odpovědi nerozumí, upraví se `normalizeResponse` v `lib/court_hearings_source.js`. Názvy polí se tam čtou tolerantně (`udalosti`/`jednani`/`items`, `datum`/`date`, `cas`, `jednaciSin`, `jednaciZruseno`).
3. **Nastavení**
   - Do `.env` zapište:
     ```
     LEXIS_INFOJEDNANI_URL=...
     LEXIS_INFOJEDNANI_METHOD=...
     LEXIS_INFOJEDNANI_BODY_TEMPLATE=...
     LEXIS_INFOJEDNANI_VERIFIED=1
     ```
   - Kódy soudů zapište do `<data>/courts_infojednani.json`:
     ```json
     { "Okresní soud v Jihlavě": "<kód>", "Krajský soud v Brně": "<kód>" }
     ```
     Případně je zadejte přímo u spisu (pole *kód soudu*).
4. **Kontrola:** `POST /api/calendar/sync` → v odpovědi `health.status: "ok"` a u spisů „InfoJednání ověřeno …“.

## Proměnné prostředí

| Proměnná | Výchozí | Význam |
|---|---|---|
| `LEXIS_INFOJEDNANI_ENABLED` | `1` | `0` hlídání InfoJednání vypne |
| `LEXIS_INFOJEDNANI_URL` | neověřená adresa | adresa rozhraní (může obsahovat `{…}` šablonu) |
| `LEXIS_INFOJEDNANI_METHOD` | `POST` | `GET` nebo `POST` |
| `LEXIS_INFOJEDNANI_BODY_TEMPLATE` | — | JSON šablona těla dotazu |
| `LEXIS_INFOJEDNANI_VERIFIED` | `0` | `1` po ověření probe skriptem (zobrazí se ve stavu) |
| `LEXIS_INFOJEDNANI_TIMEOUT_MS` | `15000` | časový limit dotazu |
| `LEXIS_COURT_CODES` | — | JSON mapa „název soudu“ → kód (alternativa k souboru) |
| `LEXIS_HEARINGS_INTERVAL_MIN` | `60` | jak často hlídač běží |
| `LEXIS_HEARINGS_OUTAGE_ALERT_H` | `6` | po kolika hodinách výpadku upozornit advokáta |
