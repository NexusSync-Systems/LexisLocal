# LexisLocal — mapa osobních údajů (GDPR)

Stav: 14. 10. 2026, větev `release-prep`. Vychází z kódu, ne z předpokladů. Není to právní rada —
lhůty uchování a role správce/zpracovatele ověřit s advokátem.

**Role:** správcem údajů klientů je advokátní kancelář. NexusSync Systems s.r.o. je dodavatel
softwaru; pokud kanceláři zajišťuje provoz/podporu s přístupem k datům, je zpracovatelem →
zpracovatelská smlouva (čl. 28 GDPR).

## Mapa dat

| Údaj | Odkud | Kde je uložený | Komu odchází | Účel | Právní základ | Jak dlouho |
|---|---|---|---|---|---|---|
| Údaje klienta ve spisu (jméno, IČO, **e-mail klienta**, protistrana) | formulář spisu (`lib/spisy.js`) | šifrovaná lokální DB | nikomu | vedení spisu | smlouva / oprávněný zájem, zákonné povinnosti advokáta | do skartace spisu |
| Dokumenty spisu (text, OCR, RAG úseky) | doručená pošta, ISDS, upload (`lib/watcher.js`, `lib/rag.js`) | disk kanceláře + lokální RAG index | lokální model; cloudový model jen při `AI_PROVIDER≠ollama` (pilot `LEXIS_PILOT_LOCAL_ONLY=1` to zakáže) | práce na věci | smlouva, plnění povinností advokáta | do skartace — **dnes se nemažou, viz nález 1** |
| **Souhrny pro klienta** (text, e-mail, kdo schválil) | `lib/client_updates.js` | lokální DB `client_updates` | **SMTP poskytovatel kanceláře** (po schválení advokátem) | informování klienta o věci | smlouva | do skartace — **dnes se nemažou** |
| Spisový deník | `spisy.addEvent` | lokální DB `spis_events` | nikomu | evidence úkonů | oprávněný zájem, povinnosti advokáta | do skartace — **dnes se nemaže** |
| AML identifikace (RČ, adresa, rizika) | `lib/aml.js` | lokální DB `aml_checks` | nikomu | AML zákon | právní povinnost | lhůta podle AML zákona (ověřit) |
| Faktury | `lib/fakturace.js` | lokální DB `invoices` | nikomu (export ručně) | účetnictví | právní povinnost | účetní/daňové lhůty (ověřit) |
| Auditní log (kdo, kdy, co — **nově i čtení**) | `lib/audit.js` | šifrovaný log + šifrovaný archiv `.audit_archiv/` | nikomu | bezpečnost, prokazatelnost nakládání se spisem | oprávněný zájem | **dnes neomezeně, viz nález 3** |
| Údaje zaměstnanců (jméno, role, zařízení, aktivita v auditu) | `lib/users.js`, `request_context` | `users.json`, audit | nikomu | řízení přístupu, audit | oprávněný zájem / pracovní smlouva | po dobu účtu + audit |

## Nálezy podle závažnosti

1. **Vysoká — skartace nemaže data spisu.** `spisy.deleteSpis()` (`lib/spisy.js`) smaže jen záznam
   spisu; deník, souhrny pro klienta, koncepty, dokumenty (soubory, záznam v doručené poště i úseky
   v RAG indexu — agent by je dál citoval), schůzky zůstávají. Nově: `GET /api/spisy/:id/skartace-inventar`
   ukáže, co zbývá a co se má smazat / ponechat / pseudonymizovat. **Kaskádové mazání čeká na
   rozhodnutí** (nevratné; pravidla musí odsouhlasit advokát).
2. **Střední — souhrny pro klienta odcházejí přes SMTP poskytovatele.** Data tím opouštějí lokální
   prostředí. Mailer vynucuje TLS (`requireTLS`, `lib/mailer.js`), odeslání jen po schválení advokátem.
   Doporučení: v dokumentaci pro kancelář uvést SMTP poskytovatele jako zpracovatele (sídlo, přenos
   mimo EU) a doporučit poskytovatele v EU.
3. **Střední — auditní log nemá retenci.** Po opravě se už nic tiše nezahazuje (archiv), ale archiv
   roste neomezeně a obsahuje i jména klientů v poli „předmět“. Doporučení: retence (např. N let od
   skartace spisu) a pseudonymizace předmětu/podrobností u skartovaných spisů.
4. **Nízká — audit čtení sleduje zaměstnance.** Je to oprávněný zájem (prokazatelnost nakládání se
   spisem), ale zaměstnanci o tom mají vědět → vnitřní informace / poučení. Zapnuto jen ve firemním
   režimu (`AUDIT_READS`), deduplikace 15 min.
5. **Nízká — e-mail klienta** se ukládá jen po validaci formátu; ve souhrnu se neuvádějí názvy
   souborů ani interní poznámky (minimalizace).

## Co doplnit do informací pro kancelář / privacy policy

- LexisLocal zpracovává data lokálně; výjimky: SMTP poskytovatel (odesílání e-mailů), volitelný
  cloudový AI poskytovatel (jen při výslovném nastavení).
- Audit zaznamenává i čtení spisů (kdo, kdy) ve firemním režimu.
- Skartace: po dokončení kaskády popsat, co se maže a co se ze zákona ponechává.

Data safety / App Privacy: netýká se (desktop/server aplikace bez obchodů). Pro mobilní LexisLink
mapu doplnit zvlášť.
