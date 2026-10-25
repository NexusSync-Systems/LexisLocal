#!/usr/bin/env node
/**
 * fetch-judikatura.js — stažení anonymizovaných rozhodnutí z OPEN-DATA API
 * Ministerstva spravedlnosti (OKRESNÍ / KRAJSKÉ / VRCHNÍ soudy). Úřední díla
 * (nechráněná autorským právem), anonymizovaná vůči účastníkům. NS/NSS zde NEJSOU
 * — ber je ze Sbírky (sbirka.nsoud.cz / sbirka.nssoud.cz).
 *
 * API (link-driven): každá úroveň vrací pole se `odkaz` na další úroveň:
 *   /api/opendata              → [{rok, pocet, odkaz}]
 *   <odkaz roku>               → [{rok, mesic, pocet, odkaz}]
 *   <odkaz měsíce>             → [{datum, pocet, odkaz}]
 *   <odkaz dne>?page=N         → { items: [ {záznam}, … ] }
 * Záznam = METADATA (bez textu): jednaciCislo, soud, datumVydani, predmetRizeni,
 *   klicovaSlova[], zminenaUstanoveni[], ecli, odkaz(→ /api/finaldoc/<uuid> = dokument).
 * Plný text/dokument se stahuje až z pole `odkaz` záznamu.
 *
 * Běží U TEBE (má síť na justice.cz). Ukládá do složky; pak nahraj přes seed-kb.js.
 * Ke každému rozhodnutí přidá hlavičku s metadaty (soud, sp. zn., klíčová slova,
 * citovaná ustanovení) — lepší dohledatelnost i ověřování citací v RAGu.
 * Bez závislostí — Node ≥ 18.
 *
 * Příklady:
 *   node fetch-judikatura.js --probe --year 2024
 *   node fetch-judikatura.js --year 2024 --keyword nájem --out "./judikatura/Nemovitosti a nájemní právo" --limit 200
 *   node fetch-judikatura.js --year 2024 --month 6 --out ./stazeno --limit 500 --delay 300
 */
'use strict';

const fs = require('fs');
const path = require('path');

const API = 'https://rozhodnuti.justice.cz/api/opendata';
const UA = { 'User-Agent': 'LexisLocal-judikatura-fetch/1.0', 'Accept': 'application/json' };

function parseArgs(argv) {
    const a = { delay: 300 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], next = () => argv[++i];
        if (k === '--year') a.year = parseInt(next(), 10);
        else if (k === '--month') a.month = parseInt(next(), 10);
        else if (k === '--day') a.day = parseInt(next(), 10);
        else if (k === '--out') a.out = next();
        else if (k === '--limit') a.limit = parseInt(next(), 10) || 0;
        else if (k === '--keyword') a.keyword = String(next()).toLowerCase();
        else if (k === '--delay') a.delay = Math.max(0, parseInt(next(), 10) || 0);
        else if (k === '--probe') a.probe = true;
        else if (k === '--help' || k === '-h') a.help = true;
        else { console.error(`Neznámý argument: ${k}`); a.help = true; }
    }
    return a;
}

function usage() {
    console.log(`fetch-judikatura.js — stáhne anonymizovaná rozhodnutí z open-data MSp (obecné soudy).

  --probe             ověří strukturu API (spusť první)
  --year <YYYY>       rok (povinné; dostupné od 2020)
  --month <M>         měsíc (volitelné)
  --day <D>           den (volitelné)
  --out <složka>      kam ukládat (výchozí ./judikatura-stazeno)
  --keyword <slovo>   jen rozhodnutí s tímto slovem v klíč. slovech/předmětu/sp.zn. (kurace)
  --limit <N>         max. počet stažených rozhodnutí
  --delay <ms>        pauza mezi dokumenty (výchozí 300)
  -h, --help          nápověda

NS/NSS zde nejsou — ber je ze Sbírky. Stažené pak nahraj přes seed-kb.js.`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
    return res.json();
}
function recordsOf(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') for (const k of ['items', 'content', 'rozhodnuti', 'data', 'results']) if (Array.isArray(data[k])) return data[k];
    return [];
}
function safeName(s) { return String(s || '').replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/\s+/g, '_').slice(0, 90) || 'rozhodnuti'; }

// Metadata → text pro filtr (klíčová slova + předmět + sp. zn. + soud).
function metaBlob(rec) {
    return [rec.jednaciCislo, rec.soud, rec.predmetRizeni,
        Array.isArray(rec.klicovaSlova) ? rec.klicovaSlova.join(' ') : '',
        Array.isArray(rec.zminenaUstanoveni) ? rec.zminenaUstanoveni.join(' ') : '']
        .filter(Boolean).join(' ').toLowerCase();
}
// Hlavička s metadaty, kterou předřadíme textu rozhodnutí.
function header(rec) {
    const L = [];
    if (rec.soud) L.push('Soud: ' + rec.soud);
    if (rec.jednaciCislo) L.push('Sp. zn.: ' + rec.jednaciCislo);
    if (rec.datumVydani) L.push('Datum vydání: ' + rec.datumVydani);
    if (rec.ecli) L.push('ECLI: ' + rec.ecli);
    if (rec.predmetRizeni) L.push('Předmět řízení: ' + rec.predmetRizeni);
    if (Array.isArray(rec.klicovaSlova) && rec.klicovaSlova.length) L.push('Klíčová slova: ' + rec.klicovaSlova.join(', '));
    if (Array.isArray(rec.zminenaUstanoveni) && rec.zminenaUstanoveni.length) L.push('Zmíněná ustanovení: ' + rec.zminenaUstanoveni.join(', '));
    return L.join('\n') + '\n\n';
}

// Stáhne dokument z odkazu záznamu. Vrací {buffer, ext} nebo {text, ext}.
async function fetchDoc(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA['User-Agent'] } });
    if (!res.ok) throw new Error(`dokument HTTP ${res.status}`);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('json')) {
        const j = await res.json();
        // najdi textové pole
        for (const k of ['text', 'plainText', 'obsah', 'telo', 'dokument', 'anonymizovanyText']) if (typeof j[k] === 'string' && j[k].trim()) return { text: j[k], ext: '.txt' };
        let best = '', n = 0; for (const v of Object.values(j)) if (typeof v === 'string' && v.length > n) { best = v; n = v.length; }
        if (n > 200) return { text: best, ext: '.txt' };
        return { text: JSON.stringify(j), ext: '.json' };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = ct.includes('pdf') ? '.pdf' : ct.includes('html') ? '.html' : ct.includes('rtf') ? '.rtf' : '.txt';
    return { buffer: buf, ext };
}

async function probe(a) {
    const y = a.year || 2024;
    console.log(`🔎 PROBE — ${API}`);
    const years = recordsOf(await getJson(API));
    console.log('roky:', years.map(r => r.rok).join(', '));
    const yr = years.find(r => r.rok === y) || years[years.length - 1];
    const months = recordsOf(await getJson(yr.odkaz));
    console.log(`${yr.rok} měsíce:`, months.map(m => `${m.mesic}(${m.pocet})`).join(', '));
    const days = recordsOf(await getJson(months[0].odkaz));
    console.log(`${yr.rok}/${months[0].mesic} dny:`, days.slice(0, 5).map(d => d.datum).join(', '), '…');
    const page = await getJson(days[0].odkaz + '?page=0');
    const recs = recordsOf(page);
    console.log(`\n${days[0].datum} — záznamů: ${recs.length}`);
    if (recs[0]) {
        console.log('KLÍČE:', Object.keys(recs[0]).join(', '));
        console.log('UKÁZKA:', JSON.stringify(recs[0]).slice(0, 500));
        try { const d = await fetchDoc(recs[0].odkaz); console.log('DOKUMENT:', d.ext, d.text ? `(text ${d.text.length} zn.)` : `(binárně ${d.buffer.length} B)`); }
        catch (e) { console.log('DOKUMENT: nešlo stáhnout —', e.message); }
    }
    console.log('\n→ Schéma sedí, můžeš stahovat (bez --probe).');
}

async function main() {
    const a = parseArgs(process.argv);
    if (a.help || (!a.probe && !a.year)) { usage(); process.exit(a.help ? 0 : 1); }
    if (a.probe) { try { await probe(a); } catch (e) { console.error('❌ probe selhal:', e.message); process.exit(1); } return; }

    const out = a.out || './judikatura-stazeno';
    fs.mkdirSync(out, { recursive: true });
    const years = recordsOf(await getJson(API));
    const yr = years.find(r => r.rok === a.year);
    if (!yr) { console.error(`❌ Rok ${a.year} není dostupný. K dispozici: ${years.map(r => r.rok).join(', ')}`); process.exit(1); }

    let months = recordsOf(await getJson(yr.odkaz));
    if (a.month) months = months.filter(m => m.mesic === a.month);
    console.log(`📥 fetch-judikatura → ${a.year}${a.month ? '/' + a.month : ''} | out ${out}${a.keyword ? ` | filtr "${a.keyword}"` : ''}${a.limit ? ` | limit ${a.limit}` : ''}`);

    let saved = 0, seen = 0, skippedFilter = 0;
    for (const m of months) {
        let days = recordsOf(await getJson(m.odkaz));
        if (a.day) days = days.filter(d => new Date(d.datum).getUTCDate() === a.day);
        for (const d of days) {
            for (let page = 0; ; page++) {
                let recs; try { recs = recordsOf(await getJson(d.odkaz + '?page=' + page)); } catch (e) { console.log(`  ⚠️ ${d.datum} str.${page}: ${e.message}`); break; }
                if (!recs.length) break;
                for (const rec of recs) {
                    seen++;
                    if (a.keyword && !metaBlob(rec).includes(a.keyword)) { skippedFilter++; continue; }
                    if (!rec.odkaz) continue;
                    let doc; try { doc = await fetchDoc(rec.odkaz); } catch (e) { console.log(`  ⚠️ ${rec.jednaciCislo || rec.ecli}: ${e.message}`); continue; }
                    const name = safeName(rec.jednaciCislo || rec.ecli || `${d.datum}-${saved}`) + doc.ext;
                    if (doc.buffer) fs.writeFileSync(path.join(out, name), doc.buffer);
                    else fs.writeFileSync(path.join(out, name), header(rec) + doc.text);
                    saved++;
                    if (saved % 20 === 0) console.log(`  … ${saved} uloženo (${d.datum})`);
                    if (a.limit && saved >= a.limit) { console.log(`\n✅ Hotovo (limit): ${saved} rozhodnutí → ${out}${skippedFilter ? ` (${skippedFilter} mimo filtr)` : ''}`); return; }
                    if (a.delay) await sleep(a.delay);
                }
                if (recs.length < 100) break; // stránka menší než plná → poslední
            }
        }
    }
    console.log(`\n✅ Hotovo: ${saved} uloženo (${seen} prošlo, ${skippedFilter} mimo filtr) → ${out}`);
}

main().catch(e => { console.error('❌ Neočekávaná chyba:', e.message); process.exit(1); });
