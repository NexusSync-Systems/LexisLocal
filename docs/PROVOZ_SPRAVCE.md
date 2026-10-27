# Provoz LexisLocalu — příručka pro správce a IT partnera

Platí pro LexisLocal 1.2 (stav 27. 10. 2026). Instalace: [`IMPLEMENTACE_KANCELAR.md`](IMPLEMENTACE_KANCELAR.md).

Zásada: **správce pracuje s technikou, ne s obsahem spisů.** Do spisů, dokumentů a odpovědí AI nenahlíží;
pokud to zásah vyžaduje, jde o krizový zásah L4 (níže) a potřebuje písemný pokyn advokáta.

## Pravidelné úkony

| Kdy | Co | Jak |
|---|---|---|
| denně | záloha proběhla a je ověřená | výstup `backup.js` („ověřeno“), velikost souboru |
| týdně | výměna záložního disku (jeden mimo kancelář) | |
| týdně | aktualizace macOS a Ollamy | po záloze; poté `readiness.js` |
| měsíčně | zkouška obnovy | `backup.js --overit <soubor>` |
| měsíčně | kontrola cloudu (je-li zapnut) | audit „Cloud AI“, Manažerský přehled → Náklady na cloudovou AI |
| čtvrtletně | kontrola účtů a zařízení | odejít pracovník → deaktivovat účet, odebrat zařízení v Tailscale |
| ročně | revize dokumentů a školení | vnitřní pravidla, oddíl 7 |

## Aktualizace LexisLocalu

1. Záloha (`backup.js`) a ověření.
2. Zastavit LexisLocal.
3. Nainstalovat nový balíček od dodavatele; přečíst poznámky k vydání (`docs/RELEASE_NOTES_*.md`).
4. Spustit, zkontrolovat log (TLS, token, „Síťové nasazení … OK“) a `node backend/scripts/readiness.js`.
5. Zkouška: přihlášení, otevření spisu, dotaz na asistenta.
6. Problém → vrátit předchozí verzi a obnovit zálohu z kroku 1.

Automatické aktualizace LexisLocal nemá — instaluje je vždy správce.

## Zálohy a obnova

```bash
node backend/scripts/backup.js --out /Volumes/Zaloha1            # záloha (+ ověření)
node backend/scripts/backup.js --overit <soubor.tar.gz>           # zkouška obnovy, nic nepřepíše
node backend/scripts/backup.js --obnovit <soubor.tar.gz>          # obnova — server musí být vypnutý
```

Archiv obsahuje šifrovanou databázi, index, audit, **šifrovací klíč** a spisovnu → jen šifrovaný disk.
Po obnově: start, `readiness.js`, kontrola auditního řetězce (backup.js ho kontroluje při ověření).

## Diagnostika bez obsahu (podpora L2)

Dodavateli se předávají jen technické údaje:

- výstup `node backend/scripts/readiness.js`,
- verze LexisLocalu, macOS, Ollamy a modelů,
- chybová hlášení z konzole serveru.

Před odesláním výpis projít: **žádná jména, spisové značky, názvy dokumentů ani text dotazů.**
Pokud tam jsou, nahradit je (např. „[spis]“). API token se nikdy neposílá (v logu je zkrácený).

## Úrovně podpory

| Úroveň | Co | Přístup k datům |
|---|---|---|
| L1 | rada telefonem / e-mailem | žádný |
| L2 | diagnostika z výpisů podle předchozího oddílu | žádný |
| L3 | sdílení obrazovky — spouští a sleduje pracovník kanceláře | jen co je vidět; zápis do protokolu podpory |
| L4 | krizový zásah nad daty (oprava DB, obnova) | jen na písemný pokyn advokáta; smlouva o zpracování (vzor 1); protokol |

Protokol podpory: [doplnit: kde se vede] — datum, kdo, důvod, rozsah, výsledek.

## API token a klíče

- Token: `~/Library/Application Support/LexisLocal/api_token` (macOS). Nikam ho nekopírovat, neposílat e-mailem.
- Výměna tokenu (např. po odchodu správce): zastavit server, soubor `api_token` přesunout do složky
  mimo LexisLocal (např. `scratch/`), spustit server — vygeneruje se nový. Poté znovu zadat token
  v dashboardu a znovu spárovat LexisEditory.
- Šifrovací klíč databáze: je v záloze. Rotace přes API `POST /api/system/rotate-key` jen po čerstvé záloze a na pokyn advokáta (tlačítko v dashboardu zatím není).
- Přístupový klíč AWS (je-li cloud): v `~/.aws/credentials` pod profilem `lexislocal-bedrock`; rotace v konzoli AWS
  (nový klíč → nastavit → starý deaktivovat). Zakládá a ruší ho kancelář.

## Cloudový model (je-li zapnut)

- Rychlé vypnutí: v `.env` `LEXIS_PILOT_LOCAL_ONLY=1` (nebo `AI_CHAT_PROVIDER=ollama`) a restart; v AWS deaktivovat přístupový klíč.
- Rozpočet: Manažerský přehled → Náklady na cloudovou AI. Odhad podle tokenů je živý; částka z AWS se doplňuje
  každý večer (po `LEXIS_AWS_SYNC_HOUR`, výchozí 22 h). Po dosažení tvrdého stropu jde vše lokálně.
- Audit „Cloud AI“: každé odeslání i odepření (spisy, model, důvod). Neočekávané odeslání → hlásit advokátovi jako incident.
- Stupeň a souhlas u spisu: příkazy v [`IMPLEMENTACE_KANCELAR.md`](IMPLEMENTACE_KANCELAR.md#8-volitelně-cloudový-model-claude-přes-amazon-bedrock-eu) (krok 5). Souhlas zaznamenává advokát; správce jen na jeho pokyn.

## Incidenty

| Situace | Okamžitě | Dál |
|---|---|---|
| Ztráta / krádež notebooku | odebrat zařízení v Tailscale, deaktivovat účet a párování v LexisLocalu | nahlásit advokátovi; posoudí ohlášení ÚOOÚ (do 72 h) |
| Podezření na neoprávněný přístup | odpojit server od sítě (vypnout Tailscale), **nevypínat počítač** | zajistit audit a log; kontaktovat dodavatele (L1/L2) |
| Spis odešel do cloudu bez souhlasu | vypnout cloud (viz výše) | audit „Cloud AI“ → advokátovi; nahlásit dodavateli jako chybu |
| „Pokyny pro AI“ v dokumentu protistrany | nic nemazat | nahlásit advokátovi; ukázku (bez osobních údajů) dodavateli |
| Selhání disku / databáze | nezapisovat dál, server vypnout | obnova ze zálohy (L4 jen s pokynem advokáta) |

Kontakty: [doplnit: odpovědná osoba v kanceláři, dodavatel, IT partner].
