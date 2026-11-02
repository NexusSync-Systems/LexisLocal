/**
 * email_text.js — z těla e-mailového zadání nechá jen samotné zadání (revize 2. 11. 2026).
 *
 * Odřízne citovanou předchozí korespondenci („> …“, „Dne … napsal(a):“, „-----Original Message-----“)
 * a podpis (řádek „-- “ nebo pozdrav na konci). Podpis advokáta (jméno s titulem, telefon, e-mail)
 * by jinak každé zadání označil za „s osobními údaji“ a model ho k práci nepotřebuje.
 * Bez závislostí — používá ho i e-mailový agent v AWS (scripts/aws/email-agent).
 */
'use strict';

const CITACE = [
    /^\s*>/,                                                        // citovaný řádek
    /^\s*-{2,}\s*(p[uů]vodn[ií] zpr[aá]va|original message|forwarded message|p[řr]eposlan[aá] zpr[aá]va)/i,
    /^\s*(dne|on)\s.{3,200}(napsal|napsala|napsal\(a\)|wrote)\s*:?\s*$/i,
    /^\s*(od|from)\s*:\s*.*(@|<)/i                                   // hlavička přeposlané/citované zprávy (s adresou)
];
const PODPIS = [
    /^--\s*$/,                                                      // standardní oddělovač podpisu
    /^\s*(s pozdravem|s úctou|s přátelským pozdravem|se srdečným pozdravem|děkuji|díky|zdravím|hezký den|best regards|regards|kind regards)(?=[\s,.!]|$).{0,40}$/i,
    /^\s*(odesláno|sent) (z|from) /i
];

/** Vrátí text zadání bez citací a podpisu (nikdy prázdný, když vstup nebyl prázdný). */
function zadaniBezPodpisu(text) {
    const puvodni = String(text || '').replace(/\r\n?/g, '\n');
    const radky = puvodni.split('\n');
    const out = [];
    for (let i = 0; i < radky.length; i++) {
        const r = radky[i];
        if (CITACE.some(re => re.test(r))) break;
        // Pozdrav / oddělovač = začátek podpisu, jen když už před ním je nějaké zadání.
        if (PODPIS.some(re => re.test(r)) && out.join('').trim()) break;
        out.push(r);
    }
    const t = out.join('\n').trim();
    return t || puvodni.trim();
}

module.exports = { zadaniBezPodpisu };
