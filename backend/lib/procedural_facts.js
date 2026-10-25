/**
 * lib/procedural_facts.js — ověřené procesní lhůty a příslušnost soudu, které dodá PROGRAM.
 *
 * Proč (server test 3. 10. 2026, qwen2.5:7b): u otázky „lhůta k odvolání proti rozsudku
 * okresního soudu“ model neuvedl 15 dní / § 204 o. s. ř. (eval R4), u anglického dopisu
 * o dluhu českého dlužníka neřekl, který soud je příslušný (eval R5). Tyto údaje jsou
 * stálé — program je modelu předá jako fakta a co model vynechá, doplní pod odpověď.
 *
 * proceduralFacts({ prompt, context }) → null | { text, items:[{ key, line, mustRe }] }
 * proceduralAppendix(response, pf) → '' | text doplňku (jen chybějící body)
 */
'use strict';

const REMEDIES = {
    civil_appeal: {
        line: '• ODVOLÁNÍ v občanském soudním řízení: do 15 dnů od doručení písemného vyhotovení rozhodnutí (§ 204 odst. 1 o. s. ř.); ' +
            'podává se u soudu, který rozhodnutí vydal (soud prvního stupně), o odvolání proti rozhodnutí okresního soudu rozhoduje krajský soud (§ 10 odst. 1 o. s. ř.). ' +
            'Konec lhůty připadající na sobotu, neděli nebo svátek se posouvá na nejbližší pracovní den (§ 57 odst. 2 o. s. ř.).',
        mustRe: /15\s*dn[ůuí]|patn[aá]ct[ií]?\s*dn/i,
        lawRe: /204/
    },
    criminal_appeal: {
        line: '• ODVOLÁNÍ v trestním řízení: do 8 dnů od doručení opisu rozsudku (§ 248 odst. 1 tr. ř.), podává se u soudu, proti jehož rozsudku směřuje.',
        mustRe: /8\s*dn[ůuí]|osm\s*dn/i,
        lawRe: /248/
    },
    admin_appeal: {
        line: '• ODVOLÁNÍ ve správním řízení: do 15 dnů ode dne oznámení rozhodnutí (§ 83 odst. 1 správního řádu), podává se u správního orgánu, který rozhodnutí vydal (§ 86 odst. 1 správního řádu).',
        mustRe: /15\s*dn[ůuí]|patn[aá]ct[ií]?\s*dn/i,
        lawRe: /§\s*83\b/
    },
    payment_order: {
        line: '• ODPOR proti platebnímu rozkazu: do 15 dnů od doručení, u soudu, který platební rozkaz vydal (§ 173 odst. 1 o. s. ř.); včasným odporem se platební rozkaz ruší.',
        mustRe: /15\s*dn[ůuí]|patn[aá]ct[ií]?\s*dn/i,
        lawRe: /173/
    },
    appellate_review: {
        line: '• DOVOLÁNÍ: do 2 měsíců od doručení rozhodnutí odvolacího soudu, podává se u soudu, který rozhodoval v prvním stupni (§ 240 odst. 1 o. s. ř.); dovolatel musí být zastoupen advokátem (§ 241 o. s. ř.).',
        mustRe: /2\s*m[eě]s[ií]c|dvou\s*m[eě]s[ií]c/i,
        lawRe: /240/
    }
};

// Otázka na lhůtu / postup — fakta se přidávají jen když se zadání na opravný prostředek ptá.
const ASKS = /lh[uů]t|do kdy|kdy (?:nejpozd|mus)|kam se|u kter[ée]ho soudu|jak (?:podat|se br[aá]nit)|odkdy|odvol[aá]|odpor|dovol[aá]n/i;

function _remedies(prompt, context) {
    const p = String(prompt || '');
    const all = p + '\n' + String(context || '').slice(0, 4000);
    if (!ASKS.test(p)) return [];
    const out = [];
    const criminal = /trestn|obžalovan|odsouzen|tr\.\s*ř|trestní příkaz|státní zástup/i.test(all);
    const admin = /správní(?!m\s+soud)|správního orgán|úřad|magistr|přestup|stavební povolen|krajsk[ýé]\s+úřad/i.test(all) && !/rozsud/i.test(p);
    if (/dovol[aá]n/i.test(p)) out.push('appellate_review');
    if (/odpor/i.test(p) && /platebn/i.test(all)) out.push('payment_order');
    if (/odvol/i.test(p)) {
        if (criminal) out.push('criminal_appeal');
        else if (admin) out.push('admin_appeal');
        else if (/rozsud|usnesen|soud/i.test(all)) out.push('civil_appeal');
    }
    return out;
}

// ── Příslušnost: dluh / žaloba proti dlužníkovi se sídlem v ČR (cizí věřitel) ──────────
const CZ_CITIES = ['Praha', 'Prague', 'Brno', 'Ostrava', 'Plzeň', 'Plzen', 'Liberec', 'Olomouc', 'České Budějovice', 'Hradec Králové', 'Ústí nad Labem', 'Pardubice', 'Zlín', 'Jihlava', 'Karlovy Vary', 'Kladno', 'Most', 'Opava', 'Teplice', 'Děčín'];
const SUE_ASK = /\bsue\b|lawsuit|court|žalob|žalovat|soudn[ěí]\s+vym|vym[aá]h[a-zá-ž]*\s+soud|kde\s+(?:podat|žalovat)|kter[ýé]\s+soud/i;

function _defendantCity(text) {
    const t = String(text || '');
    // „… s.r.o. in Brno“, „… a.s., se sídlem v Brně“, „company in Prague“
    for (const c of CZ_CITIES) {
        const stem = c.slice(0, Math.max(3, c.length - 1)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(s\\.\\s?r\\.\\s?o\\.|a\\.\\s?s\\.|spol\\.|company|firm[aě]?|se sídlem|sídl)[^.\\n]{0,40}\\b(?:in|v|ve)\\s+${stem}`, 'i');
        if (re.test(t)) return c === 'Prague' ? 'Praha' : c === 'Plzen' ? 'Plzeň' : c;
    }
    return null;
}

function jurisdictionFacts(prompt, context) {
    const all = String(prompt || '') + '\n' + String(context || '');
    if (!SUE_ASK.test(all)) return null;
    const city = _defendantCity(all);
    if (!city) return null;
    return {
        key: 'jurisdiction',
        line: `• PŘÍSLUŠNOST: dlužník (žalovaný) má sídlo v ČR (${city}) → pravomoc českých soudů je dána sídlem žalovaného ` +
            `(čl. 4 nařízení Brusel I bis; u žalobce mimo EU obdobně § 6 zákona o mezinárodním právu soukromém). Žaluje se u obecného soudu žalovaného podle jeho sídla ` +
            `(§ 84 a § 85 odst. 3 o. s. ř.) — tj. u okresního soudu příslušného pro ${city}. ` +
            `Povinné zastoupení advokátem v prvním stupni není; zahraniční účastník ale musí mít v ČR adresu pro doručování nebo zmocněnce. ` +
            `(English: Czech courts have jurisdiction because the debtor is seated in ${city}; the claim is filed with the district court for ${city}.)`,
        mustRe: new RegExp(`${city.slice(0, Math.max(3, city.length - 1))}|česk[éý]ch\\s+soud|Czech court`, 'i'),
        lawRe: null
    };
}

function proceduralFacts({ prompt, context } = {}) {
    const items = _remedies(prompt, context).map(k => Object.assign({ key: k }, REMEDIES[k]));
    const j = jurisdictionFacts(prompt, context);
    if (j) items.push(j);
    if (!items.length) return null;
    return {
        items,
        text: 'Procesní fakta (ověřil program podle zákona — převezmi je, lhůty a § neměň):\n' + items.map(i => i.line).join('\n')
    };
}

/** Pod odpověď doplní body, které model vynechal (chybí lhůta nebo § / soud). */
function proceduralAppendix(response, pf) {
    if (!pf || !pf.items || !pf.items.length) return '';
    const r = String(response || '');
    const missing = pf.items.filter(i => !i.mustRe.test(r) || (i.lawRe && !i.lawRe.test(r)));
    if (!missing.length) return '';
    return '\n\n---\n⚖️ Doplněno programem (procesní lhůty a příslušnost podle zákona):\n' + missing.map(i => i.line).join('\n');
}

/**
 * Serverový test 7. 10. 2026 (run 8, R4): „Odvolání se podává u krajského soudu“ — chybně,
 * odvolání proti rozsudku okresního soudu se podává u soudu, který rozhodnutí vydal (§ 204
 * odst. 1 o. s. ř.); krajský soud o něm jen rozhoduje. Model to měl správně ve faktech,
 * ale ve stručné odpovědi i v postupu to otočil. Program větu opraví (jen u civilního
 * odvolání a jen ve větě o odvolání — dovolání/správní řízení nechá být).
 */
function fixFilingCourt(response, pf) {
    let t = String(response || '');
    if (!pf || !pf.items || !pf.items.some(i => i.key === 'civil_appeal')) return { text: t, fixed: 0 };
    let fixed = 0;
    const re = /\b(pod[aá]v[aá]|podat|podejte|pod[aá]|pod[aá]te|pod[aá]v[aá]te|podávat|zaslat|poslat|doručit)([^.\n]{0,50}?)\b(?:u|k|ke)\s+krajsk(?:ého|ému)\s+soudu/giu;
    t = t.replace(re, (all, verb, mid, idx, whole) => {
        // Věta, ve které shoda leží: od posledního konce věty / řádku po shodu.
        const start = Math.max(whole.lastIndexOf('\n', idx), whole.lastIndexOf('. ', idx)) + 1;
        const sentence = whole.slice(start, idx + all.length);
        if (!/odvol/i.test(sentence) || /dovol[aá]n|správn/i.test(sentence)) return all;
        fixed++;
        return `${verb}${mid}u soudu, který rozhodnutí vydal (okresního soudu; o odvolání pak rozhoduje krajský soud)`;
    });
    return { text: t, fixed };
}

module.exports = { proceduralFacts, proceduralAppendix, jurisdictionFacts, fixFilingCourt, _remedies };
