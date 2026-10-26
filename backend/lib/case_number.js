/**
 * case_number.js — rozpoznání spisové značky soudu v textu (deterministicky, bez AI).
 *
 * Podporuje i rejstříky o více slovech: „19 P a Nc 57/2026“ (opatrovnické věci), dále
 * C, Co, Cm, Cmo, EC, ECm, T, To, Nc, INS, ICm, Cdo, Az, As… a diakritiku (Ř, Ď, Ť…).
 * Simulace dne v kanceláři 26. 10. 2026: písemnosti ve věcech „P a Nc“ zůstávaly bez
 * spisu (regex bral jen jedno slovo rejstříku) a „Sp. zn.“ s tečkou se nechytalo na
 * označení — spoléhalo se na první „něco/rok“ v textu.
 */
'use strict';

// číslo senátu, rejstřík (1–5 písmen, případně „X a Y“), číslo věci / ročník
const CORE = String.raw`\d{1,4}\s*[A-Za-zÁ-Žá-ž]{1,5}(?:\s+a\s+[A-Za-zÁ-Žá-ž]{1,4})?\s*\d{1,7}\s*\/\s*\d{2,4}`;
const LABELED = new RegExp(String.raw`(?:sp\.?\s*zn\.?|č\.?\s*j\.?|spisov[áé]\s+značk[ay])\s*[:\-]?\s*(` + CORE + ')', 'i');
const BROAD = new RegExp('(' + CORE + ')');

function normalize(s) {
    return String(s || '').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
}

/** Sp. zn. z textu: nejdřív označená („Sp. zn.:“, „č. j.“), jinak první výskyt ve tvaru sp. zn.; jinak ''. */
function findCaseNumber(text) {
    const t = String(text || '');
    const m = t.match(LABELED) || t.match(BROAD);
    return m ? normalize(m[1]) : '';
}

module.exports = { findCaseNumber, normalize, CASE_CORE: CORE };
