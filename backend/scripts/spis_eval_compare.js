#!/usr/bin/env node
/**
 * scripts/spis_eval_compare.js — heat mapa „typ úlohy × běh“ a regrese mezi běhy spis_eval.js.
 *
 *   node backend/scripts/spis_eval_compare.js A.json B.json [C.json …]   # první = základ, ostatní proti němu
 *   node backend/scripts/spis_eval_compare.js A.json B.json --md out.md  # i do souboru
 *
 * Regrese (nahoře výpisu): pokles skóre typu o ≥ 5 bodů nebo úspěšnosti o ≥ 15 p. b., nové selhání negativního
 * testu (mimo_spis), nová kritická chyba (halucinace, únik údajů, chybná lhůta), pokles platnosti / podpory citací
 * o ≥ 5 p. b., případ, který dřív prošel a teď ne. Kód 1, když je regrese.
 */
'use strict';
const fs = require('fs');

const TYPY = ['reserse', 'shrnuti', 'rozpory', 'citace', 'kontrola_smlouvy', 'lhuty', 'mimo_spis', 'dopis'];
const NAZVY = { reserse: 'rešerše ve spisu', shrnuti: 'shrnutí dokumentu', rozpory: 'rozpory mezi dokumenty', citace: 'odpověď s citací',
    kontrola_smlouvy: 'kontrola smlouvy', lhuty: 'lhůty a výpočty', mimo_spis: 'mimo spis (negativní)', dopis: 'dopis protistraně' };

function barva(s) { return s == null ? '·' : s >= 90 ? '🟩' : s >= 75 ? '🟨' : s >= 50 ? '🟧' : '🟥'; }
function bunka(t) { return t ? `${barva(t.skore)} ${t.skore} (${t.prosel}/${t.n})` : '—'; }
function sloupec(b) { return `${b.meta.label}`; }
function pct(a, b) { return b ? Math.round(1000 * a / b) / 10 : null; }

function tabulka(behy) {
    const h = ['Typ úlohy', ...behy.map(sloupec)];
    const r = [h, h.map(() => '---')];
    for (const t of TYPY) {
        if (!behy.some(b => b.souhrn.poTypu[t])) continue;
        r.push([NAZVY[t], ...behy.map(b => bunka(b.souhrn.poTypu[t]))]);
    }
    r.push(['**celkem**', ...behy.map(b => `**${barva(b.souhrn.celkem.skore)} ${b.souhrn.celkem.skore} (${b.souhrn.celkem.prosel}/${b.souhrn.celkem.n})**`)]);
    r.push(['citace: platné', ...behy.map(b => b.souhrn.citace.platnost == null ? '—' : `${b.souhrn.citace.platnost} % (${b.souhrn.citace.platne}/${b.souhrn.citace.celkem})`)]);
    r.push(['citace: podporují tvrzení', ...behy.map(b => b.souhrn.citace.podpora == null ? '—' : `${b.souhrn.citace.podpora} % (${b.souhrn.citace.podporujici}/${b.souhrn.citace.celkem - b.souhrn.citace.nejiste}; nejisté ${b.souhrn.citace.nejiste})`)]);
    return r.map(x => '| ' + x.join(' | ') + ' |').join('\n');
}

function citacePoTypu(behy) {
    const h = ['Citace po typech (platné / podporující)', ...behy.map(sloupec)];
    const r = [h, h.map(() => '---')];
    for (const t of TYPY) {
        if (!behy.some(b => b.souhrn.poTypu[t] && b.souhrn.poTypu[t].cit.celkem)) continue;
        r.push([NAZVY[t], ...behy.map(b => { const c = b.souhrn.poTypu[t] && b.souhrn.poTypu[t].cit; return c && c.celkem ? `${pct(c.platne, c.celkem)} % / ${pct(c.podporujici, c.celkem - c.nejiste)} % (${c.celkem})` : '—'; })]);
    }
    return r.map(x => '| ' + x.join(' | ') + ' |').join('\n');
}

function topChyby(beh, n) {
    const K = require('../eval/spis_eval/checks').KATALOG;
    return Object.entries(beh.souhrn.chyby).sort((a, b) => b[1] - a[1]).slice(0, n || 3).map(([typ, pocet]) => {
        const priklady = beh.vysledky.filter(v => v.chyby.some(c => c.typ === typ)).slice(0, 3)
            .map(v => `${v.id}: ${v.chyby.find(c => c.typ === typ).detail}`);
        return { typ, nazev: K[typ] ? K[typ].nazev : typ, pocet, pripadu: beh.vysledky.filter(v => v.chyby.some(c => c.typ === typ)).length, priklady };
    });
}

function regrese(a, b) {
    const out = [];
    for (const t of TYPY) {
        const x = a.souhrn.poTypu[t], y = b.souhrn.poTypu[t];
        if (!x || !y) continue;
        if (y.skore <= x.skore - 5) out.push(`${NAZVY[t]}: skóre ${x.skore} → ${y.skore}`);
        if (y.uspesnost <= x.uspesnost - 15) out.push(`${NAZVY[t]}: úspěšnost ${x.uspesnost} % → ${y.uspesnost} %`);
    }
    for (const k of ['platnost', 'podpora']) {
        const p = a.souhrn.citace[k], q = b.souhrn.citace[k];
        if (p != null && q != null && q <= p - 5) out.push(`citace ${k}: ${p} % → ${q} %`);
    }
    const kriticke = ['mimo_spis', 'halucinace', 'unik_udaju', 'chybna_lhuta'];
    const mapA = new Map(a.vysledky.map(v => [v.id + '#' + v.opakovani, v]));
    for (const v of b.vysledky) {
        const u = mapA.get(v.id + '#' + v.opakovani);
        if (!u) continue;
        if (u.prosel && !v.prosel) out.push(`${v.id} (${NAZVY[v.typ]}): dřív prošel, teď ne — ${v.chyby.map(c => c.typ).join(', ')}`);
        const nove = v.chyby.filter(c => kriticke.includes(c.typ) && !u.chyby.some(d => d.typ === c.typ));
        for (const c of nove) if (!(u.prosel && !v.prosel)) out.push(`${v.id}: nová kritická chyba ${c.typ} — ${c.detail}`);
    }
    return out;
}

function zlepseni(a, b) {
    const out = [];
    for (const t of TYPY) {
        const x = a.souhrn.poTypu[t], y = b.souhrn.poTypu[t];
        if (x && y && y.skore >= x.skore + 5) out.push(`${NAZVY[t]}: skóre ${x.skore} → ${y.skore}`);
    }
    return out;
}

function report(behy) {
    const b0 = behy[0];
    const s = [];
    s.push(`# Spis eval — ${behy.map(b => b.meta.label).join(' vs. ')}`);
    s.push('');
    for (const b of behy) s.push(`- **${b.meta.label}**: ${b.meta.provider} · ${b.meta.model} · režim ${b.meta.rezim} · ${b.meta.datum.slice(0, 16).replace('T', ' ')} · commit ${b.meta.commit || '?'} · sada v${b.meta.sada.verze} (${b.meta.sada.pripadu} případů × ${b.meta.opakovani}) · prompty ${b.meta.prompty} · náklady ${b.meta.naklady.odhadUsd} USD${b.meta.prerusen ? ` · ⚠️ PŘERUŠENO (${b.meta.prerusen}) — hodnocené jen hotové případy` : ''}`);
    s.push('');
    if (behy.length > 1) {
        for (const b of behy.slice(1)) {
            const r = regrese(b0, b), z = zlepseni(b0, b);
            s.push(`## ${b.meta.label} proti ${b0.meta.label}`);
            s.push(r.length ? '**Regrese:**\n' + r.map(x => '- ' + x).join('\n') : '**Regrese:** žádné');
            if (z.length) s.push('\n**Zlepšení:**\n' + z.map(x => '- ' + x).join('\n'));
            if (b.meta.sada.hash !== b0.meta.sada.hash) s.push('\n⚠️ Běhy používají jinou verzi eval sady — porovnání je jen orientační.');
            s.push('');
        }
    }
    s.push('## Heat mapa (skóre 0–100, v závorce prošlo / případů)');
    s.push('');
    s.push(tabulka(behy));
    s.push('');
    s.push('🟩 ≥ 90 · 🟨 75–89 · 🟧 50–74 · 🟥 < 50');
    s.push('');
    s.push(citacePoTypu(behy));
    s.push('');
    for (const b of behy) {
        s.push(`## Nejčastější chyby — ${b.meta.label}`);
        for (const t of topChyby(b, 5)) s.push(`- **${t.nazev}** (${t.typ}): ${t.pocet}× v ${t.pripadu} případech\n${t.priklady.map(p => '  - ' + p).join('\n')}`);
        s.push('');
    }
    return s.join('\n') + '\n';
}

if (require.main === module) {
    const a = process.argv.slice(2);
    const mdI = a.indexOf('--md');
    const md = mdI >= 0 ? a.splice(mdI, 2)[1] : null;
    if (!a.length) { console.error('Použití: spis_eval_compare.js A.json [B.json …] [--md výstup.md]'); process.exit(2); }
    const behy = a.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
    const txt = report(behy);
    console.log(txt);
    if (md) fs.writeFileSync(md, txt);
    const reg = behy.slice(1).some(b => regrese(behy[0], b).length);
    process.exit(reg ? 1 : 0);
}
module.exports = { report, tabulka, regrese, topChyby };
