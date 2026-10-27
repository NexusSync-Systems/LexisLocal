# Zavedení LexisLocalu v kanceláři — postup krok za krokem

Pro: dodavatele nebo IT partnera kanceláře, který LexisLocal instaluje.
Platí pro: LexisLocal 1.2 (stav 27. 10. 2026). Pilot: Mac mini v kanceláři, advokáti přes VPN.

Dokumenty pro advokáta (smlouvy, DPIA, pravidla, souhlasy) jsou v [`kancelar/`](kancelar/README.md).
Před ostrým provozem je musí advokát zkontrolovat a podepsat — viz krok 9.

> Pořadí je důležité: **nejdřív lokální provoz bez cloudu**, cloudový model (Bedrock) až jako
> samostatný krok 8, po aktualizaci DPIA a s doklady o souhlasu klientů.

---

## 1. Hardware a systém

| Položka | Doporučení |
|---|---|
| Server | Mac mini (Apple Silicon), RAM podle zvoleného modelu — [doplnit podle `MODEL_BENCH.md`] |
| Šifrování disku | **FileVault zapnutý** (povinně — databáze je šifrovaná, ale dokumenty spisovny ne) |
| Napájení | start po výpadku proudu zapnutý, uspání vypnuté; doporučen záložní zdroj (UPS) |
| Umístění | uzamčená místnost / skříň |
| Zálohy | 2 šifrované externí disky (střídat, jeden mimo kancelář) |
| Účet macOS | samostatný účet pro LexisLocal, silné heslo, automatické přihlášení vypnuté |

## 2. Instalace

1. Nainstalovat LexisLocal z instalátoru (`.dmg`). Nepodepsaný build: postup v [`INSTALL_UNSIGNED.md`](../INSTALL_UNSIGNED.md).
2. Nainstalovat Ollamu a stáhnout modely: chatovací model [doplnit podle `MODEL_BENCH.md`] a `bge-m3` pro vyhledávání.
3. Nainstalovat znalostní bázi (zákony, judikatura) z balíčku — [`INSTALACE_BAZE.md`](INSTALACE_BAZE.md). Server musí být při instalaci vypnutý.
4. První start: vygeneruje se šifrovací klíč a API token (uloží se mimo datovou složku, v logu je vidět jen konec tokenu).
5. Kontrola: `node backend/scripts/readiness.js` — všechny body READY (nebo vysvětlené).

## 3. Spisovna

- V dashboardu → Nastavení → spisovna: vybrat složku se spisy kanceláře.
- Doporučeno: **lokální disk Mac mini**. Síťová složka (NAS, server kanceláře) funguje, ale změny souborů se na ní zatím nemusí spolehlivě zachytit (sledování složky je navržené pro lokální disk) — při síťové spisovně ověřit, že se nový dokument objeví v LexisLocalu.
- Spisovna se zálohuje spolu s databází (krok 6).

## 4. Síť a vzdálený přístup

Podle [`VZDALENY_PRISTUP.md`](VZDALENY_PRISTUP.md): Tailscale (firemní účet), `.env`:

```
BIND_HOST=100.x.y.z        # adresa Mac mini v Tailscale, ne 0.0.0.0
USE_HTTPS=true
LEXIS_ENFORCE_TOKEN=1
```

Po restartu v logu: „Síťové (LAN) nasazení s vynuceným tokenem i TLS — OK“. Pravidla přístupu v Tailscale jen pro skupinu advokátů a port LexisLocalu.

## 5. Uživatelé a role

1. Zapnout firemní režim (`LEXIS_FIRM_MODE=1` nebo v dashboardu).
2. Založit účet každému pracovníkovi — **každý svůj** (audit čtení spisů je podle účtu).
3. Role: advokát (schvaluje odeslání klientovi, zaznamenává souhlas s cloudem, snižuje stupeň citlivosti), koncipient/asistent, správce.
4. Spárovat LexisEditor na noteboocích advokátů (párovací odkaz s otiskem klíče serveru).

## 6. Zálohy

```bash
node backend/scripts/backup.js --out /Volumes/Zaloha1         # záloha + automatické ověření
node backend/scripts/backup.js --overit /Volumes/Zaloha1/<soubor>.tar.gz   # zkouška obnovy
```

- Záloha obsahuje šifrovací klíč → **jen na šifrovaný disk**.
- Plán: [doplnit: např. denně večer na disk 1, týdně disk 2 mimo kancelář]. Zkouška obnovy jednou měsíčně.
- Obnova: viz [`PROVOZ_SPRAVCE.md`](PROVOZ_SPRAVCE.md#zálohy-a-obnova).

## 7. Pravidla AI pro pilot

- Pilot startuje v režimu **jen lokálně**: `LEXIS_PILOT_LOCAL_ONLY=1` (cloud technicky zakázán).
- Každý spis má stupeň citlivosti (výchozí **B**). Advokát při zakládání spisu zkontroluje, zda nepatří do **A** (trestní obhajoba, zdravotní údaje, nezletilí, oznamovatelé…). Stupeň má smysl nastavit už teď — až se cloud zapne, rozhoduje podle něj.
- Školení AI gramotnosti (dokument 4) před prvním použitím, záznam podepsat.

## 8. Volitelně: cloudový model Claude přes Amazon Bedrock (EU)

Až po: aktualizovaném DPIA (dokument 2), informacích pro klienty (3), schválení podle vnitřních pravidel (5) a souhlasech klientů (7).

1. Účet AWS kanceláře, šablona oprávnění a rozpočtu — [`AWS_NASTAVENI_KROKY.md`](AWS_NASTAVENI_KROKY.md). Akce v AWS konzoli provádí kancelář / její správce; přístupový klíč nikomu neposílat.
2. Podrobnosti a nastavení `.env` — [`BEDROCK_EU.md`](BEDROCK_EU.md):
   ```
   LEXIS_PILOT_LOCAL_ONLY=0
   AI_CHAT_PROVIDER=bedrock
   BEDROCK_REGION=eu-central-1
   BEDROCK_MODEL_ID=eu.anthropic.claude-sonnet-5-5
   AWS_PROFILE=lexislocal-bedrock
   ```
3. Rozpočet: dashboard → Manažerský přehled → Náklady na cloudovou AI (měsíční rozpočet, upozornění, tvrdý strop).
4. Test před ostrým provozem (syntetická data, dočasná databáze): `node backend/scripts/aws-pilot-test.js`.
5. **Stupeň a souhlas u spisu.** Tlačítka na kartě spisu zatím nejsou (v plánu). Do té doby je zaznamená správce přes API — zápis jde do deníku spisu i auditu:
   ```bash
   T=$(cat "$HOME/Library/Application Support/LexisLocal/api_token")
   U=https://127.0.0.1:4000/api/spisy/<id-spisu>/cloud
   curl -s -H "X-API-Token: $T" $U                                   # stav
   curl -s -H "X-API-Token: $T" -H 'Content-Type: application/json' \
        -d '{"stupen":"A"}' $U/stupen                                 # zvýšení stupně
   curl -s -H "X-API-Token: $T" -H 'Content-Type: application/json' \
        -d '{"typ":"spis","poznamka":"písemný souhlas ze dne …, založen ve spisu"}' $U/souhlas
   curl -s -H "X-API-Token: $T" -H 'Content-Type: application/json' \
        -d '{"duvod":"klient odvolal telefonicky dne …"}' $U/souhlas/odvolat
   ```
   Snížení stupně vyžaduje `"duvod"`. Souhlas u spisu ve stupni A systém odmítne.
6. Kontrola: dotaz ke spisu bez souhlasu → odpověď z lokálního modelu, v auditu „Cloud AI — Cloud odepřen — zpracováno lokálně“; dotaz ke spisu se souhlasem → v deníku spisu „Dotaz asistenta zpracován v cloudu“.

## 9. Kontrola před spuštěním

- [ ] `readiness.js` bez chyb
- [ ] FileVault zapnutý, Mac mini neusíná, start po výpadku proudu
- [ ] Vzdálený přístup: zkoušky z tabulky v `VZDALENY_PRISTUP.md` (bez VPN se stránka nenačte, bez tokenu 401)
- [ ] Každý uživatel má vlastní účet; LexisEditor spárovaný
- [ ] Záloha vytvořena a ověřena (`--overit`), druhý disk mimo kancelář
- [ ] Režim jen lokálně zapnutý (nebo krok 8 dokončen včetně dokumentů)
- [ ] Dokumenty z `kancelar/` zkontrolované advokátem a podepsané (smlouvy, pravidla, DPIA)
- [ ] Školení proběhlo, záznam podepsaný
- [ ] Kontakty pro incidenty doplněné (vnitřní pravidla, oddíl 6)
- [ ] Předán [`PROVOZ_SPRAVCE.md`](PROVOZ_SPRAVCE.md) správci / IT partnerovi
