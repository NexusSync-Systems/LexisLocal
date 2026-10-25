#!/usr/bin/env node
/**
 * fetch-esbirka.js — stáhne AKTUÁLNÍ ZNĚNÍ zákonů přímo z e-Sbírky a rozdělí je po
 * paragrafech do znalostní báze (stejný formát jako split-zakon.js → hlavička
 * „Zákon č. 89/2012 Sb., …“ + „§ N“, kterou čte kb_law_index i ověřování citací).
 * Odpadá ruční export textu z webu e-Sbírky.
 *
 * Zdroj (úřední díla, § 3 AZ — nechráněná autorským právem):
 *   • s klíčem: https://api.e-sbirka.gov.cz  (hlavička esel-api-access-key; klíč přiděluje
 *     MV ČR na žádost datovou schránkou, kontakt esel@spcss.cz) — DOPORUČENO,
 *   • bez klíče: https://e-sbirka.gov.cz/sbr-cache (cache portálu — není určená pro strojový
 *     přístup, proto pomalu a jen pro jednotky zákonů).
 * Rozhraní: GET /dokumenty-sbirky/{staleUrl}/fragmenty?cisloStranky=N (1000 fragmentů/str.),
 *   staleUrl = /sb/{rok}/{cislo}/{RRRR-MM-DD} URL-zakódované; fragment nese kodTypuFragmentu,
 *   staleUrl s kotvou (#par_629, #par_310-pism_c) a xhtml. Popis rozhraní je neoficiální
 *   (github.com/LexaurinTheDog/esbirka-skill) — proto --probe před prvním během.
 *
 * Běží U TEBE (síť na e-sbirka.gov.cz; open data blokují servery mimo EU).
 *
 * Příklady:
 *   node backend/scripts/fetch-esbirka.js --probe --law 89/2012
 *   node backend/scripts/fetch-esbirka.js --law 89/2012 --zkratka OZ --nazev "občanský zákoník" --out ./zakony
 *   node backend/scripts/fetch-esbirka.js --preset advokat --out ./zakony          (sada zákonů níže)
 *   node backend/scripts/fetch-esbirka.js --preset advokat --list                   (jen vypíše sadu)
 * Pak:
 *   node backend/scripts/seed-kb.js --agent resersnik --dir ./zakony/OZ   (pro každý zákon)
 *
 * Přepínače: --datum RRRR-MM-DD (znění k datu, výchozí dnes)  --key-file <soubor s klíčem>
 *   (jinak $ESBIRKA_API_KEY)  --delay ms (výchozí 500 s klíčem, 2000 bez)  --dry-run
 * Bez závislostí — Node ≥ 18.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { renderDoc, fileSafe } = require('./split-zakon');

const API_BASE = 'https://api.e-sbirka.gov.cz';
const CACHE_BASE = 'https://e-sbirka.gov.cz/sbr-cache';
const UA = 'LexisLocal-esbirka-fetch/1.0 (+https://nexusstack.eu)';

// Zákony, které advokátní praxe potřebuje nejčastěji. (Vyhlášky a ústavní zákony zatím ne —
// hlavička „Zákon č.“ by u nich nebyla přesná.)
const PRESETS = {
    advokat: [
        ['OZ', '89/2012', 'občanský zákoník'],
        ['OSŘ', '99/1963', 'občanský soudní řád'],
        ['ZŘS', '292/2013', 'zákon o zvláštních řízeních soudních'],
        ['ZOK', '90/2012', 'zákon o obchodních korporacích'],
        ['ZVR', '304/2013', 'zákon o veřejných rejstřících právnických a fyzických osob'],
        ['ZP', '262/2006', 'zákoník práce'],
        ['IZ', '182/2006', 'insolvenční zákon'],
        ['EŘ', '120/2001', 'exekuční řád'],
        ['ZSP', '549/1991', 'zákon o soudních poplatcích'],
        ['ZA', '85/1996', 'zákon o advokacii'],
        ['TZ', '40/2009', 'trestní zákoník'],
        ['TŘ', '141/1961', 'trestní řád'],
        ['SŘS', '150/2002', 'soudní řád správní'],
        ['SŘ', '500/2004', 'správní řád'],
        ['DŘ', '280/2009', 'daňový řád'],
        ['ZOS', '634/1992', 'zákon o ochraně spotřebitele'],
        ['ZRŘ', '216/1994', 'zákon o rozhodčím řízení a o výkonu rozhodčích nálezů'],
        ['ZMPS', '91/2012', 'zákon o mezinárodním právu soukromém'],
        ['KatZ', '256/2013', 'katastrální zákon'],
        ['ZOOÚ', '110/2019', 'zákon o zpracování osobních údajů'],
        ['AML', '253/2008', 'zákon o některých opatřeních proti legalizaci výnosů z trestné činnosti a financování terorismu'],
        ['OdpSt', '82/1998', 'zákon o odpovědnosti za škodu způsobenou při výkonu veřejné moci'],
        ['ZPř', '250/2016', 'zákon o odpovědnosti za přestupky a řízení o nich']
    ]
};

function parseArgs(argv) {
    const a = { laws: [], delay: null, dryRun: false };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], next = () => argv[++i];
        if (k === '--law') a.laws.push({ cislo: next() });
        else if (k === '--zkratka') { if (a.laws.length) a.laws[a.laws.length - 1].zkratka = next(); else a.zkratka = next(); }
        else if (k === '--nazev') { if (a.laws.length) a.laws[a.laws.length - 1].nazev = next(); else a.nazev = next(); }
        else if (k === '--preset') a.preset = next();
        else if (k === '--datum') a.datum = next();
        else if (k === '--out') a.out = next();
        else if (k === '--key-file') a.keyFile = next();
        else if (k === '--delay') a.delay = Math.max(0, parseInt(next(), 10) || 0);
        else if (k === '--probe') a.probe = true;
        else if (k === '--list') a.list = true;
        else if (k === '--dry-run') a.dryRun = true;
        else if (k === '--help' || k === '-h') a.help = true;
        else { console.error(`Neznámý argument: ${k}`); a.help = true; }
    }
    return a;
}

function expandHome(p) { return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }

/** /sb/2012/89/2026-10-14 → %2Fsb%2F2012%2F89%2F2026-10-14 */
function staleUrl(cislo, datum) {
    const m = String(cislo || '').trim().match(/^(\d{1,4})\/(\d{4})$/);
    if (!m) throw new Error(`Číslo předpisu „${cislo}“ musí být ve tvaru 89/2012.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) throw new Error(`Datum „${datum}“ musí být RRRR-MM-DD.`);
    return encodeURIComponent(`/sb/${m[2]}/${m[1]}/${datum}`);
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', bdquo: '„', ldquo: '“', rdquo: '”', sect: '§', hellip: '…' };
/** xhtml fragmentu → prostý text (tagy pryč, entity dekódované, mezery sjednocené). */
function xhtmlToText(x) {
    return String(x || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m))
        .replace(/[ \t ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Číslo § z kotvy staleUrl fragmentu („…#par_310-pism_c“ → „310“), jinak null. */
function parOf(frag) {
    const m = String((frag && frag.staleUrl) || '').match(/#par_(\d+[a-z]*)/i);
    return m ? m[1].toLowerCase() : null;
}

const STRUCT_TYPES = /^(Cast|Hlava|Dil|Oddil|Pododdil)/i;

/**
 * Fragmenty (v pořadí dokumentu) → [{ num, title, struct, text }] — stejný tvar jako
 * split-zakon.splitParagraphs. Příslušnost k § se bere z kotvy #par_N (spolehlivější než
 * pořadí); nový § začíná, když se kotva změní. Strukturní nadpisy (část/hlava/díl…) bez
 * kotvy § jsou kontext `struct`. Přílohy se vynechávají.
 */
function fragmentsToParagraphs(frags) {
    const out = [];
    const struct = [];   // [{ depth, text }]
    let cur = null, curPar = null;
    let lastWasStruct = false;   // „Nadpis_pod“ hned za ČÁST/HLAVA/Díl = název té úrovně
    let pendingTitle = '';       // nadpis nad paragrafem (patří k následujícímu §)
    for (const f of frags || []) {
        const type = String(f.kodTypuFragmentu || '');
        if (/^Priloha/i.test(type)) { cur = null; curPar = null; lastWasStruct = false; continue; }
        if (/^(Virtual|Prefix)/i.test(type)) continue;   // hlavička předpisu (číslo, název, „Parlament se usnesl…“)
        const text = xhtmlToText(f.xhtml);
        const par = parOf(f);
        const isTitle = /^Nadpis/i.test(type);
        if (!par) {
            if (STRUCT_TYPES.test(type) && text) {
                const depth = Number.isFinite(f.hloubka) ? f.hloubka : struct.length;
                while (struct.length && struct[struct.length - 1].depth >= depth) struct.pop();
                struct.push({ depth, text: text.replace(/\n+/g, ' ') });
                lastWasStruct = true;
                pendingTitle = '';
            } else if (isTitle && text) {
                if (lastWasStruct && struct.length) struct[struct.length - 1].text += ' ' + text.replace(/\n+/g, ' ');
                else pendingTitle = (pendingTitle ? pendingTitle + ' – ' : '') + text.replace(/\n+/g, ' ');
                lastWasStruct = false;
            }
            continue;
        }
        lastWasStruct = false;
        if (par !== curPar) {
            cur = { num: par, title: '', struct: struct.map(s => s.text).join(' › '), lines: [], head: false };
            if (pendingTitle) { cur.title = pendingTitle; pendingTitle = ''; }
            out.push(cur);
            curPar = par;
        }
        if (isTitle) { if (text && !cur.title) cur.title = text.replace(/\n+/g, ' '); continue; }
        // Fragment samotného § („§ 629“, případně s nadpisem) → nadpis; ostatní → text.
        const isParHead = /^Paragraf/i.test(type) || (!cur.head && /#par_[^-]+$/.test(String(f.staleUrl || '')) && /^§/.test(text));
        if (isParHead && !cur.head) {
            cur.head = true;
            const rest = text.replace(/^§\s*\d+[a-z]*\s*/i, '').trim();
            if (rest && !cur.title && rest.length <= 140 && !/[.;:,]$/.test(rest) && !/^\(\d+\)/.test(rest)) cur.title = rest.replace(/\n+/g, ' ');
            else if (rest) cur.lines.push(rest);
            continue;
        }
        if (text) cur.lines.push(text);
    }
    return out.map(p => ({ num: p.num, title: p.title, struct: p.struct, text: p.lines.join('\n').trim() })).filter(p => p.text);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readKey(a) {
    if (a.keyFile) return fs.readFileSync(expandHome(a.keyFile), 'utf8').trim();
    return (process.env.ESBIRKA_API_KEY || '').trim() || null;
}

async function getJson(base, pathPart, key) {
    const headers = { Accept: 'application/json', 'User-Agent': UA };
    if (key) headers['esel-api-access-key'] = key;
    const res = await fetch(base + pathPart, { headers });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
        const ch = body && Array.isArray(body.chyby) && body.chyby[0];
        const err = new Error(ch ? `${ch.kod}: ${ch.popis || ''}`.trim() : `HTTP ${res.status}`);
        err.status = res.status; err.code = ch && ch.kod;
        throw err;
    }
    return body;
}

async function fetchFragments(base, key, su, delay, log) {
    const all = [];
    for (let page = 0; ; page++) {
        const j = await getJson(base, `/dokumenty-sbirky/${su}/fragmenty?cisloStranky=${page}`, key);
        const list = (j && Array.isArray(j.seznam)) ? j.seznam : [];
        all.push(...list);
        const pages = j && Number.isFinite(j.pocetStranek) ? j.pocetStranek : (list.length >= 1000 ? page + 2 : page + 1);
        if (log) log(`   str. ${page + 1}/${pages}: ${list.length} fragmentů`);
        if (page + 1 >= pages || !list.length) break;
        await sleep(delay);
    }
    return all;
}

async function probe(a, base, key, datum) {
    const law = a.laws[0] || { cislo: '89/2012' };
    const su = staleUrl(law.cislo, datum);
    console.log(`🔎 PROBE ${base} — ${law.cislo} ke dni ${datum}${key ? ' (s klíčem)' : ' (bez klíče, cache portálu)'}`);
    const meta = await getJson(base, `/dokumenty-sbirky/${su}`, key);
    console.log('METADATA klíče:', Object.keys(meta || {}).join(', '));
    console.log('Citace:', meta && (meta.uplnaCitace || meta.zkracenaCitace));
    const j = await getJson(base, `/dokumenty-sbirky/${su}/fragmenty?cisloStranky=0`, key);
    const list = (j && j.seznam) || [];
    console.log(`FRAGMENTY str. 0: ${list.length}, pocetStranek=${j && j.pocetStranek}`);
    const types = {}; list.forEach(f => { types[f.kodTypuFragmentu] = (types[f.kodTypuFragmentu] || 0) + 1; });
    console.log('Typy:', Object.entries(types).map(([t, n]) => `${t}×${n}`).join(', '));
    const firstPar = list.findIndex(f => parOf(f));
    list.slice(Math.max(0, firstPar - 1), firstPar + 4).forEach(f => console.log(' •', f.kodTypuFragmentu, f.staleUrl, '|', xhtmlToText(f.xhtml).slice(0, 120)));
    const paras = fragmentsToParagraphs(list);
    console.log(`→ ${paras.length} § na první stránce; ukázka:\n` + (paras[0] ? renderDoc({ cislo: law.cislo, nazev: law.nazev || '…', zneni: datum }, [paras[0]]).slice(0, 600) : '(nic)'));
    const dump = path.join(process.cwd(), `esbirka_probe_${law.cislo.replace('/', '-')}.json`);
    fs.writeFileSync(dump, JSON.stringify({ meta, page0: { pocetStranek: j && j.pocetStranek, seznam: list.slice(0, 60) } }, null, 2));
    console.log(`\nUkázka uložena: ${dump} (pošli mi ji, pokud výstup nesedí).`);
}

async function main() {
    const a = parseArgs(process.argv);
    if (a.preset) {
        const p = PRESETS[a.preset];
        if (!p) { console.error(`Neznámá sada „${a.preset}“. K dispozici: ${Object.keys(PRESETS).join(', ')}`); process.exit(1); }
        p.forEach(([zkratka, cislo, nazev]) => a.laws.push({ zkratka, cislo, nazev }));
    }
    if (a.list) { a.laws.forEach(l => console.log(`${(l.zkratka || '').padEnd(6)} ${l.cislo.padEnd(10)} ${l.nazev || ''}`)); return; }
    if (a.help || !a.laws.length || (!a.probe && !a.out && !a.dryRun)) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(a.help ? 0 : 1);
    }
    const key = readKey(a);
    const base = key ? API_BASE : CACHE_BASE;
    const delay = a.delay !== null ? a.delay : (key ? 500 : 2000);
    const datum = a.datum || new Date().toISOString().slice(0, 10);
    if (a.probe) return probe(a, base, key, datum);
    if (!key) console.log('ℹ️  Bez API klíče — beru z cache portálu e-Sbírky pomalu (pauza 2 s). Pro pravidelné stahování požádej MV o klíč.');

    let ok = 0;
    for (const law of a.laws) {
        if (!law.zkratka || !law.nazev) { console.error(`⚠️  ${law.cislo}: chybí --zkratka nebo --nazev, přeskakuji.`); continue; }
        console.log(`📖 ${law.zkratka} ${law.cislo} — ${law.nazev} (znění účinné ke dni ${datum})`);
        let frags, zneni = datum;
        try {
            const su = staleUrl(law.cislo, datum);
            // Skutečně vrácené znění (k datu se vrací to účinné — např. 2026-01-01 i při dotazu na dnešek).
            const meta = await getJson(base, `/dokumenty-sbirky/${su}`, key);
            zneni = String((meta && meta.datumUcinnostiZneniOd) || '').slice(0, 10) || datum;
            await sleep(delay);
            frags = await fetchFragments(base, key, su, delay, s => console.log(s));
        }
        catch (e) { console.error(`   ❌ ${e.code === 'DOKUMENT_NENALEZEN' ? 'předpis k tomuto datu neexistuje / není účinný' : e.message}`); continue; }
        const paras = fragmentsToParagraphs(frags);
        console.log(`   ${frags.length} fragmentů → ${paras.length} § (znění od ${zneni})`);
        if (paras.length < 5) { console.error('   ⚠️  Podezřele málo paragrafů — spusť --probe a pošli ukázku.'); continue; }
        if (a.dryRun) { console.log(renderDoc({ cislo: law.cislo, nazev: law.nazev, zneni }, [paras[0]]).slice(0, 500)); continue; }
        const dir = path.join(expandHome(a.out), fileSafe(law.zkratka));
        fs.mkdirSync(dir, { recursive: true });
        const seen = new Map();
        const pad = (n) => String(n).replace(/^(\d+)/, m => m.padStart(4, '0'));
        for (const p of paras) {
            let name = `${fileSafe(law.zkratka)} ${fileSafe(law.cislo)} § ${pad(p.num)}`;
            const n = (seen.get(name) || 0) + 1; seen.set(name, n);
            if (n > 1) name += ` (${n})`;
            fs.writeFileSync(path.join(dir, name + '.txt'), renderDoc({ cislo: law.cislo, nazev: law.nazev, zneni }, [p]), 'utf8');
        }
        console.log(`   ✅ ${paras.length} souborů → ${dir}`);
        ok++;
        await sleep(delay);
    }
    if (ok && !a.dryRun) console.log(`\nDalší krok (pro každý zákon): node backend/scripts/seed-kb.js --agent resersnik --dir "${path.join(a.out, '<ZKRATKA>')}"`);
}

if (require.main === module) main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });

module.exports = { staleUrl, xhtmlToText, parOf, fragmentsToParagraphs, PRESETS };
