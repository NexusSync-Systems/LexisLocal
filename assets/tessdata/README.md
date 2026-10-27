# Jazyková data OCR (offline)

`ces.traineddata.gz` a `eng.traineddata.gz` — modely Tesseract 4 (LSTM, „best_int“) z balíčků
`@tesseract.js-data/ces` a `@tesseract.js-data/eng` 1.0.0 (npm), původně projekt tesseract-ocr/tessdata_best
(licence Apache 2.0). Přibalené, aby OCR skenů fungovalo i v kanceláři bez internetu — bez nich
tesseract.js data stahuje z CDN a offline sken skončí jako nečitelný (simulace kanceláře 26. 10. 2026).

Jinou složku lze zadat proměnnou `LEXIS_TESSDATA_DIR`. Stažená/rozbalená data se ukládají do
datové složky aplikace (`tessdata-cache`).
