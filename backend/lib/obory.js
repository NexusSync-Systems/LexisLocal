/**
 * obory.js — KANONICKÁ taxonomie právních oborů advokátní kanceláře.
 *
 * Jeden zdroj pravdy pro:
 *   • dělený judikaturní RAG (partition `_kb_obor_<slug>`),
 *   • automatickou detekci oboru z textu dotazu (lib/obor_detect.js),
 *   • plnění znalostní báze (routes/knowledge.js, scripts/seed-kb.js --root),
 *   • UI (výběr oboru, přehled pokrytí daty).
 *
 * `slug` se odvozuje z `label` stejnou deakcentační funkcí, jakou používá
 * rag_request.oborScope() při dotazu i knowledge routa při plnění — takže se
 * partition scope `_kb_obor_<slug>` VŽDY trefí bez ohledu na to, kde vznikl.
 * (Např. „Nemovitosti a nájemní právo" → `_kb_obor_nemovitosti_a_najemni_pravo`.)
 *
 * Bez závislostí (aby ho mohl require kdokoli včetně rag_request bez cyklu).
 */
'use strict';

/** Deakcent + normalizace na slug: [a-z0-9_], max 48 znaků. STEJNÁ logika jako oborScope. */
function oborSlug(text) {
    return String(text == null ? '' : text)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // deakcent (á→a, č→c…)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
}

// `keywords` = rozlišující termíny oboru (typické instituty, §, zákony). Slouží
// lexikální (offline) klasifikaci — píšou se s diakritikou, klasifikátor je stejně
// deakcentuje. `label` je zároveň text pole `agenda` u spisu (viz variantu A).
const OBORY_DEF = [
    { label: 'Občanské právo', keywords: [
        'občanský zákoník', 'závazky', 'smlouva', 'promlčení', 'bezdůvodné obohacení',
        'věcná práva', 'vlastnictví', 'závazkové právo', 'plnění', 'odstoupení od smlouvy'] },
    { label: 'Nemovitosti a nájemní právo', keywords: [
        'nájem', 'nájemné', 'pronajímatel', 'nájemce', 'byt', 'nebytový prostor',
        'katastr nemovitostí', 'věcné břemeno', 'výpověď z nájmu', 'podnájem', 'služebnost'] },
    { label: 'Rodinné právo', keywords: [
        'rozvod', 'manželství', 'výživné', 'péče o dítě', 'svěření do péče', 'styk s dítětem',
        'společné jmění manželů', 'sjm', 'rodičovská odpovědnost', 'určení otcovství'] },
    { label: 'Dědické právo', keywords: [
        'dědictví', 'závěť', 'pozůstalost', 'dědic', 'odkaz', 'nepominutelný dědic',
        'dědická posloupnost', 'vydědění', 'dovětek', 'notář'] },
    { label: 'Pracovní právo', keywords: [
        'pracovní poměr', 'zákoník práce', 'výpověď', 'okamžité zrušení', 'mzda',
        'zaměstnanec', 'zaměstnavatel', 'dohoda o provedení práce', 'odstupné', 'pracovní úraz'] },
    { label: 'Obchodní a korporátní právo', keywords: [
        'obchodní korporace', 'společnost s ručením omezeným', 's.r.o.', 'akciová společnost',
        'jednatel', 'valná hromada', 'obchodní rejstřík', 'podíl', 'péče řádného hospodáře', 'z.o.k.'] },
    { label: 'Insolvenční právo', keywords: [
        'insolvence', 'úpadek', 'oddlužení', 'konkurs', 'insolvenční správce',
        'přihláška pohledávky', 'reorganizace', 'insolvenční řízení', 'majetková podstata'] },
    { label: 'Trestní právo', keywords: [
        'trestný čin', 'obžaloba', 'obviněný', 'trest', 'trestní řízení', 'trestní zákoník',
        'poškozený', 'obhajoba', 'přečin', 'zločin', 'podmíněné odsouzení'] },
    { label: 'Správní právo', keywords: [
        'správní řízení', 'správní orgán', 'rozhodnutí', 'odvolání', 'přestupek',
        'správní řád', 'stavební úřad', 'územní řízení', 'správní soud', 'žaloba proti rozhodnutí'] },
    { label: 'Ústavní právo a lidská práva', keywords: [
        'ústavní stížnost', 'základní práva', 'ústavní soud', 'listina základních práv',
        'spravedlivý proces', 'protiústavní', 'diskriminace', 'svoboda projevu'] },
    { label: 'Náhrada škody a odpovědnost', keywords: [
        'náhrada škody', 'odpovědnost za škodu', 'nemajetková újma', 'bolestné',
        'ušlý zisk', 'újma na zdraví', 'odčinění', 'ochrana osobnosti', 'zadostiučinění'] },
    { label: 'Spotřebitelské právo', keywords: [
        'spotřebitel', 'reklamace', 'vada zboží', 'odstoupení od smlouvy', 'záruka',
        'nekalá obchodní praktika', 'spotřebitelská smlouva', 'zákon o ochraně spotřebitele'] },
    { label: 'Právo duševního vlastnictví', keywords: [
        'autorské právo', 'ochranná známka', 'patent', 'licence', 'užité vzory',
        'průmyslový vzor', 'know-how', 'nekalá soutěž', 'dílo'] },
    { label: 'Daňové a finanční právo', keywords: [
        'daň', 'daňové řízení', 'dph', 'daňový řád', 'finanční úřad', 'daň z příjmů',
        'daňová kontrola', 'doměření daně', 'penále', 'odvod'] },
    { label: 'Ochrana osobních údajů (GDPR)', keywords: [
        'gdpr', 'osobní údaje', 'zpracování údajů', 'úřad pro ochranu osobních údajů',
        'souhlas se zpracováním', 'správce údajů', 'subjekt údajů', 'právo na výmaz'] }
];

// Rozvinutá taxonomie se slugem a scope. Zmrazená (neměnná za běhu).
const OBORY = OBORY_DEF.map(o => {
    const slug = oborSlug(o.label);
    return Object.freeze({
        slug,
        label: o.label,
        scope: '_kb_obor_' + slug,
        keywords: Object.freeze(o.keywords.slice()),
        // Text pro lexikální porovnání (label + keywords), předpočítaný.
        keywordText: (o.label + ' ' + o.keywords.join(' '))
    });
});

const _bySlug = new Map(OBORY.map(o => [o.slug, o]));

function bySlug(slug) { return _bySlug.get(String(slug || '')) || null; }
function byScope(scope) {
    const s = String(scope || '');
    const slug = s.indexOf('_kb_obor_') === 0 ? s.slice('_kb_obor_'.length) : s;
    return bySlug(slug);
}
function scopeOf(labelOrSlug) {
    const slug = oborSlug(labelOrSlug);
    return slug ? '_kb_obor_' + slug : null;
}
function allSlugs() { return OBORY.map(o => o.slug); }
function allScopes() { return OBORY.map(o => o.scope); }

// Pro scope, který v taxonomii NENÍ (ruční obor), odvoď čitelný label ze slugu.
function labelForScope(scope) {
    const known = byScope(scope);
    if (known) return known.label;
    const s = String(scope || '');
    const slug = s.indexOf('_kb_obor_') === 0 ? s.slice('_kb_obor_'.length) : s;
    if (!slug) return scope;
    return slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = {
    oborSlug, OBORY, bySlug, byScope, scopeOf, allSlugs, allScopes, labelForScope
};
