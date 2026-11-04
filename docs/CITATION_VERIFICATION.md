# Ověřování citací (Citation Verification)

Cíl: **model nesmí protlačit § ani spisovou značku, které neexistují nebo nebyly
v podkladech.** Dosahujeme toho architekturou, ne prosbou v promptu — model je
brán jako nedůvěryhodný a důvěřuje se až deterministické ověřovací vrstvě
(`backend/lib/citation_verifier.js`), která běží po vygenerování odpovědi.

## Tok

```
dotaz → RAG (searchSimilar) → vytažené pasáže + jejich sourceId
      → agent/orchestrátor vygeneruje odpověď (smí citovat JEN z pasáží)
      → citation_verifier: extrahuje citace, ověří je proti kontextu + referenci
      → neověřené citace: v strict módu přegenerovat / jinak označit ⚠ NEOVĚŘENO
      → výsledek + verifikační report do transparency_logs (ledger)
      → advokát vidí odpověď, kde každá citace odkazuje na reálný zdroj
```

## Dvě roviny ověření

1. **Kontext (vždy).** Objevila se citace / doslovný citát v pasážích, které RAG
   reálně vytáhl? Tohle funguje i bez jakéhokoli korpusu a samo o sobě zabíjí
   většinu halucinací — model nemůže „doložit" něco, co nedostal.
2. **Reference (až bude korpus).** Existuje ten § v daném zákoně? Je sp. zn. mezi
   známými? Naplní se při ingestu zákonů (mapa `laws["89/2012"] = Set<paragrafy>`)
   a judikatury (`caseNumbers`). Bez indexu verifier degraduje na rovinu 1.

## Stavy citace

| status | význam | co s tím |
| --- | --- | --- |
| `verified` | doloženo v kontextu i/nebo referenci | ponechat |
| `no_reference_context_ok` | bez indexu, ale je v podkladech | ponechat (nižší jistota) |
| `unsupported_by_context` | není v podkladech ani nelze ověřit | označit / smazat |
| `not_in_reference` | § / zákon v referenci neexistuje | **silný signál halucinace** → smazat |
| `unverified_case` | sp. zn. není v indexu ani v podkladech | **smazat** |

## Citační kontrakt (jak agenti vracejí citace)

Hybridně, kvůli slabým 3B modelům:

- **Preferovaně (strukturovaně):** agent za tvrzení dá marker `[[C1]]` a na konec
  přidá blok `<citace>` s poli `{ id, typ: zakon|judikat|spis, ref, sourceId, citát }`.
  Když to model dodrží, ověřujeme přesně a napárujeme na `sourceId`.
- **Vždy (fallback):** verifier navíc regexem vytáhne z volného textu všechny
  citace (`§ …`, `zákon č. X/Y Sb.`, sp. zn.) a ověří je bez ohledu na to, jestli
  model formát dodržel. Formátovací kázeň modelu tedy není bezpečnostní podmínka.

Prompt agentům (dodat do systémových promptů): *„Citeuj výhradně z pasáží níže a
uveď jejich ID. Nikdy neuváděj paragraf ani spisovou značku, které nejsou
v pasážích. Když odpověď v pasážích není, napiš to — nedomýšlej."*

## API

```js
const { verifyCitations } = require('./lib/citation_verifier');

const report = verifyCitations(modelOutput, {
  contextChunks: matches,        // [{ text, sourceId, fileName }]
  referenceIndex,                // volitelné; jinak buildEmptyReferenceIndex()
  strict: true
});
// report.ok, report.hallucinationRate, report.unverified[], report.annotatedText
```

## Napojení (další krok)

- `rag.searchSimilar` upravit, aby vracelo i stabilní `sourceId` (dnes zahazuje
  `chunk.id` — verifier ho potřebuje pro odkaz v UI).
- `orchestrator.js`: po každém kroku i po syntéze zavolat `verifyCitations` nad
  výstupem s `highConfidence` pasážemi; v strict módu neověřené → přegenerovat.
- Report uložit do `transparency_logs` (rozšíření ledgeru) — metrika
  `hallucinationRate` pak jde měřit v evaluační sadě a hlídat regrese.

## Meze (poctivě)

Verifier chytí **falešné citace a falešné doslovné citáty**. Nechytí, když model
odkáže na *reálný* § a přitom ho *špatně vyloží* — to je věcná chyba, ne smyšlený
odkaz, a odchytí ji až člověk. Proto zůstává human-in-the-loop (`humanApproved`).

## Holý § bez zákona (13. 10. 2026)

Serverový test 13. 10. 2026 ukázal, že všech 29 neověřených citací byl paragraf bez uvedeného zákona
(„§ 2248“, „§ 629“) — verifier zákon nenašel do 300 znaků, a proto do báze zákonů vůbec nehledal.

- Verifier teď u paragrafu bez zákona prohledá **všechny zákony v bázi** (`lib/kb_law_index.js`).
  Přednost mají zákony, které odpověď jmenuje jinde. Jednoznačný nález → `verified`, zákon se doplní
  a citace nese `lawInferred: true` (důvod: „zákon … odvozen“).
- Paragraf, který je ve více zákonech báze (např. § 629 v OZ i ZOK), dostane nový stav
  **`ambiguous_law`** — počítá se mezi neověřené, v důvodu jsou kandidátní zákony.
- Prompty rešeršníka a kontrolora (a pokyn k podkladům z báze) vyžadují u každého § i zákon.
- Na dnešních 29 citacích: 19 ověřeno s odvozeným zákonem, 10 `ambiguous_law`, 0 beze změny.

## Mimo podklady (29. 10. 2026)

Zátěžový den ukázal, že ověřovač pustí **skutečný, ale nesouvisející** paragraf: u otázky na moderaci smluvní pokuty
model 7–8× z 20 uvedl § 2248 OZ (zvýšení nájemného) — v zákoně existuje, takže `verified`. Příčinou byl i vzor
„§ 2248 OZ“ přímo v systémovém promptu (opraveno, K1).

- Citace paragrafu, který je ověřený, ale jeho číslo se v podkladech k dotazu (RAG pasáže, zadání, kontext) neobjevilo,
  dostane `outsideContext: true`; výsledek má `outsideContextCount`. Podklady se čtou i s výčty a rozsahy („§§ 2048 až 2052“).
- Stav citace ani `hallucinationRate` se nemění — není to halucinace, jen upozornění: pod odpovědí řádek
  „Mimo podklady: § … — paragraf existuje, ale v podkladech k dotazu nebyl. Ověřte, že se na věc opravdu vztahuje.“
- Když podklady neobsahují žádný § (např. jen text smlouvy), neupozorňuje se — každá citace by byla „mimo“.


## Povinné zdůvodnění doporučení (4. 11. 2026)

Právní agenti (Rešeršník, Kontrolor, Spisovatel a vlastní agenti s judikaturou) musí u **každého doporučení,
právního závěru a navrženého kroku** uvést, na základě čeho — konkrétní § / čl. s předpisem, případně rozhodnutí
se sp. zn. z podkladů — a jednou větou proč z něj závěr plyne (`Doporučení: … — Opora: … — Proč: …`).
V dokumentech pro soud a protistranu je právní důvod přímo v textu.

1. **Pravidlo** (`backend/lib/legal_basis.js`) se přidává k systémovému promptu za běhu — platí i pro prompty,
   které si kancelář upravila. U vlastního agenta jde vypnout polem `zduvodneni: false`.
2. **Kontrola programem**: věty s doporučením nebo právním závěrem bez citace model dostane jako výtku a jednou je
   opraví (`output_checks`, kód `bez_opory`). Co zůstane, je pod odpovědí v „Automatické kontrole LexisLocal“
   („Bez uvedené právní opory …“), v e-mailové odpovědi i v orchestraci.
3. Když agent oporu v podkladech nemá, napíše „Opora: nenalezena v podkladech — ověřit“ (nevymýšlí) — i to se
   advokátovi ukáže.
4. Zda citovaný § existuje a sedí s předpisem, ověřuje dál kontrola citací výše (⚠ NEOVĚŘENO).

Agent v AWS (docs/EMAIL_AGENT_AWS.md) má stejné pravidlo v promptu, ale bez báze zákonů citace neověřuje.

## Judikatura jen z ověřených zdrojů a varianty postupu (4. 11. 2026)

Podle přístupu CENDAI / iSoud (Vrchní soud v Praze — judikatura jen z přesně vymezených důvěryhodných zdrojů,
neověřená rozhodnutí se vynechávají, lidský dohled, transparentnost):

- **Index sp. zn. z báze judikatury** (`backend/lib/kb_case_index.js`, z názvů souborů NS_/US_/NSS_, staví se na
  pozadí po startu): rozhodnutí z báze je ověřené, i když ho vyhledávání zrovna nevrátilo.
- **Neověřené rozhodnutí se z odpovědi vypustí** → „[rozhodnutí neověřeno — vypuštěno]“ + upozornění pod odpovědí
  (není v bázi, v podkladech ani v externím zdroji = model ho mohl vymyslet). Jen když báze judikatury existuje
  (≥ 100 sp. zn.). `LEXIS_NEOVERENE_JUDIKATY=oznacit` vrátí dřívější chování (jen ⚠ NEOVĚŘENO).
- **Varianty s pro a proti**: rozbor a kontrola smlouvy mají v osnově 2–3 varianty postupu, u každé Pro, Proti
  (rizika, náklady, doba) a oporu, a doporučenou variantu s důvodem; v orchestraci se námitky Kontrolora
  zapracují do Proti příslušné varianty.
