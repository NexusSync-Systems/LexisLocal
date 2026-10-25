/**
 * lib/doc_action.js — co se po kanceláři chce: jedna věta k doručené písemnosti,
 * kterou sestaví PROGRAM z nalezené procesní lhůty a nařízeného jednání (bez modelu).
 * Advokát ji vidí v doručené poště hned vedle shrnutí. Nic se neodesílá ani nezakládá.
 */
'use strict';

const KINDS = [
    [/dovolání/i, 'Zvážit dovolání'],
    [/odvolání/i, 'Zvážit odvolání'],
    [/odpor/i, 'Zvážit odpor'],
    [/námitk/i, 'Zvážit námitky'],
    [/rozklad/i, 'Zvážit rozklad'],
    [/stížnost/i, 'Zvážit stížnost'],
    [/vyjádř/i, 'Podat vyjádření'],
    [/doplni|odstran\w* vad|vad[yu] podání/i, 'Doplnit podání / odstranit vady'],
    [/zaplat|uhrad/i, 'Zaplatit / zajistit úhradu']
];
const _cz = iso => { const p = String(iso || '').split('-'); return p.length === 3 ? `${+p[2]}. ${+p[1]}. ${p[0]}` : iso; };

function actionFor({ metadata = {}, hearings = [] } = {}) {
    const parts = [];
    if (metadata.deadlineDays && metadata.deadlineDate) {
        const k = KINDS.find(([re]) => re.test(metadata.deadlineContext || ''));
        const what = k ? k[1] : 'Lhůta';
        const base = /doručení/.test(metadata.deadlineBase || '') ? 'od doručení' : 'od zpracování — datum doručení OVĚŘIT';
        parts.push(`${what} do ${_cz(metadata.deadlineDate)} (${metadata.deadlineDays} dnů ${base})`);
    }
    for (const h of (hearings || []).slice(0, 2)) {
        if (h && h.date) parts.push(`Jednání ${_cz(h.date)}${h.time ? ' v ' + h.time : ''}${h.room ? ', ' + h.room : ''} — potvrdit v kalendáři`);
    }
    return parts.length ? parts.join(' · ') : null;
}

module.exports = { actionFor };
