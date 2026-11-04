/**
 * eval/spis_eval/judge.js — LLM-judge pro jednu úzkou otázku: PODPORUJE citované místo spisu tvrzení? (ANO / NE)
 *
 * Používá ho spis_eval.js (--judge, jen u citací, které program nerozhodne) a kalibrace spis_eval_judge.js
 * (shoda s klíčem a s ručním označením). Příklady (few-shot) se berou JEN ze sady „vyvoj“ (spisy S1–S4);
 * sada „kontrola“ (S5–S6) slouží k měření a jako příklad se nikdy nepoužije.
 */
'use strict';

const RUBRIKA = [
    'Posuzuješ jedinou věc: zda citované místo dokumentu PODPORUJE tvrzení.',
    'ANO — vše podstatné v tvrzení (částky, data, lhůty, kdo, co, podmínky) z citovaného místa přímo plyne. Parafráze, jiný slovosled, zaokrouhlení („190 tisíc“) a jiný zápis data nevadí.',
    'NE — když platí cokoli z toho:',
    '• tvrzení uvádí jinou hodnotu nebo jinou jednotku (dny × měsíce, ročně × měsíčně),',
    '• tvrzení říká opak nebo popírá, co v místě stojí,',
    '• tvrzení přidává něco, co v místě není (stačí jedna část navíc),',
    '• místo se týká něčeho jiného (jiná povinnost, jiná strana, jiný dokument), i když je téma podobné,',
    '• tvrzení přisuzuje výrok jiné osobě (např. „zaměstnavatel přiznává“, když tvrdí zaměstnanec).',
    'Neposuzuj, zda je tvrzení pravdivé obecně nebo podle zákona — jen zda ho podporuje citované místo.',
    'Odpověz přesně ve tvaru: první řádek ANO nebo NE, druhý řádek jedna věta proč.'
].join('\n');

/** Vybere few-shot příklady ze sady vyvoj: vyváženě ANO/NE a co nejvíc různých druhů chyb. */
function vyberPriklady(pary, n) {
    const vyvoj = pary.filter(p => p.sada === 'vyvoj');
    if (!n) return [];
    const out = [], videno = new Set();
    for (const p of vyvoj) if (!videno.has(p.druh + p.klic) && out.length < n) { out.push(p); videno.add(p.druh + p.klic); }
    for (const p of vyvoj) if (out.length < n && !out.includes(p)) out.push(p);
    return out.slice(0, n);
}

function zprava(misto, tvrzeni) {
    return `CITOVANÉ MÍSTO:\n${misto}\n\nTVRZENÍ:\n${tvrzeni}`;
}

function zpravy(misto, tvrzeni, priklady) {
    const m = [{ role: 'system', content: RUBRIKA }];
    for (const p of priklady || []) {
        m.push({ role: 'user', content: zprava(p.misto, p.tvrzeni) });
        m.push({ role: 'assistant', content: `${p.klic}\n${p.duvod || (p.klic === 'ANO' ? 'Citované místo to přímo uvádí.' : 'Citované místo to neuvádí (' + p.druh.replace('_', ' ') + ').')}` });
    }
    m.push({ role: 'user', content: zprava(misto, tvrzeni) });
    return m;
}

function rozeber(text) {
    const t = String(text || '').trim();
    const m = /^\W*(ANO|NE)\b/i.exec(t);
    return { verdikt: m ? m[1].toUpperCase() : null, duvod: t.split(/\r?\n/).slice(1).join(' ').trim().slice(0, 300) };
}

/** Posudek jedné dvojice. ai = lib/ai_provider, P = lib/cloud_policy (syntetická data → „verejne“). */
async function posud({ ai, P, misto, tvrzeni, priklady, model }) {
    const r = await P.scope({ dataClass: 'verejne' }, () => ai.chat({ model, options: { temperature: 0, num_predict: 120, max_tokens: 120 }, messages: zpravy(misto, tvrzeni, priklady) }));
    return Object.assign({ raw: (r && r.message && r.message.content) || '' }, rozeber(r && r.message && r.message.content));
}

/** Text citovaného místa podle kotvy „DOC:cl:4:1“ / „DOC:b:3“ (s názvem dokumentu). */
function textMista(spis, kotva) {
    const [doc, ...k] = String(kotva).split(':');
    const d = spis.docs[doc];
    if (!d) return null;
    const t = d.kotvy[k.join(':')];
    return t ? `${d.nazev}:\n${t}` : null;
}

module.exports = { RUBRIKA, vyberPriklady, zpravy, rozeber, posud, textMista };
