/**
 * lib/korespondence.js — rutinní korespondence od PODATELNY (asistentka) přes Spisovatele.
 *
 * Pravidla (návrh schválený Zdeňkem 27. 10. 2026 po simulaci dne v kanceláři):
 *   • podatelna (úroveň 'file' ve firemním režimu) smí založit koncept JEN typu ze seznamu níže,
 *     ručně nebo přes Spisovatele; podání soudu, právní hodnocení ani smlouvy ne,
 *   • koncept jde vždy „ke kontrole“, schválit ho smí jen advokát (scope approve),
 *   • podatelna upravuje jen VLASTNÍ neschválené koncepty korespondence (zapracování připomínek),
 *   • nic se neodesílá automaticky, ve výchozím stavu VYPNUTO (nastavení kanceláře),
 *   • u konceptu zůstává, kdo ho připravil a jaký typ zvolil; audit + záznam ve spisovém deníku.
 */
'use strict';

const SPOLECNE = 'Píšeš rutinní dopis za advokátní kancelář, který připravuje ASISTENTKA a schválí advokát. ' +
    'Nepiš žádné právní hodnocení, doporučení postupu, výklad zákona, odkazy na paragrafy ani judikaturu a nepočítej lhůty. ' +
    'Neuváděj nic, co není v zadání nebo v podkladech; chybějící údaje (jména, data, částky, adresy) označ [Doplnit]. ' +
    'Krátce, zdvořile, česky, v úředním tónu; podpis „[Doplnit: jméno advokáta], advokát“.';

const TYPY = [
    { id: 'doplneni_podkladu', label: 'Žádost klienta o doplnění podkladů',
        zadani: 'Dopis klientovi s žádostí o zaslání chybějících podkladů ke spisu. Vyjmenuj požadované podklady podle zadání a požádej o jejich zaslání do data, které je v zadání (jinak [Doplnit datum]).' },
    { id: 'pruvodni_dopis', label: 'Průvodní dopis k zaslání kopie písemnosti',
        zadani: 'Průvodní dopis, kterým kancelář zasílá klientovi kopii písemnosti (uveď, o jakou písemnost jde a odkud došla). Obsah písemnosti nehodnoť; jen uveď, že se k ní advokát vyjádří.' },
    { id: 'termin_schuzky', label: 'Potvrzení nebo přesunutí termínu schůzky',
        zadani: 'Potvrzení (nebo návrh přesunutí) termínu schůzky v kanceláři: datum, čas, místo a co si klient má přinést, pokud je to v zadání.' },
    { id: 'upominka_faktury', label: 'Upomínka neuhrazené faktury',
        zadani: 'Zdvořilá upomínka klientovi na neuhrazenou fakturu za právní služby: číslo faktury, částka, splatnost a platební údaje podle zadání. Bez hrozeb a sankcí.' },
    { id: 'informace_dosla_pisemnost', label: 'Informace klientovi, že došla písemnost',
        zadani: 'Krátká informace klientovi, že do kanceláře došla písemnost v jeho věci (od koho a kdy, podle zadání) a že se jí advokát věnuje a ozve se. Obsah ani důsledky písemnosti nevysvětluj.' }
];

function typ(id) { return TYPY.find(t => t.id === id) || null; }

/** Zapnuto? env LEXIS_PODATELNA_KORESPONDENCE (1/0) má přednost před nastavením kanceláře. */
function enabled() {
    const v = process.env.LEXIS_PODATELNA_KORESPONDENCE;
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
    try { return !!require('./config').readSettings().podatelnaKorespondence; } catch (e) { return false; }
}
function source() {
    const v = process.env.LEXIS_PODATELNA_KORESPONDENCE;
    return (v === '1' || v === 'true' || v === '0' || v === 'false') ? 'env' : 'setting';
}
function setEnabled(on) {
    const config = require('./config');
    const st = config.readSettings();
    st.podatelnaKorespondence = !!on;
    config.writeSettings(st);
    return enabled();
}

/**
 * Smí principal založit koncept do spisu? Vrací { ok, viaPodatelna } nebo { status, error }.
 * Kdo má zápis, smí vždy (typ je jen štítek). Podatelna jen se zapnutou volbou a typem ze seznamu.
 */
function canCreate(principal, spisId, typId) {
    const access = require('./access');
    if (!spisId || !access.isFirmMode()) return { ok: true, viaPodatelna: false };
    let spis = null;
    try { spis = require('./spisy').getSpis(spisId); } catch (e) { spis = null; }
    if (!spis) return { status: 404, error: 'Spis nenalezen.' };
    if (access.canAccess(spis, principal, 'write')) return { ok: true, viaPodatelna: false };
    if (!access.canAccess(spis, principal, 'file')) return { status: 403, error: 'Přístup ke spisu odepřen.' };
    if (!enabled()) return { status: 403, error: 'Podatelna smí připravovat korespondenci, jen když to kancelář zapne (Nastavení → Firemní režim).', code: 'korespondence_off' };
    if (!typ(typId)) return { status: 400, error: 'Podatelna může připravit jen rutinní korespondenci — zvolte typ: ' + TYPY.map(t => t.label).join('; ') + '.', code: 'korespondence_typ' };
    return { ok: true, viaPodatelna: true };
}

/** Smí principal upravovat koncept (uložit verzi, zamknout, změnit stav, vyřešit připomínku)? */
function canEditDraft(principal, d) {
    const access = require('./access');
    if (!d || !d.spisId || !access.isFirmMode()) return true; // mimo spis / solo: řídí allowed(write)
    let spis = null;
    try { spis = require('./spisy').getSpis(d.spisId); } catch (e) { spis = null; }
    if (access.canAccess(spis, principal, 'write')) return true;
    // podatelna: jen vlastní neschválená korespondence
    return !!(d.korespondence && principal && d.korespondence.preparedBy && d.korespondence.preparedBy.userId === principal.userId
        && d.status !== 'schvaleno' && access.canAccess(spis, principal, 'file'));
}

/** Zadání pro Spisovatele (přidá se do kontextu). */
function instruction(typId) {
    const t = typ(typId);
    return t ? `ZADÁNÍ OD PODATELNY — ${t.label}.\n${t.zadani}\n${SPOLECNE}` : '';
}

/** Varování k výstupu: obsahuje znaky právního hodnocení, které do korespondence podatelny nepatří? */
function contentWarnings(text) {
    const t = String(text || '');
    const w = [];
    if (/§\s*\d/.test(t)) w.push('odkaz na paragraf');
    if (/\b\d{1,4}\s*(?:Cdo|Odo|Co|ÚS|As|Afs|Ads)\s*\d+\/\d{2,4}/.test(t)) w.push('odkaz na judikaturu');
    if (/doporučuj(?:eme|i)\s+(?:podat|napadnout|odvolat|žalovat)|podat\s+odvolání|lhůt[ay]\s+(?:k|pro)\s+(?:odvolání|odpor)/i.test(t)) w.push('doporučení procesního postupu / lhůta');
    return w;
}

/** Štítek uložený u konceptu. */
function meta(typId, principal, viaPodatelna) {
    const t = typ(typId);
    const p = principal || {};
    return t ? { typ: t.id, label: t.label, viaPodatelna: !!viaPodatelna, preparedBy: { userId: p.userId || 'local', name: p.name || '' } } : null;
}

module.exports = { TYPY, typ, enabled, source, setEnabled, canCreate, canEditDraft, instruction, contentWarnings, meta };
