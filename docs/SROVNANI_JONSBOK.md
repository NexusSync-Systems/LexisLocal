# LexisLocal × Jónsbók — podklad pro pilot

_Interní podklad (stav 29. 10. 2026) k otázce, kterou advokáti v pilotu nejspíš položí: „Proč ne Jónsbók?“
Údaje o Jónsbóku: ✅ = ověřeno na webu jonsbok.ai (ceník, bezpečnost, podmínky) nebo v tisku; ☐ = z rešerše
29. 10., na oficiálním webu nedohledáno (před použitím vůči klientům ověřit, např. v Trust Center, které je „na vyžádání“)._

## Kdo je Jónsbók

- ✅ Provozovatel Raxiom ehf. (Island), služba od 2025; investoři Crowberry Capital a Leo Capital; Česko v první vlně
  expanze (vede Petra Karkošová), česká verze webu jonsbok.ai/cs.
- ☐ IČ 570724-1180, založeno 07/2024; trhy ČR, Island, Finsko, Švédsko, Polsko, Maďarsko, Chorvatsko, Rumunsko, Litva, Lotyšsko
  (ceník potvrzuje jen, že litevské zdroje se připravují).
- ✅ Zakladatelé Bjarni Bragi Jónsson (CEO), Thelma Christel Kristjánsdóttir, Bjarni Benediktsson, Ágúst Gunnarsson.
  ☐ Podrobnosti: Jónsson ML inženýr a fyzik (ETH Zürich), Kristjánsdóttir advokátka (LL.M. UC Berkeley).

## Produkt (✅ podle webu)

1. **Chat** — rešerše v národním právu a judikatuře s citací zdroje u každé odpovědi.
2. **Review Grid** — hromadná analýza dokumentů v tabulce (due diligence, smlouvy), ☐ export do Wordu/Excelu.
3. **Skills** — tvorba dokumentů podle vzorů a stylu kanceláře.
4. **Legal Database** — vlastní dokumenty kanceláře spolu s veřejnými předpisy.
5. **Doplňky do Wordu a Outlooku.**

☐ Uvádí se právní znalostní graf (předpisy, novely, judikatura v čase) nad RAG.

## Srovnání

| | LexisLocal | Jónsbók |
|---|---|---|
| Kde běží | **Na počítači kanceláře** (Mac mini / server v kanceláři). Volitelně Claude přes Amazon Bedrock ve vlastním účtu AWS kanceláře, zámek na EU | ✅ Cloud, data v datových centrech EU/EHP. ☐ Azure a Google Cloud v EU |
| Jazykový model | Lokální (qwen 7B) — data nikam neodchází; volitelně Claude (Bedrock EU) s anonymizací klientských pasáží | ☐ OpenAI a Mistral přes EU endpointy (na webu neuvedeno) |
| Kdo vidí data klientů | Nikdo mimo kancelář (v lokálním režimu) | Dodavatel jako zpracovatel + jeho subdodavatelé (seznam jen na vyžádání) |
| Trénink na datech | Ne | ✅ Ne. ☐ Zero-data-retention |
| Certifikace | Žádná (malá firma; DPIA, zpracovatelská smlouva a interní pravidla v `docs/kancelar/`) | ✅ ISO/IEC 27001, nezávislé penetrační testy |
| Přihlášení | Token uživatele, párování zařízení, role a práva ke spisům | ✅ SSO/SAML, MFA, passkeys |
| Smlouva a soud | Česká smlouva | ✅ Islandské právo, soud v Reykjavíku (uživatelské podmínky) |
| Rešerše a citace | Lokální báze zákonů a judikatury NS, NSS, ÚS; **každá citace se ověří** proti bázi, neexistující § / sp. zn. se označí, **paragraf mimo podklady k dotazu se označí** | ✅ Citace s odkazem na zdroj |
| Spisy a provoz kanceláře | Spisy, podatelna, datové schránky, lhůtník, střet zájmů, kalendář, fakturace, koncepty ke schválení, práva podle rolí, auditní řetězec | Ne — asistent a práce s dokumenty, ne spisová služba |
| Word / Outlook | Vlastní editor (LexisEditor), koncepty ve spisu; doplňky **zatím ne** (`docs/UKOLY_KONKURENCE.md` K8, K9) | ✅ Doplňky do Wordu a Outlooku |
| Hromadná analýza dokumentů | Kontrola smlouvy po jedné; tabulka „dokumenty × otázky“ v plánu (K10) | ✅ Review Grid |
| Nasazení | Instalace v kanceláři (počítač s GPU nebo Mac mini) | Okamžitě v prohlížeči |
| Cena | Licence + hardware v kanceláři; cloud jen volitelně | ✅ **175 € / licence / měsíc bez DPH** (ročně −10 %), Enterprise individuálně; zkušební verze na webu neuvedena |

**Pro představu:** kancelář s 5 advokáty zaplatí u Jónsbóku 875 € měsíčně bez DPH, tj. ~10 500 € ročně (~9 450 € při ročním placení).

## Odpovědi na časté námitky

**„Jónsbók je v prohlížeči hned, vy potřebujete počítač.“** — Právě proto data klientů neodcházejí z kanceláře.
Mlčenlivost (§ 21 zákona o advokacii) i stanovisko ČAK k AI (20. 10. 2026) žádají vědět, kdo a kde data zpracovává.
U LexisLocalu je odpověď jednoduchá: kancelář. U cloudové služby je to dodavatel, jeho cloud a poskytovatel modelu.

**„Mají ISO 27001.“** — Pravda, a pro cloudovou službu je to důležité. U LexisLocalu data neopouštějí kancelář, takže
rozhodující je zabezpečení počítače kanceláře (šifrovaný disk, zálohy, přístupová práva) — to popisuje `docs/kancelar/`.

**„Mají doplněk do Wordu.“** — Pravda. LexisLocal má vlastní editor a koncepty ve spisu; doplněk do Wordu a Outlooku
je v plánu (K8, K9). V pilotu ověříme, jak moc advokátům chybí.

**„Je cloudový model chytřejší?“** — Velké cloudové modely jsou v rešerších silnější než lokální 7B model. Kancelář si proto
může pro náročné dotazy zapnout Claude přes Bedrock v EU ve vlastním účtu AWS (`docs/BEDROCK_EU.md`), klientské pasáže
se přitom anonymizují. Vyhledávání a spisy zůstávají lokální.

**„Neplete si AI rozsudky?“** — Citace se ověřují automaticky proti bázi zákonů a judikatury; neexistující § nebo
sp. zn. se označí, a nově i **skutečný paragraf, který v podkladech k dotazu nebyl** („Mimo podklady“). Zkouška 29. 10.:
6 ze 7 takových upozornění odhalilo skutečnou chybu modelu. Advokát koncept vždy schvaluje (koncipient schválit nemůže).

**„Kolik to stojí?“** — Jónsbók 175 € měsíčně za uživatele bez DPH. LexisLocal: hardware v kanceláři + licence
(_ceník LexisLocalu doplnit_); lokální provoz neplatí za jednotlivé dotazy.

## Kde je Jónsbók silnější (poctivě)

- Doplňky do Wordu a Outlooku — pracuje tam, kde advokát tráví nejvíc času.
- Review Grid — hromadná analýza desítek dokumentů najednou.
- ISO 27001, SSO, penetrační testy — snazší pro větší kanceláře s IT oddělením a nákupním procesem.
- Bez instalace a bez hardwaru; pokrytí více zemí.
- Silnější jazykové modely a kapitál na rozvoj a obchod.

## Zdroje

- Jónsbók — ceník — https://jonsbok.ai/en/pricing
- Jónsbók — bezpečnost — https://jonsbok.ai/en/security
- Jónsbók — uživatelské podmínky (změna 6. 5. 2026) — https://jonsbok.ai/en/user-terms
- Jónsbók — Trust Center (dokumenty na vyžádání) — https://trust.jonsbok.ai/
- Lupa.cz: Do Česka přichází AI, která přečte stovky zákonů i rozsudků za pár vteřin — https://www.lupa.cz/aktuality/do-ceska-prichazi-ai-ktera-precte-stovky-zakonu-i-rozsudku-za-par-vterin/
- LegalTech Atlas — Jónsbók — https://legaltechatlas.com/products/jonsbok-3002
- Microsoft Marketplace — Jónsbók for Outlook — https://marketplace.microsoft.com/en-us/product/saas/wa200010926?tab=overview
- Dealroom — investice Crowberry a Leo Capital — https://dealroom.co/news/166994-icelands-j-nsb-k-raises-early-vc-from-crowberry-and-leo-capital-to-expan/
- ČAK — stanovisko k umělé inteligenci (20. 10. 2026) — https://www.cak.cz/storage/files/stanovisko-cak-umela-inteligence-ai-20-10-2026.pdf
- Rešerše Zdeňka 29. 10. 2026 (údaje označené ☐)
