# LexisLocal × Jónsbók — podklad pro pilot

_Interní podklad (stav 29. 10. 2026) k otázce, kterou advokáti v pilotu nejspíš položí: „Proč ne Jónsbók?“
Údaje o Jónsbóku jsou z jejich webu (ceník, bezpečnost, zásady ochrany soukromí, podmínky předplatného), Trust Center,
oznámení investora a tisku — ověřeno 29. 10. 2026. ☐ = veřejně nedohledáno._

## Kdo je Jónsbók

- Provozovatel **Raxiom ehf.**, IČ (kennitala) 570724-1180, Hlíðarvegur 16, 200 Kópavogur, Island; založeno 2024
  (datum 17. 7. 2024 plyne z kennitaly). Služba od 2025.
- Investoři Crowberry Capital a Leo Capital (kolo oznámeno 10/2026, ☐ výše nezveřejněna).
- Trhy: 9 jurisdikcí — Island, Finsko, Švédsko, **Česko**, Chorvatsko, Maďarsko, Polsko, Rumunsko, Litva (litevské zdroje se
  připravují); vstup do Lotyšska oznámen v tisku. Pokrytí zdrojů se podle země liší.
- Česko: přímé zastoupení (Petra Karkošová), web jonsbok.ai/cs. ☐ Česká referenční kancelář ani partner veřejně neuvedeni.
- Zakladatelé: Bjarni Bragi Jónsson (CEO) a Bjarni Benediktsson (CTO) — ETH Zürich; Ágúst Gunnarsson (CPO) — strojové učení,
  UCL; Thelma Christel Kristjánsdóttir (CCO) — advokátka, LL.M. UC Berkeley, dříve BBA//Fjeldco.

## Produkt

1. **Chat** — rešerše v národním právu a judikatuře s citací zdroje u každé odpovědi.
2. **Review Grid** — hromadná analýza dokumentů v tabulce (due diligence, smlouvy), export do Wordu a Excelu.
3. **Skills** — tvorba dokumentů podle vzorů a stylu kanceláře.
4. **Legal Database** — vlastní dokumenty kanceláře spolu s veřejnými předpisy.
5. **Doplňky do Wordu a Outlooku.**

Základem je právní znalostní graf (zákony, novelizace, předpisy, rozsudky a vlastní materiály kanceláře).
☐ Které české zdroje přesně indexují (e-Sbírka, NS, NSS, ÚS, krajské soudy) a od kdy — veřejně neuvedeno; vyžádat na demu.

## Srovnání

| | LexisLocal | Jónsbók |
|---|---|---|
| Kde běží | **Na počítači kanceláře** (Mac mini / server v kanceláři). Volitelně Claude přes Amazon Bedrock ve vlastním účtu AWS kanceláře, zámek na EU | Cloud v EU/EHP — subzpracovatelé Microsoft Azure (EU) a Google Cloud (EU) |
| Jazykový model | Lokální (qwen 7B) — data nikam neodchází; volitelně Claude (Bedrock EU) s anonymizací klientských pasáží | OpenAI a Mistral, oba uvedeni jako subzpracovatelé v EU (Trust Center) |
| Kdo vidí data klientů | Nikdo mimo kancelář (v lokálním režimu) | Raxiom ehf. jako zpracovatel + subzpracovatelé (Azure, Google Cloud, OpenAI, Mistral, Clerk pro přihlášení) |
| Trénink a uchování dat | Ne; data zůstávají v kanceláři a řídí se pravidly skartace kanceláře | Netrénuje se. **Nejde o zero-data-retention:** chaty, nahrané dokumenty a výstupy se uchovávají do smazání uživatelem nebo konce předplatného, zálohy podle retenčního plánu |
| Bezpečnost | Žádná certifikace (DPIA, zpracovatelská smlouva a interní pravidla v `docs/kancelar/`); šifrovaná databáze, auditní řetězec | ISO/IEC 27001, penetrační testy, AES-256 v klidu, TLS 1.2+, monitoring Vanta |
| Přihlášení | Token uživatele, párování zařízení, role a práva ke spisům | SSO/SAML, MFA, passkeys (Clerk) |
| Smlouva a odpovědnost | Česká smlouva | Islandské právo, výlučně Okresní soud v Reykjavíku; odpovědnost omezena na předplatné zaplacené za předchozí rok |
| Rešerše a citace | Lokální báze zákonů a judikatury NS, NSS, ÚS; **každá citace se ověří** proti bázi, neexistující § / sp. zn. se označí, **paragraf mimo podklady k dotazu se označí** | Citace s odkazem na zdroj ze znalostního grafu |
| Spisy a provoz kanceláře | Spisy, podatelna, datové schránky, lhůtník, střet zájmů, kalendář, fakturace, koncepty ke schválení, práva podle rolí, auditní řetězec | Ne — asistent a práce s dokumenty, ne spisová služba |
| Word / Outlook | Vlastní editor (LexisEditor), koncepty ve spisu; doplňky **zatím ne** (`docs/UKOLY_KONKURENCE.md` K8, K9) | Doplňky do Wordu a Outlooku |
| Hromadná analýza dokumentů | Kontrola smlouvy po jedné; tabulka „dokumenty × otázky“ v plánu (K10) | Review Grid, export do Wordu/Excelu |
| Nasazení | Instalace v kanceláři (počítač s GPU nebo Mac mini) | Okamžitě v prohlížeči |
| Cena | Licence + hardware v kanceláři; cloud jen volitelně | **175 € / licence / měsíc bez DPH** i pro ČR (ročně −10 %), Enterprise individuálně; **bez zkušební verze**, jen demo |

**Pro představu:** kancelář s 5 advokáty zaplatí u Jónsbóku 875 € měsíčně bez DPH, tj. ~10 500 € ročně (~9 450 € při ročním placení).

## Odpovědi na časté námitky

**„Jónsbók je v prohlížeči hned, vy potřebujete počítač.“** — Právě proto data klientů neodcházejí z kanceláře.
Mlčenlivost (§ 21 zákona o advokacii) i stanovisko ČAK k AI (20. 10. 2026) žádají vědět, kdo a kde data zpracovává.
U LexisLocalu je odpověď jednoduchá: kancelář. U cloudové služby je to dodavatel, jeho cloud a poskytovatel modelu.

**„Mají ISO 27001.“** — Pravda, a pro cloudovou službu je to důležité. U LexisLocalu data neopouštějí kancelář, takže
rozhodující je zabezpečení počítače kanceláře (šifrovaný disk, zálohy, přístupová práva) — to popisuje `docs/kancelar/`.

**„Data se u nich neukládají.“** — Ukládají. Modely OpenAI a Mistral na datech netrénují, ale chaty, nahrané spisy a výstupy
zůstávají v jejich cloudu do smazání nebo konce předplatného (plus zálohy). Smlouva se řídí islandským právem, spory
výlučně v Reykjavíku a odpovědnost je omezena na roční předplatné. Kancelář je správce, Raxiom zpracovatel a pod ním
další čtyři subzpracovatelé — to vše patří do DPIA kanceláře.

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
- Jónsbók — Trust Center (subzpracovatelé; certifikáty a DPA na vyžádání) — https://trust.jonsbok.ai/
- Lupa.cz: Do Česka přichází AI, která přečte stovky zákonů i rozsudků za pár vteřin — https://www.lupa.cz/aktuality/do-ceska-prichazi-ai-ktera-precte-stovky-zakonu-i-rozsudku-za-par-vterin/
- LegalTech Atlas — Jónsbók — https://legaltechatlas.com/products/jonsbok-3002
- Microsoft Marketplace — Jónsbók for Outlook — https://marketplace.microsoft.com/en-us/product/saas/wa200010926?tab=overview
- Dealroom — investice Crowberry a Leo Capital — https://dealroom.co/news/166994-icelands-j-nsb-k-raises-early-vc-from-crowberry-and-leo-capital-to-expan/
- ČAK — stanovisko k umělé inteligenci (20. 10. 2026) — https://www.cak.cz/storage/files/stanovisko-cak-umela-inteligence-ai-20-10-2026.pdf
- Jónsbók — zásady ochrany soukromí (účinné od 6. 5. 2026, změna 20. 10. 2026) — https://jonsbok.ai/en/privacy-policy
- Jónsbók — podmínky předplatného — https://jonsbok.ai/en/subscription-terms
- Jónsbók — česká verze webu (cena, zkušební verze, znalostní graf) — https://jonsbok.ai/cs
- Leo Capital — Why we invested in Jónsbók (10/2026) — https://leo.capital/insights/why-we-invested-in-jonsbok-grounding-legal-ai-in-european-jurisdictions/
- Labs of Latvia — vstup do Lotyšska — https://labsoflatvia.com/en/news/icelandic-ai-legal-tech-startup-jonsbok-secures-investment-and-enters-latvian-market
