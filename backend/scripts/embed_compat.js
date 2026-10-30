#!/usr/bin/env node
/**
 * embed_compat.js — shoda vektorů: bge-m3 v Ollamě × bge-m3 v aplikaci (ONNX, lib/local_embed.js).
 *
 *   node backend/scripts/embed_compat.js [--out soubor.md] [--host http://127.0.0.1:11434]
 *
 * Režim „jen cloud“ (bez Ollamy) počítá vektory dotazů v aplikaci, ale báze zákonů a judikatury je spočítaná
 * Ollamou. Funguje to jen, když oba dávají (téměř) stejné vektory. Skript porovná kosinovou podobnost na
 * syntetických právních textech a dotazech a ověří, že pořadí nejbližších textů zůstane stejné.
 * Hotovo, když: průměr ≥ 0,99, minimum ≥ 0,98 a top-3 se shoduje u ≥ 90 % dotazů.
 */
'use strict';
const fs = require('fs');

const TEXTY = [
    'Nepřiměřeně vysokou smluvní pokutu může soud na návrh dlužníka snížit, a to až do výše škody vzniklé do doby soudního rozhodnutí.',
    'Promlčecí lhůta trvá tři roky. Běží ode dne, kdy se oprávněná strana dozvěděla o okolnostech rozhodných pro počátek jejího běhu.',
    'Odvolání se podává do patnácti dnů od doručení písemného vyhotovení rozhodnutí u soudu, proti jehož rozhodnutí směřuje.',
    'Pronajímatel může vypovědět nájem na dobu neurčitou v tříměsíční výpovědní době, poruší-li nájemce hrubě svou povinnost.',
    'Kdo způsobí jinému újmu porušením dobrých mravů, je povinen ji nahradit; náhrada škody se hradí uvedením v předešlý stav.',
    'Zhotovitel odpovídá za vady díla, které má dílo při předání; objednatel má práva z vadného plnění.',
    'Platební rozkaz lze napadnout odporem do patnácti dnů od jeho doručení; odpor musí být odůvodněn.',
    'Dědic odpovídá za dluhy zůstavitele do výše ceny nabytého dědictví, uplatnil-li výhradu soupisu.',
    'Zaměstnavatel může dát zaměstnanci výpověď jen z důvodů výslovně stanovených zákonem.',
    'Soud rozhodne o úpravě poměrů nezletilého dítěte s přihlédnutím k jeho nejlepšímu zájmu.',
    'Rozhodčí doložka musí být sjednána písemně; ve spotřebitelských sporech platí zvláštní požadavky.',
    'Jednostranné zvýšení nájemného je možné jen za podmínek stanovených zákonem nebo ujednáním stran.',
    'Insolvenční návrh může podat dlužník nebo věřitel; k návrhu věřitele se připojí přihláška pohledávky.',
    'Správní žaloba se podává do dvou měsíců od doručení rozhodnutí odvolacího správního orgánu.',
    'Ústavní stížnost lze podat do dvou měsíců od doručení rozhodnutí o posledním procesním prostředku.'
];
const DOTAZY = [
    ['Jak soud posuzuje přiměřenost smluvní pokuty?', 0],
    ['Za jak dlouho se promlčí pohledávka?', 1],
    ['Jaká je lhůta k odvolání proti rozsudku?', 2],
    ['Kdy může pronajímatel vypovědět byt?', 3],
    ['Odpovědnost zhotovitele za vady stavby', 5],
    ['Jak se bránit platebnímu rozkazu?', 6],
    ['Ručí dědic za dluhy zemřelého?', 7],
    ['Výpověď ze strany zaměstnavatele', 8],
    ['Péče o dítě po rozvodu rodičů', 9],
    ['Lhůta pro ústavní stížnost', 14]
];

function args(argv) {
    const o = { out: null, host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', model: process.env.EMBEDDING_MODEL || 'bge-m3' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') o.out = argv[++i];
        else if (argv[i] === '--host') o.host = argv[++i];
        else if (argv[i] === '--model') o.model = argv[++i];
    }
    if (!/^https?:\/\//.test(o.host)) o.host = 'http://' + o.host;
    return o;
}
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); };
const top = (q, vs, k) => vs.map((v, i) => [cos(q, v), i]).sort((x, y) => y[0] - x[0]).slice(0, k).map(x => x[1]);

async function main() {
    const O = args(process.argv.slice(2));
    const ollama = async t => { const r = await fetch(O.host + '/api/embeddings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: O.model, prompt: t }) }); const j = await r.json(); if (!j.embedding) throw new Error('Ollama: ' + JSON.stringify(j).slice(0, 200)); return j.embedding; };
    const onnx = async t => (await require('../lib/local_embed').embeddings({ prompt: t })).embedding;
    const all = TEXTY.concat(DOTAZY.map(d => d[0]));
    const t0 = Date.now();
    const vO = []; for (const t of all) vO.push(await ollama(t));
    const t1 = Date.now();
    const vX = []; for (const t of all) vX.push(await onnx(t));
    const t2 = Date.now();
    const sims = all.map((t, i) => cos(vO[i], vX[i]));
    const avg = sims.reduce((a, b) => a + b, 0) / sims.length, min = Math.min(...sims);
    let shoda3 = 0, spravneO = 0, spravneX = 0;
    DOTAZY.forEach(([, gold], j) => {
        const i = TEXTY.length + j;
        const a = top(vO[i], vO.slice(0, TEXTY.length), 3), b = top(vX[i], vO.slice(0, TEXTY.length), 3); // dotaz ONNX × báze Ollama
        if (a.join() === b.join()) shoda3++;
        if (a[0] === gold) spravneO++;
        if (b[0] === gold) spravneX++;
    });
    const ok = avg >= 0.99 && min >= 0.98 && shoda3 / DOTAZY.length >= 0.9;
    const L = ['# Shoda vektorů: Ollama × model v aplikaci (ONNX)', '',
        `- Model: ${O.model} (Ollama) × ${require('../lib/local_embed').MODEL_ID} (${require('../lib/local_embed').DTYPE}), rozměr ${vO[0].length} / ${vX[0].length}`,
        `- Kosinová podobnost (${all.length} textů): průměr **${avg.toFixed(4)}**, minimum **${min.toFixed(4)}**`,
        `- Top-3 nejbližších textů (dotaz z aplikace proti bázi z Ollamy) shodné: **${shoda3}/${DOTAZY.length}**; správně na 1. místě Ollama ${spravneO}/${DOTAZY.length}, aplikace ${spravneX}/${DOTAZY.length}`,
        `- Čas: Ollama ${((t1 - t0) / all.length).toFixed(0)} ms/text, aplikace (CPU) ${((t2 - t1) / all.length).toFixed(0)} ms/text (vč. načtení modelu)`,
        `- Výsledek: ${ok ? '✅ kompatibilní — báze z Ollamy jde použít i bez Ollamy' : '❌ NEKOMPATIBILNÍ — bázi je potřeba přepočítat modelem v aplikaci'}`];
    console.log(L.join('\n'));
    if (O.out) fs.writeFileSync(O.out, L.join('\n') + '\n');
    process.exit(ok ? 0 : 2);
}
main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
