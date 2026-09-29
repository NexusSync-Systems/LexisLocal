#!/usr/bin/env node
/**
 * split-zakon.js — rozdělí celý zákon (text z e-Sbírky) na soubory PO PARAGRAFECH,
 * připravené pro znalostní bázi Rešeršníka (seed-kb.js).
 *
 * Proč: nahrát celý zákoník jako jeden dokument znamená, že RAG vrací útržky bez
 * označení paragrafu — model pak paragraf „dopočítá" (= vymyslí). Když má každý §
 * vlastní dokument s hlavičkou „Zákon č. 89/2012 Sb. — § 629", pasáž z báze nese
 * přesnou citaci a model ji jen převezme.
 *
 * Vstup: .txt (UTF-8) nebo .docx (na macOS se převede vestavěným `textutil`).
 *   Text zákona stáhni z e-Sbírky (e-sbirka.gov.cz → předpis → Stáhnout/Export),
 *   případně otevři ve Wordu a ulož jako „Prostý text (UTF-8)".
 *
 * Použití:
 *   node backend/scripts/split-zakon.js --in ~/Downloads/89-2012.docx --zkratka OZ \
 *        --cislo 89/2012 --nazev "občanský zákoník" --zneni 2026-09-01 --out ./zakony/OZ
 *   node backend/scripts/split-zakon.js --in osr.txt --zkratka OSŘ --cislo 99/1963 \
 *        --nazev "občanský soudní řád" --out ./zakony/OSR --dry-run
 * Pak:
 *   node backend/scripts/seed-kb.js --agent resersnik --dir ./zakony/OZ
 *
 * Přepínače: --group N (spojí N po sobě jdoucích § do jednoho souboru, méně uploadů;
 *            výchozí 1 = každý § zvlášť)  --dry-run (jen statistika, nic nezapíše)
 * Bez závislostí — Node ≥ 18. Zákony jsou úřední díla (nechráněná autorským právem).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs(argv) {
    const a = { group: 1, dryRun: false };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--in') a.in = next();
        else if (k === '--out') a.out = next();
        else if (k === '--zkratka') a.zkratka = next();
        else if (k === '--cislo') a.cislo = next();
        else if (k === '--nazev') a.nazev = next();
        else if (k === '--zneni') a.zneni = next();
        else if (k === '--group') a.group = Math.max(1, parseInt(next(), 10) || 1);
        else if (k === '--dry-run') a.dryRun = true;
        else if (k === '--help' || k === '-h') a.help = true;
    }
    return a;
}

const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/** Načte text ze .txt / .docx (docx přes macOS textutil). */
function readText(file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.docx' || ext === '.doc' || ext === '.rtf') {
        const { execFileSync } = require('child_process');
        try {
            return execFileSync('textutil', ['-convert', 'txt', '-stdout', file], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
        } catch (e) {
            throw new Error(`Převod ${ext} selhal (${e.message.split('\n')[0]}). Na macOS by měl fungovat \`textutil\`; jinak ulož soubor ve Wordu jako prostý text (.txt, UTF-8).`);
        }
    }
    return fs.readFileSync(file, 'utf8');
}

// Samostatný řádek s označením paragrafu: „§ 629", „§ 1970a", případně s textem hned za ním.
const PARA_RE = /^\s*§\s*(\d+[a-z]?)\s*(?:$|(?=\(\d|[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]))/;
// Nadpisy struktury zákona — nejsou součástí textu paragrafu.
const STRUCT_RE = /^\s*(ČÁST|HLAVA|Díl|Oddíl|Pododdíl)\s+([\dIVXLC]+|[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]+)\b/;

/** Krátký řádek bez koncové interpunkce = pravděpodobně nadpis (např. „Promlčecí lhůty"). */
function isHeadingLine(line) {
    const t = line.trim();
    return t.length > 0 && t.length <= 90 && !/[.;:,]$/.test(t) && !/^\(\d+\)/.test(t) && !/^[a-z]\)/.test(t) && !PARA_RE.test(t);
}

/**
 * Rozdělí text zákona na paragrafy. Vrací [{ num, title, struct, text }].
 * Nadpis (krátké řádky těsně před „§ N") se přesune z konce předchozího § jako `title`
 * následujícího; nadpisy struktury (ČÁST/HLAVA/Díl…) se drží jako kontext `struct`.
 */
function splitParagraphs(raw) {
    const lines = raw.replace(/\r\n?/g, '\n').replace(/ /g, ' ').split('\n');
    const paras = [];
    const struct = {};
    let cur = null;
    let pending = []; // řádky před prvním § / kandidáti na nadpis
    let structNameFor = null; // úroveň struktury, jejíž název (další řádek) ještě čekáme
    const structLabel = () => ['ČÁST', 'HLAVA', 'Díl', 'Oddíl', 'Pododdíl'].filter(k => struct[k]).map(k => struct[k]).join(' › ');

    for (const line of lines) {
        const sm = line.match(STRUCT_RE);
        if (sm) {
            // nová úroveň struktury → nižší úrovně se nulují
            const order = ['ČÁST', 'HLAVA', 'Díl', 'Oddíl', 'Pododdíl'];
            const lvl = order.indexOf(sm[1]);
            order.slice(lvl + 1).forEach(k => { delete struct[k]; });
            struct[sm[1]] = line.trim();
            structNameFor = sm[1];
            pending = []; // úvod dokumentu (název zákona apod.) není nadpis prvního §
            continue;
        }
        // Název úrovně struktury („HLAVA II" ↵ „Závěrečná ustanovení") patří ke struktuře, ne k §.
        if (structNameFor && line.trim()) {
            if (isHeadingLine(line) && !PARA_RE.test(line)) {
                struct[structNameFor] += ' ' + line.trim();
                structNameFor = null;
                continue;
            }
            structNameFor = null;
        }
        const pm = line.match(PARA_RE);
        if (pm) {
            // Nadpis = souvislý blok krátkých řádků na konci předchozího textu.
            const source = cur ? cur.lines : pending;
            const title = [];
            while (source.length && source[source.length - 1].trim() === '') source.pop();
            while (source.length && isHeadingLine(source[source.length - 1]) && title.length < 3) title.unshift(source.pop().trim());
            // Poslední „řádek" předchozího § nesmí být celý text — pokud by v něm nic nezbylo, nadpis tam vrať.
            if (cur && !cur.lines.some(l => l.trim())) { cur.lines.push(...title); title.length = 0; }
            cur = { num: pm[1], title: title.join(' – '), struct: structLabel(), lines: [] };
            const rest = line.slice(pm[0].length).trim();
            if (rest) cur.lines.push(rest);
            paras.push(cur);
            pending = [];
            continue;
        }
        (cur ? cur.lines : pending).push(line);
    }
    return paras.map(p => ({
        num: p.num, title: p.title, struct: p.struct,
        text: p.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    })).filter(p => p.text);
}

/** Kontrola rozumnosti: čísla § by měla většinou stoupat (jinak jde nejspíš o odkazy v textu). */
function sequenceReport(paras) {
    let drops = 0;
    for (let i = 1; i < paras.length; i++) if (parseInt(paras[i].num, 10) < parseInt(paras[i - 1].num, 10)) drops++;
    const dup = paras.length - new Set(paras.map(p => p.num)).size;
    return { drops, dup };
}

function fileSafe(s) { return String(s).replace(/[\/\\:*?"<>|]/g, '-'); }

function renderDoc(a, group) {
    const head = `Zákon č. ${a.cislo} Sb., ${a.nazev}${a.zneni ? ` (znění ke dni ${a.zneni})` : ''}`;
    const body = group.map(p => {
        const h = `§ ${p.num}${p.title ? ` — ${p.title}` : ''}`;
        return `${h}\n${p.struct ? `(${p.struct})\n` : ''}\n${p.text}`;
    }).join('\n\n');
    return `${head}\n${body}\n\nCitace: ${group.map(p => `§ ${p.num} zákona č. ${a.cislo} Sb.`).join('; ')}\nZdroj: e-Sbírka (úřední znění).\n`;
}

function main() {
    const a = parseArgs(process.argv);
    if (a.help || !a.in || !a.zkratka || !a.cislo || !a.nazev || (!a.out && !a.dryRun)) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(a.help ? 0 : 1);
    }
    const input = expandHome(a.in);
    const raw = readText(input);
    const paras = splitParagraphs(raw);
    const { drops, dup } = sequenceReport(paras);

    console.log(`📖 ${a.zkratka} (${a.cislo}): nalezeno ${paras.length} paragrafů` +
        (paras.length ? `, § ${paras[0].num} … § ${paras[paras.length - 1].num}` : ''));
    if (paras.length < 5) console.log('⚠️  Málo paragrafů — je to opravdu celý text zákona? Každé „§ N" by mělo být na samostatném řádku.');
    if (drops > paras.length * 0.02) console.log(`⚠️  ${drops}× klesá číslo § — část „§" jsou možná odkazy v textu, zkontroluj výstup.`);
    if (dup) console.log(`ℹ️  ${dup} duplicitních čísel § (např. přechodná ustanovení novel) — soubory dostanou pořadové číslo.`);

    const groups = [];
    for (let i = 0; i < paras.length; i += a.group) groups.push(paras.slice(i, i + a.group));

    if (a.dryRun) {
        const sample = paras.find(p => p.title) || paras[0];
        if (sample) console.log('\n— ukázka —\n' + renderDoc(a, [sample]).slice(0, 800));
        console.log(`\n(dry-run) Zapsalo by se ${groups.length} souborů.`);
        return;
    }

    const outDir = expandHome(a.out);
    fs.mkdirSync(outDir, { recursive: true });
    const seen = new Map();
    for (const g of groups) {
        const first = g[0].num, last = g[g.length - 1].num;
        const pad = (n) => String(n).replace(/^(\d+)/, m => m.padStart(4, '0'));
        let name = `${fileSafe(a.zkratka)} ${fileSafe(a.cislo)} § ${pad(first)}${g.length > 1 ? `-${pad(last)}` : ''}`;
        const n = (seen.get(name) || 0) + 1; seen.set(name, n);
        if (n > 1) name += ` (${n})`;
        fs.writeFileSync(path.join(outDir, name + '.txt'), renderDoc(a, g), 'utf8');
    }
    console.log(`✅ Zapsáno ${groups.length} souborů do ${outDir}`);
    console.log(`   Další krok: node backend/scripts/seed-kb.js --agent resersnik --dir "${outDir}"`);
}

if (require.main === module) {
    try { main(); } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
}

module.exports = { splitParagraphs, sequenceReport, renderDoc, isHeadingLine };
