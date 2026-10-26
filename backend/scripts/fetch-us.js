#!/usr/bin/env node
/**
 * fetch-us.js — rozhodnutí ÚSTAVNÍHO SOUDU do znalostní báze (nálezy, stanoviska pléna).
 *
 * Proč: nálezy ÚS jsou podle čl. 89 odst. 2 Ústavy závazné pro všechny; v rešerších
 * nesmí chybět. ÚS nemá API ani otevřená data (na žádosti o hromadné poskytnutí
 * odkazuje na NALUS), proto dva zdroje:
 *
 *  1) --ccc  Dataset „The Czech Constitutional Court Database" (Š. Paulík, HU Berlin;
 *     Zenodo 11618008, CC BY 4.0) — metadata a plné texty 1993–2023 vytažené z NALUS.
 *     Čte se přímo ze staženého ZIPu (přes `unzip -p`, nic se nerozbaluje na disk)
 *     nebo z rozbalené složky s ccc_metadata.csv a ccc_texts.csv.
 *  2) --nalus  Doplní novější rozhodnutí přímo z NALUS (dataset končí rokem 2023):
 *     vyhledá nálezy a stanoviska pléna od data --od (výchozí 1. 1. 2024), projde stránky
 *     výsledků (metadata bere z tabulky výsledků) a stáhne text každého rozhodnutí.
 *     Slušně: jeden požadavek najednou, pauza --delay (výchozí 2 s), už stažené přeskočí.
 *     --prepsat stáhne a přepíše i už uložené soubory z NALUS (po opravě parseru).
 *     --nalus-probe uloží jen první stránku výsledků do scratch/ (ladění). NALUS nemá robots.txt;
 *     podmínky webu dovolují další užití s uvedením zdroje, bezplatnosti a toho, že
 *     nejde o autentické znění — to nese hlavička každého souboru.
 *
 * Soudní rozhodnutí jsou úřední dílo (§ 3 AZ). Výstup má hlavičku jako fetch-ns-sbirka.js.
 *
 * Příklady:
 *   node backend/scripts/fetch-us.js --ccc ~/Downloads/ccc_database.zip --out ./judikatura-us
 *   node backend/scripts/fetch-us.js --ccc ~/Downloads/ccc_database.zip --out ./us --od-roku 2010 --limit 50
 *   node backend/scripts/fetch-us.js --nalus --od 01.01.2024 --out ./judikatura-us
 * Pak: node backend/scripts/seed-kb.js --agent resersnik --dir ./judikatura-us --token-file ~/.lexislocal/api_token
 *
 * Přepínače: --typy "Nález,Stanovisko pléna" (lze přidat Usnesení)  --od-roku RRRR
 *   NALUS: --usneseni (jen usnesení)  --jen-publikovana (jen publikovaná ve Sbírce nálezů a usnesení)
 *   --do-roku RRRR  --limit N  --vyznam N (jen význam 1..N; 1 = nejvýznamnější)
 * Bez závislostí — Node ≥ 18 (+ systémový `unzip` pro čtení ZIPu, `curl` pro NALUS).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const NALUS = 'https://nalus.usoud.cz';
const UA = 'LexisLocal-us-fetch/1.0 (+https://nexusstack.eu)';
const CCC_CITACE = 'The Czech Constitutional Court Database (Š. Paulík, Humboldt-Universität zu Berlin; Zenodo 11618008, CC BY 4.0)';
const VYCHOZI_TYPY = ['Nález', 'Stanovisko pléna'];

function parseArgs(argv) {
    const a = { out: './judikatura-us', typy: VYCHOZI_TYPY.slice(), limit: 0, delay: 2000 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], next = () => argv[++i];
        if (k === '--ccc') a.ccc = next();
        else if (k === '--out') a.out = next();
        else if (k === '--typy') a.typy = String(next()).split(',').map(s => s.trim()).filter(Boolean);
        else if (k === '--od-roku') a.odRoku = parseInt(next(), 10) || 0;
        else if (k === '--do-roku') a.doRoku = parseInt(next(), 10) || 0;
        else if (k === '--limit') a.limit = parseInt(next(), 10) || 0;
        else if (k === '--vyznam') a.vyznam = parseInt(next(), 10) || 0;
        else if (k === '--nalus-probe') a.nalusProbe = true;
        else if (k === '--nalus') a.nalus = true;
        else if (k === '--do') a.do = next();
        else if (k === '--prepsat') a.prepsat = true;
        else if (k === '--usneseni') a.usneseni = true;           // NALUS: jen usnesení (místo nálezů a stanovisek)
        else if (k === '--jen-publikovana') a.jenPublikovana = true; // NALUS: jen publikovaná ve Sbírce nálezů a usnesení
        else if (k === '--od') a.od = next();
        else if (k === '--delay') a.delay = Math.max(1000, parseInt(next(), 10) || 2000);
        else if (k === '--help' || k === '-h') a.help = true;
        else { console.error(`Neznámý argument: ${k}`); a.help = true; }
    }
    // Usnesení: výchozí filtr typů jen „Usnesení“ (pokud --typy neurčí jinak)
    if (a.usneseni && !argv.includes('--typy')) a.typy = ['Usnesení'];
    if (a.ccc) a.ccc = a.ccc.replace(/^~(?=$|\/)/, os.homedir());
    return a;
}

// --- CSV (RFC 4180, proudově) ------------------------------------------------------
// ccc_texts.csv má ~1 GB a pole s plnými texty přes víc řádků, proto vlastní proudový
// parser (žádná závislost, nic se nedrží celé v paměti).
class CsvParser {
    constructor(onRow) {
        this.onRow = onRow;
        this.field = '';
        this.row = [];
        this.inQuotes = false;
        this.quotePending = false; // byla uvozovka uvnitř uvozovek — escape, nebo konec pole?
        this.fieldParts = [];
    }
    _endField() {
        this.fieldParts.push(this.field);
        this.row.push(this.fieldParts.length === 1 ? this.fieldParts[0] : this.fieldParts.join(''));
        this.fieldParts = [];
        this.field = '';
    }
    _endRow() {
        this._endField();
        const r = this.row;
        this.row = [];
        if (!(r.length === 1 && r[0] === '')) this.onRow(r);
    }
    push(chunk) {
        let start = 0;
        const s = chunk;
        for (let i = 0; i < s.length; i++) {
            const ch = s.charCodeAt(i);
            if (this.quotePending) {
                this.quotePending = false;
                if (ch === 34) { this.field += s.slice(start, i); start = i + 1; this.field += '"'; continue; } // ""
                this.inQuotes = false; // konec quoted pole, znak zpracujeme normálně
            }
            if (this.inQuotes) {
                if (ch === 34) { this.field += s.slice(start, i); start = i + 1; this.quotePending = true; }
                continue;
            }
            if (ch === 34) { this.field += s.slice(start, i); start = i + 1; this.inQuotes = true; }
            else if (ch === 44) { this.field += s.slice(start, i); start = i + 1; this._endField(); }
            else if (ch === 10) {
                let end = i;
                if (end > start && s.charCodeAt(end - 1) === 13) end--;
                this.field += s.slice(start, end); start = i + 1; this._endRow();
            }
        }
        if (start < s.length) {
            // Dlouhé pole přes víc kusů: sbírej části, ať se řetězec neskládá kvadraticky.
            this.field += s.slice(start);
            if (this.field.length > 1 << 20) { this.fieldParts.push(this.field); this.field = ''; }
        }
    }
    end() {
        if (this.quotePending) { this.quotePending = false; this.inQuotes = false; }
        if (this.field !== '' || this.row.length || this.fieldParts.length) this._endRow();
    }
}

/** Celý CSV řetězec → pole řádků (pro testy a malé soubory). */
function parseCsv(text) {
    const rows = [];
    const p = new CsvParser(r => rows.push(r));
    p.push(String(text));
    p.end();
    return rows;
}

/** Najde v ZIPu člen končící na /csv/<jmeno> (bez __MACOSX). */
function zipMember(zip, name) {
    const list = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n');
    const hit = list.find(l => !l.startsWith('__MACOSX') && (l === name || l.endsWith('/csv/' + name) || l.endsWith('/' + name)));
    if (!hit) throw new Error(`v ZIPu chybí ${name}`);
    return hit;
}

/** Proudově přečte CSV ze ZIPu nebo složky; onRow(objekt podle hlavičky). */
function readCsv(source, name, onRow) {
    return new Promise((resolve, reject) => {
        let stream, child;
        if (/\.zip$/i.test(source)) {
            child = spawn('unzip', ['-p', source, zipMember(source, name)]);
            stream = child.stdout;
            let err = '';
            child.stderr.on('data', d => { err += d; });
            child.on('error', reject);
            child.on('close', code => { if (code !== 0 && code !== null && !done) reject(new Error(`unzip skončil kódem ${code}: ${err.trim()}`)); });
        } else {
            const p = [path.join(source, name), path.join(source, 'csv', name)].find(f => fs.existsSync(f));
            if (!p) return reject(new Error(`nenalezen ${name} ve složce ${source}`));
            stream = fs.createReadStream(p);
        }
        let header = null;
        let done = false;
        let stopped = false;
        const parser = new CsvParser(r => {
            if (stopped) return;
            if (!header) { header = r.map(h => h.replace(/^﻿/, '')); return; }
            const o = {};
            for (let i = 0; i < header.length; i++) o[header[i]] = r[i];
            if (onRow(o) === false) { stopped = true; stream.destroy(); if (child) child.kill(); finish(); }
        });
        const dec = new StringDecoder('utf8');
        const finish = () => { if (!done) { done = true; resolve(); } };
        stream.on('data', b => { if (!stopped) parser.push(dec.write(b)); });
        stream.on('end', () => { if (!stopped) { parser.push(dec.end()); parser.end(); } finish(); });
        stream.on('error', e => { if (!stopped) reject(e); });
    });
}

// --- Metadata datasetu -------------------------------------------------------------
/** R vektor z datasetu („c("a", "b")", „NA", prostý text) → pole řetězců. */
function rVector(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s === 'NA') return [];
    if (/^c\(/.test(s) && s.endsWith(')')) {
        return [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\"/g, '"').trim()).filter(Boolean);
    }
    return [s];
}

/** „III.ÚS 2498/23" → „III. ÚS 2498/23"; „Pl.ÚS-st. 1/96" → „Pl. ÚS-st. 1/96". */
function formatSpZn(caseId) {
    return String(caseId || '').trim().replace(/^([IV]+|Pl)\.\s*ÚS/, '$1. ÚS').replace(/\s+/g, ' ');
}

const SENAT = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };
/**
 * ECLI → { spisZn, poradi }. Stanoviska pléna mají v datasetu case_id „NA";
 * ECLI „ECLI:CZ:US:2022:Pl.US-st.57.22.1" → „Pl. ÚS-st. 57/22", pořadí 1.
 */
function spZnFromEcli(ecli) {
    // Pořadí na konci občas chybí (např. ECLI:CZ:US:2002:Pl.US-st.15.02) → 1.
    const m = /^ECLI:CZ:US:\d{4}:(Pl|[1-4])\.US(-st)?\.(\d+)\.(\d+)(?:\.(\d+))?$/i.exec(String(ecli || '').trim());
    if (!m) return null;
    const sen = /^pl$/i.test(m[1]) ? 'Pl' : SENAT[m[1]];
    return { spisZn: `${sen}. ÚS${m[2] ? '-st.' : ''} ${m[3]}/${m[4]}`, poradi: m[5] || '1' };
}

// Ústavní předpisy se v NALUS uvádějí číslem; doplníme název, ať je hlavička čitelná
// i pro lexikální hledání („Listina", „Úmluva").
const NAZVY_PREDPISU = {
    '1/1993 Sb.': 'Ústava',
    '2/1993 Sb.': 'Listina základních práv a svobod',
    '209/1992 Sb.': 'Úmluva o ochraně lidských práv a základních svobod',
    '104/1991 Sb.': 'Úmluva o právech dítěte',
    '120/1976 Sb.': 'Mezinárodní pakt o občanských a politických právech',
    '110/1998 Sb.': 'ústavní zákon o bezpečnosti ČR',
};
function pojmenujPredpis(s) {
    const t = String(s).replace(/\/Sb\.m\.s\./g, '');
    const m = /^(\d+\/\d{4} Sb\.)(.*)$/.exec(t);
    return m && NAZVY_PREDPISU[m[1]] ? `${NAZVY_PREDPISU[m[1]]} (${m[1]})${m[2]}` : t;
}

/** ISO „2023-11-29" → „29.11.2023" (formát hlaviček NS). */
function czDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

const FORMACE = { Plenum: 'plénum', 'First Chamber': 'I. senát', 'Second Chamber': 'II. senát', 'Third Chamber': 'III. senát', 'Fourth Chamber': 'IV. senát' };

function na(v) { const s = String(v == null ? '' : v).trim(); return s === 'NA' ? '' : s; }

/** Řádek ccc_metadata → objekt pro hlavičku. */
function metaFromRow(r) {
    const ecli = na(r.doc_id);
    const zEcli = spZnFromEcli(ecli);
    return {
        ecli,
        spisZn: na(r.case_id) ? formatSpZn(r.case_id) : (zEcli ? zEcli.spisZn : ''),
        poradi: na(r.case_nr) || (zEcli ? zEcli.poradi : ''),
        typ: na(r.type_decision),
        popularniNazev: na(r.popular_name),
        datum: czDate(r.date_decision),
        rok: parseInt(r.year_decision, 10) || 0,
        datumVyhlaseni: czDate(na(r.date_publication)),
        vyznam: parseInt(r.importance, 10) || 0,
        typRizeni: na(r.type_proceedings),
        soudceZpravodaj: na(r.judge_rapporteur_name),
        formace: FORMACE[na(r.formation)] || na(r.formation),
        vyrok: rVector(r.type_verdict),
        napadenyAkt: rVector(r.disputed_act),
        ustavniPredpisy: rVector(r.concerned_constitutional_acts).map(pojmenujPredpis),
        predpisy: rVector(r.concerned_acts).map(pojmenujPredpis),
        predmet: rVector(r.subject_proceedings),
        rejstrik: rVector(r.subject_register),
        odlisneStanovisko: rVector(r.separate_opinion),
        url: na(r.url_address).replace(':443/', '/'),
    };
}

function matches(m, a) {
    if (a.typy && a.typy.length && !a.typy.includes(m.typ)) return false;
    if (a.odRoku && m.rok < a.odRoku) return false;
    if (a.doRoku && m.rok > a.doRoku) return false;
    if (a.vyznam && !(m.vyznam >= 1 && m.vyznam <= a.vyznam)) return false;
    return true;
}

function header(m) {
    const L = [];
    const typ = m.typ || 'Rozhodnutí';
    L.push(`${typ} Ústavního soudu ze dne ${m.datum || '?'}, sp. zn. ${m.spisZn}${m.popularniNazev ? ` („${m.popularniNazev}")` : ''}`);
    L.push('Soud: Ústavní soud');
    L.push('Sp. zn.: ' + m.spisZn);
    L.push('Datum vydání: ' + (m.datum || '?'));
    if (m.datumVyhlaseni) L.push('Datum vyhlášení: ' + m.datumVyhlaseni);
    if (m.ecli) L.push('ECLI: ' + m.ecli);
    if (m.sbnu) L.push((/SbNU/.test(m.sbnu) ? 'Sbírka nálezů a usnesení: ' : 'Vyhlášeno ve Sbírce zákonů: ') + m.sbnu);
    L.push('Typ rozhodnutí: ' + typ);
    if (m.popularniNazev) L.push('Populární název: ' + m.popularniNazev);
    if (m.formace) L.push('Rozhodl: ' + m.formace);
    if (m.soudceZpravodaj) L.push('Soudce zpravodaj: ' + m.soudceZpravodaj);
    if (m.vyznam) L.push(`Význam: ${m.vyznam} (stupnice NALUS 1–4, 1 = nejvýznamnější)`);
    if (m.typRizeni) L.push('Typ řízení: ' + m.typRizeni);
    if (m.vyrok.length) L.push('Výrok: ' + m.vyrok.join('; '));
    if (m.napadenyAkt.length) L.push('Napadený akt: ' + m.napadenyAkt.join('; '));
    if (m.ustavniPredpisy.length) L.push('Dotčené ústavní předpisy: ' + m.ustavniPredpisy.join('; '));
    if (m.predpisy.length) L.push('Zmíněná ustanovení: ' + m.predpisy.join('; '));
    if (m.predmet.length) L.push('Předmět řízení: ' + m.predmet.join('; '));
    if (m.rejstrik.length) L.push('Klíčová slova: ' + m.rejstrik.join(', '));
    if (m.odlisneStanovisko.length) L.push('Odlišné stanovisko: ' + m.odlisneStanovisko.join(', '));
    L.push('Zdroj: NALUS – databáze rozhodnutí Ústavního soudu' + (m.url ? ', ' + m.url : '') +
        '; poskytnuto bezplatně, nejde o autentické znění rozhodnutí.');
    if (m.zdrojDat !== 'nalus') L.push('Data: ' + CCC_CITACE);
    return L.join('\n') + '\n\n';
}

function cleanText(t) {
    return String(t || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function safeName(s) { return String(s || '').replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/\s+/g, '_').slice(0, 90) || 'rozhodnuti'; }
function fileNameFor(m) { return `US_${safeName(m.spisZn)}_${safeName(m.poradi || '1')}.txt`; }

async function importCcc(a) {
    if (!fs.existsSync(a.ccc)) throw new Error(`nenalezeno: ${a.ccc}`);
    fs.mkdirSync(a.out, { recursive: true });
    const existing = new Set(fs.readdirSync(a.out));

    console.log(`📚 Čtu metadata z ${path.basename(a.ccc)}…`);
    const vybrane = new Map();
    const pocty = {};
    let celkem = 0;
    await readCsv(a.ccc, 'ccc_metadata.csv', r => {
        celkem++;
        const m = metaFromRow(r);
        if (!m.ecli || !m.spisZn || !matches(m, a)) return;
        pocty[m.typ] = (pocty[m.typ] || 0) + 1;
        vybrane.set(m.ecli, m);
    });
    console.log(`   ${celkem} rozhodnutí v datasetu, vybráno ${vybrane.size} (${Object.entries(pocty).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'})`);

    let saved = 0, already = 0, empty = 0;
    console.log('📝 Čtu plné texty (~1 GB, chvíli to trvá)…');
    await readCsv(a.ccc, 'ccc_texts.csv', r => {
        const m = vybrane.get(r.doc_id);
        if (!m) return;
        vybrane.delete(r.doc_id);
        const name = fileNameFor(m);
        if (existing.has(name)) { already++; return; }
        const text = cleanText(r.text);
        if (text.length < 200) { empty++; return; }
        fs.writeFileSync(path.join(a.out, name), header(m) + text + '\n');
        saved++;
        if (saved % 250 === 0) console.log(`  … ${saved} uloženo`);
        if (a.limit && saved >= a.limit) return false;
        if (vybrane.size === 0) return false; // vše nalezeno, zbytek souboru nečíst
    });
    console.log(`✅ Uloženo ${saved}, už staženo ${already}, bez textu ${empty + (a.limit && saved >= a.limit ? 0 : vybrane.size)} → ${a.out}`);
    console.log(`   Další krok: node backend/scripts/seed-kb.js --agent resersnik --dir "${a.out}" --token-file ~/.lexislocal/api_token`);
}

// --- NALUS ------------------------------------------------------------------------
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

function spanText(html, id) {
    const m = new RegExp(`<span[^>]*id="${id}"[^>]*>([\\s\\S]*?)</span>`, 'i').exec(html);
    return m ? htmlToText(m[1]) : '';
}

/** „ze dne 31. 8. 2026" → „31.08.2026". */
function nalusDate(s) {
    const m = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(String(s || ''));
    return m ? `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3]}` : '';
}

/** sz „2-1155-26_1" + rok rozhodnutí → ECLI „ECLI:CZ:US:2026:2.US.1155.26.1". */
function ecliFromSz(sz, rok) {
    const m = /^(Pl|St|[1-4])-(\d+)-(\d+)_(\d+)$/i.exec(String(sz || ''));
    if (!m || !rok) return '';
    const sen = /^pl$/i.test(m[1]) ? 'Pl.US' : /^st$/i.test(m[1]) ? 'Pl.US-st' : `${m[1]}.US`;
    return `ECLI:CZ:US:${rok}:${sen}.${m[2]}.${m[3]}.${m[4]}`;
}

/** HTML stránky GetText.aspx → { spisZn, datum, typ, popularniNazev, text }. */
function parseNalusText(html, url) {
    const reg = spanText(html, 'lblRegistrySign'); // „II.ÚS 1155/26 ze dne 31. 8. 2026"
    const spisZn = formatSpZn(reg.replace(/\s+ze dne.*$/i, ''));
    const datum = nalusDate(reg);
    const form = spanText(html, 'lblDecisionForm');
    const typ = form ? form.charAt(0) + form.slice(1).toLowerCase() : '';
    // Text rozhodnutí = buňka DocContent až po spodní tlačítko „Tisk" (horní má id btnPrint2).
    const i = html.search(/class="DocContent"/i);
    let end;
    if (i >= 0) {
        const j = html.slice(i).search(/id="btnPrint"/i);
        if (j >= 0) end = html.lastIndexOf('<', i + j); // začátek tagu tlačítka
    }
    const text = i >= 0 ? htmlToText(html.slice(i + 'class="DocContent"'.length + 1, end)) : '';
    const sz = (/[?&]sz=([^&#]+)/.exec(String(url || '')) || [])[1] || '';
    const rok = parseInt(datum.slice(-4), 10) || 0;
    return { spisZn, datum, typ, popularniNazev: spanText(html, 'lblPopularName'), text, ecli: ecliFromSz(sz, rok), rok, url };
}

/** Odkazy na rozhodnutí (GetText.aspx?sz=…) ve výsledcích vyhledávání. */
function resultLinks(html) {
    const out = new Set();
    for (const m of String(html || '').matchAll(/GetText\.aspx\?sz=([A-Za-z0-9_-]+)/g)) out.add(m[1]);
    return [...out];
}

function hiddenFields(html) {
    const o = {};
    for (const m of String(html || '').matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
        const n = /name="([^"]+)"/.exec(m[0]); const v = /value="([^"]*)"/.exec(m[0]);
        if (n) o[n[1]] = v ? v[1].replace(/&amp;/g, '&') : '';
    }
    return o;
}

function curl(args) {
    return execFileSync('curl', ['-sS', '-L', '--fail', '--max-time', '90', '-A', UA, ...args],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// --- Výsledky vyhledávání NALUS ------------------------------------------------------
function _cells(rowHtml) {
    // Buňky datového řádku mají class='resultData0|1', některé řádky ale nemají třídu vůbec
    // (nález I. ÚS 1937/24 na 3. stránce výsledků) — bereme každé <td> kromě tlačítek akcí.
    return [...String(rowHtml).matchAll(/<td\b(?![^>]*resultActions)[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
}
function _parts(cellHtml) {
    return String(cellHtml || '').split(/<br\s*\/?>/i).map(p => htmlToText(p)).filter(Boolean);
}
const RIMSKE = { I: 1, II: 2, III: 3, IV: 4 };
/** „IV.ÚS 729/23 #1" → sz „4-729-23_1"; „Pl.ÚS 5/24 #1" → „Pl-5-24_1"; „Pl.ÚS-st. 60/24 #1" → „St-60-24_1". */
function szFromNalusZn(zn) {
    const m = /^(I{1,3}|IV|Pl)\.\s*ÚS(-st\.?)?\s+(\d+)\/(\d+)(?:\s*#(\d+))?/i.exec(String(zn || '').trim());
    if (!m) return '';
    const pre = m[2] ? 'St' : (/^pl$/i.test(m[1]) ? 'Pl' : RIMSKE[m[1].toUpperCase()]);
    return `${pre}-${m[3]}-${m[4]}_${m[5] || 1}`;
}
/** „Zemanová Daniela" → „Daniela Zemanová" (NALUS řadí příjmení napřed). */
function jmenoSoudce(s) {
    const w = String(s || '').trim().split(/\s+/);
    return w.length === 2 ? `${w[1]} ${w[0]}` : w.join(' ');
}

/**
 * Stránka výsledků NALUS → { total, items }. Metadata jsou v tabulce výsledků
 * (sp. zn., SbNU, ECLI, soudce zpravodaj, navrhovatel, populární název, data,
 * předpisy, forma + význam, výrok, předmět a rejstřík).
 */
function parseResultsPage(html) {
    const h = String(html || '');
    const total = parseInt((/z celkem\s+(\d+)/.exec(htmlToText(h)) || [])[1], 10) || 0;
    const items = [];
    for (const row of h.matchAll(/<tr class='resultData[01]'>([\s\S]*?)<\/tr>/g)) {
        const c = _cells(row[1]);
        if (c.length < 7 || !/ResultDetail\.aspx/.test(c[1])) continue;
        const id = _parts(c[1]);
        const znRaw = id[0] || '';
        const ecli = id.find(p => /^ECLI:/.test(p)) || '';
        const sbnu = id.find(p => /SbNU|\bSb\./.test(p) && !/^ECLI:/.test(p)) || '';
        const soudce = id.slice(1).filter(p => p !== ecli && p !== sbnu).pop() || '';
        // Navrhovatelé a populární název odděluje prázdný řádek (<br /><br />); navrhovatelů může být víc.
        const [navHtml, ...nazevHtml] = String(c[2] || '').split(/<br\s*\/?>\s*<br\s*\/?>/i);
        const dates = _parts(c[3]);
        const forma = _parts(c[5]);
        const zn = znRaw.replace(/\s*#\d+\s*$/, '');
        const zEcli = spZnFromEcli(ecli);
        items.push({
            spisZn: formatSpZn(zn) || (zEcli ? zEcli.spisZn : ''),
            poradi: (/#(\d+)/.exec(znRaw) || [])[1] || (zEcli ? zEcli.poradi : '1'),
            sz: szFromNalusZn(znRaw),
            sbnu,
            ecli,
            soudceZpravodaj: jmenoSoudce(soudce),
            navrhovatel: _parts(navHtml).join('; '),
            popularniNazev: _parts(nazevHtml.join('<br/>')).join(' '),
            datum: nalusDate(dates[0]),
            datumVyhlaseni: nalusDate((dates.find(d => /^\(/.test(d)) || '')),
            rok: parseInt(nalusDate(dates[0]).slice(-4), 10) || 0,
            predpisy: _parts(c[4]).map(pojmenujPredpis),
            typ: forma[0] || '',
            vyznam: parseInt(forma[1], 10) || 0,
            vyrok: _parts(c[6]),
            rejstrik: c[8] ? _parts(c[8]) : [],
        });
    }
    return { total, items };
}

/** Metadata z výsledků + text ze stránky rozhodnutí → objekt pro header(). */
function nalusMeta(it, url) {
    return {
        ecli: it.ecli, spisZn: it.spisZn, poradi: it.poradi, typ: it.typ, popularniNazev: it.popularniNazev,
        datum: it.datum, rok: it.rok, datumVyhlaseni: it.datumVyhlaseni, vyznam: it.vyznam, typRizeni: '',
        soudceZpravodaj: it.soudceZpravodaj, formace: /^Pl/.test(it.spisZn) ? 'plénum' : (/^([IV]+)\./.exec(it.spisZn) || [])[1] ? `${/^([IV]+)\./.exec(it.spisZn)[1]}. senát` : '',
        vyrok: it.vyrok, napadenyAkt: [], ustavniPredpisy: [], predpisy: it.predpisy, predmet: [],
        rejstrik: it.rejstrik, odlisneStanovisko: [], sbnu: it.sbnu, url, zdrojDat: 'nalus',
    };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Odešle vyhledávací formulář (nálezy + stanoviska pléna od data) a vrátí HTML 1. stránky výsledků. */
async function nalusSearch(a, jar) {
    const form = curl(['-c', jar, '-b', jar, `${NALUS}/Search/Search.aspx`]);
    const fields = Object.assign(hiddenFields(form), nalusTypeFields(a), {
        'ctl00$MainContent$decidedFrom': a.od || '01.01.2024',
        'ctl00$MainContent$razeni': '3',
        'ctl00$MainContent$resultsPageSize': '80',
        'ctl00$MainContent$but_search': 'Vyhledat',
    });
    if (a.do) fields['ctl00$MainContent$decidedTo'] = a.do;
    const data = [];
    for (const [k, v] of Object.entries(fields)) data.push('--data-urlencode', `${k}=${v}`);
    await sleep(a.delay);
    return curl(['-c', jar, '-b', jar, ...data, `${NALUS}/Search/Search.aspx`]);
}

/** Zaškrtávací pole formuláře NALUS (nezaškrtnuté se neposílá): nálezy + stanoviska pléna,
 *  nebo s --usneseni jen usnesení; --jen-publikovana = jen publikovaná ve Sbírce nálezů a usnesení. */
function nalusTypeFields(a) {
    const f = a.usneseni ? { 'ctl00$MainContent$usneseni': 'on' }
        : { 'ctl00$MainContent$nalezy': 'on', 'ctl00$MainContent$stanoviska_plena': 'on' };
    if (a.jenPublikovana) f['ctl00$MainContent$jen_publikovana'] = 'on';
    return f;
}

/**
 * Plné texty z datasetu CCC pro rozhodnutí, která NALUS najde, ale text nemá (26. 10. 2026:
 * 491 ze 743 publikovaných usnesení, hlavně 90. léta). Hlavička z NALUS (SbNU, populární
 * název), text z CCC (s citací datasetu). Párování podle ECLI.
 */
async function textyZCcc(list, a, existing) {
    const byEcli = new Map();
    for (const x of list) {
        const ecli = x.it.ecli || ecliFromSz(x.it.sz, x.it.rok);
        if (ecli) byEcli.set(ecli, x);
    }
    console.log(`📝 Doplňuji ${byEcli.size} textů z datasetu CCC (${path.basename(a.ccc)})…`);
    let saved = 0;
    await readCsv(a.ccc, 'ccc_texts.csv', r => {
        const x = byEcli.get(r.doc_id);
        if (!x) return;
        byEcli.delete(r.doc_id);
        const text = cleanText(r.text);
        if (text.length < 200) return;
        const m = Object.assign(nalusMeta(x.it, x.url), { ecli: r.doc_id, zdrojDat: 'nalus+ccc' });
        const name = fileNameFor(m);
        if (existing.has(name)) return;
        fs.writeFileSync(path.join(a.out, name), header(m) + text + '\n');
        existing.add(name);
        saved++;
        if (byEcli.size === 0) return false;
    });
    console.log(`   z CCC doplněno ${saved}, bez textu i v CCC ${byEcli.size}`);
    return { saved };
}

/** Soubor vznikl z NALUS (ne z datasetu) — jen takové smí --prepsat přepsat. */
function _zNalus(file) {
    try { return !/^Data: /m.test(fs.readFileSync(file, 'utf8').slice(0, 8000)); } catch (e) { return false; }
}

async function importNalus(a) {
    const jar = path.join(os.tmpdir(), `nalus_${process.pid}.cookies`);
    fs.mkdirSync(a.out, { recursive: true });
    const existing = new Set(fs.readdirSync(a.out));
    let saved = 0, already = 0, failed = 0, filtered = 0, bezMeta = 0, kratky = 0;
    const bezTextu = []; // NALUS u starších usnesení plný text nemá → doplnit z datasetu CCC (--ccc)
    try {
        console.log(`🔎 NALUS: ${a.usneseni ? 'usnesení' : 'nálezy a stanoviska pléna'}${a.jenPublikovana ? ' (jen publikovaná ve SbNU)' : ''} od ${a.od || '01.01.2024'}${a.do ? ` do ${a.do}` : ''}…`);
        const prvni = await nalusSearch(a, jar);
        let page = Object.assign(parseResultsPage(prvni), { html: prvni });
        const total = page.total;
        console.log(`   nalezeno ${total}`);
        const items = page.items.slice();
        const zkontroluj = (html, p, n) => {
            // Každý výsledek má odkaz ResultDetail.aspx; když jich je víc než rozpoznaných řádků,
            // uložíme stránku pro ladění parseru (scratch/nalus_page_<p>.html).
            const odkazu = (String(html).match(/ResultDetail\.aspx\?id=/g) || []).length;
            if (odkazu > n) {
                fs.mkdirSync('scratch', { recursive: true });
                fs.writeFileSync(path.join('scratch', `nalus_page_${p}.html`), html);
                console.log(`  ⚠️ stránka ${p + 1}: rozpoznáno ${n} z ${odkazu} výsledků → scratch/nalus_page_${p}.html`);
            }
        };
        zkontroluj(page.html, 0, page.items.length);
        for (let p = 1; items.length < total && p < 1000; p++) {
            await sleep(a.delay);
            const html = curl(['-c', jar, '-b', jar, `${NALUS}/Search/Results.aspx?page=${p}`]);
            page = parseResultsPage(html);
            zkontroluj(html, p, page.items.length);
            if (!page.items.length) break;
            items.push(...page.items);
        }
        console.log(`   metadata ${items.length}/${total}`);
        for (const it of items) {
            if (a.limit && saved >= a.limit) break;
            if (!it.spisZn || !it.sz) { failed++; if (++bezMeta <= 3) console.log(`  ⚠️ řádek bez sp. zn./odkazu: ${JSON.stringify({ spisZn: it.spisZn, sz: it.sz, typ: it.typ, datum: it.datum }).slice(0, 200)}`); continue; }
            if (a.typy && a.typy.length && !a.typy.includes(it.typ)) { filtered++; continue; }
            const name = fileNameFor(it);
            if (existing.has(name) && !(a.prepsat && _zNalus(path.join(a.out, name)))) { already++; continue; }
            const url = `${NALUS}/Search/GetText.aspx?sz=${it.sz}`;
            await sleep(a.delay);
            let d;
            try { d = parseNalusText(curl(['-b', jar, url]), url); }
            catch (e) {
                await sleep(a.delay * 5); // jedno opakování po delší pauze (výpadek / přetížení)
                try { d = parseNalusText(curl(['-b', jar, url]), url); }
                catch (e2) { console.log(`  ⚠️ ${it.spisZn}: ${String(e2.stderr || e2.message).trim().split('\n')[0]}`); failed++; continue; }
            }
            if (!d.text || d.text.length < 200) { bezTextu.push({ it, url }); failed++; if (++kratky <= 3) console.log(`  ⚠️ ${it.spisZn}: text ${d.text ? d.text.length : 0} znaků (${url})`); continue; }
            const m = nalusMeta(it, url);
            if (!m.ecli) m.ecli = d.ecli;
            fs.writeFileSync(path.join(a.out, name), header(m) + d.text + '\n');
            existing.add(name);
            saved++;
            if (saved % 25 === 0) console.log(`  … ${saved} uloženo`);
        }
        if (bezTextu.length && a.ccc && fs.existsSync(a.ccc)) {
            const r2 = await textyZCcc(bezTextu, a, existing);
            saved += r2.saved; failed -= r2.saved; kratky -= r2.saved;
        } else if (bezTextu.length) console.log(`   ${bezTextu.length} rozhodnutí NALUS nemá s plným textem — doplníte z datasetu CCC: přidejte --ccc <ccc_database.zip>`);
    } finally {
        try { fs.unlinkSync(jar); } catch (e) { /* best-effort */ }
    }
    console.log(`✅ Uloženo ${saved}, už staženo ${already}, mimo filtr ${filtered}, selhalo ${failed}${failed ? ` (bez sp. zn./odkazu ${bezMeta}, krátký text ${kratky}, chyba stažení ${failed - bezMeta - kratky})` : ''} → ${a.out}`);
    console.log(`   Další krok: node backend/scripts/seed-kb.js --agent resersnik --dir "${a.out}" --token-file ~/.lexislocal/api_token`);
}

async function nalusProbe(a) {
    const od = a.od || '01.01.2024';
    const jar = path.join(os.tmpdir(), `nalus_${process.pid}.cookies`);
    const outDir = path.join(process.cwd(), 'scratch');
    fs.mkdirSync(outDir, { recursive: true });
    try {
        const form = curl(['-c', jar, '-b', jar, `${NALUS}/Search/Search.aspx`]);
        const fields = Object.assign(hiddenFields(form), {
            'ctl00$MainContent$nalezy': 'on',
            'ctl00$MainContent$stanoviska_plena': 'on',
            'ctl00$MainContent$decidedFrom': od,
            'ctl00$MainContent$razeni': '3',
            'ctl00$MainContent$resultsPageSize': '80',
            'ctl00$MainContent$but_search': 'Vyhledat',
        });
        const data = [];
        for (const [k, v] of Object.entries(fields)) data.push('--data-urlencode', `${k}=${v}`);
        await new Promise(r => setTimeout(r, a.delay));
        const res = curl(['-c', jar, '-b', jar, ...data, `${NALUS}/Search/Search.aspx`]);
        fs.writeFileSync(path.join(outDir, 'nalus_results.html'), res);
        const links = resultLinks(res);
        const pocet = (/(?:Nalezeno|Počet)[^0-9]{0,40}(\d[\d\s]*)/i.exec(htmlToText(res)) || [])[1];
        console.log(`Výsledky uloženy do scratch/nalus_results.html — odkazů na rozhodnutí: ${links.length}${pocet ? `, hlášený počet: ${pocet.trim()}` : ''}`);
        console.log(links.slice(0, 5).map(s => `  ${NALUS}/Search/GetText.aspx?sz=${s}`).join('\n'));
        if (links.length) {
            await new Promise(r => setTimeout(r, a.delay));
            const url = `${NALUS}/Search/GetText.aspx?sz=${links[0]}`;
            const d = parseNalusText(curl(['-b', jar, url]), url);
            console.log('UKÁZKA:', JSON.stringify({ ...d, text: d.text.slice(0, 200) + '…', textLen: d.text.length }, null, 2));
        }
        console.log('\n→ Pošli mi zprávu, podle scratch/nalus_results.html doladím stránkování a stahování.');
    } finally {
        try { fs.unlinkSync(jar); } catch (e) { /* best-effort */ }
    }
}

async function main() {
    const a = parseArgs(process.argv);
    if (a.help || (!a.ccc && !a.nalusProbe && !a.nalus)) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(a.help ? 0 : 1); }
    if (a.nalusProbe) return nalusProbe(a);
    if (a.nalus) return importNalus(a);
    return importCcc(a);
}

if (require.main === module) main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });

module.exports = {
    nalusTypeFields, parseArgs, textyZCcc,
    CsvParser, parseCsv, readCsv, rVector, formatSpZn, czDate, metaFromRow, matches, header, cleanText,
    fileNameFor, spZnFromEcli, parseResultsPage, szFromNalusZn, jmenoSoudce, nalusMeta, pojmenujPredpis, parseNalusText, resultLinks, hiddenFields, ecliFromSz, nalusDate, importCcc,
};
