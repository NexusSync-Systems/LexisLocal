/**
 * lib/cz_proofread.js — pravidlová korektura JISTÝCH chyb v češtině (bez slovníku, bez GPL).
 *
 * Proč (server test 2.–3. 10. 2026, eval Y2): stylista s qwen2.5:7b místo opravy chyb
 * přepisoval význam („jsme nucený přistoupit k vimáhaní“ → „musíme se rozhodnout
 * k vykonaní“) a chyby nechával. Program proto opraví to, co lze opravit s jistotou,
 * a model dostane seznam oprav jako fakta. Pravidla jsou úmyslně úzká — raději
 * chybu nechat, než „opravit“ správné slovo.
 *
 * fixText(text) → { text, fixes:[{ from, to, rule }] }
 */
'use strict';

const L = 'A-Za-zÁ-Žá-žĚŠČŘŽÝÁÍÉÚŮĎŤŇěščřžýáíéúůďťň';

// Kořeny s předponou vy- (po v nikdy -i-): „vimáhání“ → „vymáhání“.
const VY_ROOTS = [
    ['vimáh', 'vymáh'], ['vimah', 'vymáh'], ['vijádř', 'vyjádř'], ['vizval', 'vyzval'], ['vizýv', 'vyzýv'],
    ['vizív', 'vyzýv'], ['viřídi', 'vyřídi'], ['vikonat', 'vykonat'], ['vidal', 'vydal'], ['vipověd', 'výpověd'],
    ['vislech', 'výslech'], ['viúčt', 'vyúčt'], ['vimezi', 'vymezi'], ['vipořád', 'vypořád']
];
// Podstatná jména slovesná na -ání psaná s krátkým -aní.
const ANI_WORDS = ['vymáhaní', 'jednaní', 'podaní', 'vyřizovaní', 'doručovaní', 'projednaní', 'zaplacaní'];
// Před těmito slovy se čárka před spojkou nepíše („i když“, „a že“ …).
const NO_COMMA_BEFORE = new Set(['a', 'i', 'ani', 'nebo', 'či', 'než', 'jak', 'až', 'jen', 'jenom', 'teprve', 'právě', 'hlavně',
    'zejména', 'především', 'zvlášť', 'leda', 'jako', 'neboť', 'tak', 'takže', 'ledaže',
    // předložky („na který“, „o které“, „podle toho, že“ — čárka až za „toho“)
    'v', 've', 'na', 'o', 's', 'se', 'z', 'ze', 'k', 'ke', 'u', 'do', 'od', 'po', 'pro', 'při', 'za', 'před',
    'pod', 'nad', 'mezi', 'bez', 'přes', 'proti', 'kvůli', 'podle', 'během', 'díky', 'vůči']);
const CONJ = 'že|protože|aby|když|který|která|které|kterého|kterou|kterým|kteří|jestli|zda|pokud|neboť';

function _caseLike(src, repl) {
    return src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase() ? repl[0].toUpperCase() + repl.slice(1) : repl;
}

function fixText(input) {
    let t = String(input || '');
    const fixes = [];
    const note = (from, to, rule) => { if (from !== to) fixes.push({ from, to, rule }); };

    // 1) bje / pje / mje → bě / pě / mě (kromě předpony ob-: objednat, objekt, objem …)
    t = t.replace(new RegExp(`[${L}]*[bpm]je[${L}]*`, 'g'), (w) => {
        if (/^ob[jJ]/i.test(w) || /^(sub|ad|ob)je/i.test(w)) return w;
        const out = w.replace(/([bpmBPM])je/g, (m, c) => c + 'ě');
        note(w, out, 'bě/pě/mě');
        return out;
    });

    // 2) vy- v kořenech, kde po v nemůže být i
    for (const [bad, good] of VY_ROOTS) {
        t = t.replace(new RegExp(`(?<![${L}])${bad}[${L}]*`, 'gi'), (w) => {
            const out = _caseLike(w, good + w.slice(bad.length));
            note(w, out, 'vy-');
            return out;
        });
    }
    // 3) -aní → -ání u slovesných podstatných jmen ze seznamu
    for (const w0 of ANI_WORDS) {
        const good = w0.replace(/aní$/, 'ání');
        t = t.replace(new RegExp(`(?<![${L}])${w0}(?![${L}])`, 'gi'), (w) => { const out = _caseLike(w, good); note(w, out, '-ání'); return out; });
    }
    // 4) shoda: „jsme/jste nucený/povinný/připravený“ → „nuceni/povinni/připraveni“
    t = t.replace(new RegExp(`(?<![${L}])(jsme|jste|byli jsme|byli jste)(\\s+)([${L}]+?[nt])ý(?![${L}])`, 'gi'), (m, aux, sp, stem) => {
        const out = `${aux}${sp}${stem}i`;
        note(m, out, 'shoda');
        return out;
    });
    // 5) čárka před podřadicí spojkou / vztažným zájmenem
    t = t.replace(new RegExp(`([${L}]+)(\\s+)(${CONJ})(?![${L}])`, 'g'), (m, prev, sp, conj, offset, whole) => {
        if (NO_COMMA_BEFORE.has(prev.toLowerCase())) return m;
        const out = `${prev},${sp}${conj}`;
        note(`${prev} ${conj}`, `${prev}, ${conj}`, 'čárka');
        return out;
    });
    return { text: t, fixes };
}

/** Text k opravě ze zadání: obsah uvozovek („…“, "…"), jinak celé zadání bez pokynu. */
function extractTarget(prompt) {
    const p = String(prompt || '');
    const m = p.match(/[„"“]([^„"“”]{8,4000})[“”"]/);
    if (m) return m[1];
    const c = p.split(/:\s*\n?/);
    return c.length > 1 ? c.slice(1).join(':').trim() : null;
}

/** Poznámka pro model: jisté opravy, které musí ve výsledku být. */
function _collapse(fixes) {
    // „vimáhaní → vymáhaní“ + „vymáhaní → vymáhání“ → „vimáhaní → vymáhání“
    const out = [];
    for (const f of fixes) {
        const prev = out.find(x => x.to === f.from);
        if (prev) prev.to = f.to; else out.push(Object.assign({}, f));
    }
    return out;
}

function modelNote(fixes) {
    fixes = _collapse(fixes || []);
    if (!fixes.length) return '';
    return 'Program našel tyto JISTÉ chyby — ve výsledku je oprav takto a jinak zachovej původní slova a význam:\n' +
        fixes.map(f => `• ${f.from} → ${f.to}`).join('\n');
}

/**
 * Po odpovědi modelu: opraví jisté chyby v jeho textu (kromě řádků seznamu oprav „x → y“)
 * a když v něm chybí opravená verze, doplní ji programem.
 */
function finalize(response, target) {
    const lines = String(response || '').split('\n');
    // Řádek seznamu oprav „chyba → oprava“: chybný tvar se do výsledku neopakuje,
    // zůstane jen opravený tvar („• opraveno: uběhla“).
    const fixedLines = lines.map(l => {
        const a = l.match(/^(\s*(?:[-•*]|\d+[.)])?\s*)(.*?)\s*(?:→|->)\s*(.+)$/);
        if (a) return `${a[1] || '• '}opraveno: ${fixText(a[3]).text}`;
        return fixText(l).text;
    });
    let out = fixedLines.join('\n');
    if (target) {
        const ref = fixText(target);
        const keyTargets = ref.fixes.filter(f => f.rule !== 'čárka').map(f => f.to);
        const lacks = keyTargets.some(k => !out.includes(k));
        if (ref.fixes.length && lacks) {
            out += '\n\n---\n✍️ Oprava programem (jen jisté chyby, význam beze změny):\n' + ref.text;
        }
    }
    return out;
}

module.exports = { fixText, extractTarget, modelNote, finalize, _collapse };
