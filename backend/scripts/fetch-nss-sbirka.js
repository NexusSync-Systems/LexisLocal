#!/usr/bin/env node
/**
 * fetch-nss-sbirka.js — stáhne rozhodnutí ze SBÍRKY ROZHODNUTÍ NEJVYŠŠÍHO SPRÁVNÍHO SOUDU
 * (sbirka.nssoud.cz) do znalostní báze.
 *
 * Proč: správní soudnictví (daně, cla, stavební a územní řízení, sociální věci, přestupky,
 * azyl…) v bázi chybělo — open data MSp (fetch-judikatura.js) NSS nemají a Sbírka NS
 * je jen civilní a trestní. Sbírka NSS = rozhodnutí vybraná plénem s PRÁVNÍ VĚTOU,
 * od roku 2003 (~4 800), vč. rozhodnutí krajských soudů ve správním soudnictví
 * a zvláštního senátu. Elektronická Sbírka je podle NSS zdarma; rozhodnutí jsou
 * úřední dílo (§ 3 AZ). robots.txt sekci /cz/ nezakazuje; přesto slušně: jeden
 * požadavek najednou, výchozí pauza 2 s, už stažené přeskočí (navazuje).
 *
 * Postup: /cz/archiv → stránky čísel (/cz/2026-9, /cz/2015-7-8 …) → seznam rozhodnutí
 * s metadaty (datum, sbírkové č., sp. zn., typ, autor, vydání, strana, předpisy) →
 * stránka rozhodnutí (/cz/<slug>.p<id>.html) → právní věta + plný text.
 *
 * Příklady:
 *   node backend/scripts/fetch-nss-sbirka.js --probe
 *   node backend/scripts/fetch-nss-sbirka.js --out ./judikatura-nss
 *   node backend/scripts/fetch-nss-sbirka.js --out ./judikatura-nss --od-roku 2020 --limit 50
 * Pak: node backend/scripts/seed-kb.js --agent resersnik --dir ./judikatura-nss --token-file ~/.lexislocal/api_token
 *
 * Přepínače: --od-roku RRRR  --do-roku RRRR  --limit N  --delay ms (min. 1000)
 * Bez závislostí — Node ≥ 18 (záloha přes systémový curl jako u fetch-ns-sbirka.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://sbirka.nssoud.cz';
const UA = { 'User-Agent': 'LexisLocal-nss-fetch/1.0 (+https://nexusstack.eu)' };

function parseArgs(argv) {
    const a = { out: './judikatura-nss', delay: 2000, limit: 0 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], next = () => argv[++i];
        if (k === '--out') a.out = next();
        else if (k === '--od-roku') a.odRoku = parseInt(next(), 10) || 0;
        else if (k === '--do-roku') a.doRoku = parseInt(next(), 10) || 0;
        else if (k === '--limit') a.limit = parseInt(next(), 10) || 0;
        else if (k === '--delay') a.delay = Math.max(1000, parseInt(next(), 10) || 2000);
        else if (k === '--probe') a.probe = true;
        else if (k === '--help' || k === '-h') a.help = true;
        else { console.error(`Neznámý argument: ${k}`); a.help = true; }
    }
    return a;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', bdquo: '„', ldquo: '“', rdquo: '”', sect: '§', hellip: '…', middot: '·' };
function htmlToText(h) {
    return String(h || '')
        .replace(/<\?[\s\S]*?\?>/g, '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        // Odkazové „linkla" jsou v textu jako <div> uprostřed věty — nesmí z nich být nový řádek.
        .replace(/<div[^>]*class="linkla"[^>]*>([\s\S]*?)<\/div>/gi, '$1')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h\d|td|th)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m))
        .replace(/[ \t ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Odkazy na čísla Sbírky z archivu: /cz/2003-1, /cz/2015-7-8 … (bez ročníků /cz/2015). */
function issueUrls(archivHtml) {
    const set = new Set();
    for (const m of String(archivHtml || '').matchAll(/href="(\/cz\/(\d{4})-\d+(?:-\d+)?)"/g)) set.add(m[1]);
    return [...set].sort((x, y) => {
        const p = s => s.replace('/cz/', '').split('-').map(n => parseInt(n, 10));
        const a = p(x), b = p(y);
        return a[0] - b[0] || a[1] - b[1];
    }).map(u => BASE + u);
}

const PROPS = {
    'Datum': 'datum', 'Sbírkové č.': 'cislo', 'Sp. zn.': 'spisZn', 'Typ': 'typ', 'Pramen': 'pramen',
    'Autor': 'autor', 'Vydání': 'vydani', 'Strana': 'strana', 'Vztah k předpisu': 'predpisy',
};

/** Stránka čísla Sbírky → seznam rozhodnutí s metadaty. */
function parseIssue(html) {
    const items = [];
    for (const m of String(html || '').matchAll(/<div class="list-item">([\s\S]*?)<\/p>/g)) {
        const block = m[1];
        const a = /<a\s+href="([^"]+\.p(\d+)\.html)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
        if (!a) continue;
        const d = { url: BASE + a[1], id: a[2], nadpis: htmlToText(a[3].replace(/<span class="num-tag">[\s\S]*?<\/span>/, '')).replace(/\s+/g, ' ').replace(/;\s*$/, '') };
        // Popisky („Sbírkové č.:") jsou v HTML odsazené tabulátory a odřádkované.
        for (const p of block.matchAll(/([A-ZÁ-Ža-zá-ž.][A-ZÁ-Ža-zá-ž. ]*?):\s*<span>([\s\S]*?)<\/span>/g)) {
            const key = PROPS[p[1].trim()];
            if (key) d[key] = htmlToText(p[2]);
        }
        items.push(d);
    }
    return items;
}

/** „7 A 130/2001 - 39" → „7 A 130/2001-39" (citační tvar). */
function formatSpZn(s) { return String(s || '').replace(/\s*-\s*(\d+)\s*$/, '-$1').replace(/\s+/g, ' ').trim(); }

/** Předpisy z výpisu: zákonná ustanovení a odkazy na judikaturu (JUD… Pl. ÚS 15/01) zvlášť. */
function splitPredpisy(s) {
    const parts = String(s || '').split(';').map(x => x.trim()).filter(Boolean);
    return {
        predpisy: parts.filter(p => !/^JUD\d+/.test(p)),
        judikatura: parts.filter(p => /^JUD\d+/.test(p)).map(p => p.replace(/^JUD\d+[A-Z]*\s*/, '')),
    };
}

/** Stránka rozhodnutí → { pravniVeta, text } (text = vše za právní větou). */
function parseDecision(html) {
    const h = String(html || '');
    const i = h.search(/<div\s+class="jud"/i);
    if (i < 0) return { pravniVeta: '', text: '' };
    let end = h.indexOf('<hr', i);
    if (end < 0) end = h.search(/<aside|<footer/i);
    const jud = h.slice(i, end > i ? end : undefined);
    const pv = [...jud.matchAll(/<div\s+class="pravni-veta"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|$)/gi)];
    let pravniVeta = '', rest = jud;
    if (pv.length) {
        pravniVeta = pv.map(m => htmlToText(m[1])).filter(Boolean).join('\n');
        const last = pv[pv.length - 1];
        rest = jud.slice(last.index + last[0].length);
    }
    const predpisyK = (/<div\s+class="predpisy"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(jud) || [])[1];
    return { pravniVeta, predpisyK: predpisyK ? htmlToText(predpisyK) : '', text: htmlToText(rest) };
}

function soudZAutora(autor) {
    const s = String(autor || '');
    if (/^Nejvyšší správní soud/i.test(s)) return 'Nejvyšší správní soud';
    return s.replace(/\s*-\s*.*$/, '') || 'Nejvyšší správní soud';
}

function header(d, dec) {
    const typ = String(d.typ || '').replace(/\s*\(.*\)\s*$/, '') || 'Rozhodnutí';
    const soud = soudZAutora(d.autor);
    const spz = formatSpZn(d.spisZn);
    const { predpisy, judikatura } = splitPredpisy(d.predpisy);
    const L = [];
    L.push(`${typ} – ${soud} ze dne ${d.datum || '?'}, sp. zn. ${spz} (Sb. NSS č. ${d.cislo || '?'})`);
    L.push('Soud: ' + soud);
    if (/rozšířený senát|zvláštní senát|plénum/i.test(d.autor || '')) L.push('Rozhodl: ' + String(d.autor).replace(/^[^-]+-\s*/, ''));
    L.push('Sp. zn.: ' + spz);
    if (d.datum) L.push('Datum vydání: ' + d.datum);
    L.push(`Sbírka rozhodnutí NSS: č. ${d.cislo || '?'}${d.vydani ? `, vydání ${d.vydani}` : ''}${d.strana ? `, s. ${d.strana}` : ''}`);
    L.push('Typ rozhodnutí: ' + typ);
    if (d.nadpis) L.push('Klíčová slova: ' + d.nadpis.replace(/;\s*/g, '; '));
    if (dec && dec.predpisyK) L.push('K ustanovení: ' + dec.predpisyK.replace(/\n+/g, ' '));
    if (predpisy.length) L.push('Zmíněná ustanovení: ' + predpisy.join('; '));
    if (judikatura.length) L.push('Související judikatura: ' + judikatura.join('; '));
    L.push('Zdroj: Sbírka rozhodnutí Nejvyššího správního soudu, ' + d.url);
    return L.join('\n') + '\n\n' + (dec && dec.pravniVeta ? 'Právní věta:\n' + dec.pravniVeta + '\n\n' : '');
}

function safeName(s) { return String(s || '').replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/\s+/g, '_').slice(0, 80) || 'rozhodnuti'; }
/** NSS_<č>_<rok>_<sp. zn.>.txt — prefix podle sbírkového čísla slouží k navazování. */
function fileNameFor(d) {
    const [c, r] = String(d.cislo || '').split('/');
    return `NSS_${c || d.id}_${r || 'x'}_${safeName(formatSpZn(d.spisZn))}.txt`;
}
function prefixFor(d) { const [c, r] = String(d.cislo || '').split('/'); return `NSS_${c || d.id}_${r || 'x'}_`; }

function yearOfIssue(url) { return parseInt((/\/cz\/(\d{4})-/.exec(url) || [])[1], 10) || 0; }

// Síť: Node fetch, při selhání systémový curl (stejně jako fetch-ns-sbirka.js). TLS se nikdy nevypíná.
let _useCurl = false;
function _cause(e) { const c = e && e.cause; return c ? `${c.code || ''} ${c.message || ''}`.trim() : (e && e.message) || String(e); }
function _curl(url) {
    const { execFileSync } = require('child_process');
    return execFileSync('curl', ['-sS', '-L', '--fail', '--max-time', '60', '-A', UA['User-Agent'], url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
async function getText(url) {
    if (_useCurl) return _curl(url);
    let res;
    try { res = await fetch(url, { headers: UA }); }
    catch (e) {
        const why = _cause(e);
        try { const t = _curl(url); _useCurl = true; console.log(`ℹ️  Node fetch selhal (${why}) — dál stahuji přes systémový curl.`); return t; }
        catch (e2) { throw new Error(`nelze stáhnout ${url}: ${why}; curl: ${String(e2.stderr || e2.message).trim().split('\n')[0]}`); }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.text();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    const a = parseArgs(process.argv);
    if (a.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    console.log('📚 Načítám archiv Sbírky NSS…');
    let issues = issueUrls(await getText(BASE + '/cz/archiv'));
    if (a.odRoku) issues = issues.filter(u => yearOfIssue(u) >= a.odRoku);
    if (a.doRoku) issues = issues.filter(u => yearOfIssue(u) <= a.doRoku);
    console.log(`   ${issues.length} čísel Sbírky`);

    if (a.probe) {
        const last = issues[issues.length - 1];
        const items = parseIssue(await getText(last));
        console.log(`Číslo ${last}: ${items.length} rozhodnutí`, JSON.stringify(items[0], null, 2));
        if (items[0]) {
            await sleep(a.delay);
            const dec = parseDecision(await getText(items[0].url));
            console.log(header(items[0], dec) + dec.text.slice(0, 400) + '…');
            console.log(dec.pravniVeta && dec.text.length > 500 ? '\n→ Parser sedí, můžeš stahovat (bez --probe).' : '\n⚠️  Něco chybí — pošli mi výpis.');
        }
        return;
    }

    fs.mkdirSync(a.out, { recursive: true });
    const done = new Set(fs.readdirSync(a.out).map(f => (/^(NSS_\d+_\d{4}_)/.exec(f) || [])[1]).filter(Boolean));
    let saved = 0, existing = 0, failed = 0;
    for (const issue of issues) {
        if (a.limit && saved >= a.limit) break;
        await sleep(a.delay);
        let items;
        try { items = parseIssue(await getText(issue)); }
        catch (e) { console.log(`  ⚠️ ${issue}: ${e.message}`); failed++; continue; }
        for (const d of items) {
            if (a.limit && saved >= a.limit) break;
            if (done.has(prefixFor(d))) { existing++; continue; }
            await sleep(a.delay);
            let dec;
            try { dec = parseDecision(await getText(d.url)); }
            catch (e) { console.log(`  ⚠️ ${d.cislo || d.url}: ${e.message}`); failed++; continue; }
            if (!dec.text || dec.text.length < 200) { console.log(`  ⚠️ ${d.cislo}: prázdný text (${d.url})`); failed++; continue; }
            fs.writeFileSync(path.join(a.out, fileNameFor(d)), header(d, dec) + dec.text + '\n');
            done.add(prefixFor(d));
            saved++;
            if (saved % 50 === 0) console.log(`  … ${saved} uloženo (${issue.replace(BASE + '/cz/', '')})`);
        }
    }
    console.log(`✅ Uloženo ${saved}, už staženo ${existing}, selhalo ${failed} → ${a.out}`);
    console.log(`   Další krok: node backend/scripts/seed-kb.js --agent resersnik --dir "${a.out}" --token-file ~/.lexislocal/api_token`);
}

if (require.main === module) main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });

module.exports = { issueUrls, parseIssue, parseDecision, header, htmlToText, formatSpZn, splitPredpisy, fileNameFor, prefixFor, soudZAutora };
