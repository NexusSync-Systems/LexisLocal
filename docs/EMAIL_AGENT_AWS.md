# E-mailový agent v AWS (24/7, bez přístupu ke spisům)

Advokát pošle e-mail na adresu agenta (např. `asistent@ukoly.nexusstack.eu`) a do zhruba minuty dostane odpověď
od Clauda — i když je Mac vypnutý. Agent běží v účtu NexusSync v regionu Frankfurt:

```
advokát ──e-mail──▶ SES (eu-central-1, TLS povinné, kontrola virů/spamu/SPF/DKIM/DMARC)
                     ├─▶ S3 (šifrované, neveřejné, zprávy se po 7 dnech samy smažou)
                     └─▶ Lambda ──▶ Claude přes Amazon Bedrock (EU profil) ──▶ SES ──odpověď──▶ jen advokát
```

## Co agent smí a nesmí

| | |
|---|---|
| ✅ | obecné právní dotazy: rešerše, výklad ustanovení, lhůty, postup, osnova podání |
| ❌ | spisy, dokumenty, kalendář ani databáze kanceláře — agent k nim nemá přístup (to umí jen LexisLocal na Macu, PILOT_CLOUDSHELL.md C9) |
| ❌ | osobní údaje: zadání se jménem, rodným číslem, adresou, účtem, telefonem či e-mailem se Claudovi **nepošle**; odpověď vysvětlí proč |
| ❌ | přílohy se nečtou |

Bezpečnostní pravidla (kód `scripts/aws/email-agent/index.js`, testy `backend/tests/emailAgentAws.test.js`):

- zpracuje se jen zpráva od **povolené adresy** s **DMARC = PASS** a bez viru/spamu; jiným (i podvrženým) se neodpovídá vůbec,
- odpověď jde **jen** odesílateli z povoleného seznamu, s `Auto-Submitted` (žádné smyčky s automatickými odpověďmi),
- podpis a citovaná korespondence se před kontrolou odříznou (podpis advokáta nevadí),
- **denní limit** zadání (výchozí 40) a každá zpráva se zpracuje jednou,
- do logu jde jen rozhodnutí a počty tokenů, nikdy text zadání ani odpovědi (logy 30 dní),
- funkce smí jen: číst přijatou poštu, zapsat svůj stav, volat Clauda v EU, odeslat e-mail z adresy agenta.

Náklady: jedno zadání ≈ 1–5 tis. tokenů → řádově centy (Claude Sonnet přes Bedrock); SES, S3 a Lambda v desetinách
centu. Útratu Bedrocku dál hlídá tvrdý strop účtu (pilot-cloudshell.sh) a denní limit agenta.

**Podmínka DMARC:** doména advokáta musí mít záznam DMARC (stačí `p=none`) a poštu podepsanou DKIM — Gmail,
Seznam, Microsoft 365 i běžní hostingoví poskytovatelé to splňují. Bez DMARC agent zadání zahodí (`neovereny-puvod`).

## Nasazení (CloudShell, správce účtu, region Frankfurt)

Potřeba: subdoména jen pro agenta (např. `ukoly.nexusstack.eu`) — MX se mění jen u ní, běžná pošta kanceláře
na hlavní doméně zůstává beze změny.

```bash
REF=<hash commitu>     # vždy pevný commit — šablona a kód se nasazují pod správcem
curl -fsSLO https://raw.githubusercontent.com/NexusSync-Systems/LexisLocal/$REF/scripts/aws/email-agent-cloudshell.sh

# 1) stack + kód funkce (ukáže změny a čeká na „ano“); příjem zatím vypnutý
bash email-agent-cloudshell.sh nasad --domena ukoly.nexusstack.eu --adresa asistent@ukoly.nexusstack.eu \
     --povoleni advokat@kancelar.cz --limit 40 --ref $REF

# 2) záznamy do DNS (MX + 3× CNAME pro DKIM + doporučený DMARC) — přidá správce domény
bash email-agent-cloudshell.sh dns

# 3) SES v sandboxu: AWS pošle advokátovi ověřovací e-mail, on klikne na odkaz
bash email-agent-cloudshell.sh odesilatele

# 4) po ověření domény (DKIM SUCCESS, obvykle do hodiny) zapnout příjem
bash email-agent-cloudshell.sh aktivuj

# zkouška: advokát pošle obecný dotaz bez osobních údajů, pak
bash email-agent-cloudshell.sh stav
```

SES sandbox (nový účet) stačí: odpovědi jdou jen na ověřené adresy advokátů, max. 200 zpráv denně.
O produkční přístup SES žádat není potřeba.

V regionu smí být aktivní jen jedna sada pravidel příjmu SES — `aktivuj` upozorní, když už nějaká je.

## Provoz

```bash
bash email-agent-cloudshell.sh stav                 # doména, příjem, dnešní počet, posledních 15 rozhodnutí
bash email-agent-cloudshell.sh kod --ref <commit>   # nová verze kódu
bash email-agent-cloudshell.sh nasad … --ref <commit>   # změna povolených adres / limitu (stejné parametry)
bash email-agent-cloudshell.sh vypni                # okamžitě zastaví příjem (stack zůstane)
bash email-agent-cloudshell.sh smaz                 # vše smaže včetně uložené pošty (nevratné, ptá se)
```

Výsledky v logu (`stav`): `odpovezeno`, `osobni-udaje`, `limit`, `prazdne` (s odpovědí);
`odesilatel-nepovoleny`, `neovereny-puvod`, `automaticka-zprava`, `odesilatel-neplatny` (bez odpovědi).

## Rozdíl proti úkolům e-mailem na Macu

| | LexisLocal na Macu (IMAP, PILOT_CLOUDSHELL.md C9) | Agent v AWS (tento návod) |
|---|---|---|
| běží | když běží Mac | 24/7 |
| spisy | ano — sp. zn. v předmětu, platí stupeň a souhlas spisu | ne |
| osobní údaje | ve spisu se souhlasem ano | ne |
| výstup | koncept ve spisu + odpověď | jen odpověď |
| ověření odesílatele | DKIM/DMARC z `Authentication-Results` | DMARC verdikt SES |
