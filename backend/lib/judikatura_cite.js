'use strict';
/**
 * lib/judikatura_cite.js — citace rozhodnutí (soud + sp. zn.) z pasáží znalostní báze.
 *
 * Server 25. 10. 2026 (J1/J2): agent dostal rozhodnutí NS/ÚS v podkladech, ale model (7B)
 * spisovou značku do odpovědi neuvedl, nebo napsal jen název souboru. Advokát přitom
 * potřebuje vědět, o který judikát se odpověď opírá. Proto:
 *  • label(m)      — štítek pasáže pro model („Nejvyšší soud, sp. zn. 31 Cdo 2273/2022“),
 *  • section(ms, text) — deterministický seznam rozhodnutí z podkladů pod odpověď
 *                    (jen ta, jejichž sp. zn. odpověď sama neuvádí).
 * Sp. zn. se bere z hlavičky pasáže („Sp. zn.: …“), jinak z názvu souboru.
 */

const COURTS = { NS: 'Nejvyšší soud', US: 'Ústavní soud', NSS: 'Nejvyšší správní soud' };
const PREFIX = /^(NSS|NS|US)_/;

/** Sp. zn. z názvu souboru: NS_<id>_31_Cdo_2273_2022 · US_II._ÚS_3335_11_1 · NSS_4414_2023_8_As_29_2021-36. */
function spznFromFileName(fileName) {
    const base = String(fileName || '').split('/').pop().replace(/\.txt$/i, '');
    const m = PREFIX.exec(base);
    if (!m) return null;
    let t = base.slice(m[0].length).split('_').filter(Boolean);
    if (m[1] === 'NS') t = t.slice(1);                 // id ve Sbírce NS
    else if (m[1] === 'NSS') t = t.slice(2);           // číslo a rok ve Sbírce NSS
    else if (m[1] === 'US' && t.length > 3 && /^\d+$/.test(t[t.length - 1]) && t[t.length - 1].length <= 2) t = t.slice(0, -1); // pořadové číslo NALUS
    if (t.length < 3) return null;
    const year = t[t.length - 1], num = t[t.length - 2];
    const sen = t.slice(0, -2).join(' ').replace(/\bNSCR\b/, 'NSČR');
    return `${sen} ${num}/${year}`.replace(/\s+/g, ' ').trim();
}

/** { kind, court, spzn } nebo null (není to judikatura). */
function cite(m) {
    const fileName = (m && m.fileName) || '';
    const k = PREFIX.exec(String(fileName).split('/').pop());
    if (!k) return null;
    const head = /Sp\.\s*zn\.:\s*([^\n]+?)\s*(?:\n|$|Datum|ECLI|Soud:)/.exec(String((m && m.text) || ''));
    const spzn = (head && head[1].trim()) || spznFromFileName(fileName);
    if (!spzn) return null;
    return { kind: k[1], court: COURTS[k[1]], spzn };
}

function label(m) {
    const c = cite(m);
    return c ? `${c.court}, sp. zn. ${c.spzn}` : null;
}

const norm = s => String(s).toLowerCase().replace(/[\s.]+/g, '');

/** Seznam rozhodnutí z podkladů, která odpověď sama necituje (nebo '' když žádná). */
function section(matches, responseText) {
    const seen = new Set(), items = [];
    const resp = norm(responseText || '');
    for (const m of matches || []) {
        const c = cite(m);
        if (!c) continue;
        const key = c.kind + norm(c.spzn);
        if (seen.has(key)) continue;
        seen.add(key);
        if (resp.includes(norm(c.spzn))) continue;
        items.push(`- ${c.court}, sp. zn. ${c.spzn}`);
    }
    if (!items.length) return '';
    return 'Judikatura v podkladech (odpověď z ní vycházela; před použitím ověřte znění):\n' + items.join('\n');
}

module.exports = { spznFromFileName, cite, label, section };
