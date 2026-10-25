/**
 * lib/clause_scan.js — deterministická kontrola rizikových ustanovení ve smlouvě.
 *
 * Server test 2. 10. 2026 (qwen2.5:7b): Kontrolor u smlouvy o dílo, nájemní a kupní
 * smlouvy vždy část nevyvážených ustanovení vynechal (rozhodčí doložka, kauce nad
 * trojnásobek, vzdání se práv z vad…), u 40článkové smlouvy nenašel čl. 31.
 * Hledání známých vzorů zvládne kód spolehlivě: najde ustanovení i s číslem článku,
 * modelu je předá jako kontrolní seznam a co model v odpovědi vynechá, doplní pod ni.
 *
 * Pravidla jsou obecná (občanský zákoník, ochrana spotřebitele a nájemce, GDPR), ne
 * šitá na konkrétní dokument. Výsledek je podklad pro advokáta, ne právní závěr.
 */
'use strict';

const NUM_WORDS = { dvoj: 2, troj: 3, tří: 3, čtyř: 4, pěti: 5, šesti: 6, sedmi: 7, osmi: 8, devíti: 9, deseti: 10, dvanácti: 12 };

function _num(s) { return Number(String(s).replace(/\s/g, '').replace(',', '.')); }

/** Rozdělí text na úseky s označením článku: [{ article, text }]. */
function segment(text) {
    const out = [];
    let current = null;
    // PDF láme věty přes řádky → spojíme řádky, které nekončí větou a další nezačíná článkem/bodem.
    const rawLines = String(text || '').split(/\r?\n/);
    const lines = [];
    const isStart = (l) => /^(?:Čl\.|Článek|čl\.)\s*[IVXLC\d]/i.test(l) || /^\d{1,3}\.(?:\d{1,2})?\s/.test(l);
    for (const r of rawLines) {
        const l = r.trim();
        if (!l) { lines.push(''); continue; }
        const prev = lines.length ? lines[lines.length - 1] : '';
        if (prev && !/[.:;!?“”"]$/.test(prev) && !isStart(l) && !isStart(prev)) lines[lines.length - 1] = prev + ' ' + l;
        else lines.push(l);
    }
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const head = line.match(/^(?:Čl\.|Článek|čl\.)\s*([IVXLC]+|\d+)\b\.?/i);
        if (head) {
            current = 'čl. ' + head[1];
            const rest = line.slice(head[0].length).replace(/^[\s–—\-:.]+/, '');
            if (rest) out.push({ article: current, text: rest });
            continue;
        }
        // Řádek s více pododstavci „31.1 … 31.2 …“ rozdělíme.
        const parts = line.split(/(?=(?:^|\s)\d{1,3}\.\d{1,2}\s)/);
        for (const p of parts) {
            const t = p.trim();
            if (!t) continue;
            const sub = t.match(/^(\d{1,3})\.(\d{1,2})\s+/);
            const point = !sub && t.match(/^(\d{1,3})\.\s+(?=\S)/);
            if (sub) out.push({ article: `čl. ${sub[1]}.${sub[2]}`, text: t.slice(sub[0].length) });
            else if (point) out.push({ article: current ? `${current} odst. ${point[1]}` : `bod ${point[1]}`, text: t.slice(point[0].length) }); // „Čl. VII / 1. …“ → čl. VII odst. 1 (run 6)
            else out.push({ article: current, text: t });
        }
    }
    return out;
}

// Každé pravidlo: test(seg, ctx) → null | { detail }. keys = jak poznat, že ho model zmínil.
const RULES = [
    {
        id: 'zaloha_100', label: 'Záloha — úhrada celé ceny předem', law: '§ 1813 OZ (nepřiměřené ujednání v neprospěch spotřebitele)',
        re: /(100\s?%|celou\s+cenu|celé\s+ceny|v\s+plné\s+výši)[^.]{0,80}(předem|od podpisu|při podpisu|před zahájením)/i,
        // i obrácené pořadí: „uhradí předem v plné výši (100 % ceny)“ (run 6)
        alt: /(předem|před\s+zahájením)[^.]{0,80}(100\s?%|v\s+plné\s+výši|celou\s+cenu|celé\s+ceny)/i,
        detail: (m) => /100/.test(m[0]) ? '100 % ceny' : 'celá cena',
        keys: /z[aá]loh|100\s?%|cel[éou] cen|předem/i, consumer: true
    },
    {
        id: 'jednostranna_cena', label: 'Jednostranné zvýšení ceny / nájemného', law: '§ 1752, § 1813 OZ; u nájmu § 2248–2249 OZ',
        re: /jednostrann\S*\s+(?:\S+\s+){0,3}(zvýš|změn)\S*[^.]{0,80}?(\d{1,3}\s?%)?/i,
        detail: (m, seg) => { const p = seg.slice(m.index).match(/(\d{1,3}\s?%)/); return p ? `až o ${p[1]}` : ''; },
        keys: /jednostrann|zvýš/i
    },
    {
        id: 'jednostranna_lhuta', label: 'Jednostranné prodloužení termínu plnění', law: '§ 1813 OZ',
        re: /jednostrann\S*\s+(?:\S+\s+){0,2}prodlou/i, keys: /prodlou|termín/i
    },
    {
        id: 'rozhodci', label: 'Rozhodčí doložka', law: 'u spotřebitele neplatná — § 3 odst. 6 zák. č. 216/1994 Sb.',
        re: /rozhodčí\S*\s+řízení|rozhodce|rozhodčí doložk/i, keys: /rozhod[čc]/i,
        // Nestačí doložku zmínit — odpověď musí říct, že je neplatná, a odkázat na zákon o rozhodčím
        // řízení. Debata v run 6 radila „zjistit, zda byla spotřebitelka informována“ (chybně).
        must: [/neplatn/i, /216\/1994/]
    },
    {
        id: 'zaruka_kratka', label: 'Zkrácená záruka / doba pro uplatnění vad', law: 'spotřebitel: § 2165 OZ (24 měsíců), § 1813 OZ',
        re: /záruk\S*[^.]{0,60}?(\d{1,2})\s*(měsíc\S*)/i,
        when: (m, ctx) => ctx.consumer && Number(m[1]) < 24,
        detail: (m) => `${m[1]} ${m[2]}`, keys: /z[aá]ruk/i
    },
    {
        id: 'vady_lhuta', label: 'Krátká lhůta k oznámení vad se zánikem práv', law: '§ 1813 OZ, § 2112 OZ',
        re: /(?:do|nejpozději do)\s+(\d{1,2})\s*(dn[ůíy]|hodin)[^.]{0,80}(zanik|zaniká|ztrácí)/i,
        detail: (m) => `${m[1]} ${m[2]}`, keys: /vad|oznám/i
    },
    {
        id: 'vzdani_vad', label: 'Vzdání se práv z vadného plnění', law: '§ 1814 písm. b) OZ, § 2161 OZ (spotřebitel se práv nemůže vzdát)',
        re: /vzdává\S*[^.]{0,40}práv\S*\s+z\s+vadn|nemá\s+práv\S*\s+z\s+vad|neodpovídá\s+za\s+vady/i, keys: /vad/i
    },
    {
        id: 'bez_odstoupeni', label: 'Vyloučení práva odstoupit od smlouvy', law: '§ 1813 OZ; zákonná práva odstoupit nelze u spotřebitele vyloučit',
        re: /nemá\s+právo[^.]{0,30}odstoup|odstoupení[^.]{0,40}vyloučen/i, keys: /odstoup/i
    },
    {
        id: 'tachometr', label: 'Stav tachometru / najetých km bez záruky', law: '§ 2095, § 2161 OZ (ujištění o vlastnostech věci)',
        re: /(tachometr|najet\S*|km)[^.]{0,80}(negarant|bez záruky|nezaručuje|cca)/i, keys: /tachometr|najet|km/i
    },
    {
        id: 'jak_stoji', label: 'Doložka „jak stojí a leží“', law: 'u spotřebitele nevylučuje odpovědnost za vady (§ 2161 OZ)',
        re: /jak\s+stojí\s+a\s+leží/i, keys: /jak stoj|vad/i
    },
    {
        id: 'kauce', label: 'Jistota (kauce) nad trojnásobek nájemného', law: '§ 2254 odst. 1 OZ',
        re: /jistot\S*[^.]{0,80}?(dvoj|troj|tří|čtyř|pěti|šesti|sedmi|osmi|devíti|deseti|dvanácti|\d{1,2})\s*-?\s*násob/i,
        when: (m) => (NUM_WORDS[m[1].toLowerCase()] || Number(m[1])) > 3,
        detail: (m) => `${m[1]}násobek`, keys: /jistot|kauc|2254/i
    },
    {
        id: 'zvirata', label: 'Úplný zákaz chovu zvířat', law: '§ 2258 OZ',
        re: /nesmí[^.]{0,30}(chovat|držet)[^.]{0,30}zví/i, keys: /zv[ií][řr]/i
    },
    {
        id: 'vstup_bez_ohlaseni', label: 'Vstup pronajímatele do bytu bez ohlášení', law: '§ 2219 OZ',
        re: /vstoupit\s+do\s+bytu[^.]{0,80}(kdykoli|bez\s+(?:předchozího\s+)?ohlášení)/i, keys: /vstup|ohl[aá][šs]/i
    },
    {
        id: 'vypoved_bez_duvodu', label: 'Výpověď nájmu pronajímatelem bez důvodu / nevyvážené výpovědní doby', law: '§ 2286–2288 OZ',
        re: /(pronajímatel[^.]{0,40}vypov\S*[^.]{0,60}bez\s+(?:udání\s+)?důvodu)|(výpovědní\s+dob\S*[^.]{0,30}(jednoho|1)\s+měsíc)/i,
        keys: /v[yý]pov[eě]d/i
    },
    {
        id: 'zdravotni_data', label: 'Předání / licence k osobním (zdravotním) údajům třetím osobám', law: 'GDPR čl. 6 a 9, § 1813 OZ',
        re: /(údaj\S*\s+o\s+zdravotním\s+stavu|osobní\S*\s+údaj\S*|zdravotnick\S*\s+dokumentac\S*)[^.]{0,120}(třetím|třetí\s+osob|marketing|licenc)/i,
        alt: /licenc\S*[^.]{0,80}(údaj\S*\s+o\s+zdravotním|osobních\s+údaj)/i,
        keys: /zdravot|pacient|GDPR|osobn[ií]ch [uú]daj/i
    },
    {
        id: 'automaticke_prodlouzeni', label: 'Automatické prodloužení na dlouhou dobu / dlouhá výpovědní lhůta', law: '§ 1813 OZ, § 2000 OZ',
        re: /automaticky\s+prodlužuje[^.]{0,40}?(\d{1,2}\s*(?:let|roky|rok))|prodlužuje\s+(?:vždy\s+)?o\s+(\d{1,2}\s*let)/i,
        detail: (m) => (m[1] || m[2] || '').trim(), keys: /prodlou|\d+\s*let|deset let/i
    },
    {
        id: 'vysoka_pokuta', label: 'Nepřiměřeně vysoká smluvní pokuta', law: '§ 2051 OZ (moderace), § 1813 OZ',
        re: /smluvní\s+pokut\S*[^.]{0,80}?(\d{1,3}(?:[  ]\d{3}){2,})\s*Kč/i,
        when: (m) => _num(m[1]) >= 1000000, detail: (m) => `${m[1].replace(/ /g, ' ')} Kč`, keys: /pokut|\d[\d ]*000 000|mil/i
    }
];

/** Nevyvážené smluvní pokuty (procenta pro jednu stranu ≥ 10× vyšší než pro druhou, nebo „bez omezení“). */
function _penaltyAsymmetry(segs) {
    const pen = segs.filter(s => /smluvní\s+pokut/i.test(s.text));
    const vals = [];
    for (const s of pen) {
        const re = /(\d{1,2}(?:,\d{1,3})?)\s?%/g; let m;
        while ((m = re.exec(s.text))) vals.push({ v: _num(m[1]), raw: m[1] + ' %', article: s.article, unlimited: /bez\s+omezení/i.test(s.text) });
    }
    if (vals.length < 2) return null;
    const min = vals.reduce((a, b) => (b.v < a.v ? b : a));
    const max = vals.reduce((a, b) => (b.v > a.v ? b : a));
    if (min.v > 0 && (max.v / min.v >= 10 || (max.unlimited && !min.unlimited))) {
        return {
            id: 'pokuty_nerovnovaha', article: min.article === max.article ? min.article : `${min.article} / ${max.article}`,
            label: 'Nevyvážené smluvní pokuty', law: '§ 1813 OZ, § 2051 OZ',
            detail: `${min.raw} pro jednu stranu vs. ${max.raw}${max.unlimited ? ' bez omezení' : ''} pro druhou`,
            quote: '', keys: /pokut|0,01|0,5\s?%/i
        };
    }
    return null;
}

/** Je text smlouva (stojí za to ho kontrolovat)? */
function looksLikeContract(text) {
    const t = String(text || '');
    return /smlouv/i.test(t) && (/(?:Čl\.|Článek)\s*[IVXLC\d]/i.test(t) || /^\s*\d+\.\s+\S/m.test(t)) && t.length > 200;
}

/** Najde riziková ustanovení. Vrací [{ id, article, label, law, detail, quote }]. */
function scanContract(text) {
    const src = String(text || '');
    if (!looksLikeContract(src)) return [];
    const ctx = { consumer: /spotřebitel/i.test(src) };
    const segs = segment(src);
    const found = [];
    for (const rule of RULES) {
        if (rule.consumer && !ctx.consumer) continue;
        for (const s of segs) {
            const m = s.text.match(rule.re) || (rule.alt && s.text.match(rule.alt));
            if (!m) continue;
            if (rule.when && !rule.when(m, ctx)) continue;
            found.push({
                id: rule.id, article: s.article, label: rule.label, law: rule.law,
                detail: rule.detail ? rule.detail(m, s.text) : '',
                quote: s.text.length > 180 ? s.text.slice(0, 177) + '…' : s.text,
                keys: rule.keys, must: rule.must
            });
            break; // stačí první výskyt pravidla
        }
    }
    const asym = _penaltyAsymmetry(segs);
    if (asym) found.push(asym);
    return found;
}

function _line(f) {
    return `• ${f.article ? f.article.replace(/^čl\./, 'Čl.') + ' – ' : ''}${f.label}${f.detail ? ' (' + f.detail + ')' : ''} — ${f.law}`;
}

/** Systémová zpráva pro model: kontrolní seznam, který musí v odpovědi pokrýt. */
function modelNote(findings) {
    if (!findings.length) return '';
    return 'Automatická kontrola smlouvy (provedl program) našla tato riziková ustanovení. ' +
        'V odpovědi KAŽDÉ z nich uveď s číslem článku, vysvětli riziko pro klienta a uveď ustanovení zákona; ' +
        'můžeš doplnit další rizika, která najdeš:\n' + findings.map(_line).join('\n');
}

// Čísla z detailu („6 měsíců“, „0,01 %“, „5 000 000 Kč“) a první § zákona — model je musí uvést.
function _mustTokens(f) {
    const toks = [];
    const re = /(\d[\d \u00a0]*(?:,\d+)?)\s*(%|[A-Za-zÁ-ž]{2,3})?/g; let m;
    const d = String(f.detail || '');
    while ((m = re.exec(d))) {
        const num = m[1].trim().replace(/[ \u00a0]+/g, '[ \\u00a0]?').replace(',', '[,.]');
        const unit = m[2] ? (m[2] === '%' ? '\\s?%' : '\\s?' + m[2].slice(0, 3)) : '';
        toks.push(new RegExp('(?<![\\d,])' + num + unit, 'i'));
    }
    const par = String(f.law || '').match(/§\s*(\d{3,4})/);
    if (par) toks.push(new RegExp('(?<!\\d)' + par[1] + '(?!\\d)'));
    return toks;
}
function _covered(r, f) {
    if (!(f.keys && f.keys.test(r))) return false;
    if (f.must && !f.must.every(t => t.test(r))) return false;
    return _mustTokens(f).every(t => t.test(r));
}

/** Ustanovení, která model v odpovědi nezmínil → text k připojení pod odpověď ('' když nic). */
function missingAppendix(response, findings) {
    const r = String(response || '');
    const miss = findings.filter(f => !_covered(r, f));
    if (!miss.length) return { text: '', missing: [] };
    return {
        text: '\n\n---\n🔎 Automatická kontrola smlouvy našla i tato ustanovení, která odpověď výše nezmiňuje nebo u nich chybí správný závěr (ověřte):\n' + miss.map(_line).join('\n'),
        missing: miss.map(f => f.id)
    };
}

module.exports = { scanContract, segment, looksLikeContract, modelNote, missingAppendix, RULES };
