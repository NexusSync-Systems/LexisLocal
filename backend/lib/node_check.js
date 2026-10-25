/**
 * node_check.js — preflight kontrola verze Node.js.
 *
 * LexisLocal je testován na LTS liniích Node (20 / 22). „Current" liché verze
 * (zejména 25+) opakovaně padaly NATIVNĚ v běhovém prostředí (`zsh: abort`,
 * stack v libnode/libuv) — ne v aplikačním kódu. Tahle kontrola jen VARUJE
 * (nikdy neblokuje běh), aby vývojář i pilotní kancelář včas poznali, že běží
 * na nepodporované verzi, a měli po ruce nápravu. Bez závislostí.
 */
'use strict';

const MIN_MAJOR = 20;       // včetně
const MAX_MAJOR_EXCL = 25;  // vyjma → podporováno 20–24 (LTS 20/22, přechodně 24)

function nodeStatus() {
    const major = parseInt(String(process.versions.node).split('.')[0], 10) || 0;
    const ok = major >= MIN_MAJOR && major < MAX_MAJOR_EXCL;
    return { version: process.versions.node, major, ok, min: MIN_MAJOR, maxExcl: MAX_MAJOR_EXCL };
}

/**
 * Vypíše varování, když je verze mimo podporované rozpětí. `prefix` = odsazení
 * řádků (např. '   ' v setupu). Vrací nodeStatus() pro případné další rozhodnutí.
 */
function warnIfUnsupported(prefix = '') {
    const s = nodeStatus();
    if (s.ok) return s;
    const y = '\x1b[33m', r = '\x1b[31m', b = '\x1b[1m', x = '\x1b[0m';
    console.warn(`${prefix}${r}${b}⚠️  Nepodporovaná verze Node.js: ${s.version}${x}`);
    console.warn(`${prefix}${y}   LexisLocal je testován na Node ${s.min}–${s.maxExcl - 1} (LTS). Novější „Current" verze`);
    console.warn(`${prefix}${y}   (25+) opakovaně nativně padaly. Doporučení: přejdi na Node 22 LTS.${x}`);
    console.warn(`${prefix}${y}   macOS:  brew install node@22  &&  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"${x}`);
    return s;
}

module.exports = { nodeStatus, warnIfUnsupported, MIN_MAJOR, MAX_MAJOR_EXCL };
