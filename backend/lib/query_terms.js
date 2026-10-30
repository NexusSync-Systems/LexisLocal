'use strict';
/**
 * query_terms.js — pomoc vyhledávání u dotazů běžnou řečí (K17, 30. 10. 2026).
 *
 * 1) Slovník „hovorově → právně“: k dotazu se připojí právní pojmy, které v něm chybí
 *    („půjčil jsem kamarádovi peníze“ → zápůjčka). Deterministicky, bez AI — přepis dotazu
 *    qwenem hledání zhoršoval (training/embed/README.md, laboratoř 1).
 * 2) Výslovně zmíněný zákon („s.r.o.“, „zákoník práce“, „exekuce“) → malé zvýhodnění paragrafů
 *    toho zákona (prefix názvu souboru báze, např. „ZOK 90-2012“).
 *
 * Slovník je obecný (typické laické situace), NE podle chyb ze zlaté sady; ověřuje se na zvláštní
 * sadě training/embed/holdout_queries.json. Zapnutí: RAG_QUERY_TERMS=1 (výchozí vypnuto do změření),
 * opts.queryTerms přepíše env. Váha zvýhodnění RAG_LAW_BOOST (výchozí 0.03 k hybridnímu skóre).
 */

// [vzor (bez diakritiky, malá písmena), právní pojmy]
const SLOVNIK = [
    [/\bpujc(il|ila|ili|ilo|it|im|ka|ku|ky)\b.*\b(penize|korun|kc|tisic)|\bnevraci\b.*\b(penize|dluh)/, 'zápůjčka, smlouva o zápůjčce, vrácení zápůjčky'],
    [/\bpujc(il|ila|ili|it)\b.*\b(auto|vec|kolo|telefon|mobil|naradi)/, 'výpůjčka, smlouva o výpůjčce'],
    [/\bnezaplatil|\bneplati\b|\bdluzi\b|\bpozde zaplatil|\bpo splatnosti/, 'prodlení dlužníka, úrok z prodlení'],
    [/\bvyhodit z bytu|\bvystehovat|\bvypovedet (najem|byt)|\bmajitel\w* bytu|\bpronajimatel|\bnajemn|\bpodnaj|\bv pronajmu|\bz pronajmu/, 'nájem bytu, práva a povinnosti nájemce a pronajímatele'],
    [/\bkauc/, 'jistota u nájmu'],
    [/\bdostal(a)? vypoved|\bvyhodili z prace|\bpropust|\bzamestnavatel|\bv praci\b|\bz prace\b/, 'pracovní poměr, zákoník práce, výpověď z pracovního poměru'],
    [/\brozbil(o|a)?\b|\bnefunguj|\breklam|\bvadn|\bzamlcel|\bje poskozen/, 'vadné plnění, práva z vad, odpovědnost za vady'],
    [/\bpod cenou|\bzlomek (jeji |jeho )?ceny|\bneumern/, 'neúměrné zkrácení'],
    [/\bvyhrozoval|\bnatlak|\bdonutil/, 'bezprávná výhrůžka, neplatnost právního jednání'],
    [/\bomylem (jsem )?(poslal|zaplatil|prevedl)|\bdvakrat zaplatil|\bspatny ucet/, 'bezdůvodné obohacení, vydání plnění'],
    [/\bnasel (jsem )?|\bnalezen|\bztracen/, 'nález, ztracená věc, nálezné'],
    [/\bkraden|\bod zlodeje|\bneopravnen/, 'nabytí vlastnického práva od neoprávněného, dobrá víra'],
    [/\bsoused/, 'sousedská práva, imise, vlastnické právo'],
    [/\bzdedit|\bdedictv|\bzavet|\bpozustal|\bzemrel|\bumrel/, 'dědění, dědické právo, pozůstalost'],
    [/\brozvod|\brozvest|\bmanzel/, 'manželství, společné jmění manželů'],
    [/\balimenty|\bvyzivn|\bplatit na dite/, 'vyživovací povinnost, výživné'],
    [/\bexekuc|\bexekutor|\bzabavil/, 'exekuce, exekuční řízení'],
    [/\bbankrot|\boddluzen|\bnezvladam splacet|\bpredluzen/, 'insolvence, oddlužení'],
    [/\bnehoda|\bublizil|\bzranen|\buraz|\bskoda\b|\bskodu\b/, 'náhrada škody, újma'],
    [/\bodejit z firmy|\bvystoupit ze? (spolecnost|firm|sro)|\bodejit jako spolecnik/, 'vystoupení společníka, zánik účasti společníka'],
    [/\bzisk\b|\bdividend/, 'podíl na zisku'],
    [/\bucetnictvi|\bnahlizet do/, 'právo společníka na informace'],
    [/\bzalozeni (s\.?r\.?o|firmy|spolecnosti)|\bzalozit (s\.?r\.?o|firmu)/, 'založení společnosti, vklad, základní kapitál'],
    [/\bpred podanim zaloby|\bpred zalobou|\bvyzva k zaplaceni|\bupominka/, 'předžalobní výzva'],
    [/\bpreklep|\bspatne (napsal|uvedl)|\bchyba v rozsudku/, 'oprava rozsudku, chyby v psaní a počtech'],
    [/\bnechodi k soudu|\bneprisel k soudu|\bnedostavil/, 'nedostavení se k soudu, pořádková pokuta'],
    [/\btlumocn|\bnemluvim (dobre )?cesky|\bcizinec/, 'jednací jazyk, tlumočník, mateřština'],
    [/\bjiny(m)? soud|\bspatny(m)? soud|\bv jinem meste/, 'místní příslušnost soudu, obecný soud'],
    [/\bnabidk/, 'nabídka, přijetí nabídky, uzavření smlouvy'],
    [/\bkocku|\bkocka|\bpsa\b|\bpes\b|\bzvire/, 'chov zvířete v bytě'],
    [/\bpredelat|\bprestavb|\bkoupeln|\bupravy bytu/, 'změna bytu nájemcem, souhlas pronajímatele'],
    [/\bpodepsal za (nas|firmu)|\bnad ramec|\bnemel opravneni|\bnesmel podepsat/, 'zastoupení, překročení zástupčího oprávnění'],
    [/\bv rozporu se zakonem|\bnelegaln|\bprotizakon/, 'neplatnost právního jednání pro rozpor se zákonem']
];

// Výslovně zmíněný zákon → prefix souborů báze (formát fetch-esbirka / split-zakon: „ZOK 90-2012 § 0132.txt“).
const ZAKONY = [
    [/obcansk\w* soudn\w* rad|\bo\. ?s\. ?r\.|\bosr\b/, 'OSŘ 99-1963'],
    [/obcansk\w* zakonik|\bnoz\b|\boz\b/, 'OZ 89-2012'],
    [/obchodnich korporac|\bzok\b|\bs\. ?r\. ?o\.?|\bsro\b|akciov\w* spolecnost|\ba\. ?s\.|\bjednatel|\bvaln\w* hromad|\bspolecnik/, 'ZOK 90-2012'],
    [/zakonik\w* prace|\bzamestnava|\bzamestnan|pracovn\w* pomer/, 'ZP 262-2006'],
    [/insolven|oddluzen|bankrot/, 'IZ 182-2006'],
    [/exekuc|exekutor/, 'EŘ 120-2001'],
    [/trestn\w* zakonik|trestn\w* cin/, 'TZ 40-2009'],
    [/trestn\w* rad|obvinen|obzalob/, 'TŘ 141-1961'],
    [/soudn\w* rad\w* spravn|spravn\w* zalob/, 'SŘS 150-2002'],
    [/spravn\w* rad\b/, 'SŘ 500-2004'],
    [/danov\w* rad|spravce dane/, 'DŘ 280-2009'],
    [/katastr/, 'KatZ 256-2013'],
    [/osobnich udaj|\bgdpr\b/, 'ZOOÚ 110-2019'],
    [/prestup/, 'ZPř 250-2016'],
    [/soudn\w* poplat/, 'ZSP 549-1991'],
    [/rozhodci/, 'ZRŘ 216-1994'],
    [/ochran\w* spotrebitel/, 'ZOS 634-1992'],
    [/zakon\w* o advokacii/, 'ZA 85-1996'],
    [/verejn\w* rejstrik|obchodn\w* rejstrik/, 'ZVR 304-2013']
];

const _norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Pojem už v dotazu je (i v jiném tvaru): každé jeho slovo delší než 3 znaky se v dotazu vyskytuje
// aspoň začátkem (5 znaků) — „jistotu u nájmu“ ≈ „jistota u nájmu“.
function _obsahuje(n, pojem) {
    const slova = _norm(pojem).split(/[^a-z0-9]+/).filter(w => w.length > 3);
    return slova.length > 0 && slova.every(w => n.includes(w.slice(0, 5)));
}

function zapnuto(opts) {
    if (opts && typeof opts.queryTerms === 'boolean') return opts.queryTerms;
    return ['1', 'true', 'yes', 'on'].includes(String(process.env.RAG_QUERY_TERMS || '').toLowerCase());
}

function lawBoost() {
    const v = parseFloat(process.env.RAG_LAW_BOOST);
    return Number.isFinite(v) && v >= 0 && v <= 0.2 ? v : 0.03;
}

/** { text, pojmy[], zakony[] } — text = dotaz + chybějící právní pojmy v závorce. Čistá funkce. */
function rozsir(query) {
    const q = String(query || '');
    const n = _norm(q);
    const pojmy = [];
    for (const [re, t] of SLOVNIK) {
        if (re.test(n)) for (const p of t.split(/,\s*/)) if (!_obsahuje(n, p) && !pojmy.includes(p)) pojmy.push(p);
    }
    const zakony = [];
    for (const [re, pref] of ZAKONY) if (re.test(n) && !zakony.includes(pref)) zakony.push(pref);
    return { text: pojmy.length ? `${q} (${pojmy.join(', ')})` : q, pojmy, zakony };
}

module.exports = { rozsir, zapnuto, lawBoost, SLOVNIK, ZAKONY };
