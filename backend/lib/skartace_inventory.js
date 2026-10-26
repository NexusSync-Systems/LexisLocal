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

/**
 * Plán skartace — KONKRÉTNÍ položky, které by kaskádové mazání odstranilo / ponechalo /
 * pseudonymizovalo (ID záznamů, cesty dokumentů, počet úseků v RAG indexu). JEN ČTE.
 * Slouží advokátovi ke schválení pravidel (docs/kancelar/6_Pravidla_skartace.docx) a jako
 * podklad skartačního protokolu; samotné mazání se doplní až po schválení pravidel.
 */
function plan(spisId) {
    const inv = inventory(spisId);
    if (!inv) return null;
    const spis = require('./spisy').getSpis(spisId);
    const key = spis.spisZn ? _caseKey(spis.spisZn) : null;
    const by = (col) => (db.get(col) || []).filter(x => x && x.spisId === spisId);
    const files = key ? (db.get('inbox_files') || []).filter(f => f.caseNumber && _caseKey(f.caseNumber) === key) : [];
    let rag = null;
    try { rag = require('./rag'); } catch (e) { rag = null; }
    const ragChunks = (relPath) => {
        if (!rag || !relPath) return null;
        try {
            const dir = relPath.includes('/') ? relPath.split('/')[0] : 'root';
            return (rag.loadPartition(dir).chunks || []).filter(c => c.fileName === relPath).length;
        } catch (e) { return null; }
    };
    let drafts = [];
    try { drafts = require('./drafts').listDrafts({ spisId }); } catch (e) { drafts = []; }
    const ids = arr => arr.map(x => x.id).filter(Boolean);
    const dokumenty = files.map(f => ({
        id: f.id || null, soubor: f.relativePath || f.fileName || null, nazev: f.fileName || null,
        ragUseku: ragChunks(f.relativePath || f.fileName), doruceno: f.deliveredAt || f.date || null
    }));
    return {
        spisId, spisZn: inv.spisZn, stav: inv.stav, vytvoreno: new Date().toISOString(),
        smazat: {
            spis: [spisId],
            spis_events: ids(by('spis_events')),
            client_updates: ids(by('client_updates')),
            drafts: ids(drafts),
            meetings: ids(by('meetings')),
            dokumenty
        },
        ponechat: { invoices: ids(by('invoices')), aml_checks: ids(by('aml_checks')) },
        pseudonymizovat: { audit: inv.items.find(i => i.kind === 'audit').count },
        souhrn: Object.assign({}, inv.totals, {
            ragUseku: dokumenty.reduce((n, d) => n + (d.ragUseku || 0), 0),
            souboruNaDisku: dokumenty.filter(d => d.soubor).length
        })
    };
}

module.exports = { inventory, plan };
