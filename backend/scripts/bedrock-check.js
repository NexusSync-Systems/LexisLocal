#!/usr/bin/env node
/**
 * bedrock-check.js — ověření nastavení Claude přes Amazon Bedrock (EU) před zapnutím v kanceláři.
 *
 *   node backend/scripts/bedrock-check.js            kontrola nastavení (bez volání AWS)
 *   node backend/scripts/bedrock-check.js --volat    + jeden zkušební dotaz se SYNTETICKÝM textem (stojí zlomek centu)
 *
 * Kontroluje: region jen eu-*, model jen EU profil / model v EU (ne us./global.), model bez povinného
 * ukládání (Claude Fable 5/5.1 jen s BEDROCK_POVOLIT_UKLADANI=1), přístupové údaje (jen zda jsou, nevypisuje je),
 * lokální režim mlčenlivosti, embeddingy lokálně. Klíče ani tokeny nikdy nevypisuje.
 * Načte .env z kořene projektu (jako server).
 */
'use strict';
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch (e) { /* bez dotenv */ }
const B = require('../lib/bedrock');

const ok = [], warn = [], bad = [];
function zkus(nazev, fn) {
    try { const r = fn(); ok.push(`${nazev}: ${r}`); return r; } catch (e) { bad.push(`${nazev}: ${e.message}`); return null; }
}

async function main() {
    const volat = process.argv.includes('--volat');
    const region = zkus('Region', () => B.region());
    const model = zkus('Model', () => B.modelId());
    if (B.instanceMode()) {
        try { const c = await B.credentialsAsync(); ok.push(`Přístup k AWS: role instance „${c.role}“ (dočasné klíče)`); } catch (e) { bad.push('Přístup k AWS: ' + e.message); }
    } else zkus('Přístup k AWS', () => { const c = B.credentials(); return `nalezen (klíč …${String(c.accessKeyId).slice(-4)}${c.sessionToken ? ', dočasný' : ''})`; });
    if (process.env.AI_CHAT_PROVIDER !== 'bedrock') warn.push(`AI_CHAT_PROVIDER=${process.env.AI_CHAT_PROVIDER || '(nenastaveno)'} — aplikace Bedrock nepoužije, dokud nebude „bedrock“`);
    if (process.env.LEXIS_PILOT_LOCAL_ONLY === '1') warn.push('LEXIS_PILOT_LOCAL_ONLY=1 — lokální režim mlčenlivosti Bedrock zakáže (to je v pořádku, dokud ho kancelář nechce)');
    const emb = String(process.env.AI_EMBED_PROVIDER || process.env.AI_PROVIDER || 'ollama').toLowerCase();
    if (emb !== 'ollama') bad.push(`AI_EMBED_PROVIDER=${emb} — vyhledávání a znalostní báze musí zůstat lokální (ollama)`);
    else ok.push('Vyhledávání (embeddingy): lokálně (ollama)');
    if (model && /^eu\./.test(model)) warn.push('EU inference profil může zpracovat dotaz v kterémkoli regionu EU — ověřte cílové regiony: aws bedrock get-inference-profile --region ' + (region || 'eu-central-1') + ' --inference-profile-identifier ' + model + " --query 'models[].modelArn'");
    warn.push('V účtu AWS nastavte uchovávání dat Bedrocku (data retention) na „none“ pro regiony EU a nechte vypnuté Model invocation logging (docs/BEDROCK_EU.md).');

    if (volat && !bad.length) {
        const t0 = Date.now();
        try {
            const r = await B.chat([{ role: 'system', content: 'Odpovídej jedním slovem.' }, { role: 'user', content: 'Testovací dotaz bez osobních údajů: napiš slovo „funguje“.' }], { temperature: 0 });
            ok.push(`Zkušební dotaz: „${String(r.message.content).trim().slice(0, 40)}“ za ${Date.now() - t0} ms (model ${r.model}) — region zpracování uvidíte v CloudTrail (pole inferenceRegion)`);
        } catch (e) { bad.push('Zkušební dotaz: ' + e.message.slice(0, 300)); }
    } else if (volat) warn.push('Zkušební dotaz se nespustil — nejdřív opravte chyby výše.');

    for (const l of ok) console.log('✅ ' + l);
    for (const l of warn) console.log('⚠️  ' + l);
    for (const l of bad) console.log('❌ ' + l);
    process.exit(bad.length ? 1 : 0);
}
main();
