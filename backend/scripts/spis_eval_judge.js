#!/usr/bin/env node
/**
 * scripts/spis_eval_judge.js — kalibrace LLM-judge (podporuje citované místo tvrzení? ANO/NE).
 *
 *   node backend/scripts/spis_eval_judge.js --list                    # pracovní list k ručnímu označení (CSV)
 *   node backend/scripts/spis_eval_judge.js --provider mock           # kontrola skriptu (zdarma)
 *   node backend/scripts/spis_eval_judge.js --provider bedrock --model eu.anthropic.claude-sonnet-4-6 \
 *        --aws-profile lexislocal-bedrock [--oznaceni backend/eval/spis_eval/judge/kalibrace_k_oznaceni.csv] [--fewshot 8]
 *
 * Měří na sadě „kontrola“ (spisy S5–S6, judge je nikdy nevidí jako příklad): shodu s klíčem, s ručním označením
 * (když je vyplněné) a pro srovnání i deterministickou kontrolu programu (checks.hodnotCitaci). Výsledek:
 * scratch/spis-eval/judge_<čas>_<label>.json + .md. Jen syntetická data. ~35 krátkých dotazů ≈ 0,05–0,15 USD.
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const EVAL = path.join(__dirname, '..', 'eval', 'spis_eval');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const flag = k => args.includes(k);

const C = require('../eval/spis_eval/checks');
const J = require('../eval/spis_eval/judge');
const SPISY = C.nactiSpisy(path.join(EVAL, 'spisy'));
const PARY = JSON.parse(fs.readFileSync(path.join(EVAL, 'judge', 'pary.json'), 'utf8')).pary
    .map(p => Object.assign({}, p, { misto: J.textMista(SPISY[p.spis], p.kotva) }));
const LIST = path.join(EVAL, 'judge', 'kalibrace_k_oznaceni.csv');

function popisMista(p) {
    const [doc, typ, a, b] = p.kotva.split(':');
    const d = SPISY[p.spis].docs[doc];
    const rim = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
    const cl = typ === 'b' ? `bod ${a}` : `čl. ${/^Čl\.\s*[IVX]/.test(d.kotvy['cl:' + a] || '') ? rim[+a] : a}${b ? ' odst. ' + b : ''}`;
    return `${d.nazev}, ${cl}`;
}
const csv = v => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';

/** Pracovní list: pořadí zamíchané (pevně), bez klíče a druhu — aby hodnotitel nebyl ovlivněn. */
function pracovniList() {
    const radky = [...PARY].sort((x, y) => crypto.createHash('md5').update(x.id).digest('hex').localeCompare(crypto.createHash('md5').update(y.id).digest('hex')));
    const out = ['id;citované místo;text citovaného místa;tvrzení;hodnocení (ANO/NE);poznámka'];
    for (const p of radky) out.push([p.id, popisMista(p), p.misto.split('\n').slice(1).join(' '), p.tvrzeni, '', ''].map(csv).join(';'));
    fs.writeFileSync(LIST, '﻿' + out.join('\n') + '\n');
    console.log(`Pracovní list: ${LIST} (${radky.length} dvojic). Do sloupce „hodnocení“ napište ANO nebo NE — podporuje citované místo tvrzení?`);
}

function nactiOznaceni(f) {
    if (!f || !fs.existsSync(f)) return {};
    const out = {};
    const text = fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
    for (const r of text.split(/\r?\n/).slice(1)) {
        const pole = (r.match(/("([^"]|"")*"|[^;]*)(;|$)/g) || []).map(x => x.replace(/;$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
        const id = pole[0], h = String(pole[4] || '').trim().toUpperCase();
        if (/^J\d+$/.test(id) && (h === 'ANO' || h === 'NE')) out[id] = h;
    }
    return out;
}

function metriky(dvojice) {   // [{ ocek, vysl }] — ANO = pozitivní
    const m = { n: 0, shoda: 0, tp: 0, fp: 0, tn: 0, fn: 0, bez: 0 };
    for (const { ocek, vysl } of dvojice) {
        if (!vysl) { m.bez++; continue; }
        m.n++; if (ocek === vysl) m.shoda++;
        if (vysl === 'ANO') ocek === 'ANO' ? m.tp++ : m.fp++; else ocek === 'NE' ? m.tn++ : m.fn++;
    }
    m.presnost = m.n ? Math.round(1000 * m.shoda / m.n) / 10 : null;
    const po = m.n ? m.shoda / m.n : 0, pa = m.n ? (((m.tp + m.fp) * (m.tp + m.fn)) + ((m.tn + m.fn) * (m.tn + m.fp))) / (m.n * m.n) : 0;
    m.kappa = m.n && pa < 1 ? Math.round(100 * (po - pa) / (1 - pa)) / 100 : null;
    return m;
}

async function main() {
    if (flag('--list')) return pracovniList();
    const PROVIDER = String(arg('--provider', 'mock')).toLowerCase();
    if (!['bedrock', 'ollama', 'mock'].includes(PROVIDER)) throw new Error('--provider bedrock | ollama | mock');
    try { require('../lib/env_load').nacti({ cwd: ROOT }); } catch (e) { /* bez .env */ }
    if (arg('--aws-profile')) process.env.AWS_PROFILE = arg('--aws-profile');
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-judge-'));
    process.env.WATCH_DIR = path.join(TMP, 'data'); process.env.LEXIS_DATA_DIR = path.join(TMP, 'settings'); process.env.LEXIS_KEY_DIR = path.join(TMP, 'key');
    fs.mkdirSync(process.env.WATCH_DIR, { recursive: true });
    delete process.env.LEXIS_PILOT_LOCAL_ONLY; delete process.env.AI_LOCAL_ONLY;
    if (PROVIDER === 'bedrock') { process.env.AI_CHAT_PROVIDER = 'bedrock'; process.env.LEXIS_JEN_CLOUD = '1'; if (arg('--model')) process.env.BEDROCK_MODEL_ID = arg('--model'); }
    else { process.env.AI_CHAT_PROVIDER = 'ollama'; delete process.env.LEXIS_JEN_CLOUD; if (arg('--model')) process.env.CHAT_MODEL = arg('--model'); }
    const ai = require('../lib/ai_provider');
    const P = require('../lib/cloud_policy');
    if (PROVIDER === 'bedrock') {
        try { const c = await require('../lib/bedrock').credentialsAsync(); if (!c || !c.accessKeyId) throw new Error('bez klíče'); }
        catch (e) { console.error(`❌ Bez přístupu k AWS (${String(e.message || e).slice(0, 160)}). Použijte --aws-profile <profil>.`); process.exit(2); }
    }
    const nFew = parseInt(arg('--fewshot', '8'), 10);
    const priklady = J.vyberPriklady(PARY, Number.isFinite(nFew) ? nFew : 8);
    const sada = arg('--sada', 'kontrola') === 'vse' ? PARY : PARY.filter(p => p.sada === 'kontrola');
    const oznaceni = nactiOznaceni(arg('--oznaceni', LIST));
    const model = PROVIDER === 'bedrock' ? process.env.BEDROCK_MODEL_ID : PROVIDER === 'mock' ? 'mock' : process.env.CHAT_MODEL;
    const label = arg('--label', `${PROVIDER}-few${priklady.length}`);
    console.log(`Kalibrace judge — ${sada.length} dvojic · ${PROVIDER} · ${model} · příkladů ${priklady.length} · ručně označeno ${Object.keys(oznaceni).length}\n`);

    const vys = [];
    let usd = 0;
    for (const p of sada) {
        let j;
        if (PROVIDER === 'mock') j = { verdikt: p.klic, duvod: 'mock', raw: p.klic };
        else {
            try {
                j = await P.scope({ dataClass: 'verejne' }, async () => { const r = await J.posud({ ai, P, misto: p.misto, tvrzeni: p.tvrzeni, priklady, model: process.env.CHAT_MODEL }); const sh = P.shrnuti(); if (sh && sh.naklady) usd += sh.naklady.odhadUsd || 0; return r; });
            } catch (e) { j = { verdikt: null, duvod: 'chyba: ' + String(e.message || e).slice(0, 160) }; }
        }
        const [doc, ...k] = p.kotva.split(':');
        const c = C.hodnotCitaci({ raw: '', tvrzeni: p.tvrzeni, doc, cl: k[0] === 'cl' ? +k[1] : null, odst: k[0] === 'cl' && k[2] ? +k[2] : null, bod: k[0] === 'b' ? +k[1] : null }, SPISY[p.spis]);
        const program = c.podpora === 'ano' ? 'ANO' : c.podpora === 'ne' ? 'NE' : null;
        vys.push({ id: p.id, druh: p.druh, klic: p.klic, clovek: oznaceni[p.id] || null, judge: j.verdikt, duvod: j.duvod, program });
        console.log(`${j.verdikt === p.klic ? '✅' : '❌'} ${p.id} ${p.druh.padEnd(12)} klíč ${p.klic.padEnd(3)} judge ${String(j.verdikt).padEnd(4)} program ${String(program || '?').padEnd(3)}${oznaceni[p.id] ? ' člověk ' + oznaceni[p.id] : ''}`);
    }
    const s = {
        judgeKlic: metriky(vys.map(v => ({ ocek: v.klic, vysl: v.judge }))),
        programKlic: metriky(vys.map(v => ({ ocek: v.klic, vysl: v.program }))),
        judgeClovek: metriky(vys.filter(v => v.clovek).map(v => ({ ocek: v.clovek, vysl: v.judge }))),
        clovekKlic: metriky(vys.filter(v => v.clovek).map(v => ({ ocek: v.klic, vysl: v.clovek }))),
        poDruhu: {}
    };
    for (const d of [...new Set(vys.map(v => v.druh))]) s.poDruhu[d] = metriky(vys.filter(v => v.druh === d).map(v => ({ ocek: v.klic, vysl: v.judge })));
    const md = [
        `# Kalibrace LLM-judge — ${label}`, '',
        `${model} · ${priklady.length} příkladů ze sady vývoj · měřeno na ${sada.length} dvojicích (spisy S5–S6) · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ≈ ${Math.round(usd * 1e4) / 1e4} USD`, '',
        '| Srovnání | shoda | κ | FP (řekl ANO, má být NE) | FN (řekl NE, má být ANO) | nerozhodl |', '| --- | --- | --- | --- | --- | --- |',
        ...[['judge × klíč', s.judgeKlic], ['program (bez judge) × klíč', s.programKlic], ['judge × člověk', s.judgeClovek], ['člověk × klíč', s.clovekKlic]]
            .map(([n, m]) => `| ${n} | ${m.presnost == null ? '—' : m.presnost + ' % (' + m.shoda + '/' + m.n + ')'} | ${m.kappa == null ? '—' : m.kappa} | ${m.fp} | ${m.fn} | ${m.bez} |`), '',
        '| Druh dvojice | judge shoda |', '| --- | --- |',
        ...Object.entries(s.poDruhu).map(([d, m]) => `| ${d} | ${m.presnost} % (${m.shoda}/${m.n}) |`), '',
        'Nejdůležitější je FP — judge, který podvrženou citaci „schválí“, nadhodnotí podporu citací. Použitelný je při shodě ≥ 90 % a FP ≤ 1.', '',
        '## Neshody s klíčem', ...vys.filter(v => v.judge !== v.klic).map(v => `- ${v.id} (${v.druh}): klíč ${v.klic}, judge ${v.judge} — ${v.duvod}`)
    ].join('\n') + '\n';
    const OUT = path.resolve(arg('--out', path.join(ROOT, 'scratch', 'spis-eval')));
    fs.mkdirSync(OUT, { recursive: true });
    const stem = path.join(OUT, `judge_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${label}`);
    fs.writeFileSync(stem + '.json', JSON.stringify({ meta: { label, provider: PROVIDER, model, priklady: priklady.map(p => p.id), usd }, souhrn: s, vysledky: vys }, null, 1));
    fs.writeFileSync(stem + '.md', md);
    console.log('\n' + md.split('\n').slice(4, 10).join('\n'));
    console.log(`\nVýsledek: ${stem}.md`);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* úklid */ }
}

if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.error('❌', e && e.message || e); process.exit(1); });
module.exports = { metriky, nactiOznaceni, popisMista };
