# Vzdálený přístup k Mac mini v kanceláři (Tailscale / WireGuard)

Cíl: advokát se z domova nebo od soudu připojí k LexisLocalu na Mac mini v kanceláři,
**aniž by server byl vidět z internetu**. Žádné přesměrování portů na routeru, žádná veřejná IP.

Doporučení: **Tailscale** (WireGuard s automatickou správou klíčů). Alternativy na konci.

## Jak to funguje

- Mac mini i notebooky advokátů jsou v soukromé síti kanceláře (tzv. tailnet), každé zařízení
  má adresu `100.x.y.z` a jméno, např. `lexis-macmini.<vase-sit>.ts.net`.
- Provoz jde šifrovaně (WireGuard) **přímo mezi zařízeními**; když přímé spojení nejde,
  přes přenosový uzel Tailscale — i tam zůstává šifrovaný end-to-end, obsah Tailscale nevidí.
- Tailscale (koordinační server) vidí **metadata**: názvy zařízení, IP adresy, kdy byla online.
  Obsah spisů ani komunikace ne. → uvést v DPIA kanceláře (zpracovatel / poskytovatel).
- LexisLocal má dál **vlastní** ochranu: TLS, API token, účty uživatelů (firemní režim) a audit.
  Tailscale je jen další vrstva — kdo není v síti kanceláře, se k serveru vůbec nedostane.

## 1. Mac mini (server)

1. Nainstalovat Tailscale (aplikace pro macOS) a přihlásit se **firemním** účtem kanceláře
   (ne osobním). Pojmenovat zařízení, např. `lexis-macmini`.
2. V administraci Tailscale u Mac mini **vypnout vypršení klíče** (Disable key expiry) —
   jinak se server po čase odpojí a advokáti se nepřipojí.
3. Mac mini nesmí usínat: Nastavení systému → Energie → zabránit automatickému uspání,
   zapnout start po výpadku proudu.
4. LexisLocal — `.env` (firemní režim):
   ```
   BIND_HOST=100.x.y.z          # adresa Mac mini v Tailscale (tailscale ip -4); ne 0.0.0.0
   USE_HTTPS=true
   LEXIS_ENFORCE_TOKEN=1
   ```
   `BIND_HOST` na adresu Tailscale znamená, že server poslouchá **jen** v síti kanceláře
   (ani v místní Wi-Fi ne). Pokud ho mají používat i počítače v kanceláři bez Tailscale,
   nainstalujte Tailscale i na ně (doporučeno), nebo použijte `0.0.0.0` a firewall macOS.
5. Restartovat LexisLocal a zkontrolovat v logu: „Síťové (LAN) nasazení s vynuceným tokenem i TLS — OK“
   a otisk klíče serveru (pro párování LexisEditoru).

## 2. Notebook advokáta

1. Nainstalovat Tailscale, přihlásit se do sítě kanceláře (pozvánka od správce).
2. V prohlížeči otevřít `https://lexis-macmini.<vase-sit>.ts.net:4000` (nebo `https://100.x.y.z:4000`).
   Prohlížeč upozorní na vlastní certifikát — **ověřit otisk** proti otisku z logu serveru.
3. LexisEditor: Nastavení → Spárovat → vložit párovací odkaz ze serveru (obsahuje otisk klíče).
4. Přihlásit se vlastním účtem (firemní režim) — každý advokát svůj, kvůli auditu.

## 3. Pravidla přístupu (doporučeno)

V administraci Tailscale (Access controls) povolit k Mac mini jen port LexisLocalu
a jen skupině advokátů kanceláře, např.:

```json
{
  "groups":    { "group:advokati": ["jana@kancelar.cz", "petr@kancelar.cz"] },
  "tagOwners": { "tag:lexis-server": ["group:advokati"] },
  "acls": [
    { "action": "accept", "src": ["group:advokati"], "dst": ["tag:lexis-server:4000"] }
  ]
}
```

Mac mini označit tagem `tag:lexis-server`. Ztracený notebook: v administraci zařízení
odebrat a v LexisLocalu zrušit jeho párování / deaktivovat účet.

## 4. Kontrola po nastavení

| Zkouška | Očekávání |
|---|---|
| Notebook na mobilních datech, Tailscale zapnutý → `https://lexis-macmini…:4000` | LexisLocal se otevře, otisk sedí |
| Totéž s vypnutým Tailscale | stránka se nenačte (server není z internetu vidět) |
| Bez přihlášení / bez tokenu | 401 |
| Audit spisu po práci z domova | čtení je zapsané pod účtem advokáta |

## Alternativy

- **Headscale** — vlastní koordinační server (open source) místo služby Tailscale; metadata
  zůstanou u kanceláře, za cenu správy dalšího serveru.
- **Čistý WireGuard** — router kanceláře (nebo Mac mini) jako WireGuard server, klíče
  rozdává správce ručně. Žádná třetí strana, ale ručně: přidání zařízení, výměna klíčů,
  otevřený UDP port na routeru.
- **Nepoužívat**: přesměrování portu 4000 z internetu na Mac mini, vzdálená plocha přes
  veřejné služby, sdílení přes cloudové disky.

## Do dokumentace kanceláře

- Tailscale (nebo jiný poskytovatel VPN) uvést v záznamech o činnostech zpracování / DPIA
  jako poskytovatele infrastruktury (vidí metadata, ne obsah); u Tailscale lze uzavřít DPA.
- Pravidla: kdo smí mít přístup z domova, ztráta zařízení, odchod zaměstnance (odebrat
  zařízení v Tailscale + deaktivovat účet v LexisLocalu).
