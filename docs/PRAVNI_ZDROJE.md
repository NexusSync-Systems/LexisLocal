# Právní zdroje pro znalostní bázi LexisLocal

Stav 24. 10. 2026. Všechno níže jsou **úřední díla** (§ 3 autorského zákona) — zákony a soudní
rozhodnutí nejsou chráněná autorským právem. Komentáře a odborná literatura (ASPI, CODEXIS, Beck)
zdarma nejsou; k nim vede jen volitelný konektor CODEXIS AI s licencí kanceláře.

| Zdroj | Co dává | Skript | Poznámka |
|---|---|---|---|
| e-Sbírka (MV ČR) | aktuální i historická znění zákonů, po paragrafech | `backend/scripts/fetch-esbirka.js` | s klíčem `api.e-sbirka.gov.cz` (žádost datovou schránkou, esel@spcss.cz), bez klíče cache portálu — pomalu |
| Open data MSp (rozhodnuti.justice.cz) | okresní, krajské, vrchní soudy (od 2020) | `backend/scripts/fetch-judikatura.js`, `naplnit-judikaturu.sh` | metadata + text, anonymizované |
| Sbírka soudních rozhodnutí a stanovisek NS (sbirka.nsoud.cz) | publikovaná judikatura NS s právní větou (~10 tis.) | `backend/scripts/fetch-ns-sbirka.js` | seznam ze sitemap, pauza 2 s, navazuje |
| Ústavní soud — dataset CCC (Zenodo, CC BY 4.0) a NALUS | nálezy a stanoviska pléna (~6,6 tis.) | `backend/scripts/fetch-us.js` | `--ccc` načte zip datasetu, `--nalus --od DD.MM.RRRR` dotáhne novější nálezy; text z NALUS je neautentické znění |
| Sbírka rozhodnutí NSS (sbirka.nssoud.cz) | publikovaná judikatura NSS s právní větou (~4,8 tis.) | `backend/scripts/fetch-nss-sbirka.js` | archiv → sešity → rozhodnutí; bere i rozhodnutí jen s právní větou |
| CODEXIS AI | dotaz na agenta nad databází CODEXIS | Nastavení → Uživatelé → CODEXIS AI | licence kanceláře, čerpá kredity, ven jen očištěná otázka; viz `docs/PRIVACY-MAP.md` |

## Postup (na Macu, z kořene repozitáře)

```bash
# 1) Zákony z e-Sbírky — nejdřív ověřit strukturu (uloží esbirka_probe_89-2012.json)
node backend/scripts/fetch-esbirka.js --probe --law 89/2012
node backend/scripts/fetch-esbirka.js --preset advokat --list
node backend/scripts/fetch-esbirka.js --preset advokat --out ./zakony       # ~23 zákonů
#    s klíčem: ESBIRKA_API_KEY=… nebo --key-file ~/.lexislocal/esbirka_key

# 2) Judikatura NS ze Sbírky
node backend/scripts/fetch-ns-sbirka.js --probe                               # uloží ns_sbirka_probe.html
node backend/scripts/fetch-ns-sbirka.js --out "./judikatura/NS Sbírka" --od-roku 2014 --by-druh

# 3) Judikatura ÚS a NSS
node backend/scripts/fetch-us.js --ccc ./ccc_dataset.zip --out ./judikatura-us     # dataset CCC
node backend/scripts/fetch-us.js --nalus --od 01.01.2024 --out ./judikatura-us     # novější z NALUS
node backend/scripts/fetch-nss-sbirka.js --out ./judikatura-nss                    # Sbírka NSS

# 4) Nahrání do RAGu (server musí běžet)
node backend/scripts/seed-kb.js --agent resersnik --dir ./zakony/OZ          # pro každý zákon
node backend/scripts/seed-kb.js --root ./judikatura                           # obory = podsložky
node backend/scripts/seed-kb.js --agent resersnik --dir ./judikatura-us --token-file ~/.lexislocal/api_token
node backend/scripts/seed-kb.js --agent resersnik --dir ./judikatura-nss --token-file ~/.lexislocal/api_token
#    měsíční aktualizace jde i přes spouštěč úloh (backend/scripts/task-runner.js)
```

Formát souborů zákonů je stejný jako u `split-zakon.js` („Zákon č. 89/2012 Sb., … / § 629 / Citace: …“),
takže je hned čte index paragrafů (`lib/kb_law_index.js`) a ověřování citací.

## Omezení

- Popis rozhraní e-Sbírky je neoficiální (github.com/LexaurinTheDog/esbirka-skill); MV upozorňuje,
  že struktura fragmentů se může do 15. 1. 2027 měnit → před velkým stahováním vždy `--probe`.
- Cache portálu e-Sbírky není určená pro strojový přístup — na pravidelnou aktualizaci požádejte o klíč.
- Parser stránek Sbírky NS je napsaný podle popisu stránky; `--probe` ukáže, jestli sedí.
