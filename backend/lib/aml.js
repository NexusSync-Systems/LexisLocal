/**
 * LexisLocal — AML: identifikace a kontrola klienta.
 *
 * Advokát je u vyjmenovaných služeb povinnou osobou dle zák. č. 253/2008 Sb.
 * (AML). Tento modul podporuje identifikaci klienta (§ 8) a kontrolu (§ 9):
 *   • ověření právnické osoby v ARES + insolvence v ISIR (přes lib/registries),
 *   • screening jména proti LOKÁLNÍMU seznamu (PEP / sankce), který si vede
 *     kancelář,
 *   • klasifikaci rizika a vytvoření auditovatelného záznamu, navázaného na spis.
 *
 * POCTIVĚ K LIMITŮM: úplný screening PEP a mezinárodních sankčních seznamů
 * vyžaduje EXTERNÍ aktualizovaný zdroj (EU/OFAC/…). Tento modul screenuje jen
 * lokální seznam kanceláře a proto vždy nastaví `needsManualScreening=true` —
 * povinnou osobu nezbavuje odpovědnosti ověřit klienta i vůči oficiálním seznamům.
 */
'use strict';

const db = require('./database');
const registries = require('./registries');
const sanctions = require('./sanctions');
const spisy = require('./spisy');

function _deaccent(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// --- Lokální PEP / sankční seznam kanceláře ---------------------------------
function listWatch() {
    return db.get('aml_watchlist') || [];
}
function addWatch(entry) {
    entry = entry || {};
    const name = String(entry.name || '').trim();
    if (!name) throw new Error('Záznam do seznamu musí mít jméno.');
    return db.insert('aml_watchlist', {
        name: name,
        type: entry.type === 'PEP' ? 'PEP' : (entry.type === 'SANKCE' ? 'SANKCE' : 'JINE'),
        note: entry.note ? String(entry.note) : ''
    });
}
// Shoda jména proti lokálnímu seznamu (substringová, bez diakritiky).
function _matchWatch(name) {
    const n = _deaccent(name);
    if (!n) return [];
    return listWatch().filter(w => {
        const wn = _deaccent(w.name);
        return wn && (n.includes(wn) || wn.includes(n));
    });
}

// --- Klasifikace rizika -----------------------------------------------------
function _assessRisk(factors) {
    if (factors.some(f => f.severity === 'high')) return 'high';
    if (factors.some(f => f.severity === 'medium')) return 'medium';
    return 'low';
}

/**
 * Provede identifikaci a kontrolu klienta a uloží auditovatelný AML záznam.
 * @param input { typ:'FO'|'PO', jmeno, ico, rc, adresa, spisId, provedl, poznamka }
 */

// Shoda zadaného názvu s názvem z ARES: alespoň jedno významné slovo (bez právní formy) společné.
const _AML_FORMS = new Set(['sro', 'spol', 'as', 'ks', 'vos', 'zs', 'se', 'ops', 'zu', 'druzstvo']);
function _nameTokens(s) {
    return _deaccent(String(s || '')).toLowerCase()
        .replace(/s\.\s*r\.\s*o\.?/g, ' sro ').replace(/a\.\s*s\.?/g, ' as ')
        .split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !_AML_FORMS.has(t));
}
function _namesCompatible(a, b) {
    const A = _nameTokens(a), B = new Set(_nameTokens(b));
    if (!A.length || !B.size) return true; // nelze posoudit → nehlásit falešně
    return A.some(t => B.has(t));
}

async function identify(input) {
    input = input || {};
    const typ = input.typ === 'PO' ? 'PO' : (input.typ === 'FO' ? 'FO' : (input.ico ? 'PO' : 'FO'));
    const jmeno = String(input.jmeno || '').trim();
    if (!jmeno) throw new Error('Jméno / název klienta je povinné pro identifikaci.');
    const ico = input.ico ? String(input.ico).replace(/\s+/g, '') : '';

    const factors = [];

    // 1) Ověření v registrech (PO / je-li IČO).
    let registryData = null;
    if (ico) {
        try {
            registryData = await registries.checkSubject(ico);
            if (registryData && registryData.error) {
                factors.push({ code: 'ico_neplatne', severity: 'medium', detail: registryData.error });
                registryData = null;
            } else if (registryData && registryData.inInsolvency) {
                factors.push({ code: 'insolvence', severity: 'high', detail: registryData.insolvencyCase || 'aktivní insolvence' });
            }
            // Zadaný název musí odpovídat subjektu s daným IČO (překlep v IČO / záměna subjektu).
            if (registryData && registryData.aresOk !== false && registryData.name && !_namesCompatible(jmeno, registryData.name)) {
                factors.push({ code: 'nazev_nesouhlasi', severity: 'medium', detail: `IČO ${ico} patří v ARES subjektu „${registryData.name}“, zadáno „${jmeno}“.` });
            }
        } catch (e) {
            factors.push({ code: 'registry_nedostupne', severity: 'medium', detail: e.message });
        }
    } else if (typ === 'PO') {
        factors.push({ code: 'ico_chybi', severity: 'medium', detail: 'PO bez IČO — nelze ověřit v registrech.' });
    }

    // 2) Úplnost identifikace fyzické osoby.
    if (typ === 'FO' && !input.rc && !input.adresa) {
        factors.push({ code: 'identifikace_neuplna', severity: 'medium', detail: 'Chybí RČ i adresa FO.' });
    }

    // 3) Screening proti lokálnímu PEP/sankčnímu seznamu.
    const watchHits = _matchWatch(jmeno);
    if (watchHits.length) {
        const hasSankce = watchHits.some(w => w.type === 'SANKCE');
        factors.push({
            code: hasSankce ? 'sankcni_shoda' : 'pep_shoda',
            severity: 'high',
            detail: watchHits.map(w => `${w.name} (${w.type})`).join(', ')
        });
    }

    // 3b) Screening proti OFICIÁLNÍMU sankčnímu seznamu (EU/OFAC/UN), je-li načten.
    // FAIL-CLOSED: když seznam není k dispozici, needsManualScreening zůstává true.
    let sanctionsScreen = { available: false, matches: [] };
    try { sanctionsScreen = sanctions.screenName(jmeno); } catch (e) { sanctionsScreen = { available: false, matches: [] }; }
    if (sanctionsScreen.available && sanctionsScreen.matches.length) {
        factors.push({
            code: 'sankcni_shoda_oficialni',
            severity: 'high',
            detail: sanctionsScreen.matches.map(m => `${m.name} (${m.list}${m.program ? ': ' + m.program : ''})`).join(', ')
        });
    }

    const risk = _assessRisk(factors);

    const record = db.insert('aml_checks', {
        typ: typ,
        jmeno: jmeno,
        ico: ico || null,
        rc: input.rc ? String(input.rc) : null,
        adresa: input.adresa ? String(input.adresa) : null,
        spisId: input.spisId || null,
        provedl: input.provedl ? String(input.provedl) : '',
        poznamka: input.poznamka ? String(input.poznamka) : '',
        registry: registryData ? {
            name: registryData.name, seat: registryData.seat,
            inInsolvency: registryData.inInsolvency, insolvencyCase: registryData.insolvencyCase,
            verifiedAt: registryData.verifiedAt
        } : null,
        watchlistHits: watchHits.map(w => ({ name: w.name, type: w.type })),
        sanctionsHits: (sanctionsScreen.matches || []).map(m => ({ name: m.name, list: m.list, program: m.program || null })),
        sanctionsListAvailable: !!sanctionsScreen.available,
        factors: factors,
        risk: risk,
        // I s oficiálním sankčním seznamem zůstává povinnost ověřit PEP a aktuálnost
        // zdroje — proto needsManualScreening trvale true (lokální/automat ≠ úřední).
        needsManualScreening: true,
        note: sanctionsScreen.available
            ? 'Screening proběhl proti lokálnímu seznamu i načtenému sankčnímu seznamu. Ověřte ještě aktuálnost seznamu a PEP status u oficiálního zdroje.'
            : 'Screening proběhl jen proti lokálnímu seznamu kanceláře (oficiální sankční seznam nebyl načten). Ověřte klienta i vůči oficiálním PEP/sankčním seznamům (EU/OFAC).'
    });

    if (record.spisId) {
        spisy.addEvent(record.spisId, 'aml', `AML identifikace klienta „${jmeno}" — riziko: ${risk.toUpperCase()}.`);
    }
    return record;
}

function listChecks(filter) {
    filter = filter || {};
    let list = db.get('aml_checks') || [];
    if (filter.spisId) list = list.filter(c => c.spisId === filter.spisId);
    if (filter.risk) list = list.filter(c => c.risk === filter.risk);
    return list;
}
function getCheck(id) {
    return (db.get('aml_checks') || []).find(c => c.id === id) || null;
}

module.exports = { identify, listChecks, getCheck, listWatch, addWatch, _matchWatch, _assessRisk };
