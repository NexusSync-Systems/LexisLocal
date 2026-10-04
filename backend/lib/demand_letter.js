/**
 * lib/demand_letter.js — výzva k úhradě / předžalobní výzva / dopis protistraně
 * jako STRUKTUROVANÁ DATA od modelu a dopis poskládaný programem.
 *
 * Proč: malý model ve volném textu vynechával [Doplnit], pletl rod v oslovení a
 * nechával v dopise pole šablony („Oslovení: …“) — serverový test 3. 10. 2026, W1.
 * Model teď vrátí JSON (fakta a formulace), program z něj sestaví dopis:
 *   • chybějící údaj → vždy „[Doplnit – …]“ (model nemá kam nic vymyslet),
 *   • oslovení z lib/cz_salutation (rod, titul, 5. pád),
 *   • místo a datum, závěr a podpis advokáta pevně.
 * Když JSON nepřijde nebo nejde přečíst, route použije původní volný text.
 */
'use strict';

const { salutation, parsePersonName, genderOf } = require('./cz_salutation');

const RE_DEMAND = /předžalobní\s+výzv|výzv\S*\s+(k|ke)\s+(úhrad|zaplacení|plnění|splnění|vrácení|náhrad)|upomín|(dopis|výzv)\S*[^.]{0,80}(protistran|povinn|dlužník|žalovan|soused|nájemc|pronajímatel)|(protistran|povinn|dlužník)[^.]{0,80}(dopis|výzv)/i;

/** Jde o výzvu k plnění / dopis protistraně? (žaloba, plná moc, smlouva ne) */
function isDemandLetter(prompt) {
    const p = String(prompt || '');
    if (/žalob[auy]\b(?!\s*nepodáme)|plnou\s+moc|plná\s+moc|smlouv[uay]\s+(o|na)\b|odvolání|dovolání|stížnost/i.test(p) && !/předžalobní/i.test(p)) return false;
    return RE_DEMAND.test(p);
}

const SCHEMA = {
    type: 'object',
    properties: {
        typ: { type: 'string' },
        odesilatel: { type: 'object', properties: { jmeno: { type: ['string', 'null'] }, adresa: { type: ['string', 'null'] } } },
        adresat: { type: 'object', properties: { jmeno: { type: ['string', 'null'] }, adresa: { type: ['string', 'null'] }, pohlavi: { type: ['string', 'null'] } } },
        misto: { type: ['string', 'null'] },
        vec: { type: 'string' },
        skutkovy_stav: { type: 'string' },
        pravni_duvod: { type: ['string', 'null'] },
        castka: { type: ['string', 'null'] },
        lhuta: { type: ['string', 'null'] },
        platebni_udaje: { type: ['string', 'null'] },
        nasledky: { type: ['string', 'null'] },
        chybejici: { type: 'array', items: { type: 'string' } }
    },
    required: ['vec', 'skutkovy_stav', 'castka', 'lhuta', 'adresat', 'odesilatel']
};

const INSTRUCTION =
    'FORMÁT ODPOVĚDI: Tento dopis sestaví program. Vrať POUZE JSON objekt (žádný jiný text) s poli:\n' +
    '{"typ": "předžalobní výzva" | "výzva k úhradě" | "dopis protistraně",\n' +
    ' "odesilatel": {"jmeno": klient (za koho píšeme) nebo null, "adresa": adresa klienta nebo null},\n' +
    ' "adresat": {"jmeno": jméno adresáta PŘESNĚ jak je v podkladech (i symbol jako [OSOBA_1]) nebo null, "adresa": adresa nebo null, "pohlavi": "M" | "F" | null},\n' +
    ' "misto": město odesílatele nebo null,\n' +
    ' "vec": krátké označení věci („Výzva k úhradě náhrady škody“),\n' +
    ' "skutkovy_stav": 1–3 odstavce: co se stalo, kdy, jak vznikl dluh/škoda a jeho výše (rozpis položek, pokud je v podkladech). Piš ve 2. osobě k adresátovi („Dne … jste …“), v 1. osobě množného čísla za kancelář („naše klientka“).\n' +
    ' "pravni_duvod": právní důvod jednou větou (předpis obecně, § jen když si jsi jistý) nebo null,\n' +
    ' "castka": celková požadovaná částka přesně podle podkladů („86 000 Kč“) nebo null,\n' +
    ' "lhuta": lhůta k plnění, jen pokud ji zadání nebo podklady uvádějí („do 15 dnů od doručení této výzvy“), jinak null,\n' +
    ' "platebni_udaje": číslo účtu pro platbu jen pokud ho zadání VÝSLOVNĚ určuje pro tuto platbu, jinak null,\n' +
    ' "nasledky": následky nesplnění (žaloba, náklady řízení, úroky z prodlení) nebo null,\n' +
    ' "chybejici": seznam údajů, které v podkladech chybí}\n' +
    'Co v podkladech není, dej null — NIC NEVYMÝŠLEJ. Rodná čísla, zdravotní a rodinné údaje klienta do JSON nedávej (protistrana je nepotřebuje).';

function _str(v) { return typeof v === 'string' && v.trim() && !/^(null|neuvedeno|není uvedeno|n\/a|-)$/i.test(v.trim()) ? v.trim() : null; }

/** Vytáhne JSON i z odpovědi s ```json bloky nebo textem okolo. */
function parseLetterJson(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const cands = [s];
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) cands.push(fence[1]);
    const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) cands.push(s.slice(a, b + 1));
    for (const c of cands) {
        try {
            const o = JSON.parse(c);
            if (o && typeof o === 'object' && !Array.isArray(o) && (_str(o.skutkovy_stav) || _str(o.vec))) return o;
        } catch (e) { /* další kandidát */ }
    }
    return null;
}

/** Na každé textové pole použije fn (např. obnovu pseudonymů). */
function mapStrings(obj, fn) {
    if (typeof obj === 'string') return fn(obj);
    if (Array.isArray(obj)) return obj.map(x => mapStrings(x, fn));
    if (obj && typeof obj === 'object') { const o = {}; for (const k of Object.keys(obj)) o[k] = mapStrings(obj[k], fn); return o; }
    return obj;
}

// „V Jihlavě“ — 6. pád běžných měst; jinak „Místo: X“ by vypadalo jako šablona.
const LOC = { praha: 'V Praze', brno: 'V Brně', ostrava: 'V Ostravě', plzeň: 'V Plzni', olomouc: 'V Olomouci', jihlava: 'V Jihlavě', liberec: 'V Liberci', zlín: 'Ve Zlíně', pardubice: 'V Pardubicích', 'hradec králové': 'V Hradci Králové', 'české budějovice': 'V Českých Budějovicích', 'ústí nad labem': 'V Ústí nad Labem', kladno: 'Na Kladně', opava: 'V Opavě', karlovy_vary: 'V Karlových Varech', 'karlovy vary': 'V Karlových Varech', třebíč: 'V Třebíči', znojmo: 'Ve Znojmě', tábor: 'V Táboře', kolín: 'V Kolíně', most: 'V Mostě', teplice: 'V Teplicích', prostějov: 'V Prostějově', přerov: 'V Přerově', frýdek_místek: 'Ve Frýdku-Místku', 'frýdek-místek': 'Ve Frýdku-Místku', chomutov: 'V Chomutově', havířov: 'V Havířově', děčín: 'V Děčíně', jablonec: 'V Jablonci nad Nisou', 'mladá boleslav': 'V Mladé Boleslavi' };
function placeLine(misto, today) {
    const d = today || new Date();
    const date = `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
    const m = _str(misto);
    if (!m) return `V [Doplnit – místo] dne ${date}`;
    const loc = LOC[m.toLowerCase()] || (/^(V|Ve|Na)\s/.test(m) ? m : `V ${m}`);
    return `${loc} dne ${date}`;
}

const D = (what) => `[Doplnit – ${what}]`;

/** „naší klientky“ / „našeho klienta“ podle jména klienta (společnost = klientka). */
function clientForms(klient) {
    if (!klient) return { gen: 'naší klientky / našeho klienta', nom: 'naše klientka / náš klient' };
    if (/s\.\s?r\.\s?o|a\.\s?s\.|spol\.|v\.\s?o\.\s?s|k\.\s?s\.|z\.\s?s\.|družstvo|společnost/i.test(klient)) return { gen: 'naší klientky', nom: 'naše klientka' };
    const g = genderOf(parsePersonName(klient));
    if (g === 'F') return { gen: 'naší klientky', nom: 'naše klientka' };
    if (g === 'M') return { gen: 'našeho klienta', nom: 'náš klient' };
    return { gen: 'naší klientky / našeho klienta', nom: 'naše klientka / náš klient' };
}

/**
 * Sestaví dopis z dat modelu. Vrací { text, missing:[…], addressee }.
 * opts.today (Date) pro testy.
 */
function renderLetter(data, opts = {}) {
    const o = data || {};
    const ods = o.odesilatel || {}; const adr = o.adresat || {};
    const klient = _str(ods.jmeno);
    const adrName = _str(adr.jmeno);
    const castka = _str(o.castka);
    const lhuta = _str(o.lhuta);
    const ucet = _str(o.platebni_udaje);
    const cf = clientForms(klient);
    const missing = [];
    const need = (v, what) => { if (v) return v; missing.push(what); return D(what); };

    const lines = [];
    lines.push('Odesílatel:');
    lines.push(`${D('jméno advokáta / advokátní kanceláře, adresa sídla, ev. č. ČAK')}`);
    lines.push(`v zastoupení klienta: ${need(klient, 'jméno klienta')}${_str(ods.adresa) ? ', ' + _str(ods.adresa) : ''}`);
    lines.push('');
    lines.push('Adresát:');
    lines.push(need(adrName, 'jméno adresáta'));
    lines.push(need(_str(adr.adresa), 'adresa adresáta'));
    lines.push('');
    lines.push(placeLine(o.misto, opts.today));
    lines.push('');
    const typ = _str(o.typ) || 'výzva k úhradě';
    const vec = _str(o.vec) || (typ.charAt(0).toUpperCase() + typ.slice(1));
    lines.push(`Věc: ${vec}`);
    lines.push('');
    const sal = adrName ? salutation({ name: adrName, gender: _str(adr.pohlavi) }) : null;
    lines.push(sal || 'Vážená paní, vážený pane,');
    lines.push('');
    lines.push(`obracíme se na Vás jako právní zástupce ${cf.gen} (${klient || D('jméno klienta')}) v následující věci.`);
    lines.push('');
    lines.push(need(_str(o.skutkovy_stav), 'popis skutkového stavu'));
    if (_str(o.pravni_duvod)) { lines.push(''); lines.push(_str(o.pravni_duvod)); }
    lines.push('');
    const isPre = /předžalob/i.test(typ) || /předžalob/i.test(String(opts.prompt || ''));
    lines.push(`${isPre ? 'V souladu s § 142a občanského soudního řádu Vás tímto vyzýváme' : 'Tímto Vás vyzýváme'} k úhradě částky ${need(castka, 'celková požadovaná částka')} ` +
        `${lhuta || 'do 15 dnů ode dne doručení této výzvy'}, a to na účet ${ucet || D('číslo účtu pro platbu')}` +
        `${ucet ? '' : ', variabilní symbol ' + D('variabilní symbol')}.`);
    if (!lhuta) missing.push('lhůta k úhradě (navrženo 15 dnů — ověřte)');
    if (!ucet) missing.push('číslo účtu pro platbu');
    lines.push('');
    lines.push(_str(o.nasledky) || (isPre
        ? `Nebude-li částka ve stanovené lhůtě uhrazena, uplatní ${cf.nom} svůj nárok u příslušného soudu bez dalšího upozornění, a to včetně zákonných úroků z prodlení a náhrady nákladů řízení, které tím vzniknou.`
        : 'Nebude-li částka ve stanovené lhůtě uhrazena, budeme nuceni zahájit další právní kroky k jejímu vymožení, včetně podání žaloby.'));
    lines.push('');
    lines.push('S pozdravem');
    lines.push('');
    lines.push(D('jméno a podpis advokáta'));
    lines.push(`advokát, v zastoupení klienta: ${klient || D('jméno klienta')}`);
    const extra = (Array.isArray(o.chybejici) ? o.chybejici : []).map(_str).filter(Boolean)
        .filter(x => !missing.some(m => m.toLowerCase().includes(x.toLowerCase().slice(0, 12))));
    const allMissing = [...new Set(missing.concat(extra))].slice(0, 12);
    return { text: lines.join('\n'), missing: allMissing, addressee: adrName, data: o };
}

module.exports = { clientForms, isDemandLetter, SCHEMA, INSTRUCTION, parseLetterJson, renderLetter, mapStrings, placeLine };
