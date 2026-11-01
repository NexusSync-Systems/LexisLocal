# Režim „jen cloud“ — kancelář bez lokálního modelu (bez Ollamy)

_Stav 1. 11. 2026. Pro kancelář, která nechce nebo nemůže provozovat počítač s GPU / Mac mini s lokálním modelem.
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

## Přeřazení výsledků přes Bedrock (volitelné, pilot)

Na Macu bez GPU není lokální reranker. Měření 26. 10. (původní bge-m3, bez rerankeru): správný § mezi pasážemi
asistenta ~82 % (na 1. místě 34 %), proti 95 % (77 %) se sestavou s rerankerem na GPU. Přeřazení pasáží lze
nechat na **Amazon Bedrock Rerank v EU**:

```
RAG_RERANK=1
RAG_RERANK_PROVIDER=bedrock
BEDROCK_RERANK_MODEL=cohere.rerank-v3-5:0   # nebo amazon.rerank-v1:0 (vybere měření pilot-hledani)
BEDROCK_RERANK_USD=0.002                     # odhad ceny jednoho volání (náklady v Manažerském přehledu)
```

- Do AWS jde **jen dotaz a veřejné pasáže zákonů a judikatury**; úseky ze spisů zůstávají na svém místě a nikam
  neodcházejí (`lib/rerank_service.js`).
- Jen když dotaz pustí pravidla cloudu (spis se souhlasem / ☁️ Obecný dotaz), stejně jako odpověď Clauda. Jinak,
  při chybě nebo vypršení (`RAG_RERANK_TIMEOUT_MS`) zůstane původní pořadí.
- IAM: `bedrock:Rerank` + `bedrock:InvokeModel` na `cohere.rerank-*` / `amazon.rerank-*` v eu-* (šablona
  `scripts/aws/bedrock-eu-kancelar.yaml`). Cohere je model třetí strany (AWS Marketplace) — předplatné jednou potvrdit
  v konzoli Bedrock → Model access.
- **Měření 1. 11. 2026 večer** (`2026-11-01_1640_remote_judikatura`, původní bge-m3, 5 pasáží, slovník, 1 volání na dotaz,
  všech 243 volání na model prošlo bez chyb a bez překročení limitu) — správný § mezi pasážemi asistenta / na 1. místě:

  | Sada | bez rerankeru | **Cohere Rerank 3.5** | Amazon Rerank 1.0 | GPU (doladěný model + reranker, 31. 10.) |
  |---|---|---|---|---|
  | zlatá (124) | 89,5 / 37,9 % | **96,8 / 78,2 %** | 90,3 / 61,3 % | 95,2 / 76,6 % |
  | dotazy klientů (68) | 85,3 / 32,4 % | **97,1 / 70,6 %** | 91,2 / 48,5 % | 94,1 / 72,1 % |
  | odložená (21) | 81,0 / 9,5 % | **85,7 / 52,4 %** | 81,0 / 28,6 % | 95,2 / 47,6 % |
  | nezávislá odložená (30) | 60,0 / 16,7 % | **66,7 / 43,3 %** | 60,0 / 26,7 % | 63,3 / 43,3 % |

  **Pro pilot `BEDROCK_RERANK_MODEL=cohere.rerank-v3-5:0`** — vyrovná se sestavě s GPU, Amazon Rerank je výrazně horší.
  Hledání s přeřazením p50 ~1,7–2,0 s (p95 v měření zkresluje čekání na limit). Cena Cohere Rerank 3.5 na Bedrocku
  0,002 USD za volání (= dotaz) → při ~50 dotazech denně ~2 USD měsíčně.
- **Kvóta volání:** nový účet má Cohere Rerank 3 volání/min a Amazon Rerank 2/min (Service Quotas, 1. 11. 2026;
  požádáno o zvýšení). LexisLocal dělá 1 volání na dotaz (zákony i judikatura dohromady), výsledky drží 10 min v cache
  a hlídá limit: `BEDROCK_RERANK_RPM` (výchozí 3), čekání na volný slot nejvýš `BEDROCK_RERANK_MAX_WAIT_MS` (výchozí
  3000 ms — pak hledá bez přeřazení), po 429 až `BEDROCK_RERANK_RETRIES` opakování (výchozí 2).
- Kontrola: `node backend/scripts/aws-pilot-test.js` kroky R1 (přeřazení funguje) a R2 (u spisu stupně A nic neodejde).
- Měření: profil `pilot-hledani` (`docs/SIMULACE_KANCELARE.md`), `KB_REG_PILOT=1` v `kb_regression.js`.
- Měření 1. 11. 2026 (`2026-11-01_0733_remote_judikatura`, původní bge-m3, 5 pasáží): Bedrock Rerank **neproběhl**
  (role testovací instance měla ze staré verze šablony výslovný zákaz InvokeModel mimo Clauda → 0 úspěšných volání;
  opravit aktualizací stacku na novou šablonu a měření zopakovat). Bez rerankeru: správný § mezi pasážemi —
  zlatá 84,7 % (na 1. místě 33,9 %), se slovníkem **89,5 %** (37,9 %); dotazy klientů 77,9 → 85,3 %; odložená
  38,1 → 81,0 %; nezávislá odložená 56,7 → 60,0 %. **Bez rerankeru slovník pomáhá → zapnout.** Řazení „zákony
  napřed“ (cesta přeřazení zvlášť s nefunkčním rerankerem) zvedlo 1. místo na zlaté 33,9 → 58,9 % při stejném
  hit@5 — kandidát na výchozí chování i bez rerankeru.

Po startu se vyhledávací model v aplikaci načte hned (ne až u prvního dotazu); vypnutí `EMBED_ONNX_WARMUP=0`.

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
