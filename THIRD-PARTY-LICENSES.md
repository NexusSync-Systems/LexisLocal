# Licence třetích stran — LexisLocal

*Ověřeno automatickým auditem závislostí dne 24. 8. 2026.*

## Prohlášení o licenční čistotě

Projekt **LexisLocal je GPL-free**. Všechny závislosti (produkční i vývojové)
jsou licencovány pod **permisivními** licencemi (MIT, ISC, Apache-2.0, BSD-2/3,
BlueOak-1.0.0, 0BSD, WTFPL, CC0), nebo jsou **duálně licencované** s permisivní
volbou (viz níže). Žádná závislost není licencována výhradně pod copyleft licencí
(GPL / LGPL / AGPL / MPL / EUPL / SSPL). Distribucí aplikace tak nevzniká
povinnost zpřístupnit zdrojový kód.

## Souhrn (995 balíčků)

| Licence | Počet |
|---|---|
| MIT | 788 |
| ISC | 105 |
| Apache-2.0 | 24 |
| BSD-3-Clause | 23 |
| BSD-2-Clause | 21 |
| BlueOak-1.0.0 | 18 |
| ostatní permisivní (MIT-0, 0BSD, WTFPL, CC0, CC-BY-4.0, Python-2.0) | zbytek |
| bez uvedené licence | **0** |
| výhradně copyleft | **0** |

## Duální licence — zvolená varianta

U balíčků nabízených pod více licencemi tímto **volíme permisivní variantu**:

| Balíček | Nabízené licence | Zvolená |
|---|---|---|
| `jszip` | MIT OR GPL-3.0-or-later | **MIT** |
| `@zone-eu/mailsplit` | MIT OR EUPL-1.1+ | **MIT** |

## Přibalená data (mimo npm)

| Data | Zdroj | Licence |
|---|---|---|
| `assets/tessdata/ces.traineddata.gz`, `eng.traineddata.gz` (OCR, Tesseract 4 LSTM „best_int“) | npm `@tesseract.js-data/ces`, `@tesseract.js-data/eng` 1.0.0 ← tesseract-ocr/tessdata_best | Apache-2.0 |

## Metodika

Audit prošel rekurzivně všechny `package.json` v `node_modules` (včetně vnořených)
a vyhodnotil pole `license`/`licenses` proti seznamu copyleft licencí. Report je
možné kdykoli obnovit stejným skenerem.

## Pro distribuci

Tento soubor přiložit k desktopové distribuci (adresář aplikace nebo „O aplikaci").
Slouží jako doklad licenční čistoty pro komerční nasazení a případné spory.
