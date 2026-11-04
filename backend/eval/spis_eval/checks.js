/**
 * eval/spis_eval/checks.js — deterministické kontroly odpovědí nad syntetickými spisy (bez závislostí).
 *
 * Katalog chyb (KATALOG níže) — každá chyba má levnou automatickou kontrolu; LLM-judge jen u „nejistých“
 * citací (tvrzení bez čísel, kde nestačí překryv slov) a u vymyšlených rozporů, a to jen s --judge.
 *
 * Citace jako samostatná metrika: každá citace místa ve spisu („smlouva o dílo, čl. 4 odst. 1“, „protokol, bod 3“)
 * se dohledá v kotvách dokumentu → PLATNÁ (místo existuje) a PODPORUJÍCÍ (citované místo obsahuje tvrzení).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const KATALOG = {
    halucinace:            { nazev: 'halucinovaný fakt (částka, datum, %, osoba mimo spis)', vaha: 30, strop: 60, kriticka: true },
    neexistujici_misto:    { nazev: 'citace na neexistující místo ve spisu', vaha: 15, strop: 30 },
    chybna_citace:         { nazev: 'správný fakt s chybnou citací', vaha: 15, strop: 30 },
    citace_nepodporuje:    { nazev: 'citované místo tvrzení nepodporuje', vaha: 10, strop: 30 },
    nejednoznacna_citace:  { nazev: 'citace bez určení dokumentu (ve spisu s více dokumenty)', vaha: 3, strop: 9 },
    chybejici_fakt:        { nazev: 'chybí klíčový fakt odpovědi', vaha: 25, strop: 50 },
    vynechany_dokument:    { nazev: 'vynechaný klíčový dokument', vaha: 15, strop: 30 },
    mimo_spis:             { nazev: 'odpověď mimo spis (nepřiznal, že spis údaj neobsahuje)', vaha: 60, strop: 60, kriticka: true },
    past:                  { nazev: 'záměna se zavádějící hodnotou (past)', vaha: 30, strop: 30 },
    nepriznany_rozpor:     { nazev: 'rozpor mezi dokumenty nenalezen', vaha: 30, strop: 60 },
    vymysleny_rozpor:      { nazev: 'vymyšlený rozpor (jen s --judge)', vaha: 15, strop: 30 },
    chybna_lhuta:          { nazev: 'chybná lhůta / datum / výpočet', vaha: 50, strop: 50, kriticka: true },
    unik_udaju:            { nazev: 'únik osobních údajů do dopisu protistraně', vaha: 50, strop: 50, kriticka: true },
    vymysleny_paragraf:    { nazev: 'neexistující § (mimo rozsah zákona)', vaha: 20, strop: 40 },
    bez_opory:             { nazev: 'doporučení bez právní opory', vaha: 5, strop: 20 },
    neuplne_shrnuti:       { nazev: 'neúplné shrnutí / kontrola (chybí klíčový bod)', vaha: 40, strop: 40 },
    chyba_behu:            { nazev: 'chyba běhu (odepřeno, timeout, prázdná odpověď)', vaha: 100, strop: 100, kriticka: true }
};

// ---------------------------------------------------------------------------------------------------
// Spisy a kotvy
// ---------------------------------------------------------------------------------------------------
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
function _cislo(t) { const s = String(t || '').trim().toUpperCase(); return ROMAN[s] || parseInt(s, 10) || null; }

function rozeberDokument(text) {
    const kotvy = {};   // 'cl:4' | 'cl:4:1' | 'b:3' → text
    let cl = null;
    for (const radek of String(text).split(/\r?\n/)) {
        const r = radek.trim();
        let m;
        if ((m = r.match(/^Čl\.\s*([IVX]+|\d+)\b/))) { cl = _cislo(m[1]); kotvy['cl:' + cl] = r; continue; }
        if ((m = r.match(/^Bod\s+(\d+)\b/))) { kotvy['b:' + m[1]] = r; continue; }
        if (cl && (m = r.match(/^\((\d+)\)\s*(.*)$/))) { kotvy['cl:' + cl + ':' + m[1]] = r; kotvy['cl:' + cl] += '\n' + r; }
    }
    return kotvy;
}

function nactiSpisy(dir) {
    const out = {};
    for (const id of fs.readdirSync(dir).filter(d => fs.statSync(path.join(dir, d)).isDirectory()).sort()) {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8'));
        const docs = {};
        for (const [kod, d] of Object.entries(meta.dokumenty)) {
            const text = fs.readFileSync(path.join(dir, id, kod + '.txt'), 'utf8');
            docs[kod] = Object.assign({ kod, text, kotvy: rozeberDokument(text), aliasRe: d.aliasy.map(a => new RegExp(a, 'giu')) }, d);
        }
        out[id] = Object.assign({ id, docs }, meta);
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------
// Normalizace (částky, data, procenta)
// ---------------------------------------------------------------------------------------------------
const MESICE = { ledna: 1, února: 2, března: 3, dubna: 4, května: 5, června: 6, července: 7, srpna: 8, září: 9, října: 10, listopadu: 11, prosince: 12 };
function kanon(text) {
    let t = String(text || '').replace(/[   ]/g, ' ');
    t = t.replace(/\b(\d{1,2})\.\s*(ledna|února|března|dubna|května|června|července|srpna|září|října|listopadu|prosince)\s+(\d{4})/giu, (a, d, m, y) => `${+d}. ${MESICE[m.toLowerCase()]}. ${y}`);
    t = t.replace(/\b0?(\d{1,2})\.\s*0?(\d{1,2})\.\s*(\d{4})\b/g, (a, d, m, y) => `${+d}. ${+m}. ${y}`);
    // tisíce: „1.480.000“, „1480000“, „1 480 000“ → „1 480 000“ (ne u r. č., účtů a kódů se „/“ nebo „-“)
    const seskup = d => d.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    t = t.replace(/(?<![\d/-])\d{1,3}(?:[ .]\d{3})+(?![\d/-]|\.\d)/g, m => seskup(m.replace(/[ .]/g, '')));
    t = t.replace(/(?<![\d/.-])\d{5,}(?![\d/-])/g, m => seskup(m));
    t = t.replace(/(\d)\s*,-\s*Kč/g, '$1 Kč').replace(/(\d)\s*%/g, '$1 %');
    return t;
}
function najdi(re, text) { return new RegExp(re, 'iu').test(kanon(text)); }

// Hodnoty (částky v Kč, data, procenta) — pro kontrolu halucinací a podpory citací.
function hodnoty(text) {
    const t = kanon(text);
    const out = [];
    let m;
    const reKc = /(\d{1,3}(?: \d{3})+|\d{2,3})(?:,\d+)?\s*Kč/g;
    while ((m = reKc.exec(t))) out.push({ druh: 'kc', v: m[1].replace(/ /g, '') });
    const reD = /\b(\d{1,2})\. (\d{1,2})\. (\d{4})\b/g;
    while ((m = reD.exec(t))) out.push({ druh: 'datum', v: `${m[1]}.${m[2]}.${m[3]}` });
    const reKm = /(\d{1,3}(?: \d{3})+) km/g;
    while ((m = reKm.exec(t))) out.push({ druh: 'km', v: m[1].replace(/ /g, '') });
    const reP = /\b(\d+(?:,\d+)?) %/g;
    while ((m = reP.exec(t))) out.push({ druh: 'pct', v: m[1] });
    return out;
}

// ---------------------------------------------------------------------------------------------------
// Odpověď: oddělení doplňků programu, citace míst ve spisu
// ---------------------------------------------------------------------------------------------------
/** Text, který napsal model (bez doplňků a upozornění programu). */
function textModelu(odpoved) {
    let t = String(odpoved || '');
    const odd = t.search(/\n---\n\s*(?:🔎|⚠️|📅|⚖️|ℹ️)/u);   // oddělovač doplňků programu
    if (odd >= 0) t = t.slice(0, odd).replace(/\s+$/, '');
    const znacky = ['\n---\n⚠️ Automatická kontrola', '📅 Doplněno programem', '⚖️ Doplněno programem', '📅 Jen pro advokáta', '⚖️ Jen pro advokáta', '\n\n⚠️ KONTROLA ZDŮVODNĚNÍ'];
    let konec = t.length;
    for (const z of znacky) { const i = t.indexOf(z); if (i >= 0 && i < konec) konec = i; }
    return t.slice(0, konec);
}

const RE_CITACE = /(?:čl(?:\.|ánk\w*|ánek)\s*([IVX]+|\d+)(?:\s*,?\s*odst\.\s*(\d+))?|odst\.\s*(\d+)\s*čl\.\s*([IVX]+|\d+)|bod(?:u|ě|em|y)?\s+(\d+)(?:\s*(?:a|,)\s*(\d+))?)/giu;
const GENERICKE = /(rozsud\w*|usnesen\w*|reklamac\w*|objednáv\w*|dodatk\w* č\. ?[2-9]|plná moc|plné moci|smlouv\w* o půjčce|nájemní\w* smlouv\w*|kupní\w* smlouv\w*|smlouv\w* o dílo|protokol\w*|faktur\w*|posud\w*|žalob\w*|výpově\w*|vyjádření|výpis\w*|e-mail\w*)/giu;

function citace(odpoved, spis, docsPripadu) {
    const t = textModelu(odpoved);
    const out = [];
    const radky = t.split(/\r?\n/);
    let posun = 0;
    for (const radek of radky) {
        RE_CITACE.lastIndex = 0;
        let m, predchoziKonec = 0;
        while ((m = RE_CITACE.exec(radek))) {
            // „§ 3 odst. 5“ / „čl. 3 odst. 5 zákona“ není citace spisu
            const pred = radek.slice(Math.max(0, m.index - 4), m.index);
            const za = radek.slice(m.index + m[0].length, m.index + m[0].length + 18);
            if (/§\s*$/.test(pred) || /^\s*(zákona|zák\.|Listiny|Úmluvy|nařízení|směrnice|o\. ?s\. ?ř|OZ\b)/i.test(za)) continue;
            const bod = m[5] ? +m[5] : null;
            const cl = m[1] ? _cislo(m[1]) : (m[4] ? _cislo(m[4]) : null);
            const odst = m[2] ? +m[2] : (m[3] ? +m[3] : null);
            let zac = predchoziKonec;
            const usek = radek.slice(predchoziKonec, m.index);
            const re = /(?:(?<!\b(?:č|odst|čl|zák|písm|tzv|např|resp|nar|r|o|s|ř|Sb|Kč|ul|str|tj))\.\s+(?=[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ])|\s\d+\)\s+|^\s*[-•*]\s+)/gu;
            let x; while ((x = re.exec(usek))) zac = predchoziKonec + x.index + x[0].length;
            const tvrzeni = radek.slice(zac, m.index + m[0].length);
            const okno = radek.slice(Math.max(0, m.index - 90), Math.min(radek.length, m.index + m[0].length + 40));
            const stred = Math.min(90, m.index);
            let urc = _urciDokument(okno, stred, spis, docsPripadu);
            const predchozi = out.length && out[out.length - 1].radek === posun ? out[out.length - 1] : null;
            if (!urc.doc && !urc.ciziDokument && predchozi && predchozi.doc) urc = { doc: predchozi.doc, pokracovani: true };   // „(čl. 3 odst. 1), zálohy … (čl. 3 odst. 2)“
            out.push(Object.assign({ raw: m[0], cl, odst, bod, tvrzeni, pozice: posun + m.index, radek: posun }, urc));
            predchoziKonec = m.index + m[0].length;
        }
        posun += radek.length + 1;
    }
    return out;
}

// Dokument citace: nejbližší zmínka dokumentu PŘED citací (nepřekročí „;“ ani „)“ předchozí citace),
// jinak hned ZA citací („čl. 6 odst. 1 smlouvy“), jinak jediný dokument úlohy. „Dodatek ke smlouvě“,
// „odstoupení od smlouvy“ — zmínka po „ke/k/od“ se nepočítá. Typ dokumentu, který ve spisu není
// („rozsudek, bod 2“), těsně před citací = citace na neexistující dokument.
function _urciDokument(okno, stred, spis, docsPripadu) {
    const docs = docsPripadu && docsPripadu.length ? docsPripadu : Object.keys(spis.docs);
    const pred = okno.slice(0, stred);
    const hranice = Math.max(pred.lastIndexOf(';'), pred.lastIndexOf(')'));
    const predSeg = pred.slice(hranice + 1);
    const posunSeg = hranice + 1;
    const za = okno.slice(stred).replace(new RegExp(RE_CITACE.source, "giu"), m => ' '.repeat(m.length)).slice(0, 40).split(/[;()]/)[0];
    let predNej = null, zaNej = null;
    const zkus = (re, kod, cizi) => {
        for (const [seg, pos, jePred] of [[predSeg, posunSeg, true], [za, stred, false]]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(seg))) {
                if (/smlouv/i.test(m[0]) && /(?:^|\s)(?:ke?|od)\s+(?:\S+\s+)?$/i.test(seg.slice(Math.max(0, m.index - 14), m.index))) continue;
                if (jePred) {
                    const konec = pos + m.index + m[0].length;
                    if (cizi && !/^[\s,(]*$/.test(okno.slice(konec, stred))) continue;   // cizí dokument jen těsně před citací
                    if (!predNej || konec > predNej.konec) predNej = { doc: kod, cizi, slovo: m[0], konec };
                } else if (!cizi && (!zaNej || m.index < zaNej.i) && m.index <= 30) zaNej = { doc: kod, i: m.index };
            }
        }
    };
    for (const kod of docs) for (const re of spis.docs[kod].aliasRe) zkus(re, kod, false);
    const genericke = new RegExp(GENERICKE.source, 'giu');
    const znamy = slovo => docs.some(k => spis.docs[k].aliasRe.some(re => { re.lastIndex = 0; return re.test(slovo); }));
    {
        genericke.lastIndex = 0; let g;
        while ((g = genericke.exec(predSeg))) {
            if (znamy(g[0]) && !/dodatk\w* č\. ?[2-9]/iu.test(g[0])) continue;
            const konec = posunSeg + g.index + g[0].length;
            if (!/^[\s,(]*$/.test(okno.slice(konec, stred))) continue;
            if (!predNej || konec > predNej.konec) predNej = { doc: null, cizi: true, slovo: g[0], konec };
        }
    }
    if (predNej) return predNej.cizi ? { doc: null, ciziDokument: predNej.slovo } : { doc: predNej.doc };
    if (zaNej) return { doc: zaNej.doc };
    if (docs.length === 1) return { doc: docs[0], implicitni: true };
    return { doc: null };
}

function _kotva(c) { return c.bod != null ? 'b:' + c.bod : (c.odst != null ? `cl:${c.cl}:${c.odst}` : `cl:${c.cl}`); }

function _kmeny(text) {
    return new Set((String(text).toLowerCase().match(/[a-záčďéěíňóřšťúůýž]{5,}/gu) || []).map(w => w.slice(0, 5)));
}
const STOP = new Set(['smlou', 'člán', 'odsta', 'dokum', 'proto', 'podle', 'uvádí', 'který', 'která', 'které', 'tohot', 'tento', 'jsou', 'pouze']);

/** Hodnocení jedné citace: platna (místo existuje) a podpora: 'ano' | 'ne' | 'nejiste'. */
function hodnotCitaci(c, spis) {
    if (c.ciziDokument) return Object.assign(c, { platna: false, duvod: 'dokument ve spisu není: ' + c.ciziDokument, podpora: 'ne' });
    if (!c.doc) return Object.assign(c, { platna: null, nejednoznacna: true, podpora: 'nejiste' });
    const d = spis.docs[c.doc];
    const k = _kotva(c);
    let text = d.kotvy[k];
    if (!text && c.odst != null && d.kotvy['cl:' + c.cl]) text = null; // odstavec neexistuje
    if (!text) return Object.assign(c, { platna: false, kotva: c.doc + ':' + k, duvod: `${d.nazev}: ${k} neexistuje`, podpora: 'ne' });
    c.platna = true; c.kotva = c.doc + ':' + k; c.textKotvy = text;
    // Podpora: hodnoty z tvrzení (bez čísel samotné citace) musí být v citovaném místě.
    const tvrzeni = c.tvrzeni.replace(RE_CITACE, ' ').replace(/č\.\s*[A-Z0-9-/]+/g, ' ');
    const vSpisu = new Set(hodnoty(Object.values(spis.docs).map(x => x.text).join('\n')).map(h => h.druh + ':' + h.v));
    const hv = hodnoty(tvrzeni).filter(h => vSpisu.has(h.druh + ':' + h.v));
    const kt = kanon(text);
    const hk = new Set(hodnoty(kt).map(h => h.druh + ':' + h.v));
    if (hv.length) {
        const mam = hv.filter(h => hk.has(h.druh + ':' + h.v)).length;
        c.podpora = mam / hv.length >= 0.5 ? 'ano' : 'ne';
        if (c.podpora === 'ne') c.duvod = 'hodnoty z tvrzení v citovaném místě nejsou';
        return c;
    }
    const a = [..._kmeny(tvrzeni)].filter(w => !STOP.has(w));
    const b = _kmeny(text);
    const spol = a.filter(w => b.has(w)).length;
    c.podpora = (spol >= 2 || (a.length && spol / a.length >= 0.3)) ? 'ano' : (spol === 0 && a.length >= 3 ? 'ne' : 'nejiste');
    return c;
}

// ---------------------------------------------------------------------------------------------------
// Povolené odvozené hodnoty (výpočty z čísel spisu) — aby výpočet nebyl „halucinace“
// ---------------------------------------------------------------------------------------------------
function _pracovni(dt) { const x = new Date(dt); while (x.getUTCDay() === 0 || x.getUTCDay() === 6) x.setUTCDate(x.getUTCDate() + 1); return x; }
function _fmt(dt) { return `${dt.getUTCDate()}.${dt.getUTCMonth() + 1}.${dt.getUTCFullYear()}`; }
function odvozene(korpus) {
    const hv = hodnoty(korpus);
    const kc = [...new Set(hv.filter(h => h.druh === 'kc').map(h => +h.v))];
    const pct = [...new Set(hv.filter(h => h.druh === 'pct').map(h => parseFloat(h.v.replace(',', '.'))))];
    const ok = new Set();
    for (const a of kc) {
        for (const b of kc) { ok.add('kc:' + (a + b)); ok.add('kc:' + Math.abs(a - b)); }
        for (const p of pct) { const v = Math.round(a * p / 100); ok.add('kc:' + v); for (let n = 1; n <= 120; n++) ok.add('kc:' + v * n); }
        for (let n = 2; n <= 3; n++) ok.add('kc:' + a * n);
    }
    const dny = [...new Set([7, 10, 14, 15, 30].concat((kanon(korpus).match(/(\d+) dn/g) || []).map(s => parseInt(s, 10))))];
    const mesice = [...new Set([3, 24].concat((kanon(korpus).match(/(\d+) měsíc/g) || []).map(s => parseInt(s, 10))))];
    for (const h of hv.filter(x => x.druh === 'datum')) {
        const [d, m, y] = h.v.split('.').map(Number);
        const base = Date.UTC(y, m - 1, d);
        for (const n of [-1, 0, 1]) ok.add('datum:' + _fmt(new Date(base + n * 864e5)));
        for (const n of dny) { ok.add('datum:' + _fmt(new Date(base + n * 864e5))); ok.add('datum:' + _fmt(_pracovni(base + n * 864e5))); }
        for (const n of mesice) {
            ok.add('datum:' + _fmt(new Date(Date.UTC(y, m - 1 + n, d))));
            ok.add('datum:' + _fmt(new Date(Date.UTC(y, m + n, 0))));      // konec měsíce
            ok.add('datum:' + _fmt(new Date(Date.UTC(y, m, 1))));          // 1. den následujícího měsíce
        }
    }
    return ok;
}

// ---------------------------------------------------------------------------------------------------
// § mimo rozsah zákona
// ---------------------------------------------------------------------------------------------------
const ALIAS_ZAKONA = { '89/2012': 'OZ|NOZ|obč\\.\\s?zák|občansk\\S*\\s+zákoník', '99/1963': 'o\\.\\s?s\\.\\s?ř|OSŘ|občansk\\S*\\s+soudn', '216/1994': 'rozhodčím', '262/2006': 'ZP\\b|zákoník\\S*\\s+práce', '90/2012': 'ZOK' };
const MAX_PAR = { '89/2012': 3081, '99/1963': 376, '216/1994': 50, '90/2012': 786, '262/2006': 396, '634/1992': 26, '40/2009': 421, '141/1961': 471, '292/2013': 503, '500/2004': 184 };
function vymysleneParagrafy(text) {
    let ex = [];
    try { ex = require('../../lib/citation_verifier').extractCitations(text); } catch (e) { ex = []; }
    return ex.filter(c => c.type === 'paragraf' && c.law && MAX_PAR[c.law] && parseInt(c.paragraph, 10) > MAX_PAR[c.law] &&
            new RegExp('§\\s*' + c.paragraph + '\\b[^§]{0,40}?(?:' + c.law.replace('/', '\\/') + (ALIAS_ZAKONA[c.law] ? '|' + ALIAS_ZAKONA[c.law] : '') + ')').test(text))
        .map(c => `§ ${c.paragraph} (zák. č. ${c.law} Sb. má jen ${MAX_PAR[c.law]} §)`);
}

const RE_NEDOSTATEK = /nedostatek podklad|(?:spis|podklady|dokumenty|posudek|smlouva)[^.]{0,40}(?:neobsahuj|neuvád|nezmiňuj|nejsou|není)|(?:není|nejsou|chybí)[^.]{0,30}(?:ve spisu|v podkladech|v dokumentech|uveden)|nelze (?:z podkladů|ze spisu|z dokumentů)?\s*(?:určit|zjistit)|ve spisu (?:není|nenacház|chybí)|nemám (?:k dispozici|informac)/iu;
const RE_ROZPOR = /rozpor|nesoulad|neshod|liší|odlišn|neodpovídá|nesedí|protiřeč|v rozporu|kdežto|zatímco|ale |avšak/iu;

// ---------------------------------------------------------------------------------------------------
// Vyhodnocení jednoho případu
// ---------------------------------------------------------------------------------------------------
function vyhodnot(pripad, odpoved, spisy, opts) {
    const o = opts || {};
    const spis = spisy[pripad.spis];
    const docsPripadu = pripad.docs || Object.keys(spis.docs);
    const plna = String(odpoved || '');
    const model = textModelu(plna);
    const chyby = [];
    const chyba = (typ, detail) => chyby.push({ typ, detail: String(detail || '').slice(0, 200) });

    if (!model.trim() || o.chyba) {
        chyba('chyba_behu', o.chyba || 'prázdná odpověď');
        return _skore(pripad, chyby, { celkem: 0, platne: 0, podporujici: 0, nejiste: 0, polozky: [] });
    }

    // Citace míst ve spisu
    const cits = citace(model, spis, docsPripadu).map(c => hodnotCitaci(c, spis));
    for (const c of cits) {
        if (c.nejednoznacna) chyba('nejednoznacna_citace', c.raw);
        else if (c.platna === false) chyba('neexistujici_misto', c.duvod || c.raw);
        else if (c.podpora === 'ne') chyba('citace_nepodporuje', `${c.kotva}: „${c.tvrzeni.trim().slice(-120)}“`);
    }

    // Klíčová fakta + správnost citace u faktu
    const chybiFakt = [];
    for (const f of pripad.fakta || []) {
        if (!najdi(f.re, model)) { chybiFakt.push(f.re); chyba('chybejici_fakt', f.re); continue; }
        const re = new RegExp(f.re, 'iu');
        const kFaktu = cits.filter(c => c.platna && re.test(kanon(c.tvrzeni)));
        if (kFaktu.length && !kFaktu.some(c => re.test(kanon(c.textKotvy || '')))) chyba('chybna_citace', `${f.re} → ${kFaktu.map(c => c.kotva).join(', ')} (správně ${f.anchor})`);
    }

    // Klíčové dokumenty
    for (const kod of pripad.klicove_dokumenty || []) {
        const d = spis.docs[kod];
        if (!d) continue;
        if (pripad.docs && pripad.docs.length === 1) continue;   // jediný dokument v kontextu je implicitní
        if (pripad.typ === 'dopis') continue;                     // dopis protistraně zdroje nejmenuje
        if (!d.aliasRe.some(re => { re.lastIndex = 0; return re.test(model); })) chyba('vynechany_dokument', d.nazev);
    }

    // Mimo spis (negativní případy)
    if (pripad.odpovedetelne === false) {
        if (!RE_NEDOSTATEK.test(model)) chyba('mimo_spis', 'nepřiznal, že spis údaj neobsahuje');
        for (const p of pripad.pasti || []) if (najdi(p, model)) chyba('mimo_spis', 'uvádí údaj, který ve spisu není: ' + p);
    } else {
        // Pasti: zavádějící hodnota uvedena, a zároveň chybí správná
        const chybiNeco = chybiFakt.length || (pripad.lhuta || []).some(l => !najdi(l, plna));
        for (const p of pripad.pasti || []) if (najdi(p, model) && chybiNeco) chyba('past', p);
    }

    // Rozpory
    for (const r of pripad.rozpory || []) {
        if (!(najdi(r.a, model) && najdi(r.b, model) && RE_ROZPOR.test(model))) chyba('nepriznany_rozpor', `${r.a} × ${r.b}`);
    }

    // Lhůty a výpočty (celá odpověď — doplněk programu se počítá, je to výstup aplikace)
    for (const l of pripad.lhuta || []) if (!najdi(l, plna)) chyba('chybna_lhuta', 'chybí ' + l);

    // Únik osobních údajů (dopis protistraně)
    for (const u of pripad.unik || []) if (new RegExp(u, 'iu').test(plna) || new RegExp(u, 'iu').test(plna.replace(/\s/g, ''))) chyba('unik_udaju', u);

    // Shrnutí / kontrola: klíčové body
    if ((pripad.body || []).length) {
        const chybi = pripad.body.filter(b => !najdi(b, model));
        if (chybi.length) chyba('neuplne_shrnuti', `chybí ${chybi.length}/${pripad.body.length}: ${chybi.join(', ')}`);
    }

    // Halucinace: částky, data, % mimo spis a mimo povolené výpočty
    const korpus = docsPripadu.map(k => spis.docs[k].text).join('\n') + '\n' + Object.values(spis.docs).map(d => d.text).join('\n') + '\n' + pripad.prompt;
    const vKorpusu = new Set(hodnoty(korpus).map(h => h.druh + ':' + h.v));
    const povolene = odvozene(korpus);
    for (const h of hodnoty(model)) {
        const k = h.druh + ':' + h.v;
        if (vKorpusu.has(k) || povolene.has(k)) continue;
        if (h.druh === 'pct' && ['50', '100'].includes(h.v)) continue;
        chyba('halucinace', `${h.druh === 'kc' ? h.v + ' Kč' : h.druh === 'pct' ? h.v + ' %' : h.v}`);
    }
    const osoby = (model.match(/\b(?:Mgr|Ing|JUDr|MUDr|PhDr|Bc|doc|prof)\.\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+/gu) || []);
    for (const os of osoby) {
        const prijmeni = os.split(/\s+/).pop().slice(0, 5);
        if (!korpus.includes(prijmeni)) chyba('halucinace', 'osoba ' + os);
    }

    // Neexistující §
    for (const p of vymysleneParagrafy(model)) chyba('vymysleny_paragraf', p);

    // Doporučení bez opory (právní úlohy)
    if (['kontrola_smlouvy', 'reserse', 'citace'].includes(pripad.typ)) {
        try {
            const k = require('../../lib/legal_basis').kontrolaOpory(model);
            for (const b of k.bezOpory.slice(0, 4)) chyba('bez_opory', b);
        } catch (e) { /* bez modulu */ }
    }

    const metrika = {
        celkem: cits.length,
        platne: cits.filter(c => c.platna === true).length,
        podporujici: cits.filter(c => c.platna === true && c.podpora === 'ano').length,
        nejiste: cits.filter(c => c.podpora === 'nejiste').length,
        polozky: cits.map(c => ({ raw: c.raw, tvrzeni: String(c.tvrzeni || '').trim().slice(0, 300), doc: c.doc, kotva: c.kotva || null, platna: c.platna, podpora: c.podpora, duvod: c.duvod || null }))
    };
    return _skore(pripad, chyby, metrika);
}

function _skore(pripad, chyby, citaceMetrika) {
    const poTypu = {};
    for (const ch of chyby) poTypu[ch.typ] = (poTypu[ch.typ] || 0) + 1;
    let srazka = 0;
    for (const [typ, n] of Object.entries(poTypu)) {
        const k = KATALOG[typ];
        if (!k) continue;
        if (typ === 'neuplne_shrnuti') {
            const ch = chyby.find(c => c.typ === typ);
            const m = /chybí (\d+)\/(\d+)/.exec(ch.detail);
            srazka += m ? Math.round(k.vaha * (+m[1] / +m[2])) : k.vaha;
        } else srazka += Math.min(k.strop, k.vaha * n);
    }
    const skore = Math.max(0, 100 - srazka);
    const kriticka = chyby.some(c => KATALOG[c.typ] && KATALOG[c.typ].kriticka);
    return { id: pripad.id, typ: pripad.typ, skore, prosel: skore >= 80 && !kriticka, chyby, citace: citaceMetrika };
}

module.exports = { KATALOG, nactiSpisy, rozeberDokument, kanon, hodnoty, textModelu, citace, hodnotCitaci, odvozene, vymysleneParagrafy, vyhodnot };
