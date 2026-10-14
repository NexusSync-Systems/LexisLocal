#!/usr/bin/env node
/**
 * fetch-ns-sbirka.js — stáhne rozhodnutí a stanoviska ze SBÍRKY SOUDNÍCH ROZHODNUTÍ
 * A STANOVISEK Nejvyššího soudu (sbirka.nsoud.cz) do znalostní báze.
 *
 * Proč: open data MSp (fetch-judikatura.js) mají jen okresní/krajské/vrchní soudy.
 * Sbírka NS = publikovaná, sjednocující judikatura s PRÁVNÍ VĚTOU — pro rešerše nejcennější.
 * Úřední díla (§ 3 AZ). robots.txt sbírky nic nezakazuje; přesto slušně: výchozí pauza
 * 2 s, jeden požadavek najednou, navazování (už stažené přeskočí).
 *
 * Seznam rozhodnutí se bere ze sitemap (sitemap_index.xml → collection-sitemap*.xml,
 * adresy /sbirka/<id>/). Ze stránky se vytáhne tabulka „Právní věta / Soud / Datum
 * rozhodnutí / Spisová značka / Číslo rozhodnutí / Rok / Sešit / Typ rozhodnutí / Heslo /
 * Předpisy / Druh“ a sbírkový text. Výstup má hlavičku jako fetch-judikatura.js.
 *
 * Příklady:
 *   node backend/scripts/fetch-ns-sbirka.js --probe
 *   node backend/scripts/fetch-ns-sbirka.js --out "./judikatura/NS Sbírka" --limit 200
 *   node backend/scripts/fetch-ns-sbirka.js --out ./ns --od-roku 2015 --druh civilní --keyword nájem
 * Pak: node backend/scripts/seed-kb.js --obor "Občanské právo" --dir ./ns   (nebo --root)
 *
 * Přepínače: --limit N  --od-roku RRRR  --druh civilní|trestní  --keyword slovo (v hesle,
 *   předpisech, právní větě)  --delay ms  --by-druh (podsložky podle druhu)
 * Bez závislostí — Node ≥ 18.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://sbirka.nsoud.cz';
const UA = { 'User-Agent': 'LexisLocal-ns-sbirka-fetch/1.0 (+https://nexusstack.eu)' };

function parseArgs(argv) {
    const a = { delay: 2000, limit: 0 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], next = () => argv[++i];
        if (k === '--out') a.out = next();
        else if (k === '--limit') a.limit = parseInt(next(), 10) || 0;
        else if (k === '--od-roku') a.odRoku = parseInt(next(), 10) || 0;
        else if (k === '--druh') a.druh = String(next()).toLowerCase();
        else if (k === '--keyword') a.keyword = String(next()).toLowerCase();
        else if (k === '--delay') a.delay = Math.max(1000, parseInt(next(), 10) || 2000);
        else if (k === '--by-druh') a.byDruh = true;
        else if (k === '--probe') a.probe = true;
        else if (k === '--help' || k === '-h') a.help = true;
        else { console.error(`Neznámý argument: ${k}`); a.help = true; }
    }
    return a;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', bdquo: '„', ldquo: '“', rdquo: '”', sect: '§', hellip: '…' };
function htmlToText(h) {
    return String(h || '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
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

/** URL všech <loc> v XML (sitemap). */
function sitemapLocs(xml) {
    return [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].trim());
}

const LABELS = {
    'Právní věta': 'pravniVeta', 'Soud': 'soud', 'Datum rozhodnutí': 'datum', 'Spisová značka': 'spisZn',
    'Číslo rozhodnutí': 'cislo', 'Rok': 'rok', 'Sešit': 'sesit', 'Typ rozhodnutí': 'typ',
    'Heslo': 'heslo', 'Předpisy': 'predpisy', 'Druh': 'druh'
};

/**
 * HTML stránky rozhodnutí → { title, ecli, pravniVeta, soud, datum, spisZn, cislo, rok, sesit,
 * typ, heslo, predpisy, druh, text }. Řádky tabulky „štítek: hodnota“; nejdelší řádek bez
 * štítku (nebo štítek „Sbírkový text“) = text rozhodnutí.
 */
function parseDecision(html) {
    const r = {};
    const h1 = String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    r.title = h1 ? htmlToText(h1[1]).replace(/\s+/g, ' ') : '';
    const ecli = (r.title + ' ' + html).match(/ECLI:CZ:NS:\d{4}:[0-9A-Z.]+/);
    r.ecli = ecli ? ecli[0].replace(/\.$/, '') : '';
    let longest = '';
    for (const row of String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => c[1]);
        if (!cells.length) continue;
        const label = htmlToText(cells[0]).replace(/\s*:\s*$/, '').trim();
        const key = LABELS[label];
        if (key && cells.length > 1) { r[key] = htmlToText(cells.slice(1).join('\n')); continue; }
        const val = htmlToText(cells.length > 1 && /sbírkový text/i.test(label) ? cells.slice(1).join('\n') : cells.join('\n'));
        if (val.length > longest.length) longest = val;
    }
    r.text = longest.replace(/^Sbírkový text rozhodnutí\s*/i, '').trim();
    return r;
}

function header(d, url) {
    const L = [];
    L.push('Soud: ' + (d.soud || 'Nejvyšší soud'));
    if (d.spisZn) L.push('Sp. zn.: ' + d.spisZn);
    if (d.datum) L.push('Datum vydání: ' + d.datum);
    if (d.ecli) L.push('ECLI: ' + d.ecli);
    if (d.cislo || d.rok) L.push(`Sbírka soudních rozhodnutí a stanovisek: č. ${d.cislo || '?'}/${d.rok || '?'}${d.sesit ? `, sešit ${d.sesit}` : ''}`);
    if (d.typ) L.push('Typ rozhodnutí: ' + d.typ);
    if (d.druh) L.push('Druh: ' + d.druh);
    if (d.heslo) L.push('Klíčová slova: ' + d.heslo.replace(/\n+/g, ', '));
    if (d.predpisy) L.push('Zmíněná ustanovení: ' + d.predpisy.replace(/\n+/g, '; '));
    if (url) L.push('Zdroj: ' + url);
    return L.join('\n') + '\n\n' + (d.pravniVeta ? 'Právní věta:\n' + d.pravniVeta + '\n\n' : '');
}

function safeName(s) { return String(s || '').replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/\s+/g, '_').slice(0, 90) || 'rozhodnuti'; }

/** Má se rozhodnutí uložit podle filtrů? */
function matches(d, a) {
    if (a.odRoku && parseInt(d.rok, 10) < a.odRoku) return false;
    if (a.druh && !String(d.druh || '').toLowerCase().includes(a.druh)) return false;
    if (a.keyword) {
        const blob = [d.heslo, d.predpisy, d.pravniVeta, d.title].join(' ').toLowerCase();
        if (!blob.includes(a.keyword)) return false;
    }
    return !!d.text;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// Node „fetch failed“ skrývá skutečnou příčinu v err.cause (DNS, TLS…). Častý případ u
// státních webů: server nepošle mezilehlý certifikát → Node ho neověří (prohlížeč ano).
// Pak zkusíme systémový curl (na macOS ověřuje proti systémové důvěře a umí řetěz doplnit).
// Ověřování TLS se NIKDY nevypíná.
let _useCurl = false;
function _cause(e) {
    const c = e && e.cause;
    return c ? `${c.code || ''} ${c.message || ''}`.trim() : (e && e.message) || String(e);
}
function _curl(url) {
    const { execFileSync } = require('child_process');
    return execFileSync('curl', ['-sS', '-L', '--fail', '--max-time', '60', '-A', UA['User-Agent'], url],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
async function getText(url) {
    if (_useCurl) return _curl(url);
    let res;
    try { res = await fetch(url, { headers: UA }); }
    catch (e) {
        const why = _cause(e);
        try {
            const t = _curl(url);
            _useCurl = true;
            console.log(`ℹ️  Node fetch selhal (${why}) — dál stahuji přes systémový curl.`);
            return t;
        } catch (e2) {
            throw new Error(`nelze stáhnout ${url}: ${why}; curl: ${String(e2.stderr || e2.message).trim().split('\n')[0]}`);
        }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.text();
}

async function listDecisionUrls(delay) {
    const idx = sitemapLocs(await getText(BASE + '/sitemap_index.xml')).filter(u => /collection-sitemap\d*\.xml$/.test(u));
    const urls = [];
    for (const sm of idx) {
        await sleep(delay);
        urls.push(...sitemapLocs(await getText(sm)).filter(u => /\/sbirka\/\d+\/?$/.test(u)));
    }
    // Novější (vyšší id) napřed.
    return [...new Set(urls)].sort((x, y) => parseInt(y.match(/(\d+)\/?$/)[1], 10) - parseInt(x.match(/(\d+)\/?$/)[1], 10));
}

async function main() {
    const a = parseArgs(process.argv);
    if (a.help || (!a.probe && !a.out)) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(a.help ? 0 : 1); }
    console.log('📚 Načítám seznam rozhodnutí ze sitemap…');
    const urls = await listDecisionUrls(a.delay);
    console.log(`   ${urls.length} rozhodnutí ve sbírce`);
    if (a.probe) {
        const html = await getText(urls[0]);
        const d = parseDecision(html);
        fs.writeFileSync('ns_sbirka_probe.html', html);
        console.log('UKÁZKA:', JSON.stringify({ ...d, text: d.text.slice(0, 300) + '…', textLen: d.text.length }, null, 2));
        console.log(d.spisZn && d.text.length > 500 ? '\n→ Parser sedí, můžeš stahovat (bez --probe).' : '\n⚠️  Něco chybí — pošli mi soubor ns_sbirka_probe.html.');
        return;
    }
    fs.mkdirSync(a.out, { recursive: true });
    let saved = 0, skipped = 0, existing = 0;
    const done = new Set(fs.readdirSync(a.out, { recursive: true })
        .map(f => (path.basename(String(f)).match(/^NS_(\d+)_/) || [])[1]).filter(Boolean));
    for (const url of urls) {
        if (a.limit && saved >= a.limit) break;
        const id = url.match(/(\d+)\/?$/)[1];
        if (done.has(id)) { existing++; continue; }
        await sleep(a.delay);
        let d;
        try { d = parseDecision(await getText(url)); } catch (e) { console.log(`  ⚠️ ${url}: ${e.message}`); continue; }
        if (!matches(d, a)) { skipped++; continue; }
        const dir = a.byDruh && d.druh ? path.join(a.out, safeName(d.druh)) : a.out;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `NS_${id}_${safeName(d.spisZn || d.ecli)}.txt`), header(d, url) + d.text + '\n');
        saved++;
        if (saved % 20 === 0) console.log(`  … ${saved} uloženo`);
    }
    console.log(`✅ Uloženo ${saved}, mimo filtr ${skipped}, už staženo ${existing} → ${a.out}`);
    console.log(`   Další krok: node backend/scripts/seed-kb.js --obor "<obor>" --dir "${a.out}"  (nebo --root nad složkou oborů)`);
}

if (require.main === module) main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });

module.exports = { parseDecision, sitemapLocs, htmlToText, header, matches };
