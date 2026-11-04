# Spis eval — typ úlohy × model nad syntetickými spisy

Měří, jak agenti LexisLocalu pracují se spisem: odpovídají z dokumentů, citují existující místa, najdou rozpory,
nevymýšlejí a nepouštějí osobní údaje do dopisů. Výsledek je **heat mapa po typech úloh**, ne jedno skóre.
Citace míst ve spisu (dokument + čl./odst./bod) jsou samostatná metrika.

**Data jsou smyšlená** (spisy S1–S4): jména, firmy, adresy, IČO s chybným kontrolním součtem, r. č. s neplatným
měsícem, účet s kódem banky 0000. Test `backend/tests/spisEval.test.js` to hlídá. Nikdy sem nedávat reálné spisy.

## Obsah

| Soubor | Co |
|---|---|
| `spisy/S1–S4/*.txt`, `meta.json` | 4 spisy, 19 dokumentů (smlouvy, dodatek, protokoly, faktura, posudek, výzvy, žaloba, vyjádření), aliasy dokumentů |
| `cases.json` | 48 případů: 8 typů × 6, ke každému zlatá odpověď, klíčová fakta s místem ve zdroji, pasti, rozpory, lhůty |
| `checks.js` | katalog chyb (17 typů) a deterministické kontroly, metrika citací |
| `../../scripts/spis_eval.js` | runner → `scratch/spis-eval/<čas>_<label>.json` + `.md` |
| `../../scripts/spis_eval_compare.js` | heat mapa více běhů + regrese proti prvnímu |

Typy úloh: rešerše ve spisu · shrnutí dokumentu · rozpory mezi dokumenty · odpověď s citací · kontrola smlouvy ·
lhůty a výpočty · mimo spis (negativní) · dopis protistraně.

## Spuštění (Mac, z kořene projektu)

```bash
node backend/scripts/spis_eval.js --provider mock                         # kontrola harnessu, zdarma (vše 100)
node backend/scripts/spis_eval.js --provider bedrock --model eu.anthropic.claude-sonnet-4-6 --label sonnet46
node backend/scripts/spis_eval.js --provider ollama --model qwen2.5:3b --label qwen3b
node backend/scripts/spis_eval_compare.js scratch/spis-eval/A.json scratch/spis-eval/B.json
```

- `--rezim aplikace` (výchozí): celý řetězec `/api/agent` (osnovy, pravidlo zdůvodnění, kontroly výstupu, pseudonymizace,
  pravidla cloudu) nad dočasnou databází; dokumenty spisu jdou do kontextu (vyhledávání v bázi se v evalu nepoužívá).
- `--rezim model`: jen model s dokumenty v kontextu — čisté porovnání modelů nebo verzí promptu.
- `--opakovani 3` při malých rozdílech (rozptyl), `--typy`, `--pripady`, `--judge` (nejisté citace posoudí model).
- Na Macu spouštět přes `caffeinate -i node backend/scripts/spis_eval.js …` — když Mac usne, případy „trvají“ desítky minut
  a skončí chybou běhu. Po 3 výpadcích cloudu / sítě za sebou se běh sám přeruší a uloží jen hotové případy.
- Bedrock: 48 případů ≈ 1–3 USD (podle délky odpovědí a oprav); skript na konci vypíše skutečný odhad.

## Skóre a metriky

Případ začíná na 100, každá chyba strhne body podle váhy v `KATALOG` (`checks.js`). Prošel = skóre ≥ 80 a žádná
kritická chyba (halucinace, mimo spis, chybná lhůta, únik údajů, chyba běhu).

Citace: **platné** = podíl citací, které míří na existující dokument a místo; **podporují** = podíl, kde citované
místo obsahuje hodnoty z tvrzení (částky, data, %, km) nebo, u tvrzení bez čísel, jeho klíčová slova. Co nejde rozhodnout,
je „nejisté“ (bez `--judge` se do podpory nepočítá).

Regrese (`spis_eval_compare.js`, kód 1): pokles typu o ≥ 5 bodů nebo úspěšnosti o ≥ 15 p. b., pokles platnosti / podpory
citací o ≥ 5 p. b., nová kritická chyba, případ, který dřív prošel.

## Známá omezení

- Kontroly jsou deterministické — parafráze bez čísel posuzují jen podle klíčových slov; vymyšlený rozpor bez čísel neodhalí.
- Halucinace se hledají u částek, dat, procent, km a osob s titulem; vypočtené hodnoty (součty, lhůty) jsou povolené.
- Vyhledávání nad spisem (RAG) se v evalu neměří — dokumenty jsou v kontextu. Kvalitu vyhledávání měří `rag_eval`.

## LLM-judge (podporuje citované místo tvrzení?)

Program posuzuje podporu citace jen podle čísel a klíčových slov. Na kontrolní sadě dvojic **schválil 12 z 34
citací, které tvrzení nepodporují** (jiná hodnota, opak, tvrzení navíc, jiná strana) — shoda s klíčem 65 %.
Proto je tu úzký judge (`judge.js`): jedna otázka ANO/NE, pevná rubrika, příklady (few-shot) jen ze sady vývoj.

| Soubor | Co |
|---|---|
| `spisy/S5`, `spisy/S6` | další 2 smyšlené spisy (pracovní poměr, zápůjčka) jen pro kontrolu judge |
| `judge/pary.json` | 59 dvojic tvrzení + citované místo s klíčem a druhem (parafráze, jiná hodnota, jiné místo, opak, částečně, související); vývoj = S1–S4 (24), kontrola = S5–S6 (35) |
| `judge/kalibrace_k_oznaceni.csv` | pracovní list k ručnímu označení — zamíchané, bez klíče (`spis_eval_judge.js --list` ho vytvoří znovu) |
| `../../scripts/spis_eval_judge.js` | kalibrace: shoda judge s klíčem a s člověkem, κ, FP/FN, po druzích dvojic |

```bash
# 1) ručně: otevřít kalibrace_k_oznaceni.csv (Numbers / Excel), do sloupce „hodnocení“ ANO nebo NE, uložit jako CSV (středník)
# 2) kalibrace (~0,05–0,15 USD)
node backend/scripts/spis_eval_judge.js --provider bedrock --model eu.anthropic.claude-sonnet-4-6 --aws-profile lexislocal-bedrock
# 3) eval s judgem nad všemi platnými citacemi
node backend/scripts/spis_eval.js --provider bedrock --model eu.anthropic.claude-sonnet-4-6 --aws-profile lexislocal-bedrock --judge-vse --label sonnet46-judge
```

Judge je použitelný při shodě ≥ 90 % a nejvýš 1 falešném ANO (FP) na kontrolní sadě. Řádek „člověk × klíč“ ověřuje,
že klíč dvojic sedí s lidským úsudkem — kde se liší, opravit klíč nebo dvojici, ne judge.
