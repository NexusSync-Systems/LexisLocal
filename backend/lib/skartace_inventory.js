'use strict';
/**
 * skartace_inventory.js — co o spisu (a tedy o klientovi) v LexisLocal leží a co se
 * stane při skartaci. JEN ČTE, nic nemaže.
 *
 * Nález 14. 10. 2026 (GDPR kontrola): spisy.deleteSpis() maže jen záznam spisu —
 * deník, souhrny pro klienta, koncepty, dokumenty (vč. RAG indexu), schůzky, AML,
 * faktury i auditní záznamy zůstávají. Inventář ukáže, co zbývá a proč, aby advokát
 * před skartací rozhodl; kaskádové mazání se doplní až po odsouhlasení pravidel.
 *
 * action: 'smazat' (patří jen ke spisu), 'ponechat' (zákonná evidenční povinnost —
 * lhůty ověřit s advokátem), 'pseudonymizovat' (auditní stopa: kdo/kdy zůstane, obsah ne).
 */
const db = require('./database');

function _caseKey(s) { try { return require('./spisy')._caseKey(s); } catch (e) { return String(s || '').toLowerCase(); } }

function inventory(spisId) {
    const spisy = require('./spisy');
    const spis = spisy.getSpis(spisId);
    if (!spis) return null;
    const key = spis.spisZn ? _caseKey(spis.spisZn) : null;
    const by = (col) => (db.get(col) || []).filter(x => x && x.spisId === spisId);
    const files = key ? (db.get('inbox_files') || []).filter(f => f.caseNumber && _caseKey(f.caseNumber) === key) : [];
    let drafts = [];
    try { drafts = require('./drafts').listDrafts({ spisId }); } catch (e) { drafts = []; }
    let auditCount = 0;
    try { auditCount = require('./audit').getLogsForSpis(spisId).length; } catch (e) { auditCount = 0; }

    const items = [
        { kind: 'spis', label: 'Záznam spisu (klient, IČO, e-mail klienta, protistrana)', count: 1, action: 'smazat', note: 'Maže se už dnes (DELETE /api/spisy/:id ve stavu skartace).' },
        { kind: 'spis_events', label: 'Spisový deník', count: by('spis_events').length, action: 'smazat' },
        { kind: 'client_updates', label: 'Souhrny pro klienta (text, e-mail)', count: by('client_updates').length, action: 'smazat' },
        { kind: 'drafts', label: 'Koncepty ke spisu', count: drafts.length, action: 'smazat' },
        { kind: 'documents', label: 'Dokumenty spisu (záznam v doručené poště, text v RAG indexu, soubor na disku)', count: files.length, action: 'smazat', note: 'Včetně úseků v RAG indexu — jinak by je agent dál citoval.' },
        { kind: 'meetings', label: 'Schůzky v kalendáři', count: by('meetings').length, action: 'smazat' },
        { kind: 'invoices', label: 'Faktury', count: by('invoices').length, action: 'ponechat', note: 'Účetní a daňová evidence — lhůtu uchování ověřte.' },
        { kind: 'aml_checks', label: 'AML identifikace a kontrola klienta', count: by('aml_checks').length, action: 'ponechat', note: 'Povinnost uchování podle AML zákona — lhůtu ověřte.' },
        { kind: 'audit', label: 'Auditní stopa spisu', count: auditCount, action: 'pseudonymizovat', note: 'Zachovat kdo/kdy/úkon; předmět a podrobnosti s osobními údaji klienta odstranit.' }
    ];
    return {
        spisId, spisZn: spis.spisZn || '', stav: spis.stav,
        items,
        totals: {
            smazat: items.filter(i => i.action === 'smazat').reduce((s, i) => s + i.count, 0),
            ponechat: items.filter(i => i.action === 'ponechat').reduce((s, i) => s + i.count, 0),
            pseudonymizovat: items.filter(i => i.action === 'pseudonymizovat').reduce((s, i) => s + i.count, 0)
        }
    };
}

module.exports = { inventory };
