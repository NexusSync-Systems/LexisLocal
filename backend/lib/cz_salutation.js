/**
 * lib/cz_salutation.js — oslovení v dopisech počítá program, ne model.
 *
 * Model vidí místo jmen pseudonymy ([OSOBA_1]), takže nezná rod adresáta. Serverový test
 * 3. 10. 2026 (W1) skončil větou „Vážená Ing. Tomáš Horák!“. Rod, titul a 5. pád se dají
 * určit pravidly. Kde si program jistý není, použije bezpečné „Vážený pane,“ / „Vážená paní,“.
 *
 *   parsePersonName('Ing. Tomáš Horák') → { titles:['Ing.'], first:'Tomáš', surname:'Horák' }
 *   salutation({ name:'Ing. Tomáš Horák' }) → 'Vážený pane inženýre,'
 *   salutation({ name:'Eva Novotná' })      → 'Vážená paní Novotná,'
 *   fixSalutations(text, { addressee })     → { text, fixed:[{from,to}] }
 */
'use strict';

// Titul → [mužský 5. pád, ženský 5. pád, pořadí (vyšší = přednost)]
const TITLES = [
    [/^prof\.?$/i, 'profesore', 'profesorko', 50],
    [/^doc\.?$/i, 'docente', 'docentko', 40],
    [/^(JUDr|MUDr|MVDr|PhDr|RNDr|PaedDr|ThDr|PharmDr|RSDr|ICDr|Dr|Ph\.?D|CSc|DrSc|MDDr)\.?$/i, 'doktore', 'doktorko', 30],
    [/^Ing\.?$/i, 'inženýre', 'inženýrko', 20],
    [/^(Mgr|MgA)\.?$/i, 'magistře', 'magistro', 20],
    [/^(Bc|BcA|DiS|MBA|LL\.?M)\.?$/i, null, null, 0]
];
const TITLE_TOKEN = /^(prof|doc|JUDr|MUDr|MVDr|PhDr|RNDr|PaedDr|ThDr|PharmDr|RSDr|ICDr|Dr|Ph\.?D|CSc|DrSc|MDDr|Ing|arch|Mgr|MgA|Bc|BcA|DiS|MBA|LL\.?M)\.?,?$/i;

// Běžná mužská křestní jména končící na -a/-e (jinak -a/-e = žena).
const MALE_A = new Set(['nikola', 'saša', 'míša', 'jirka', 'honza', 'kuba', 'luka', 'ilja', 'jožka', 'joshua', 'andrea']);

function parsePersonName(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const tokens = s.split(' ');
    const titles = []; const words = [];
    for (const t of tokens) {
        if (TITLE_TOKEN.test(t)) titles.push(t.replace(/,$/, ''));
        else if (/^(pan|paní|pane|slečna)$/i.test(t)) continue;
        else words.push(t.replace(/[,;:]$/, ''));
    }
    const names = words.filter(w => /^\p{Lu}[\p{L}'’-]+$/u.test(w));
    if (!names.length) return { titles, first: null, surname: null };
    return { titles, first: names.length > 1 ? names[0] : null, surname: names[names.length - 1] };
}

function genderOf(p, hint) {
    if (hint === 'F' || hint === 'M') return hint;
    if (!p) return null;
    const sur = String(p.surname || '').toLowerCase();
    const first = String(p.first || '').toLowerCase();
    if (/á$/.test(sur)) return 'F';
    if (/[ýí]$/.test(sur)) return 'M';
    if (first) {
        if (MALE_A.has(first)) return 'M';
        if (/[ae]$/.test(first)) return 'F';
        return 'M';
    }
    // Jen příjmení: -a (Svoboda) je v češtině mužské, ženské by bylo -ová.
    if (sur) return 'M';
    return null;
}

/** 5. pád mužského příjmení; null = nejisté (použije se oslovení bez jména). */
function vocativeSurname(surname) {
    const s = String(surname || '');
    if (!s) return null;
    const low = s.toLowerCase();
    if (/[ýíoeuiy]$/.test(low)) return s;                    // Novotný, Krejčí, Hugo, Tichý
    if (/[^aeiouyáéíóúůý]a$/.test(low)) return s.slice(0, -1) + 'o'; // Svoboda → Svobodo
    if (/[nN]ěk$/.test(s)) return s.slice(0, -3) + 'ňku';    // Vaněk → Vaňku
    if (/[dD]ěk$/.test(s)) return s.slice(0, -3) + 'ďku';
    if (/[tT]ěk$/.test(s)) return s.slice(0, -3) + 'ťku';
    if (/[^aeiouyáéíóúůý]ek$/.test(low)) return s.slice(0, -2) + 'ku'; // Marek → Marku, Hájek → Hájku
    if (/(ec|el|eň)$/.test(low)) return null;                // Němec, Havel, Kameň — nepravidelné
    if (/(k|h|g|ch)$/.test(low)) return s + 'u';             // Horák → Horáku
    if (/[šžčřcjťďňxsz]$/.test(low)) return s + 'i';         // Beneš → Beneši, Kovář → Kováři
    if (/[^aeiouyáéíóúůý]r$/.test(low)) return s.slice(0, -1) + 'ře'; // Petr → Petře
    if (/[bdfmnptvwlr]$/.test(low)) return s + 'e';          // Kubát → Kubáte, Král → Krále
    return null;
}

function _topTitle(titles, g) {
    let best = null;
    for (const t of titles || []) {
        const row = TITLES.find(r => r[0].test(t));
        if (row && row[1] && (!best || row[3] > best[3])) best = row;
    }
    return best ? (g === 'F' ? best[2] : best[1]) : null;
}

/**
 * Oslovení jedné osoby. person = { name, gender? } nebo řetězec se jménem.
 * Vrací např. „Vážený pane inženýre,“. Bez jména → null.
 */
function salutation(person) {
    const name = typeof person === 'string' ? person : person && person.name;
    const p = parsePersonName(name);
    if (!p || (!p.surname && !(p.titles || []).length)) return null;
    const g = genderOf(p, person && person.gender);
    if (!g) return null;
    const head = g === 'F' ? 'Vážená paní' : 'Vážený pane';
    const title = _topTitle(p.titles, g);
    if (title) return `${head} ${title},`;
    if (g === 'F') return p.surname ? `${head} ${p.surname},` : `${head},`;
    const voc = vocativeSurname(p.surname);
    return voc ? `${head} ${voc},` : `${head},`;
}

// Řádek s oslovením: „Vážený pane Horáku,“ „Vážená Ing. Tomáš Horák!“ „Oslovení: …“
const RE_SAL = /^([ \t]*)(?:\*\*)?(?:Oslovení:\s*)?(Vážen[ýáéí][^\n,!]{0,80})([,!]?)(?:\*\*)?[ \t]*$/gmu;
const RE_SAL_FIELD = /^([ \t]*)(?:\*\*)?Oslovení:(?:\*\*)?[ \t]*([^\n]*)$/gmu;
const _NOT_NAME = /^(pane|paní|pan|slečno|kolego|kolegyně|kolegové|dámy|pánové|a|zástupce|zástupkyně|společnosti?|advokáte?|soude?|soudce)$/i;

function _nameIn(fragment) {
    const words = String(fragment || '').replace(/^Vážen\S*\s*/i, '').split(/\s+/).filter(Boolean);
    const kept = words.filter(w => TITLE_TOKEN.test(w) || (/^\p{Lu}/u.test(w) && !_NOT_NAME.test(w)));
    return kept.length ? kept.join(' ') : null;
}

/**
 * Opraví oslovení v textu. opts.addressee = jméno adresáta (z podkladů), použije se,
 * když oslovení jméno neobsahuje nebo obsahuje jen pseudonym. Plurál („Vážení,“) a
 * oslovení soudu/společnosti nechá být.
 */
function fixSalutations(text, opts = {}) {
    const fixed = [];
    let t = String(text || '');
    if (!opts.addressee) {
        // Adresát z hlavičky dopisu („Adresát: Ing. Tomáš Horák“ nebo na dalším řádku).
        const m = t.match(/^[ \t*]*Adresát(?:ka)?[^:\n]{0,20}:[ \t*]*(?:\n[ \t]*)?([^\n,]{3,80})/mu);
        const nm = m && m[1].replace(/\*+/g, '').trim();
        if (nm && !/^\[/.test(nm) && parsePersonName(nm) && parsePersonName(nm).surname) opts = Object.assign({}, opts, { addressee: nm });
    }
    const pick = (fragment) => {
        if (/^Vážení(?!\p{L})/iu.test(fragment) || /soud|společnost|firm|zástup/i.test(fragment)) return null;
        const inLine = _nameIn(fragment);
        const p = inLine && parsePersonName(inLine);
        const usable = p && (p.surname || p.titles.length) && !/^\[/.test(inLine);
        const who = usable ? inLine : opts.addressee;
        if (!who) return null;
        // Bez jména v oslovení: jen hlídáme rod („Vážená pane“ apod.).
        const want = salutation({ name: who, gender: opts.gender });
        if (!want) return null;
        if (!usable) {
            const g = genderOf(parsePersonName(who), opts.gender);
            const isF = /^Vážená(?!\p{L})/iu.test(fragment) || /(?<!\p{L})paní(?!\p{L})/iu.test(fragment);
            const isM = /^Vážený(?!\p{L})/iu.test(fragment) || /(?<!\p{L})pane(?!\p{L})/iu.test(fragment);
            if ((g === 'F' && isF && !isM) || (g === 'M' && isM && !isF)) return null;
        }
        return want;
    };
    t = t.replace(RE_SAL_FIELD, (all, ind, rest) => {
        const want = pick('Vážený ' + rest) || salutation({ name: opts.addressee, gender: opts.gender });
        if (!want) return all;
        fixed.push({ from: all.trim(), to: want });
        return ind + want;
    });
    t = t.replace(RE_SAL, (all, ind, frag) => {
        const want = pick(frag.trim());
        if (!want) return all;
        const cur = (frag.trim() + ',').replace(/\s+/g, ' ');
        if (cur === want) return all;
        fixed.push({ from: all.trim(), to: want });
        return ind + want;
    });
    return { text: t, fixed };
}

module.exports = { parsePersonName, genderOf, vocativeSurname, salutation, fixSalutations };
