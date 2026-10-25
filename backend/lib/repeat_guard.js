'use strict';
/**
 * lib/repeat_guard.js — odstraní řádky, které model zopakoval.
 *
 * Server 25. 10. 2026 (J1): qwen2.5:7b napsal pod „Co ještě ověřit“ pětkrát stejný řádek
 * a pod „Doporučený postup“ čtyřikrát „Získat zprávy o výsledcích vyšetřování…“. Advokát
 * by takovou odpověď neposlal dál a zabírá místo. Ponechá se první výskyt řádku v rámci
 * oddílu (oddíl začíná nadpisem „3. Právní úprava:“, „## …“ apod.); stejný řádek v jiném
 * oddílu zůstává (např. stejný § ve „Právní úpravě“ i v „Lhůtách“). Krátké řádky (< 15 znaků
 * po normalizaci), prázdné řádky a bloky kódu se nemění.
 */
const HEADING = /^\s*(?:#{1,6}\s+\S|\d{1,2}\.\s+[^\n]{0,80}:\s*$|[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^\n]{0,60}:\s*$)/;
const norm = l => l.replace(/^\s*(?:[-*•–]|\d{1,2}[.)])\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.;,]+$/, '');

function collapseRepeats(text) {
    if (typeof text !== 'string' || !text) return { text, removed: 0 };
    const out = [];
    let seen = new Set(), inCode = false, removed = 0;
    for (const line of text.split('\n')) {
        if (/^\s*```/.test(line)) { inCode = !inCode; out.push(line); continue; }
        if (inCode) { out.push(line); continue; }
        if (HEADING.test(line)) { seen = new Set(); out.push(line); continue; }
        const k = norm(line);
        if (k.length >= 15) {
            if (seen.has(k)) { removed++; continue; }
            seen.add(k);
        }
        out.push(line);
    }
    return { text: removed ? out.join('\n') : text, removed };
}

module.exports = { collapseRepeats };
