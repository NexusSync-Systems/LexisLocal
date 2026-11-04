/**
 * legal_basis.js — každé doporučení právních agentů musí mít právní oporu (požadavek 4. 11. 2026).
 *
 * 1. PRAVIDLO: k systémovému promptu právních agentů (rešeršník, kontrolor, spisovatel a vlastní agenti
 *    s judikaturou) se přidá povinnost u každého doporučení / závěru uvést, na základě čeho — konkrétní
 *    ustanovení (§ / čl. + předpis), případně rozhodnutí se sp. zn., a proč z něj závěr plyne.
 *    Přidává se za běhu (ne do uloženého promptu), takže platí i pro prompty, které si kancelář upravila.
 * 2. kontrolaOpory(text): program najde věty s doporučením nebo právním závěrem bez citace.
 *    Model je dostane jako výtku k jedné opravě (lib/output_checks.js) a co zůstane, ukáže se advokátovi
 *    pod odpovědí. Zda citovaný § opravdu existuje a sedí, ověřuje dál lib/citation_verifier.js.
 */
'use strict';

const PRAVNI_AGENTI = new Set(['resersnik', 'kontrolor', 'spisovatel']);

const PRAVIDLO =
    'ZDŮVODNĚNÍ (povinné): Každé doporučení, právní závěr nebo navržený krok musí mít oporu — uveď, NA ZÁKLADĚ ČEHO:\n' +
    '• konkrétní ustanovení: § nebo čl. s číslem a předpisem („§ [číslo] OZ“, „§ [číslo] o. s. ř.“, „§ [číslo] zákona č. [číslo]/[rok] Sb.“), ' +
    'případně rozhodnutí soudu se spisovou značkou z podkladů,\n' +
    '• a jednou větou PROČ z něj závěr plyne (které znaky ustanovení jsou ve věci splněny).\n' +
    'V rozboru a v doporučeních pro advokáta piš u každého bodu: „Doporučení: … — Opora: … — Proč: …“. ' +
    'V dokumentu pro soud nebo protistranu uveď právní důvod přímo v textu (bez těchto štítků).\n' +
    'Ustanovení ber jen z podkladů nebo tehdy, když si jsi jistý číslem i předpisem. Když oporu nemáš, NEVYMÝŠLEJ ji — ' +
    'napiš u bodu „Opora: nenalezena v podkladech — ověřit“.\n' +
    'Podklady ze spisu cituj vždy s názvem dokumentu i místem („nájemní smlouva, čl. 3 odst. 1“, „předávací protokol, bod 2“) — samotné „čl. 3“ je ve spisu s více dokumenty nejednoznačné.';

/** Platí pravidlo pro tohoto agenta? Vypnout jde u vlastního agenta polem zduvodneni:false. */
function jePravniAgent(agent) {
    if (!agent || agent.zduvodneni === false) return false;
    if (agent.zduvodneni === true) return true;
    if (PRAVNI_AGENTI.has(agent.id)) return true;
    return !agent.isSystem && agent.useJudikatura === true;   // vlastní agent, který čerpá z judikatury
}

/** Systémový prompt agenta včetně pravidla zdůvodnění (u právních agentů). */
function systemPrompt(agent) {
    const base = String((agent && agent.systemPrompt) || '');
    return jePravniAgent(agent) ? base + '\n\n' + PRAVIDLO : base;
}

// Doporučení nebo právní závěr (ne popis skutku, ne otázka).
const RE_DOPORUCENI = new RegExp([
    '(?<![A-Za-zÁ-ž])doporuč\\w*', '(?<![A-Za-zÁ-ž])navrhuj\\w*', '(?<![A-Za-zÁ-ž])navrhuji(?![A-Za-zÁ-ž])', '(?<![A-Za-zÁ-ž])je\\s+(třeba|nutné|nezbytné|vhodné|možné)(?![A-Za-zÁ-ž])', '(?<![A-Za-zÁ-ž])bylo\\s+by\\s+vhodné(?![A-Za-zÁ-ž])',
    '(?<![A-Za-zÁ-ž])měl[aiy]?\\s+by(?![A-Za-zÁ-ž])', '(?<![A-Za-zÁ-ž])musí(?![A-Za-zÁ-ž])', '(?<![A-Za-zÁ-ž])nelze(?![A-Za-zÁ-ž])', '(?<![A-Za-zÁ-ž])lze(?![A-Za-zÁ-ž])', '(?<![A-Za-zÁ-ž])má\\s+(právo|nárok)(?![A-Za-zÁ-ž])', '(?<![A-Za-zÁ-ž])je\\s+povin\\w*', '(?<![A-Za-zÁ-ž])vzniká\\s+(nárok|právo|povinnost)(?![A-Za-zÁ-ž])',
    '(?<![A-Za-zÁ-ž])je\\s+(neplatn|nicotn|zdánliv|promlčen|oprávněn|neoprávněn|vymahateln|nevymahateln)\\w*', '(?<![A-Za-zÁ-ž])odpovídá\\s+za(?![A-Za-zÁ-ž])', '(?<![A-Za-zÁ-ž])podejte(?![A-Za-zÁ-ž])', '(?<![A-Za-zÁ-ž])uplatněte(?![A-Za-zÁ-ž])'
].join('|'), 'i');
// Opora: §, článek, číslo předpisu, zkratka zákona s §, spisová značka rozhodnutí.
const RE_OPORA = /§\s*\d+|(?<![A-Za-zÁ-ž])čl\.\s*\d+|(?<![A-Za-zÁ-ž])článk\S*\s+\d+|\b\d{1,4}\/\d{4}\s*Sb\.|(?<![A-Za-zÁ-ž])zák(?:ona|on)?\.?\s*č\.\s*\d+\/\d{4}|\b\d+\s+(?:Cdo|Odo|Cmo|Co|C|Cm|Tdo|As|Afs|Ads|Azs|Aps|Ans|Ca|Cad|Ncu|Nd)\s+\d+\/\d{4}\b|\b(?:I|II|III|IV|Pl)\.\s*ÚS\s+\d+\/\d{2,4}\b|\bsp\.\s*zn\.\s*\S+/i;
const RE_BEZ_OPORY = /opora\s*:\s*(nenalezen|chybí|není|neuveden)/i;

function _jednotky(text) {
    const out = [];
    let sekce = '';
    for (const radek0 of String(text || '').split(/\r?\n/)) {
        const radek = radek0.replace(/\*\*|__|`/g, '').replace(/^\s*>\s?/, '');
        const r = radek.trim();
        if (!r) continue;
        if (/^#{1,6}\s/.test(r) || /^(\d+\.|[IVX]+\.)?\s*[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^.!?]{0,60}:$/.test(r)) { sekce = r.toLowerCase(); continue; }
        // Delší odstavec → věty; položka seznamu = jedna jednotka.
        const casti = /^\s*([-•*]|\d+[.)])\s+/.test(radek) || r.length < 220 ? [r] : r.split(/(?<=[.!?])\s+(?=[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ])/);
        for (const c of casti) out.push({ text: c.trim(), sekce });
    }
    return out;
}

/**
 * Najde doporučení / právní závěry bez opory.
 * → { doporuceni, bezOpory: [věta…], vyslovneBez: [věta…] }  (věty zkrácené na 160 znaků)
 */
function kontrolaOpory(text) {
    const j = _jednotky(text);
    let doporuceni = 0;
    const bezOpory = [], vyslovneBez = [];
    for (let i = 0; i < j.length; i++) {
        const u = j[i];
        if (u.text.length < 25 || /\[Doplnit/i.test(u.text) && u.text.length < 60) continue;
        if (/ověřit|co ještě|otázk|chybí v podkladech|upozornění|⚠|📅|⚖️/i.test(u.sekce) || /^[⚠📅⚖️🔎]/u.test(u.text)) continue;
        if (/\?\s*$/.test(u.text)) continue;
        if (/^\s*([-•*]|\d+[.)])?\s*(doporučení|návrh|varianta|shrnutí)(?![a-záčďéěíňóřšťúůýž])[^.:;]{0,45}$/i.test(u.text)) continue;   // nadpis („Doporučení pro klienta“)
        // Popis ustanovení, upozornění a přiznání, že podklady údaj neobsahují, nejsou doporučení (eval 4. 11. 2026).
        if (/^\s*([-•*]|\d+[.)])?\s*(co (?:ustanovení|smlouva|článek) (?:říká|stanoví)|znění|text ustanovení|upozornění|poznámka|pozn\.)\s*:/i.test(u.text)) continue;
        if (/nedostatek podklad|(?:uveden|obsažen)\w*\s+(?:není|nejsou)|(?:není|nejsou)\s+(?:\S+\s+){0,3}(?:uveden|obsažen)|(?:spis|podklady)\S*\s+(?:\S+\s+){0,3}neobsahuj/i.test(u.text)) continue;
        // Hodnocení variant („Pro: …“, „Proti: …“) není samo doporučení — opora patří k variantě / doporučené variantě.
        if (/^\s*([-•*]|\d+[.)])?\s*(pro|proti|výhody|nevýhody|rizika?|náklady|doba)\s*:/i.test(u.text)) continue;
        if (!RE_DOPORUCENI.test(u.text)) continue;
        doporuceni++;
        const kratce = u.text.replace(/^\s*([-•*]|\d+[.)])\s+/, '').slice(0, 160);
        // Opora může být i na následujícím řádku („— Opora: § …“, „Opora: …“).
        const dalsi = j[i + 1] && /^\s*[—–-]?\s*(opora|právní (základ|důvod|opora))\s*:/i.test(j[i + 1].text) ? j[i + 1].text : '';
        const spolu = u.text + ' ' + dalsi;
        if (RE_BEZ_OPORY.test(spolu)) { vyslovneBez.push(kratce); continue; }
        if (!RE_OPORA.test(spolu)) bezOpory.push(kratce);
    }
    return { doporuceni, bezOpory, vyslovneBez };
}

/** Výtka pro jednu opravu modelem. */
function vytka(bezOpory) {
    const seznam = bezOpory.slice(0, 5).map(t => '„' + t + '“').join('; ');
    return 'Tato doporučení / závěry nemají uvedenou právní oporu: ' + seznam + '. Ke každému doplň konkrétní ustanovení ' +
        '(§ nebo čl. a předpis, případně rozhodnutí se sp. zn. z podkladů) a jednou větou, proč z něj závěr plyne. ' +
        'Když oporu v podkladech nemáš, napiš u bodu „Opora: nenalezena v podkladech — ověřit“. Jinak odpověď neměň.';
}

/** Řádek(y) do upozornění pod odpovědí (prázdné, když je vše podložené). */
function upozorneni(k) {
    if (!k) return '';
    const radky = [];
    if (k.bezOpory.length) radky.push(`• Bez uvedené právní opory (${k.bezOpory.length} z ${k.doporuceni} doporučení) — před použitím ověřte: ` +
        k.bezOpory.slice(0, 4).map(t => '„' + t.slice(0, 90) + (t.length > 90 ? '…' : '') + '“').join('; ') + (k.bezOpory.length > 4 ? ' …' : '') + '.');
    if (k.vyslovneBez.length) radky.push(`• Agent u ${k.vyslovneBez.length} doporučení uvedl, že oporu v podkladech nenašel — ověřte ručně.`);
    return radky.join('\n');
}

module.exports = { PRAVIDLO, jePravniAgent, systemPrompt, kontrolaOpory, vytka, upozorneni, RE_OPORA };
