/**
 * lib/cloud_policy.js — kdy smí dotaz s klientskými daty odejít do cloudového modelu.
 *
 * Mlčenlivost (§ 21 zák. o advokacii) je širší než GDPR: pseudonymizace řeší osobní údaje,
 * ne důvěrné skutečnosti. Proto o cloudu nerozhoduje jen nastavení kanceláře (AI_CHAT_PROVIDER),
 * ale každý SPIS: stupeň citlivosti + souhlas klienta. Rozhoduje advokát, ne software.
 *
 *   A – přísně důvěrné   cloud nikdy (trestní obhajoba, zdravotní údaje, nezletilí, oznamovatelé…)
 *   B – důvěrné          cloud jen s výslovným souhlasem klienta pro tento spis   (VÝCHOZÍ)
 *   C – standardní       cloud se souhlasem pro spis nebo s rámcovým souhlasem ve smlouvě
 *   D – veřejné          cloud bez souhlasu (veřejná data bez vazby na klienta)
 *
 * Pravidla (fail-closed):
 *   • Dotaz nese „cloudový kontext“ požadavku (request_context): které spisy do něj přispěly
 *     (spis konceptu, pasáže z RAG, dokumenty načtené nástrojem) a zda je tam text neznámého
 *     původu. Kontext zakládá route agenta (declare); bez něj cloud neprojde.
 *   • Dotaz nad více spisy má stupeň nejcitlivějšího z nich — musí projít každý.
 *   • Dotaz bez spisu projde jen jako výslovně „veřejný“ (dataClass: 'verejne').
 *   • Přímé API (Anthropic, veřejné OpenAI) nemá EU region ani smluvní rámec kanceláře →
 *     pro klientská data zakázané vždy; jen veřejný dotaz a jen s LEXIS_POVOLIT_PRIME_API=1.
 *   • OpenAI-kompatibilní server na loopbacku / v LAN (vLLM, LM Studio) je LOKÁLNÍ model.
 *   • Odepřený cloud: ve výchozím stavu se dotaz zpracuje lokálně (Ollama) a zapíše do auditu;
 *     LEXIS_CLOUD_ODEPRENI=chyba místo toho vrátí chybu.
 */
'use strict';

const requestContext = require('./request_context');

const STUPNE = {
    A: { label: 'A – přísně důvěrné', cloud: 'nikdy', popis: 'Jen lokálně. Cloud zakázán i se souhlasem klienta.' },
    B: { label: 'B – důvěrné', cloud: 'souhlas_spis', popis: 'Cloud jen s výslovným souhlasem klienta pro tento spis.' },
    C: { label: 'C – standardní', cloud: 'souhlas', popis: 'Cloud se souhlasem pro spis nebo s rámcovým souhlasem ve smlouvě o právních službách.' },
    D: { label: 'D – veřejné', cloud: 'vzdy', popis: 'Veřejná data bez vazby na klienta; cloud bez souhlasu.' }
};
const PORADI = ['D', 'C', 'B', 'A']; // od nejméně po nejvíc citlivý
const VYCHOZI_STUPEN = 'B';
const TYPY_SOUHLASU = { spis: 'Výslovný souhlas pro tento spis', ramcovy: 'Rámcový souhlas ve smlouvě o právních službách' };

class CloudPolicyError extends Error {
    constructor(message, status, code) { super(message); this.status = status || 400; this.code = code || 'cloud_policy'; }
}

function _truthy(v) { const t = String(v == null ? '' : v).trim().toLowerCase(); return t !== '' && t !== '0' && t !== 'false' && t !== 'no' && t !== 'off'; }
function _spisy() { return require('./spisy'); }
function _label(spis) { return spis ? (spis.spisZn || spis.nazev || spis.id) : '(neznámý spis)'; }

// ---------------------------------------------------------------------------
// Stupeň a souhlas na spisu
// ---------------------------------------------------------------------------
function stupenSpisu(spis) {
    const s = spis && String(spis.cloudStupen || '').toUpperCase();
    return STUPNE[s] ? s : VYCHOZI_STUPEN;
}
function platnySouhlas(spis) {
    const s = spis && spis.cloudSouhlas;
    return s && s.stav === 'udelen' && TYPY_SOUHLASU[s.typ] ? s : null;
}

/** Vyhodnocení jednoho spisu: { ok, stupen, code?, duvod? }. */
function vyhodnotSpis(spis) {
    if (!spis) return { ok: false, stupen: null, code: 'spis_nenalezen', duvod: 'Spis nenalezen.' };
    const st = stupenSpisu(spis);
    const souhlas = platnySouhlas(spis);
    const l = _label(spis);
    if (st === 'A') return { ok: false, stupen: st, code: 'stupen_a', duvod: `Spis ${l} je přísně důvěrný (stupeň A) — zpracování jen lokálně.` };
    if (st === 'B' && !(souhlas && souhlas.typ === 'spis')) {
        return { ok: false, stupen: st, code: 'chybi_souhlas', duvod: `Spis ${l} (stupeň B) vyžaduje výslovný souhlas klienta pro tento spis.` };
    }
    if (st === 'C' && !souhlas) {
        return { ok: false, stupen: st, code: 'chybi_souhlas', duvod: `Spis ${l} (stupeň C) vyžaduje souhlas klienta (pro spis nebo rámcový).` };
    }
    return { ok: true, stupen: st, souhlas: souhlas ? souhlas.typ : null };
}

function _actor(principal) {
    if (principal) return { id: principal.userId || null, name: principal.name || null };
    const a = requestContext.currentActor();
    return a ? { id: a.id || null, name: a.name || null } : null;
}
function _hasScope(principal, scope) {
    if (!principal) return true; // mimo HTTP (testy, skripty) — oprávnění řeší volající
    if (principal.kind === 'agent') return false; // AI agent o stupni ani souhlasu nerozhoduje
    return require('./principal').hasScope(principal, scope);
}
function _audit(operation, spis, details) {
    try { require('./audit').logEvent('Cloud AI', operation, _label(spis), Object.assign({ spisId: spis.id }, details || {})); } catch (e) { /* audit best-effort */ }
}

/**
 * Změna stupně. Zvýšení smí každý se zápisem do spisu; snížení jen advokát/správce
 * (scope approve) a s odůvodněním (zapíše se do deníku i auditu).
 */
function setStupen(spisId, stupen, opts) {
    opts = opts || {};
    const S = _spisy();
    const spis = S.getSpis(spisId);
    if (!spis) throw new CloudPolicyError('Spis nenalezen.', 404, 'not_found');
    const novy = String(stupen || '').toUpperCase();
    if (!STUPNE[novy]) throw new CloudPolicyError('Neznámý stupeň citlivosti. Povolené: A, B, C, D.', 400, 'bad_stupen');
    const stary = stupenSpisu(spis);
    if (novy === stary && spis.cloudStupen) return spis;
    const snizeni = PORADI.indexOf(novy) < PORADI.indexOf(stary);
    const duvod = opts.duvod ? String(opts.duvod).trim() : '';
    if (snizeni) {
        if (!_hasScope(opts.principal, 'approve')) throw new CloudPolicyError('Snížit stupeň citlivosti smí jen advokát nebo správce.', 403, 'forbidden_role');
        if (duvod.length < 5) throw new CloudPolicyError('Snížení stupně citlivosti vyžaduje odůvodnění.', 400, 'missing_reason');
    } else if (opts.principal && opts.principal.kind === 'agent') {
        throw new CloudPolicyError('AI agent stupeň citlivosti nemění.', 403, 'forbidden_role');
    }
    const kdo = _actor(opts.principal);
    const patch = { cloudStupen: novy, cloudStupenZmena: { od: stary, at: new Date().toISOString(), kdo, duvod: duvod || null } };
    const updated = require('./database').update('spisy', spis.id, patch);
    S.addEvent(spis.id, 'cloud_stupen', `Stupeň citlivosti: ${STUPNE[stary].label} → ${STUPNE[novy].label}${duvod ? ' (' + duvod + ')' : ''}.`, { od: stary, na: novy, kdo });
    _audit(snizeni ? 'Snížení stupně citlivosti' : 'Zvýšení stupně citlivosti', spis, { od: stary, na: novy, duvod: duvod || null });
    return updated;
}

/** Udělení souhlasu klienta (zaznamenává advokát/správce). typ: 'spis' | 'ramcovy'. */
function udelSouhlas(spisId, opts) {
    opts = opts || {};
    const S = _spisy();
    const spis = S.getSpis(spisId);
    if (!spis) throw new CloudPolicyError('Spis nenalezen.', 404, 'not_found');
    if (!_hasScope(opts.principal, 'approve')) throw new CloudPolicyError('Souhlas klienta zaznamenává jen advokát nebo správce.', 403, 'forbidden_role');
    const typ = String(opts.typ || 'spis');
    if (!TYPY_SOUHLASU[typ]) throw new CloudPolicyError('Neznámý typ souhlasu. Povolené: spis, ramcovy.', 400, 'bad_typ');
    if (stupenSpisu(spis) === 'A') throw new CloudPolicyError('Spis má stupeň A — cloud je zakázán i se souhlasem klienta.', 409, 'stupen_a');
    const kdo = _actor(opts.principal);
    const souhlas = {
        stav: 'udelen', typ,
        udelenoAt: new Date().toISOString(), udelil: kdo,
        // Jak byl souhlas získán (písemně, e-mailem, ve smlouvě…) — doklad má kancelář ve spisu.
        poznamka: opts.poznamka ? String(opts.poznamka).slice(0, 500) : null
    };
    const updated = require('./database').update('spisy', spis.id, { cloudSouhlas: souhlas });
    S.addEvent(spis.id, 'cloud_souhlas', `Souhlas klienta se zpracováním v cloudu: ${TYPY_SOUHLASU[typ]}${souhlas.poznamka ? ' (' + souhlas.poznamka + ')' : ''}.`, { typ, kdo });
    _audit('Udělení souhlasu klienta s cloudem', spis, { typ, poznamka: souhlas.poznamka });
    return updated;
}

/** Odvolání souhlasu — smí každý se zápisem do spisu (bezpečný směr); účinné okamžitě. */
function odvolejSouhlas(spisId, opts) {
    opts = opts || {};
    const S = _spisy();
    const spis = S.getSpis(spisId);
    if (!spis) throw new CloudPolicyError('Spis nenalezen.', 404, 'not_found');
    if (opts.principal && opts.principal.kind === 'agent') throw new CloudPolicyError('AI agent souhlas neodvolává.', 403, 'forbidden_role');
    const prev = spis.cloudSouhlas;
    if (!prev || prev.stav !== 'udelen') return spis;
    const kdo = _actor(opts.principal);
    const souhlas = Object.assign({}, prev, { stav: 'odvolan', odvolanoAt: new Date().toISOString(), odvolal: kdo, duvodOdvolani: opts.duvod ? String(opts.duvod).slice(0, 500) : null });
    const updated = require('./database').update('spisy', spis.id, { cloudSouhlas: souhlas });
    S.addEvent(spis.id, 'cloud_souhlas_odvolan', 'Souhlas klienta se zpracováním v cloudu odvolán — další dotazy jen lokálně.', { kdo });
    _audit('Odvolání souhlasu klienta s cloudem', spis, { duvod: souhlas.duvodOdvolani });
    return updated;
}

/** Přehled pro UI/API. */
function stavSpisu(spis) {
    if (!spis) return null;
    const st = stupenSpisu(spis);
    return {
        stupen: st, stupenNastaven: !!spis.cloudStupen, stupenLabel: STUPNE[st].label,
        souhlas: spis.cloudSouhlas || null, platnySouhlas: !!platnySouhlas(spis),
        cloudPovolen: vyhodnotSpis(spis).ok, vyhodnoceni: vyhodnotSpis(spis),
        zmena: spis.cloudStupenZmena || null
    };
}

// ---------------------------------------------------------------------------
// Cloudový kontext požadavku (co do dotazu přispělo)
// ---------------------------------------------------------------------------
function _ctx(create) {
    const store = requestContext.current();
    if (!store) return null;
    if (!store.cloud && create) store.cloud = { declared: false, dataClass: null, spisIds: new Set(), unknown: [], logged: new Set(), last: null };
    return store.cloud || null;
}

/** Route agenta ohlásí, že dotaz sestavuje (bez toho cloud neprojde). dataClass: 'verejne' | jinak nezařazeno. */
function declare(opts) {
    const c = _ctx(true);
    if (!c) return null;
    c.declared = true;
    const dc = opts && opts.dataClass ? String(opts.dataClass).toLowerCase() : null;
    // „verejne“ nelze přebít: jakmile přispěje spis nebo neznámý text, rozhodují ty.
    if (dc === 'verejne' && c.dataClass == null) c.dataClass = 'verejne';
    else if (dc && dc !== 'verejne') c.dataClass = 'nezarazeno';
    return c;
}
function noteSpis(spisId) {
    const c = _ctx(true);
    if (c && spisId) c.spisIds.add(String(spisId));
}
function noteCase(caseNumber) {
    if (!caseNumber) return;
    const spis = _spisy().findByCase(caseNumber);
    if (spis) noteSpis(spis.id); else noteUnknown(`sp. zn. ${caseNumber} bez spisu`);
}
function noteUnknown(reason) {
    const c = _ctx(true);
    if (c && c.unknown.length < 20) c.unknown.push(String(reason || 'text neznámého původu'));
}
/** Dokument/úsek ze souboru: přiřadí spis, jinak „neznámý původ“. */
function noteFile(fileName) {
    if (!fileName) return;
    let spis = null;
    try { spis = require('./file_acl').spisForFileName(fileName); } catch (e) { spis = null; }
    if (spis) noteSpis(spis.id); else noteUnknown(`dokument mimo spis: ${String(fileName).slice(0, 80)}`);
}
/** Výsledky RAG: znalostní báze (scope _kb_*) je veřejná, klientské úseky se přiřadí ke spisu. */
function noteRagMatches(matches) {
    (matches || []).forEach(m => {
        if (!m) return;
        if (typeof m.scope === 'string' && m.scope.indexOf('_kb_') === 0) return;
        noteFile(m.fileName);
    });
}

/** Spustí fn s vlastním cloudovým kontextem (např. úloha mimo HTTP požadavek). */
function scope(opts, fn) {
    const parent = requestContext.current() || {};
    return requestContext.run(Object.assign({}, parent, { cloud: undefined }), () => { declare(opts); return fn(); });
}

// ---------------------------------------------------------------------------
// Rozhodnutí pro konkrétního poskytovatele
// ---------------------------------------------------------------------------
function _isLocalHost(h) {
    h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return false;
    if (h === 'localhost' || h === '::1' || h === 'host.docker.internal' || /\.(localhost|local|lan|internal)$/.test(h)) return true;
    const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
    if (!m) return false;
    const a = +m[1], b = +m[2];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
function isLocalUrl(url) {
    try { return _isLocalHost(new URL(url).hostname); } catch (e) { return false; }
}
/** 'lokalni' | 'cloud_eu' | 'prime_api' | 'nezname' */
function druhPoskytovatele(provider) {
    const p = String(provider || '').toLowerCase();
    if (p === 'ollama') return 'lokalni';
    if (p === 'openai') return isLocalUrl(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') ? 'lokalni' : 'prime_api';
    if (p === 'anthropic') return 'prime_api';
    if (p === 'bedrock') return 'cloud_eu';
    return 'nezname';
}

/**
 * Smí aktuální dotaz k poskytovateli? Vrací
 * { allowed, druh, code, duvody[], spisy[{id, spisZn, stupen}], dataClass }.
 */
function rozhodni(provider) {
    const druh = druhPoskytovatele(provider);
    if (druh === 'lokalni') return { allowed: true, druh, code: 'lokalni', duvody: [], spisy: [] };
    const c = _ctx(false);
    const S = _spisy();
    const spisy = c ? [...c.spisIds].map(id => S.getSpis(id) || { id, _missing: true }) : [];
    const popis = spisy.map(s => ({ id: s.id, spisZn: s.spisZn || s.nazev || null, stupen: s._missing ? null : stupenSpisu(s) }));
    const base = { druh, spisy: popis, dataClass: c ? c.dataClass : null };
    const deny = (code, duvody) => Object.assign({ allowed: false, code, duvody }, base);

    if (druh === 'nezname') return deny('nezname', [`Neznámý poskytovatel AI „${provider}“.`]);

    if (druh === 'prime_api') {
        const verejny = c && c.declared && c.dataClass === 'verejne' && c.spisIds.size === 0 && c.unknown.length === 0;
        if (verejny && _truthy(process.env.LEXIS_POVOLIT_PRIME_API)) return Object.assign({ allowed: true, code: 'verejne_prime_api', duvody: [] }, base);
        return deny('prime_api', ['Přímé API (' + provider + ') nemá EU region ani smluvní rámec kanceláře — klientská data přes něj neodcházejí. Použijte Claude přes Amazon Bedrock v EU.']);
    }

    // cloud_eu (Bedrock)
    if (!c || !c.declared) {
        if (process.env.LEXIS_CLOUD_BEZ_KONTEXTU === 'povolit') {
            return Object.assign({ allowed: true, code: 'bez_kontextu_povoleno', duvody: ['Dotaz bez kontextu spisu — povoleno nastavením LEXIS_CLOUD_BEZ_KONTEXTU (jen pro testy se syntetickými daty).'] }, base);
        }
        return deny('bez_kontextu', ['Dotaz nemá kontext spisu (úloha mimo asistenta) — zpracování jen lokálně.']);
    }
    if (c.unknown.length) return deny('neznamy_puvod', ['Dotaz obsahuje text neznámého původu: ' + c.unknown.slice(0, 3).join('; ') + '.']);
    if (c.spisIds.size === 0) {
        if (c.dataClass === 'verejne') return Object.assign({ allowed: true, code: 'verejne', duvody: [] }, base);
        return deny('nezarazeno', ['Dotaz není navázaný na spis ani označený jako veřejný (bez klientských údajů).']);
    }
    const duvody = [];
    for (const s of spisy) {
        const v = s._missing ? { ok: false, duvod: 'Spis ' + s.id + ' nenalezen.' } : vyhodnotSpis(s);
        if (!v.ok) duvody.push(v.duvod);
    }
    if (duvody.length) return deny('spis', duvody);
    return Object.assign({ allowed: true, code: 'spis', duvody: [] }, base);
}

/** Zapíše rozhodnutí do auditu (jednou za požadavek a výsledek) a do deníku spisů. */
function zaznamenej(decision, info) {
    info = info || {};
    const c = _ctx(false);
    if (c) c.last = Object.assign({}, decision, { provider: info.provider || null, model: info.model || null });
    const key = (decision.allowed ? 'ok:' : 'deny:') + decision.code;
    if (c) { if (c.logged.has(key)) return; c.logged.add(key); }
    const ids = (decision.spisy || []).map(s => s.id);
    try {
        require('./audit').logEvent('Cloud AI',
            decision.allowed ? 'Dotaz odeslán do cloudu' : (info.fallback ? 'Cloud odepřen — zpracováno lokálně' : 'Cloud odepřen'),
            (decision.spisy || []).map(s => s.spisZn || s.id).join(', ') || (decision.dataClass === 'verejne' ? 'veřejný dotaz' : 'bez spisu'),
            { spisId: ids.length === 1 ? ids[0] : null, spisIds: ids, provider: info.provider || null, model: info.model || null,
              code: decision.code, duvody: decision.duvody, stupne: (decision.spisy || []).map(s => s.stupen) });
    } catch (e) { /* audit best-effort */ }
    if (decision.allowed) {
        const S = _spisy();
        for (const id of ids) {
            try { S.addEvent(id, 'cloud_ai', `Dotaz asistenta zpracován v cloudu (${info.provider || 'cloud'}${info.model ? ', ' + info.model : ''}).`, { provider: info.provider || null, model: info.model || null }); } catch (e) { /* deník best-effort */ }
        }
    }
}

/** Přičte spotřebu cloudového volání k požadavku (zobrazí se v odpovědi asistenta). */
function pridejNaklady(rec) {
    const c = _ctx(false);
    if (!c || !rec) return;
    c.naklady = c.naklady || { volani: 0, inputTokens: 0, outputTokens: 0, odhadUsd: 0, bezCeniku: false };
    c.naklady.volani++;
    c.naklady.inputTokens += rec.inputTokens || 0;
    c.naklady.outputTokens += rec.outputTokens || 0;
    if (rec.odhadUsd == null) c.naklady.bezCeniku = true; else c.naklady.odhadUsd = Math.round((c.naklady.odhadUsd + rec.odhadUsd) * 1e6) / 1e6;
}

/** Shrnutí pro odpověď API (co se s dotazem stalo a kolik stál). */
function shrnuti() {
    const c = _ctx(false);
    if (!c || !c.last) return null;
    const d = c.last;
    return { cloud: !!d.allowed, druh: d.druh, code: d.code, provider: d.provider, duvody: d.duvody || [], spisy: d.spisy || [], naklady: c.naklady || null };
}

function rezimOdepreni() { return String(process.env.LEXIS_CLOUD_ODEPRENI || 'lokalne').toLowerCase() === 'chyba' ? 'chyba' : 'lokalne'; }

module.exports = {
    STUPNE, VYCHOZI_STUPEN, TYPY_SOUHLASU, CloudPolicyError,
    stupenSpisu, platnySouhlas, vyhodnotSpis, stavSpisu,
    setStupen, udelSouhlas, odvolejSouhlas,
    declare, noteSpis, noteCase, noteFile, noteUnknown, noteRagMatches, scope, pridejNaklady,
    isLocalUrl, druhPoskytovatele, rozhodni, zaznamenej, shrnuti, rezimOdepreni
};
