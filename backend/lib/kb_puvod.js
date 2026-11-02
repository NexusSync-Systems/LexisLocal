'use strict';
/**
 * kb_puvod.js — co ze znalostních bází (_kb_*) je VEŘEJNÉ a smí do cloudu jako „obecná“ pasáž.
 *
 * Bezpečnostní revize 2. 11. 2026: báze agentů se plní i nahráním z dashboardu (interní postupy, vzory…) a pravidla
 * cloudu i přeřazení přes Bedrock dřív braly celé _kb_* jako veřejnou bázi zákonů → dokument kanceláře (nebo podklad
 * ze spisu) nahraný do báze šel do cloudu bez souhlasu klienta. Nově:
 *   - každá nová pasáž nese `puvod`: 'verejne' (zákony, judikatura — instalační balíček, seed-kb --verejne,
 *     správce výslovně) nebo 'kancelar' (vše ostatní, výchozí);
 *   - starší pasáže bez `puvod` jsou veřejné jen podle názvu souboru zákonů a judikatury z balíčku
 *     („OZ 89-2012 § 0082.txt“, „NS_…“, „US_…“, „NSS_…“) — nová nahrání to obejít nemohou, protože `puvod` mají vždy.
 */
const KB_PREFIX = '_kb_';
const LEGACY_VEREJNE = [
    /^\p{Lu}[\p{L}]{0,7} \d{1,4}-\d{4} § /u,   // předpis: zkratka číslo-rok § …
    /^(NS|US|NSS)_/                              // judikatura NS, ÚS, NSS z balíčku
];

function jeKb(m) { return !!(m && typeof m.scope === 'string' && m.scope.indexOf(KB_PREFIX) === 0); }

/** Je pasáž veřejná (zákon, judikatura) → smí do cloudu bez vazby na spis? */
function jeVerejna(m) {
    if (!jeKb(m)) return false;
    if (m.puvod === 'verejne') return true;
    if (m.puvod) return false; // 'kancelar' nebo cokoli jiného
    const f = String(m.fileName || '');
    return LEGACY_VEREJNE.some(re => re.test(f));
}

/** Hodnota `puvod` pro novou pasáž: veřejná jen výslovně. */
function puvodZVolby(verejne) { return verejne === true ? 'verejne' : 'kancelar'; }

module.exports = { jeKb, jeVerejna, puvodZVolby, KB_PREFIX };
