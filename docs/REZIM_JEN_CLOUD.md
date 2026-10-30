# Režim „jen cloud“ — kancelář bez lokálního modelu (bez Ollamy)

_Stav 30. 10. 2026. Pro kancelář, která nechce nebo nemůže provozovat počítač s GPU / Mac mini s lokálním modelem.
Odpovědi dává **Claude přes Amazon Bedrock v EU** ve vlastním účtu AWS kanceláře (`docs/BEDROCK_EU.md`)._

## Co se mění oproti hybridnímu režimu

| | Hybridní (výchozí s cloudem) | Jen cloud |
|---|---|---|
| Odpovědi AI | Claude, když to pravidla dovolí; jinak lokální qwen | **Jen Claude** (Bedrock EU) |
| Spis bez souhlasu klienta / stupeň A / po odvolání souhlasu / přes strop rozpočtu | Odpoví lokální model | **AI dotaz nezpracuje** — srozumitelná hláška, nic neodejde |
| Výpadek Bedrocku | Náhradně lokální model | Chyba „AI služba nedostupná“ (503), **žádná náhradní ani simulovaná odpověď** |
| Vyhledávání (RAG, vektory) | Ollama (bge-m3) | **Model bge-m3 přímo v aplikaci** (ONNX, CPU) — text kvůli vyhledávání nikam neodchází |
| Příjem pošty / podatelna | Pravidla + lokální AI vytěžení | **Jen pravidla** (sp. zn., odesílatel, lhůty z textu) — AI vytěžení se přeskočí |
| Pravidla cloudu (stupně A–D, souhlas, rozpočet, audit, deník spisu) | Platí | Platí beze změny |

Obecné dotazy bez spisu (rešerše) je potřeba označit **„☁️ Obecný dotaz“** (`dataClass: 'verejne'`) — v režimu jen cloud
je volba v asistentovi předvolená a ve výběru modelu je jen cloudový model.

## Přepnutí v aplikaci (správce)

**Manažerský přehled → „🧭 Režim AI kanceláře“**: tři režimy (lokální / hybridní / jen cloud) a u každého kontrola
připravenosti (Ollama a modely; Bedrock: region v EU, EU profil modelu, přístup k AWS; vyhledávací model v aplikaci).
- Do cloudového režimu jen s připraveným Bedrockem a s potvrzením správce (zpracovatelská smlouva s AWS, DPIA, informovaní klienti).
- Návrat na lokální je povolen vždy (i bez běžící Ollamy — s varováním).
- Změna platí hned, doporučen restart a obnovení stránky; zapisuje se do auditu („Nastavení → Režim AI“).
- Volba se uloží (`lexislocal.settings.json` → `aiRezim`) a při startu má přednost před `.env`.
- Zámky: `LEXIS_PILOT_LOCAL_ONLY=1` / `AI_LOCAL_ONLY=1` → jen lokální; `LEXIS_AI_REZIM_ZAMEK=1` → režim určuje jen `.env`.
- API: `GET/POST /api/settings/ai-rezim` (jen správce, `lib/ai_rezim.js`).

## Nastavení ručně (`.env`)

```
LEXIS_JEN_CLOUD=1
AI_CHAT_PROVIDER=bedrock
AI_EMBED_PROVIDER=onnx
# + BEDROCK_* podle docs/BEDROCK_EU.md (region eu-central-1, EU inference profil, rozpočet)
```

Volitelné:

- `EMBED_ONNX_DIR=/cesta/k/modelu` — instalace bez internetu: model se předem nahraje do složky a nic se nestahuje.
  Bez této proměnné se model (Xenova/bge-m3, ~2,2 GB fp32) při prvním dotazu stáhne z Hugging Face.
- `EMBED_ONNX_DTYPE=fp32` (výchozí; nejbližší Ollamě). `q8` je menší a rychlejší, ale vektory se mírně liší → ověřit `embed_compat.js`.
- `EMBED_ONNX_MODEL`, `EMBED_ONNX_MAXCHARS` (výchozí 16000 znaků).

Kombinace `LEXIS_JEN_CLOUD=1` s lokálním poskytovatelem chatu (`ollama`) je chyba konfigurace (aplikace ji odmítne).
Kontrola připravenosti ukazuje „AI služba (Claude přes Bedrock EU)“ a „Vyhledávací model v aplikaci“; při startu se
přeskočí kontrola lokálního modelu.

## Báze zákonů a judikatury

Báze je spočítaná Ollamou (bge-m3). Model v aplikaci je tentýž bge-m3 (CLS pooling, normalizace, 1024 rozměrů), takže
bázi není třeba přepočítávat — **pokud to potvrdí** `node backend/scripts/embed_compat.js --out embed_compat.md`
(potřebuje jednou běžící Ollamu pro srovnání). Hotovo, když průměrná kosinová podobnost ≥ 0,99, minimum ≥ 0,98
a top-3 nejbližších textů se shoduje u ≥ 90 % dotazů; jinak skript skončí kódem 2 a bázi je třeba přepočítat modelem v aplikaci.

## Co kancelář ztrácí (říct předem)

- U spisů bez souhlasu klienta (a stupně A) **AI nepracuje vůbec** — spisová služba, lhůtník, podatelna a vyhledávání ano.
- Dokument mimo spis (smlouva, e-mail nezařazený do spisu) AI nezpracuje — nejdřív ho zařadit do spisu se souhlasem.
  Kontrola smlouvy a odpověď na e-mail ze spisu se souhlasem fungují (spis se pozná podle dokumentu, `contextFileName`).
- V asistentovi je volba **„Ke spisu“**: dotaz se váže na spis, vyhledává se jen v jeho dokumentech a v bázi zákonů
  a judikatury; u spisu je hned vidět, jestli ho AI v cloudu smí zpracovat. Úseky z jiných spisů se při zapnutém
  cloudu do dotazu nedostanou (dřív kvůli nim odmítlo 5 dotazů ke spisům se souhlasem).
- Bez internetu nebo při výpadku AWS je AI nedostupná.
- Každý dotaz stojí peníze (rozpočet a tvrdý strop v Manažerském přehledu).

## Test

Profil `kancelar-jen-cloud` (`docs/SIMULACE_KANCELARE.md`): server se nejdřív změří `embed_compat`, pak se Ollama zastaví
a den kanceláře běží s `--jen-cloud`. Kontroly K23a–d: všechny odpovědi AI z cloudu, žádná simulovaná odpověď, odmítnutí
jen podle pravidel cloudu s důvodem, připravenost hlásí Bedrock a vyhledávací model; rozhraní U4/U5 (odmítnutí bez
lokálního modelu, ve výběru jen cloud).

## Vypnutí

Smazat `LEXIS_JEN_CLOUD`, `AI_EMBED_PROVIDER=ollama`, spustit Ollamu a restartovat (hybridní režim), nebo
`AI_CHAT_PROVIDER=ollama` pro čistě lokální provoz.
