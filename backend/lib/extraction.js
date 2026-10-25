/**
 * extraction.js — sdílený AI-extraktor metadat + výpočet lhůty.
 *
 * Dřív byly `runAIExtractor` a `calculateDeadlineDate` zkopírované byte-po-bytu
 * ve watcher.js i paperless.js (dva pipeline zpracování dokumentu). Jakákoli
 * úprava promptu/logiky se musela dělat dvakrát a hrozil rozjezd. Nově je to
 * jeden zdroj, který oba importují.
 */
'use strict';

// AI poskytovatel nezávislý na backendu (Ollama | OpenAI | Anthropic) — stejné
// rozhraní jako ollama lib, takže extrakce funguje pro jakýkoli model.
const { CHAT_MODEL } = require('./model_config');
const ollama = require('./ai_provider');

// --- Pracovní dny / svátky (§ 57 odst. 2 o.s.ř.) ---
function _dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function _easterSunday(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
}
const _holidayCache = {};
function _czechHolidays(year) {
    if (_holidayCache[year]) return _holidayCache[year];
    const fixed = ['01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26'];
    const set = new Set(fixed.map(md => `${year}-${md}`));
    const easter = _easterSunday(year);
    const gf = new Date(easter.getTime()); gf.setDate(gf.getDate() - 2); set.add(_dateKey(gf)); // Velký pátek
    const em = new Date(easter.getTime()); em.setDate(em.getDate() + 1); set.add(_dateKey(em)); // Velikonoční pondělí
    _holidayCache[year] = set;
    return set;
}
function _isWorkingDay(d) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return false;
    return !_czechHolidays(d.getFullYear()).has(_dateKey(d));
}

// Přičte měsíce s ošetřením konce měsíce (§ 57 odst. 2 o.s.ř.): stejné číslo dne,
// jinak poslední den cílového měsíce (31. 1. + 1 měsíc → 28./29. 2.). Rok = 12 měsíců.
function _addMonthsClamped(base, months) {
    const total = base.getMonth() + (parseInt(months, 10) || 0);
    const y = base.getFullYear() + Math.floor(total / 12);
    const m = ((total % 12) + 12) % 12;
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(base.getDate(), last), 12, 0, 0, 0);
}

// Obecný výpočet data lhůty podle jednotky (YYYY-MM-DD). § 57 o.s.ř.:
//   • dny/týdny: základ + N (resp. 7·N) dní,
//   • měsíce/roky (odst. 2): stejné číslo dne s ošetřením konce měsíce.
// V každém případě: padne-li konec na So/Ne/svátek, posun na následující pracovní den.
// unit ∈ {'day','week','month','year'} (default 'day'). Vrací null pro amount ≤ 0.
function calculateDeadlineByUnit(amount, unit, baseDate) {
    const n = parseInt(amount, 10);
    if (!n || n <= 0) return null;
    const base = baseDate ? new Date(baseDate) : new Date();
    base.setHours(12, 0, 0, 0); // vyhne se posunu přes půlnoc/DST
    let d;
    switch (unit) {
        case 'week':  d = new Date(base); d.setDate(d.getDate() + n * 7); break;
        case 'month': d = _addMonthsClamped(base, n); break;
        case 'year':  d = _addMonthsClamped(base, n * 12); break;
        case 'day':
        default:      d = new Date(base); d.setDate(d.getDate() + n); break;
    }
    d.setHours(12, 0, 0, 0);
    let guard = 0;
    while (!_isWorkingDay(d) && guard < 30) { d.setDate(d.getDate() + 1); guard++; }
    return _dateKey(d);
}

// Spočítá datum lhůty zadané POČTEM DNÍ (YYYY-MM-DD). Deleguje na obecný výpočet;
// chování zachováno pro zpětnou kompatibilitu (watcher.js, paperless.js).
function calculateDeadlineDate(days, baseDate) {
    if (!days) return null;
    return calculateDeadlineByUnit(days, 'day', baseDate);
}

// Deterministická detekce lhůt v textu (dny/týdny/měsíce/roky, číslicí i slovní
// číslovkou), zrcadlí editorový lexis-calendar.detectDeadlines. Vrací
// [{ amount, unit, context }]. Měsíce/týdny/roky bere jen v lhůtovém kontextu
// (ochrana proti false-positive typu „smlouva na 2 roky").
const _CZ_NUM = {
    'jeden':1,'jednoho':1,'jedne':1,'jednu':1,'jedna':1,'dva':2,'dvou':2,'dve':2,'dvema':2,
    'tri':3,'trech':3,'trem':3,'ctyri':4,'ctyr':4,'ctyrech':4,'pet':5,'peti':5,'sest':6,'sesti':6,
    'sedm':7,'sedmi':7,'osm':8,'osmi':8,'devet':9,'deviti':9,'deset':10,'desiti':10,
    'patnact':15,'patnacti':15,'dvacet':20,'dvaceti':20,'tricet':30,'triceti':30
};
function _deaccent(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function _parseNum(tok) {
    if (tok == null) return null;
    const s = String(tok).trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const k = _deaccent(s);
    return Object.prototype.hasOwnProperty.call(_CZ_NUM, k) ? _CZ_NUM[k] : null;
}

// Normalizuje jednotku lhůty (české slovo i anglický klíč) na kanonický klíč
// 'day' | 'week' | 'month' | 'year'. Vrací null pro neznámé/prázdné vstupy —
// slouží k ošetření toho, co vrátí AI-extraktor (viz runAIExtractor).
function normalizeDeadlineUnit(u) {
    if (u == null) return null;
    const k = _deaccent(String(u).trim());
    if (!k) return null;
    if (/^(day|days|den|dny|dnu|dni|dnech|dnu)$/.test(k)) return 'day';
    if (/^(week|weeks|tyden|tydny|tydnu|tydne|tydnech)$/.test(k)) return 'week';
    if (/^(month|months|mesic|mesice|mesicu|mesici|mesicich)$/.test(k)) return 'month';
    if (/^(year|years|rok|roku|roky|roce|let|leta)$/.test(k)) return 'year';
    return null;
}

// Sestaví seznam lhůt v JINÝCH jednotkách než dny (týdny/měsíce/roky) ze dvou
// zdrojů: deterministické detekce v textu (detectDeadlines) i strukturovaného
// AI-extraktoru (aiResult.deadlineAmount + deadlineUnit). Sjednotí je (dedup dle
// amount+unit), spočítá datum (§ 57/2) a KAŽDOU označí needsReview=true — advokát
// musí potvrdit; nic se tiše nefinalizuje (dny řeší primární deadlineDays cesta).
function collectUnitDeadlines(text, aiResult, baseDate) {
    const seen = new Set();
    const out = [];
    function add(amount, unit, context, source) {
        const a = parseInt(amount, 10);
        const u = normalizeDeadlineUnit(unit);
        if (!a || a <= 0 || !u || u === 'day') return;
        const key = a + ':' + u;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
            amount: a,
            unit: u,
            deadlineDate: calculateDeadlineByUnit(a, u, baseDate),
            context: context ? String(context).trim().replace(/\s+/g, ' ').slice(0, 300) : '',
            source: source,
            needsReview: true
        });
    }
    try {
        detectDeadlines(text).forEach(function (d) { add(d.amount, d.unit, d.context, 'regex'); });
    } catch (e) { /* deterministická detekce je best-effort */ }
    if (aiResult && aiResult.deadlineAmount != null && aiResult.deadlineUnit) {
        add(aiResult.deadlineAmount, aiResult.deadlineUnit, aiResult.deadlineContext || aiResult.summary, 'ai');
    }
    return out;
}
function detectDeadlines(text) {
    if (!text) return [];
    const NUM = '(\\d+|jed(?:en|noho|n[eé]|nu|na)|dv(?:a|ou|[eě]|[eě]ma)|t[rř][ií]|t[rř]ech|t[rř]em|[cč]ty[rř](?:i|ech)?|p[eě]t|p[eě]ti|[sš]est|[sš]esti|sedm|sedmi|osm|osmi|dev[eě]t|dev[ií]ti|deset|des[ií]ti|patn[aá]ct|patn[aá]cti|dvacet|dvaceti|t[rř]icet|t[rř]iceti)';
    const END = '(?![a-zá-žA-ZÁ-Ž])';
    const pat = {
        day:   new RegExp(NUM + '\\s+(?:pracovn[ií]ch\\s+)?(?:den|dnech|dn[uůíey])' + END, 'gi'),
        week:  new RegExp(NUM + '\\s+(?:t[yý]dnech|t[yý]den|t[yý]dn[uůyeí])' + END, 'gi'),
        month: new RegExp(NUM + '\\s+m[eě]s[ií]c[uůeieí]*' + END, 'gi'),
        year:  new RegExp(NUM + '\\s+(?:let|roky|rok[uůy]?|roce)' + END, 'gi')
    };
    const ctxRe = /(lh[uů]t|nejpozd|ve lh[uů]t|do\s+\d|do\s+[a-zá-ž]+\s+(?:m[eě]s|t[yý]d|dn|rok|let)|podat|vyj[aá]d[rř]|odvol|dovol|n[aá]mitk|[zž]alob|st[ií][zž]nost|kasa[cč]n|term[ií]n)/i;
    const out = [];
    String(text).split(/[\n\r]+/).forEach(function (line) {
        if (line.trim().length < 8) return;
        const hasCtx = ctxRe.test(line);
        const ctx = line.trim().replace(/\s+/g, ' ');
        ['day', 'week', 'month', 'year'].forEach(function (unit) {
            if (unit !== 'day' && !hasCtx) return;
            const re = pat[unit]; re.lastIndex = 0; let m;
            while ((m = re.exec(line)) !== null) {
                const amount = _parseNum(m[1]);
                if (!amount || amount <= 0) continue;
                if (!out.some(function (d) { return d.amount === amount && d.unit === unit && d.context === ctx; })) {
                    out.push({ amount: amount, unit: unit, context: ctx });
                }
            }
        });
    });
    return out;
}

// Která denní lhůta je ta PROCESNÍ (k odvolání/odporu/vyjádření)?
// Test 2. 10. 2026: u rozsudku vzal AI-extraktor 3denní pariční lhůtu („do tří dnů
// od právní moci“) místo 15denní lhůty k odvolání → advokát by viděl 18. 9. místo 30. 9.
// Pariční lhůta běží od PRÁVNÍ MOCI, ne od doručení — tu do lhůtníku nedáváme.
// Vrací { days, context } nebo null.
const PROC_RE = /(odvol|odpor|dovol[aá]n|vyj[aá]d[rř]|n[aá]mitk|st[ií][zž]nost|rozklad|kasa[cč]n|ode\s+dne\s+doru[cč]|od\s+doru[cč])/i;
const NONPROC_RE = /(pr[aá]vn[ií]\s+moc|zaplatit|splatn|uhradit|vyklidit|plnit)/i;
function pickProceduralDeadline(text) {
    if (!text) return null;
    // věty místo řádků — PDF láme řádky uprostřed věty („do tří\ndnů“)
    const flat = String(text).replace(/\s*[\r\n]+\s*/g, ' ');
    const sentences = flat.split(/(?<=[.!?])\s+(?=[A-ZÁ-Ž0-9IVX])/);
    let best = null;
    sentences.forEach(sent => {
        detectDeadlines(sent).filter(d => d.unit === 'day').forEach(d => {
            let score = 0;
            if (PROC_RE.test(sent)) score += 2;
            if (NONPROC_RE.test(sent)) score -= 2;
            if (score <= 0) return;
            if (!best || score > best.score || (score === best.score && d.amount > best.days)) {
                best = { days: d.amount, context: sent.trim().slice(0, 200), score };
            }
        });
    });
    return best ? { days: best.days, context: best.context } : null;
}

// Ollama AI extraktor strukturovaných metadat z českého právního textu.
async function runAIExtractor(text) {
    // Build a highly optimized, single-shot structured JSON prompt
    const prompt = `Zanalyzuj následující český právní text a vytáhni z něj klíčová strukturovaná metadata.
Reaguj VÝHRADNĚ validním JSON objektem s těmito poli:
{
  "caseNumber": "spisová značka ve formátu např. '23 C 120/2026'",
  "plaintiff": "jméno žalobce",
  "defendant": "jméno žalovaného",
  "deadlineDays": 15, // PROCESNÍ lhůta (k odvolání, odporu, vyjádření) VE DNECH jako číslo; NE lhůta k zaplacení „od právní moci“ (jinak null)
  "deadlineAmount": null, // číslo lhůty, pokud je uvedena v TÝDNECH / MĚSÍCÍCH / LETECH (jinak null)
  "deadlineUnit": null, // jednotka k deadlineAmount: "week" | "month" | "year" (jinak null)
  "summary": "krátké shrnutí obsahu jednou větou; začni typem dokumentu podle jeho skutečné formy (např. E-mail klienta, Smlouva o dílo, Rozsudek, Výzva soudu)"
}
Pokud některý údaj v textu NENÍ, vrať null — jména, spisové značky ani lhůty si NEVYMÝŠLEJ.
Smlouva, e-mail nebo dopis obvykle žalobce/žalovaného ani spisovou značku nemají. E-mail nebo dopis, který o žalobě jen mluví, NENÍ žaloba.

Text k analýze:
${text.substring(0, 3000)}`;

    const response = await ollama.chat({
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        options: { temperature: 0.1 }
    });

    const content = response.message.content;

    // Parse the JSON blocks safely
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        const parsed = validateExtraction(JSON.parse(jsonMatch[0]), text);
        // Normalizuj jednotku lhůty od AI; když AI vrátí jednotku 'day', převeď
        // ji na deadlineDays (jedna pravda pro denní lhůty), ať se nezdvojuje.
        if (parsed && parsed.deadlineUnit != null) {
            const nu = normalizeDeadlineUnit(parsed.deadlineUnit);
            parsed.deadlineUnit = nu;
            if (nu === 'day' && (parsed.deadlineDays == null || parsed.deadlineDays === '') && parsed.deadlineAmount != null) {
                parsed.deadlineDays = parseInt(parsed.deadlineAmount, 10) || parsed.deadlineDays;
                parsed.deadlineAmount = null;
                parsed.deadlineUnit = null;
            }
        }
        return parsed;
    }
    return null;
}


// Odstraní z výstupu AI-extraktoru údaje, které v textu NEJSOU (test 1. 10. 2026:
// nesouvisející dokumenty dostaly smyšlené účastníky „Jana/Karel Fiktivní“, smlouva
// o dílo lhůtu 3 dny). Jméno musí mít v textu aspoň příjmení (poslední slovo ≥ 3 znaky),
// sp. zn. musí být v textu (bez ohledu na mezery), lhůta musí odpovídat číslu v textu.
function validateExtraction(parsed, text) {
    if (!parsed || typeof parsed !== 'object') return parsed;
    const src = _deaccent(text);
    const srcNoWs = src.replace(/\s+/g, '');
    const nameOk = n => {
        if (!n || typeof n !== 'string') return false;
        const words = _deaccent(n).replace(/[.,]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !/^(s\.?r\.?o|a\.?s|spol)$/.test(w));
        // české skloňování: „Karel Malý“ vs. „Karlu Malému“ → porovnáváme kmen
        const stem = w => w.length > 4 ? w.slice(0, w.length - 2) : w.slice(0, 3);
        return words.length > 0 && words.some(w => src.includes(stem(w)));
    };
    ['plaintiff', 'defendant'].forEach(k => { if (parsed[k] != null && !nameOk(parsed[k])) parsed[k] = null; });
    if (parsed.caseNumber && !srcNoWs.includes(_deaccent(parsed.caseNumber).replace(/\s+/g, ''))) parsed.caseNumber = null;
    const amounts = new Set(detectDeadlines(text).map(d => d.amount));
    if (parsed.deadlineDays != null && !amounts.has(parseInt(parsed.deadlineDays, 10))) parsed.deadlineDays = null;
    if (parsed.deadlineAmount != null && !amounts.has(parseInt(parsed.deadlineAmount, 10))) { parsed.deadlineAmount = null; parsed.deadlineUnit = null; }
    return parsed;
}

// Datum DORUČENÍ písemnosti — od něj (ne od dneška!) běží procesní lhůty (§ 57 OSŘ).
// Změřeno 1. 10. 2026: rozsudek doručený 15. 9. dostal lhůtu k odvolání 16. 10.
// místo 30. 9. — falešný pocit, že je čas. Vrací { date: 'YYYY-MM-DD'|null, all: [...], conflict }.
// Při více různých datech bere NEJDŘÍVĚJŠÍ (konzervativně) a hlásí rozpor.
function extractDeliveryDates(text) {
    const t = String(text || '');
    const re = /(doru[čc]en[oaýíé]?|doru[čc]ení|p[řr]evzal[aiy]?|p[řr]evzat[oaý]?|p[řr]evzet[ií])[^\n\d]{0,60}?(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/gi;
    const all = [];
    let m;
    while ((m = re.exec(t))) {
        const d = parseInt(m[2], 10), mo = parseInt(m[3], 10), y = parseInt(m[4], 10);
        if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
        const key = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (!all.includes(key)) all.push(key);
    }
    all.sort();
    return { date: all[0] || null, all, conflict: all.length > 1 };
}

module.exports = { pickProceduralDeadline, calculateDeadlineDate, extractDeliveryDates, validateExtraction, calculateDeadlineByUnit, detectDeadlines, normalizeDeadlineUnit, collectUnitDeadlines, runAIExtractor };
