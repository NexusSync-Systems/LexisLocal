# Ověření: umí LexisLocal to, co uvádí Jónsbók? (30. 10. 2026)

Seznam funkcí a zdrojů podle prezentace Jónsbóku pro ČR, proti LexisLocalu ověřeno **v kódu** (větev `release-prep`)
a **v posledním serverovém dni kanceláře** (`kancelar-bedrock`, 29. 10. 2026, 159 spisů, 360 dokumentů).
✅ umí · 🟡 částečně · ❌ neumí. Úkoly: `docs/UKOLY_KONKURENCE.md`.

## Funkce

| Jónsbók | LexisLocal | Doklad | Mezera → úkol |
|---|---|---|---|
| **Rešerše v přirozeném jazyce** | ✅ asistent Rešeršník nad bází zákonů a judikatury, obecně i ke spisu | server 29. 10.: obecné rešerše 19/19, ke spisu 47/47 | — |
| **…časová působnost zákonů a novely** | 🟡 báze obsahuje **jedno znění** (účinné ke dni stažení z e-Sbírky, `fetch-esbirka.js --datum`); historická znění, data účinnosti novel a „jaké znění platilo ke dni skutku“ AI nezná | `lib/kb_law_index.js`, `scripts/fetch-esbirka.js` | **K14** |
| **…ke každému tvrzení přímý odkaz na § / rozsudek** | 🟡 citace se **ověřují** proti bázi (neexistující § / sp. zn. a § mimo podklady se označí), ale nejsou to klikací odkazy na text zdroje | 645 citací za den, neověřeno 18, mimo podklady 28; `lib/citation_verifier` | **K4** (klik na citaci) |
| **Review Grid** — desítky smluv do tabulky, rizika, export Excel/Word | ❌ kontrola smlouvy jen **po jedné** (rizika podle `clause_scan`, 16/17 prošlo); tabulka „dokumenty × otázky“ a export do Excelu chybí | `lib/clause_scan.js`, `routes/agent.js` | **K10** |
| **Skills** — dokumenty podle vzorů a stylu kanceláře | 🟡 Spisovatel: pevné ověřené šablony (předžalobní výzva, žaloba, odvolání, smlouva), **vzorové výstupy kanceláře** (few-shot, Nastavení → Agenti), vlastní báze vzorů agenta; koncept → LexisEditor → schválení → .docx do spisu. Chybí „nahraj vlastní .docx vzor a vyplň ho“ se zachováním formátu | `lib/documentTemplates.js`, `lib/agent_examples.js`, `routes/agentKnowledge.js`, `routes/drafts.js` (`export.docx`); server: koncepty 13/13 | **K16** |
| **Privátní báze** (vnitřní předpisy, spisy, PDF, Word, e-maily, skeny) + kombinace s veřejným právem | ✅ spisy a dokumenty v kanceláři (PDF, DOCX, TXT, HTML, obrázky), **OCR skenů** (Tesseract), **e-maily** (IMAP + mailparser), **datové schránky**, vnitřní postupy v bázi rešeršníka; RAG spojuje spis + zákony + judikaturu. Navíc spisová služba, lhůtník, střet zájmů, práva podle rolí | server: OCR sp. zn. 12/12 a 7/7, interní postupy 3/3; `lib/ocr.js`, `lib/imapIntake.js`, `lib/watcher.js` | starý .doc a e-maily uložené jako .msg/.eml ve složce spisu se nenačtou (e-maily jen přes IMAP) → **K15b** |
| **Doplňky MS Word a Outlook** | ❌ vlastní editor LexisEditor a export .docx; doplňky v plánu | — | **K8, K9** |

## Zdroje v ČR

| Jónsbók | LexisLocal | Mezera → úkol |
|---|---|---|
| Zákony a novely (Sbírka / e-Sbírka) | 🟡 **23 nejčastějších zákonů** pro advokacii (OZ, o. s. ř., ZŘS, ZOK, ZP, IZ, EŘ, TZ, TŘ, SŘS, SŘ, DŘ, …) v aktuálním znění; ostatní zákony skript stáhne, v balíčku nejsou; novely viz K14 | **K15** |
| Prováděcí předpisy | ❌ vyhlášky a nařízení vlády nejsou (`fetch-esbirka.js`: hlavička „Zákon č.“ by nebyla přesná) | **K15** |
| Judikatura ÚS, NS, NSS | ✅ Sbírka NS (~10 tis.), nálezy ÚS (CCC + NALUS, ~6,6 tis.), Sbírka NSS (~4,8 tis.); balíček ~30 tis. dokumentů, ~300 tis. pasáží | — |
| Obecné soudy | 🟡 skript pro open data MSp (okresní, krajské, vrchní soudy od 2020, `fetch-judikatura.js`) je, ale **v balíčku báze nejsou** | **K15** |
| Evropské právo | ❌ nic (EUR-Lex, SDEU) | **K15** |
| Vlastní data kanceláře | ✅ (viz výše), navíc zůstávají v kanceláři | — |
| Komentáře ASPI / Beck / Codexis | Stejně jako Jónsbók je v bázi nemáme (autorské právo). **Navíc:** volitelný konektor CODEXIS AI s licencí kanceláře (ven jen očištěná otázka) | — |

## Shrnutí

- **Stejně nebo lépe:** rešerše s ověřováním citací, privátní spisy včetně OCR, e-mailů a datových schránek, celá
  spisová služba, data v kanceláři, volitelně Claude v EU.
- **Částečně:** časová působnost (jedno znění), odkazy u citací (ověření ano, klik ne), vzory kanceláře (šablony
  a ukázky ano, vlastní .docx vzor ne), rozsah pramenů (23 zákonů, bez obecných soudů v balíčku).
- **Chybí:** Review Grid s exportem do Excelu, doplňky Word/Outlook, prováděcí předpisy, evropské právo.
- Pozor na formulace v materiálech: neříkat „chápe časovou působnost“ ani „přímý odkaz u každého tvrzení“, dokud
  nejsou hotové K14 a K4.
