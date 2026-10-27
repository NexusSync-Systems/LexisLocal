# Dokumenty pro kancelář — LexisLocal 1.2

**Všechno jsou NÁVRHY připravené dodavatelem softwaru podle toho, jak LexisLocal skutečně funguje.
Nejsou to právní rady. Před použitím je zkontroluje a upraví advokát.** Místa `[doplnit: …]` jsou
v dokumentech zvýrazněná žlutě.

Stav: aktualizace 27. 10. 2026 (původní verze 26. 10. 2026).

| # | Dokument | Pro koho | Podpis | Stav |
|---|---|---|---|---|
| 1 | `1_Zpracovatelska_smlouva.docx` — smlouva o zpracování (čl. 28 GDPR) | kancelář ↔ dodavatel | obě strany | aktualizováno |
| 2 | `2_DPIA_posouzeni_vlivu.docx` — posouzení vlivu | kancelář (správce) | advokát, pověřenec | aktualizováno |
| 3 | `3_Informace_pro_klienty_AI.docx` — jak kancelář používá AI | klienti | — | aktualizováno |
| 4 | `4_Skoleni_AI_gramotnosti.docx` — osnova, otázky, záznam | pracovníci | účastníci | aktualizováno |
| 5 | `5_Vnitrni_pravidla_AI.docx` — vnitřní pravidla | pracovníci | vedoucí advokát | aktualizováno |
| 6 | `6_Pravidla_skartace_navrh.docx` — co se při skartaci smaže | advokát (rozhodnutí pro vývoj) | advokát | aktualizováno |
| 7 | `7_Souhlas_klienta_cloud.docx` — souhlas pro věc, rámcová doložka, odvolání | klienti | klient, advokát | **nové** |
| 8 | `8_Dolozky_licencni_smlouva.docx` — mlčenlivost, dodávka bez přístupu, podpora L1–L4 | kancelář ↔ dodavatel | obě strany | **nové** |

Technické příručky (pro dodavatele / IT partnera, ne k podpisu):
[`../IMPLEMENTACE_KANCELAR.md`](../IMPLEMENTACE_KANCELAR.md) (zavedení krok za krokem),
[`../PROVOZ_SPRAVCE.md`](../PROVOZ_SPRAVCE.md) (provoz, zálohy, incidenty),
[`../BEDROCK_EU.md`](../BEDROCK_EU.md) a [`../AWS_NASTAVENI_KROKY.md`](../AWS_NASTAVENI_KROKY.md) (cloud),
[`../VZDALENY_PRISTUP.md`](../VZDALENY_PRISTUP.md).

Souvisí: samostatný dokument k posouzení **„Model dodávky bez přístupu dodavatele k datům“**
(stupně A–D, alternativní modely) — na něj navazují dokumenty 1, 7 a 8.

## Co se změnilo oproti 26. 10.

Důvod: v LexisLocalu jsou nově **pravidla cloudu podle spisu** (stupeň citlivosti A–D + souhlas klienta),
volitelný **cloudový model Claude přes Amazon Bedrock v EU** v účtu kanceláře, **zablokované přímé API**
poskytovatelů modelů pro klientská data a **rozpočet cloudu** (živý odhad, tvrdý strop, porovnání s AWS).

- **1 Smlouva o zpracování:** IT partner kanceláře (čl. 2); AWS není dalším zpracovatelem dodavatele (čl. 4);
  úrovně podpory L1–L4 a protokol podpory (čl. 4); čl. 6 přepsán — Bedrock v účtu kanceláře, EU, bez ukládání,
  dodavatel bez přístupu do účtu AWS, přímé API zablokované, CLOUD Act v DPIA; příloha 1 + 4 řádky (pravidla
  cloudu, kdo rozhoduje, záznam o cloudu, rozpočet).
- **2 DPIA:** tok „Bedrock (budoucí)“ nahrazen skutečným stavem; nové toky (přímé API — zablokováno, údaje
  o nákladech z AWS); tabulka stupňů A–D a pravidla (fail-closed); výslovně uvedeno, že **pseudonymizace před
  odesláním do cloudu zatím není**; R4 upraveno; nová rizika R11 (spis bez souhlasu / chybný stupeň),
  R12 (CLOUD Act), R13 (cloud bez pseudonymizace).
- **3 Informace pro klienty:** místo zástupného textu varianta pro kancelář s cloudem (souhlas, AWS jako
  zpracovatel, CLOUD Act, odvolání); druhá doložka s rámcovým souhlasem.
- **4 Školení:** téma 9 „Lokálně, nebo v cloudu?“; tři nové kontrolní otázky.
- **5 Vnitřní pravidla:** Bedrock mezi nástroji ([doplnit: schválen / neschválen]); zákaz přímého API;
  rozpočet a tvrdý strop; nový oddíl 2a — tabulka stupňů a 7 pravidel (kdo stupeň mění, jak se zaznamenává
  souhlas, rámcový souhlas jen pro C, odvolání, měsíční kontrola auditu).
- **6 Skartace:** stupeň a souhlas na spisu (smaže se), doklad o souhlasu (ponechá se — prokázání),
  záznamy o využití a nákladech AI a záznamy „Cloud AI“ v auditu (pseudonymizace).

Změny jsou zapracované přímo do textu (bez revizí); úvod každého dokumentu má odstavec „Aktualizace 27. 10. 2026“.
Předchozí verze jsou v gitu (commit před touto změnou).

## Otázky pro advokáta

1. **Souhlas, nebo zproštění mlčenlivosti?** Stačí pro použití Bedrocku souhlas klienta, nebo jde o zproštění
   mlčenlivosti v rozsahu § 21 odst. 2 ZA — případně je souhlas vůbec nutný, je-li AWS zpracovatelem advokáta
   vázaným smlouvou? (dokumenty 3, 7)
2. **Stupně A–D:** sedí výčet věcí pro stupeň A? Je správné, že rámcový souhlas ve smlouvě stačí jen pro C?
3. **CLOUD Act:** je zbytkové riziko přijatelné při zpracování v EU bez ukládání a jen se souhlasem? (DPIA R12)
4. **Pseudonymizace:** má být podmínkou zapnutí cloudu (zatím není implementovaná)? (DPIA R13)
5. **Dodavatel a § 21 odst. 9 ZA:** je dodavatel / IT partner osobou, na kterou se mlčenlivost vztahuje přímo,
   nebo jen smluvně? (dokument 8, čl. 1)
6. **Model bez přístupu k datům:** je-li podpora jen L1–L3, je zpracovatelská smlouva potřeba vůbec, nebo jen
   pro L4? (dokumenty 1 a 8)
7. **Skartace:** lhůty uchování dokladu o souhlasu a záznamů o nákladech AI. (dokument 6)
8. **Informace pro klienty:** stačí informační dokument, nebo má být souhlas vždy písemný (vzor 7A)?

## Co v LexisLocalu zatím chybí (dokumenty to uvádějí poctivě)

- Tlačítka pro stupeň citlivosti a souhlas na kartě spisu — zatím jen přes API (postup v `IMPLEMENTACE_KANCELAR.md`, krok 8).
- Pseudonymizace dotazů před odesláním do cloudu.
- Kaskádové mazání při skartaci (dokument 6 je podklad pro jeho naprogramování).
- Diagnostický balíček pro podporu L2 — zatím ruční výpis (`PROVOZ_SPRAVCE.md`).
