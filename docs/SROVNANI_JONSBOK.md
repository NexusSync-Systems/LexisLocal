# LexisLocal × Jónsbók — podklad pro pilot

_Interní podklad (stav 28. 10. 2026) k otázce, kterou advokáti v pilotu nejspíš položí: „Proč ne Jónsbók?“
O Jónsbóku uvádíme jen to, co je ve veřejných zdrojích (dole). Co se nepodařilo zjistit, je tak označeno — nedomýšlet._

## Kdo je Jónsbók

Islandský legaltech (Raxiom ehf.), služba od 2025, investoři Crowberry Capital a Leo Capital. Česko je v první vlně
expanze (vede Petra Karkošová), dál Finsko, Maďarsko, Chorvatsko. AI asistent pro rešerše, analýzy a psaní
smluv, podání a memorand; odpovědi s citacemi a odkazem na zdroj; analýza nahraných PDF/Word/e-mailů;
porovnání více dokumentů vedle sebe (review grid); webové rozhraní + doplněk do Wordu a Outlooku.

## Srovnání

| | LexisLocal | Jónsbók (veřejné zdroje) |
|---|---|---|
| Kde běží | **Na počítači kanceláře** (Mac mini / server v kanceláři). Volitelně Claude přes Amazon Bedrock ve vlastním účtu AWS kanceláře, zámek na EU | Cloud, „evropská datová centra“ (LegalTech Atlas) |
| Kdo vidí data klientů | Nikdo mimo kancelář (v lokálním režimu data neopouštějí počítač) | Dodavatel jako zpracovatel; poskytovatel jazykového modelu **nezjištěn** |
| Trénink na datech | Ne (lokální model) | Ne (uživatelské podmínky), výjimka: zpětná vazba odeslaná uživatelem |
| Právo a soud ze smlouvy | Česká smlouva (zpracovatelská smlouva, licenční doložky v `docs/kancelar/`) | Islandské právo, soud v Reykjavíku (uživatelské podmínky) |
| Rešerše a citace | Zákony a judikatura NS, NSS, ÚS v lokální bázi; **každá citace se po odpovědi ověří** proti bázi (`docs/CITATION_VERIFICATION.md`), neověřené jsou označené | Citace s odkazem na zdroj; jak se ověřují, **nezjištěno** |
| Spisy a provoz kanceláře | Spisy, podatelna, datové schránky, lhůtník s koncem lhůty, střet zájmů, kalendář, fakturace, koncepty ke schválení, práva podle rolí, auditní řetězec | Ne (podle zveřejněného popisu jde o asistenta, ne o spisovou službu) |
| Práce v textovém editoru | LexisEditor (vlastní editor napojený na LexisLocal); doplněk do Wordu/Outlooku **zatím ne** (`docs/UKOLY_KONKURENCE.md` K8, K9) | Doplněk do Wordu a Outlooku |
| Nasazení | Instalace v kanceláři (počítač s GPU nebo Mac mini) | Okamžitě v prohlížeči |
| Cena | Licence + hardware v kanceláři; cloud jen volitelně | Předplatné, ceník **nezjištěn** |

## Odpovědi na časté námitky

**„Jónsbók je v prohlížeči hned, vy potřebujete počítač.“** — Právě proto data klientů neodcházejí z kanceláře.
Mlčenlivost (§ 21 zákona o advokacii) i stanovisko ČAK k AI (20. 10. 2026) žádají vědět, kdo a kde data zpracovává.
U LexisLocalu je odpověď jednoduchá: kancelář.

**„Mají doplněk do Wordu.“** — Pravda. LexisLocal má vlastní editor a koncepty ve spisu; doplněk do Wordu a Outlooku
je v plánu (K8, K9). V pilotu ověříme, jak moc advokátům chybí.

**„Je cloudový model chytřejší?“** — Velké cloudové modely jsou v rešerších silnější než lokální 7B model. Kancelář si proto
může pro náročné dotazy zapnout Claude přes Bedrock v EU ve vlastním účtu AWS (`docs/BEDROCK_EU.md`), klientské pasáže
se přitom anonymizují. Vyhledávání a spisy zůstávají lokální.

**„Neplete si AI rozsudky?“** — Citace se ověřují automaticky proti bázi zákonů a judikatury; neexistující § nebo
sp. zn. se označí. Ověřovač zatím nechytí **skutečný, ale nesprávně použitý** paragraf (zátěžový test 27. 10.: u dotazu
na moderaci smluvní pokuty model 7× z 20 uvedl § 2248 místo § 2051 OZ) — to řeší úkoly K1–K3. Advokát koncept vždy
schvaluje (koncipient schválit nemůže).

## Kde je Jónsbók silnější (poctivě)

- Doplněk do Wordu a Outlooku — pracuje tam, kde advokát tráví nejvíc času.
- Bez instalace a bez hardwaru.
- Kapitál na rozvoj a obchod.
- Pravděpodobně silnější jazykový model (poskytovatel nezveřejněn).

## Zdroje

- Lupa.cz: Do Česka přichází AI, která přečte stovky zákonů i rozsudků za pár vteřin — https://www.lupa.cz/aktuality/do-ceska-prichazi-ai-ktera-precte-stovky-zakonu-i-rozsudku-za-par-vterin/
- Jónsbók — uživatelské podmínky (změna 6. 5. 2026) — https://jonsbok.ai/en/user-terms
- LegalTech Atlas — Jónsbók — https://legaltechatlas.com/products/jonsbok-3002
- Microsoft Marketplace — Jónsbók for Outlook — https://marketplace.microsoft.com/en-us/product/saas/wa200010926?tab=overview
- Dealroom — investice Crowberry a Leo Capital — https://dealroom.co/news/166994-icelands-j-nsb-k-raises-early-vc-from-crowberry-and-leo-capital-to-expan/
- ČAK — stanovisko k umělé inteligenci (20. 10. 2026) — https://www.cak.cz/storage/files/stanovisko-cak-umela-inteligence-ai-20-10-2026.pdf
