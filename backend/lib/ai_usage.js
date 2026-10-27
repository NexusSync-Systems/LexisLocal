/**
 * lib/ai_usage.js — spotřeba cloudové AI (tokeny, odhad ceny), měsíční rozpočet a jeho čára.
 *
 * Tři zdroje s různou rychlostí:
 *   1. LexisLocal (živě): každé volání Bedrocku vrací přesný počet tokenů (`usage`) →
 *      × ceník kanceláře = odhad v USD; ví i KE KTERÉMU SPISU a uživateli tokeny patří.
 *   2. AWS fakturace (večer, lib/aws_billing.js): Cost Explorer vrátí skutečné částky po dnech.
 *      Za dny, které AWS potvrdil, se zobrazuje částka AWS; od poslední synchronizace odhad
 *      (opravený poměrem AWS/odhad z poslední synchronizace). Rozdíl nad toleranci = upozornění.
 *   3. AWS Budgets: e-mailové upozornění ze šablony scripts/aws/bedrock-eu-kancelar.yaml.
 *
 * Dny jsou v UTC (stejně jako fakturace AWS). Částky v USD (AWS účtuje v USD).
 * Nastavení (config.readSettings().aiBudget): mesicniRozpocetUsd, varovaniPct, tvrdyStrop, cenik.
 */
'use strict';

const db = require('./database');
const config = require('./config');

// USD za 1 milion tokenů. Výchozí odhad pro EU inference profily (regionální ≈ +10 % k ceníku
// Anthropicu, 10/2026). Kancelář si ceník upraví v nastavení; večerní porovnání s AWS ukáže odchylku.
const VYCHOZI_CENIK = [
    { vzor: 'opus', vstup: 5.50, vystup: 27.50 },
    { vzor: 'sonnet', vstup: 3.30, vystup: 16.50 },
    { vzor: 'haiku', vstup: 1.10, vystup: 5.50 }
];
const VYCHOZI = { mesicniRozpocetUsd: 0, varovaniPct: 80, tvrdyStrop: false, tolerancePct: 5, cenik: VYCHOZI_CENIK };

function _num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function _round(n, d = 4) { const f = Math.pow(10, d); return Math.round((Number(n) || 0) * f) / f; }
function dnes(now) { return (now || new Date()).toISOString().slice(0, 10); }
function mesicZ(den) { return String(den).slice(0, 7); }

// --- Nastavení -------------------------------------------------------------
function nastaveni() {
    const s = config.readSettings().aiBudget || {};
    const cenik = Array.isArray(s.cenik) && s.cenik.length ? s.cenik : VYCHOZI_CENIK;
    return {
        mesicniRozpocetUsd: Math.max(0, _num(s.mesicniRozpocetUsd, VYCHOZI.mesicniRozpocetUsd)),
        varovaniPct: Math.min(100, Math.max(1, _num(s.varovaniPct, VYCHOZI.varovaniPct))),
        tvrdyStrop: s.tvrdyStrop === true,
        tolerancePct: Math.max(0, _num(s.tolerancePct, VYCHOZI.tolerancePct)),
        cenik: cenik.map(c => ({ vzor: String(c.vzor || '').toLowerCase(), vstup: Math.max(0, _num(c.vstup, 0)), vystup: Math.max(0, _num(c.vystup, 0)) })).filter(c => c.vzor)
    };
}
function ulozNastaveni(patch) {
    patch = patch || {};
    const all = config.readSettings();
    const cur = Object.assign({}, nastaveni());
    if (patch.mesicniRozpocetUsd !== undefined) {
        const v = Number(patch.mesicniRozpocetUsd);
        if (!Number.isFinite(v) || v < 0) throw new Error('Rozpočet musí být nezáporné číslo (USD).');
        cur.mesicniRozpocetUsd = _round(v, 2);
    }
    if (patch.varovaniPct !== undefined) {
        const v = Number(patch.varovaniPct);
        if (!Number.isFinite(v) || v < 1 || v > 100) throw new Error('Hranice varování musí být 1–100 %.');
        cur.varovaniPct = v;
    }
    if (patch.tvrdyStrop !== undefined) cur.tvrdyStrop = patch.tvrdyStrop === true || patch.tvrdyStrop === 'true';
    if (patch.tolerancePct !== undefined) {
        const v = Number(patch.tolerancePct);
        if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error('Tolerance musí být 0–100 %.');
        cur.tolerancePct = v;
    }
    if (patch.cenik !== undefined) {
        if (!Array.isArray(patch.cenik)) throw new Error('Ceník musí být seznam { vzor, vstup, vystup }.');
        cur.cenik = patch.cenik.map(c => {
            const vzor = String((c && c.vzor) || '').trim().toLowerCase();
            const vstup = Number(c && c.vstup), vystup = Number(c && c.vystup);
            if (!vzor || !Number.isFinite(vstup) || !Number.isFinite(vystup) || vstup < 0 || vystup < 0) throw new Error('Neplatný řádek ceníku.');
            return { vzor, vstup, vystup };
        });
    }
    all.aiBudget = cur;
    config.writeSettings(all);
    try { require('./audit').logEvent('Nastavení', 'Rozpočet a ceník cloudové AI', `${cur.mesicniRozpocetUsd} USD / měsíc`, { varovaniPct: cur.varovaniPct, tvrdyStrop: cur.tvrdyStrop }); } catch (e) { /* audit best-effort */ }
    return nastaveni();
}

/** Ceník pro model (první řádek, jehož vzor je v ID modelu), nebo null. */
function cenaModelu(model, cenik) {
    const m = String(model || '').toLowerCase();
    return (cenik || nastaveni().cenik).find(c => m.indexOf(c.vzor) !== -1) || null;
}
/** Odhad ceny volání v USD (null = model bez ceníku). Cache: zápis ≈ 1,25× vstup, čtení ≈ 0,1× vstup. */
function odhadCeny(model, u, cenik) {
    const c = cenaModelu(model, cenik);
    if (!c) return null;
    const inT = _num(u.inputTokens, 0), outT = _num(u.outputTokens, 0);
    const cw = _num(u.cacheWriteInputTokens, 0), cr = _num(u.cacheReadInputTokens, 0);
    return _round((inT * c.vstup + outT * c.vystup + cw * c.vstup * 1.25 + cr * c.vstup * 0.1) / 1e6, 6);
}

// --- Záznam ----------------------------------------------------------------
function _denniPocitadlo(den, pole) {
    const list = db.get('ai_usage_daily') || [];
    const row = list.find(r => r.den === den);
    if (row) db.update('ai_usage_daily', row.id, { [pole]: (row[pole] || 0) + 1 });
    else db.insert('ai_usage_daily', { den, lokalne: 0, cloud: 0, odepreno: 0, [pole]: 1 });
}
/** Počítadlo dotazů: 'lokalne' | 'cloud' | 'odepreno'. */
function pocitej(druh) {
    if (['lokalne', 'cloud', 'odepreno'].indexOf(druh) === -1) return;
    try { _denniPocitadlo(dnes(), druh); } catch (e) { /* statistika nesmí shodit dotaz */ }
}

/**
 * Záznam jednoho cloudového volání. info: { provider, model, usage, spisIds, kdo }.
 * Vrací záznam (s odhadem ceny) nebo null.
 */
function zaznamenej(info) {
    info = info || {};
    const u = info.usage || {};
    const inT = _num(u.inputTokens != null ? u.inputTokens : u.input_tokens, 0);
    const outT = _num(u.outputTokens != null ? u.outputTokens : u.output_tokens, 0);
    const usage = { inputTokens: inT, outputTokens: outT, cacheReadInputTokens: _num(u.cacheReadInputTokens, 0), cacheWriteInputTokens: _num(u.cacheWriteInputTokens, 0) };
    let kdo = info.kdo || null;
    if (!kdo) { try { kdo = require('./request_context').currentActor(); } catch (e) { kdo = null; } }
    try {
        return db.insert('ai_usage', {
            den: dnes(), provider: info.provider || null, model: info.model || null,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens,
            odhadUsd: odhadCeny(info.model, usage),
            spisIds: Array.isArray(info.spisIds) ? info.spisIds.slice(0, 20) : [],
            uzivatel: kdo ? (kdo.name || kdo.id || null) : null
        });
    } catch (e) { return null; }
}

// --- Synchronizace s AWS (výsledky ukládá lib/aws_billing.js) ---------------
function posledniSync(mesic, jenUspesna) {
    const list = (db.get('ai_billing_sync') || []).filter(s => s.mesic === mesic && (!jenUspesna || s.stav !== 'chyba'));
    return list.length ? list[list.length - 1] : null;
}

function _dnyMesice(mesic) {
    const [y, m] = mesic.split('-').map(Number);
    const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return Array.from({ length: n }, (_, i) => `${mesic}-${String(i + 1).padStart(2, '0')}`);
}

/**
 * Přehled měsíce: rozpočet, utraceno (AWS potvrzeno + odhad od synchronizace), řada po dnech
 * pro graf (kumulativně, se zdrojem 'aws'|'odhad'), odhad do konce měsíce, rozpad po spisech,
 * uživatelích a modelech, počty dotazů lokálně / v cloudu / odepřeno.
 */
function souhrn(mesic, now) {
    now = now || new Date();
    mesic = /^\d{4}-\d{2}$/.test(String(mesic || '')) ? mesic : dnes(now).slice(0, 7);
    const n = nastaveni();
    const zaznamy = (db.get('ai_usage') || []).filter(r => mesicZ(r.den) === mesic);
    const sync = posledniSync(mesic, true);
    const posledniPokus = posledniSync(mesic, false);
    const dny = _dnyMesice(mesic);
    const dnesek = dnes(now);

    const odhadDen = {};
    let bezCeniku = 0;
    for (const r of zaznamy) {
        if (r.odhadUsd == null) { bezCeniku++; continue; }
        odhadDen[r.den] = (odhadDen[r.den] || 0) + r.odhadUsd;
    }
    // Opravný poměr z poslední synchronizace (AWS / odhad za stejné dny), jen v rozumných mezích.
    let korekce = 1;
    if (sync && sync.odhadUsd > 0 && sync.awsUsd >= 0) {
        const k = sync.awsUsd / sync.odhadUsd;
        if (k >= 0.5 && k <= 2) korekce = k;
    }
    const potvrzenoDo = sync ? sync.obdobiDo : null; // první den, který AWS ještě nepotvrdil (exkluzivně)
    let kumul = 0;
    const rada = [];
    for (const den of dny) {
        if (den > dnesek) break;
        let castka, zdroj;
        if (potvrzenoDo && den < potvrzenoDo) { castka = (sync.awsDny && sync.awsDny[den]) || 0; zdroj = 'aws'; }
        else { castka = (odhadDen[den] || 0) * korekce; zdroj = 'odhad'; }
        kumul += castka;
        rada.push({ den, castka: _round(castka, 4), kumulativne: _round(kumul, 4), zdroj });
    }
    const celkem = _round(kumul, 4);
    const potvrzeno = sync ? _round(sync.awsUsd, 4) : null;
    const odhadOdSync = _round(celkem - (potvrzeno || 0), 4);
    const uplynulo = rada.length || 1;
    const vyhled = _round(dnesek.slice(0, 7) === mesic ? celkem / uplynulo * dny.length : celkem, 2);
    const rozpocet = n.mesicniRozpocetUsd;
    const pct = rozpocet > 0 ? _round(celkem / rozpocet * 100, 1) : null;
    const stav = !rozpocet ? 'bez_rozpoctu' : pct >= 100 ? 'prekroceno' : pct >= n.varovaniPct ? 'varovani' : 'ok';

    const agg = (keyFn) => {
        const m = new Map();
        for (const r of zaznamy) {
            for (const k of keyFn(r)) {
                const cur = m.get(k) || { klic: k, dotazu: 0, inputTokens: 0, outputTokens: 0, odhadUsd: 0 };
                cur.dotazu++; cur.inputTokens += r.inputTokens || 0; cur.outputTokens += r.outputTokens || 0; cur.odhadUsd += r.odhadUsd || 0;
                m.set(k, cur);
            }
        }
        return [...m.values()].map(x => Object.assign(x, { odhadUsd: _round(x.odhadUsd, 4) })).sort((a, b) => b.odhadUsd - a.odhadUsd);
    };
    const S = require('./spisy');
    const poSpisech = agg(r => (r.spisIds && r.spisIds.length ? r.spisIds : ['(bez spisu)'])).slice(0, 15)
        .map(x => { const s = x.klic !== '(bez spisu)' ? S.getSpis(x.klic) : null; return Object.assign(x, { spisZn: s ? (s.spisZn || s.nazev) : x.klic }); });
    const denni = (db.get('ai_usage_daily') || []).filter(r => mesicZ(r.den) === mesic);
    const pocty = denni.reduce((a, r) => ({ lokalne: a.lokalne + (r.lokalne || 0), cloud: a.cloud + (r.cloud || 0), odepreno: a.odepreno + (r.odepreno || 0) }), { lokalne: 0, cloud: 0, odepreno: 0 });

    return {
        mesic, mena: 'USD', rozpocet, varovaniPct: n.varovaniPct, tvrdyStrop: n.tvrdyStrop, stav, pct,
        celkem, potvrzenoAws: potvrzeno, odhadOdSync, vyhledDoKonceMesice: vyhled, korekce: _round(korekce, 3),
        tokeny: { vstup: zaznamy.reduce((a, r) => a + (r.inputTokens || 0), 0), vystup: zaznamy.reduce((a, r) => a + (r.outputTokens || 0), 0) },
        aktualizovanoOdhad: now.toISOString(),
        sync: sync ? { kdy: sync.kdy, obdobiOd: sync.obdobiOd, obdobiDo: sync.obdobiDo, awsUsd: sync.awsUsd, odhadUsd: sync.odhadUsd, rozdilUsd: sync.rozdilUsd, rozdilPct: sync.rozdilPct, stav: sync.stav, sluzby: sync.sluzby || [] } : null,
        posledniPokus: posledniPokus && posledniPokus !== sync ? { kdy: posledniPokus.kdy, stav: posledniPokus.stav, chyba: posledniPokus.chyba || null } : null,
        rada, dnuVMesici: dny.length, poSpisech, poUzivatelich: agg(r => [r.uzivatel || '(neznámý)']).slice(0, 15),
        poModelech: agg(r => [r.model || '(neznámý)']), pocty, bezCeniku
    };
}

/** Smí další dotaz do cloudu z pohledu rozpočtu? { ok, duvod?, pct } */
function kontrolaRozpoctu(now) {
    const n = nastaveni();
    if (!n.tvrdyStrop || !n.mesicniRozpocetUsd) return { ok: true };
    const s = souhrn(null, now);
    if (s.celkem >= n.mesicniRozpocetUsd) {
        return { ok: false, pct: s.pct, duvod: `Měsíční rozpočet na cloudovou AI (${n.mesicniRozpocetUsd} USD) je vyčerpán (${s.celkem.toFixed(2)} USD) — zpracování lokálně.` };
    }
    return { ok: true, pct: s.pct };
}

module.exports = {
    VYCHOZI_CENIK, nastaveni, ulozNastaveni, cenaModelu, odhadCeny,
    pocitej, zaznamenej, souhrn, kontrolaRozpoctu, posledniSync, dnes
};
