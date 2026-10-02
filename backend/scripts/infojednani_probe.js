#!/usr/bin/env node
/**
 * infojednani_probe.js — ověření rozhraní InfoJednání (po obnovení justičních webů).
 *
 *   node backend/scripts/infojednani_probe.js --spis "12 C 45/2026" --court <KÓD_SOUDU>
 *        [--url <adresa>] [--method GET|POST] [--body '<šablona JSON>'] [--raw]
 *
 * Vypíše: HTTP stav, typ obsahu, ukázku odpovědi, co z ní LexisLocal přečte (events)
 * a doporučené proměnné prostředí. Posílá jen sp. zn. a kód soudu (veřejné údaje).
 * Postup viz backend/docs/INFOJEDNANI.md.
 */
'use strict';
const src = require('../lib/court_hearings_source');

function arg(name) {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : null;
}

(async () => {
    const spis = arg('spis'), court = arg('court');
    if (!spis || !court) {
        console.error('Použití: --spis "12 C 45/2026" --court <KÓD_SOUDU> [--url …] [--method GET|POST] [--body …] [--raw]');
        process.exit(2);
    }
    if (arg('url')) process.env.LEXIS_INFOJEDNANI_URL = arg('url');
    if (arg('method')) process.env.LEXIS_INFOJEDNANI_METHOD = arg('method');
    if (arg('body')) process.env.LEXIS_INFOJEDNANI_BODY_TEMPLATE = arg('body');
    const cfg = src.config();
    console.log(`→ ${cfg.method} ${cfg.url}\n  sp. zn. ${spis}, soud ${court}${cfg.bodyTemplate ? '\n  šablona těla: ' + cfg.bodyTemplate : ''}`);

    // Zachytíme surovou odpověď pro diagnostiku.
    let rawInfo = null;
    const tapFetch = async (url, init) => {
        const res = await fetch(url, init);
        const text = await res.text();
        rawInfo = { status: res.status, type: res.headers.get('content-type'), sample: text.slice(0, process.argv.includes('--raw') ? 4000 : 600) };
        return { ok: res.ok, status: res.status, text: async () => text };
    };
    const r = await src.fetchHearings({ courtCode: court, spisZn: spis }, { fetch: tapFetch });
    if (rawInfo) {
        console.log(`← HTTP ${rawInfo.status}, ${rawInfo.type || 'bez content-type'}\n--- ukázka odpovědi ---\n${rawInfo.sample}\n-----------------------`);
    }
    if (r.ok) {
        console.log(`✅ LexisLocal odpovědi rozumí: ${r.events.length} jednání${r.court ? ' (' + r.court + ')' : ''}`);
        r.events.forEach(e => console.log(`   ${e.date} ${e.time || '--:--'}  síň ${e.room || '—'}${e.cancelled ? '  ZRUŠENO' : ''}`));
        console.log('\nDoporučené nastavení (.env):');
        console.log(`LEXIS_INFOJEDNANI_URL=${cfg.url}`);
        if (cfg.method !== 'POST') console.log(`LEXIS_INFOJEDNANI_METHOD=${cfg.method}`);
        if (cfg.bodyTemplate) console.log(`LEXIS_INFOJEDNANI_BODY_TEMPLATE=${cfg.bodyTemplate}`);
        console.log('LEXIS_INFOJEDNANI_VERIFIED=1');
        if (r.events.length === 0) console.log('\n⚠️ 0 jednání — ověřte na webu, že věc má nařízené jednání v příštích 30 dnech, jinak test nic nedokazuje.');
        process.exit(0);
    }
    console.log(`❌ ${r.kind}: ${r.reason}`);
    if (r.kind === 'invalid_response') console.log('→ Rozhraní se změnilo nebo URL vede na webovou stránku. Zachyťte skutečný dotaz v prohlížeči (viz docs/INFOJEDNANI.md).');
    process.exit(1);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
