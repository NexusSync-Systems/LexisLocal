#!/usr/bin/env node
/**
 * aws-pilot-test.js — test LexisLocal proti SKUTEČNÉMU AWS (Bedrock v EU + Cost Explorer) před pilotem.
 *
 *   node backend/scripts/aws-pilot-test.js              celý test (~5 malých dotazů, řádově 0,01–0,03 USD)
 *   node backend/scripts/aws-pilot-test.js --latence 5  navíc 5 měření doby odpovědi typického dotazu
 *   node backend/scripts/aws-pilot-test.js --bez-ce     bez Cost Exploreru (např. ještě není zapnutý)
 *
 * Jen SYNTETICKÁ data. Běží nad dočasnou databází (nesahá na spisy ani nastavení kanceláře);
 * z .env bere jen přístup k AWS a BEDROCK_*. Klíče nevypisuje. Výsledek: konzole + protokol
 * v scratch/aws-test-<datum>.md (přiložit k DPIA / pilotu).
 *
 * Ověřuje:
 *   A  nastavení: region eu-*, EU profil, přístup k AWS, embeddingy lokálně
 *   B  cílové regiony EU profilu jsou všechny v EU (GetInferenceProfile)
 *   C  povolený dotaz (veřejný, syntetický) projde přes ai_provider → Bedrock, zapíše tokeny a odhad ceny
 *   D  pravidla spisu: spis stupně A / bez souhlasu → nic neodejde (počítá se síťová volání), odpoví lokální model
 *   E  zámek v kódu: profil us./global. se odmítne PŘED odesláním
 *   F  zámek v AWS (IAM): přímé podepsané volání mimo EU a globální profil → AccessDenied
 *   G  tvrdý strop rozpočtu → po vyčerpání nic neodejde
 *   H  Cost Explorer: přístup, náklady Bedrocku/Claude v měsíci, NÁZVY SLUŽEB (pro filtr AWS Budgets)
 *   I  (volitelně) latence: medián a nejhorší doba odpovědi
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = path.join(__dirname, '..', '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch (e) { /* bez dotenv */ }

// Dočasná data — žádný zásah do spisů, auditu ani nastavení kanceláře.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-awstest-'));
process.env.WATCH_DIR = path.join(TMP, 'data'); process.env.LEXIS_DATA_DIR = path.join(TMP, 'settings'); process.env.LEXIS_KEY_DIR = path.join(TMP, 'key');
fs.mkdirSync(process.env.WATCH_DIR, { recursive: true });
process.env.AI_CHAT_PROVIDER = 'bedrock';
delete process.env.LEXIS_PILOT_LOCAL_ONLY; delete process.env.AI_LOCAL_ONLY;
delete process.env.LEXIS_JEN_CLOUD; // test pravidel spisu (D) počítá s lokálním záskokem — režim jen cloud ho záměrně nemá
process.env.LEXIS_CLOUD_ODEPRENI = 'lokalne';

// Lokální model se v testu nevolá doopravdy — stačí vědět, že dotaz skončil lokálně.
const ocPath = require.resolve('../lib/ollama_client');
let lokalnich = 0;
require.cache[ocPath] = { id: ocPath, filename: ocPath, loaded: true, exports: { chat: async () => { lokalnich++; return { message: { content: '(lokální model — test)' } }; }, embeddings: async () => ({ embedding: [0] }) } };

// Počítadlo odchozích volání (ověření, že při odepření nic neodejde).
const realFetch = global.fetch;
const sit = [];
global.fetch = (url, init) => { sit.push(String(url)); return realFetch(url, init); };

const B = require('../lib/bedrock');
const P = require('../lib/cloud_policy');
const ai = require('../lib/ai_provider');
const U = require('../lib/ai_usage');
const AB = require('../lib/aws_billing');
const spisy = require('../lib/spisy');

const args = process.argv.slice(2);
const latN = args.includes('--latence') ? Math.max(1, Math.min(20, parseInt(args[args.indexOf('--latence') + 1], 10) || 3)) : 0;
const vysledky = [];
const ADV = { userId: 'test', name: 'Test advokát', kind: 'user', scopes: ['read', 'write', 'approve'] };
const SYNT = 'Testovací dotaz bez osobních údajů. Odpověz jednou větou: jaká je obecná promlčecí lhůta podle občanského zákoníku?';

function zapis(kod, nazev, stav, detail) { vysledky.push({ kod, nazev, stav, detail: detail || '' }); console.log(`${stav === 'ok' ? '✅' : stav === 'varovani' ? '⚠️ ' : stav === 'preskoceno' ? '⏭️ ' : '❌'} ${kod} ${nazev}${detail ? ' — ' + detail : ''}`); }
async function krok(kod, nazev, fn) { try { const r = await fn(); if (r !== false) zapis(kod, nazev, (r && r.stav) || 'ok', r && r.detail); } catch (e) { zapis(kod, nazev, 'chyba', String(e.message || e).slice(0, 300)); } }
const ask = (opts, notes) => P.scope(opts, async () => { if (notes) notes(); const r = await ai.chat({ model: 'local-test', messages: [{ role: 'user', content: SYNT }], options: { temperature: 0 } }); return { r, sh: P.shrnuti() }; });

// Odepření v IAM: AWS vrací 403 s „AccessDenied“ nebo (Bedrock, 10/2026) „… is not authorized to perform: bedrock:…“.
function odepreno(r) { return r.status === 403 && /AccessDenied|not authorized to perform/i.test(r.text); }

async function signed(method, host, segs, reg, service, body, extra) {
    const s = B.sign({ method, host, pathSegments: segs, headers: Object.assign({ 'content-type': 'application/json' }, extra || {}), body: body || '', service, region: reg, creds: await B.credentialsAsync() });
    const res = await realFetch(`https://${host}${s.path}`, { method, headers: s.headers, body: method === 'GET' ? undefined : body });
    return { status: res.status, text: await res.text() };
}

async function main() {
    console.log('LexisLocal — test proti AWS (jen syntetická data)\n');
    let region, model;
    await krok('A1', 'Region jen EU', () => { region = B.region(); return { detail: region }; });
    await krok('A2', 'Model: EU profil', () => { model = B.modelId(); return { detail: model }; });
    await krok('A3', 'Přístup k AWS', async () => { const c = await B.credentialsAsync(); return { detail: c.role ? `role instance „${c.role}“` : `klíč …${String(c.accessKeyId).slice(-4)}${c.sessionToken ? ' (dočasný)' : ''}` }; });
    await krok('A4', 'Embeddingy lokálně', () => { const e = String(process.env.AI_EMBED_PROVIDER || 'ollama').toLowerCase(); if (e !== 'ollama') throw new Error('AI_EMBED_PROVIDER=' + e); return { detail: 'ollama' }; });
    if (!region || !model) { zapis('—', 'Další kroky přeskočeny', 'chyba', 'opravte nastavení A'); return; }

    await krok('B', 'Cílové regiony EU profilu', async () => {
        if (!/^eu\./.test(model)) return { stav: 'preskoceno', detail: 'model není profil (volá se přímo v regionu)' };
        const r = await signed('GET', `bedrock.${region}.amazonaws.com`, ['inference-profiles', model], region, 'bedrock', '');
        if (r.status === 403) return { stav: 'varovani', detail: 'bez oprávnění bedrock:GetInferenceProfile (aktualizujte šablonu) — ověřte ručně: aws bedrock get-inference-profile' };
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
        const arns = (JSON.parse(r.text).models || []).map(m => m.modelArn);
        const mimo = arns.filter(a => !/^arn:aws:bedrock:eu-/.test(a));
        if (mimo.length) throw new Error('profil obsahuje regiony mimo EU: ' + mimo.join(', '));
        return { detail: arns.map(a => a.split(':')[3]).join(', ') };
    });

    const sA = spisy.createSpis({ spisZn: '1 T 1/2026', nazev: 'TEST stupeň A' });
    P.setStupen(sA.id, 'A', { principal: ADV });
    const sB = spisy.createSpis({ spisZn: '2 C 2/2026', nazev: 'TEST stupeň B bez souhlasu' });

    await krok('C', 'Povolený dotaz → Bedrock (veřejný, syntetický)', async () => {
        const n0 = sit.length, t0 = Date.now();
        const { r, sh } = await ask({ dataClass: 'verejne' });
        const doBedrocku = sit.slice(n0).filter(u => u.includes('bedrock-runtime')).length;
        if (doBedrocku !== 1 || !sh || !sh.cloud) throw new Error('dotaz neodešel do Bedrocku: ' + JSON.stringify(sh));
        const n = sh.naklady || {};
        return { detail: `${Date.now() - t0} ms, tokeny ${n.inputTokens}→${n.outputTokens}, odhad ${n.odhadUsd} USD; odpověď „${String(r.message.content).trim().slice(0, 60)}…“` };
    });

    await krok('D1', 'Spis stupně A → nic neodejde', async () => {
        const n0 = sit.length, l0 = lokalnich;
        const { sh } = await ask({}, () => P.noteSpis(sA.id));
        if (sit.length !== n0) throw new Error('odešlo síťové volání!');
        if (lokalnich !== l0 + 1) throw new Error('neodpověděl lokální model');
        return { detail: sh.duvody[0] };
    });
    await krok('D2', 'Spis stupně B bez souhlasu → nic neodejde', async () => {
        const n0 = sit.length;
        const { sh } = await ask({}, () => P.noteSpis(sB.id));
        if (sit.length !== n0) throw new Error('odešlo síťové volání!');
        return { detail: sh.duvody[0] };
    });
    await krok('D3', 'Spis B se souhlasem → Bedrock', async () => {
        P.udelSouhlas(sB.id, { typ: 'spis', principal: ADV, poznamka: 'test' });
        const n0 = sit.length;
        await ask({}, () => P.noteSpis(sB.id));
        if (!sit.slice(n0).some(u => u.includes('bedrock-runtime'))) throw new Error('dotaz neodešel');
        return { detail: 'odesláno, zapsáno do deníku spisu' };
    });

    await krok('E', 'Zámek v kódu: us./global. profil odmítnut před odesláním', async () => {
        const orig = process.env.BEDROCK_MODEL_ID, out = [];
        for (const pref of ['us.', 'global.']) {
            process.env.BEDROCK_MODEL_ID = model.replace(/^eu\./, pref);
            const n0 = sit.length;
            let chyba = null;
            try { await ask({ dataClass: 'verejne' }); } catch (e) { chyba = e.message; }
            process.env.BEDROCK_MODEL_ID = orig;
            if (sit.length !== n0) throw new Error(pref + ' profil odeslán!');
            if (!chyba) throw new Error(pref + ' profil nebyl odmítnut');
            out.push(pref + ' odmítnut');
        }
        return { detail: out.join(', ') };
    });

    await krok('F1', 'IAM: Bedrock mimo EU (us-east-1) → AccessDenied', async () => {
        const body = JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'test' }] }], inferenceConfig: { maxTokens: 5 } });
        const r = await signed('POST', 'bedrock-runtime.us-east-1.amazonaws.com', ['model', model.replace(/^eu\./, 'us.'), 'converse'], 'us-east-1', 'bedrock', body);
        if (r.status === 200) throw new Error('VOLÁNÍ MIMO EU PROŠLO — IAM/SCP zámek nefunguje!');
        if (!odepreno(r)) return { stav: 'varovani', detail: `HTTP ${r.status}, ne odepření IAM: ${r.text.slice(0, 150)}` };
        return { detail: 'odepřeno v AWS' };
    });
    await krok('F2', 'IAM: globální profil v EU regionu → AccessDenied', async () => {
        const body = JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'test' }] }], inferenceConfig: { maxTokens: 5 } });
        const r = await signed('POST', `bedrock-runtime.${region}.amazonaws.com`, ['model', model.replace(/^eu\./, 'global.'), 'converse'], region, 'bedrock', body);
        if (r.status === 200) throw new Error('GLOBÁLNÍ PROFIL PROŠEL — IAM zámek nefunguje!');
        if (!odepreno(r)) return { stav: 'varovani', detail: `HTTP ${r.status}, ne odepření IAM: ${r.text.slice(0, 150)}` };
        return { detail: 'odepřeno v AWS' };
    });

    await krok('G', 'Tvrdý strop rozpočtu → nic neodejde', async () => {
        // Simulace vyčerpaného rozpočtu: rozpočet 1 USD a v dočasné databázi záznam za 2 USD.
        const db = require('../lib/database');
        const fake = db.insert('ai_usage', { den: U.dnes(), provider: 'test', model: 'test', inputTokens: 0, outputTokens: 0, odhadUsd: 2, spisIds: [] });
        U.ulozNastaveni({ mesicniRozpocetUsd: 1, tvrdyStrop: true });
        const n0 = sit.length;
        const { sh } = await ask({ dataClass: 'verejne' });
        U.ulozNastaveni({ mesicniRozpocetUsd: 0, tvrdyStrop: false });
        db.set('ai_usage', (db.get('ai_usage') || []).filter(r => r.id !== fake.id));
        if (sit.length !== n0) throw new Error('odešlo síťové volání!');
        if (sh.code !== 'rozpocet') throw new Error('neočekávaný důvod: ' + sh.code);
        return { detail: 'po vyčerpání jen lokálně' };
    });

    if (args.includes('--bez-ce')) zapis('H', 'Cost Explorer', 'preskoceno', '--bez-ce');
    else await krok('H', 'Cost Explorer: přístup a názvy služeb', async () => {
        const od = new Date().toISOString().slice(0, 8) + '01';
        const doEx = new Date(Date.now() + 864e5).toISOString().slice(0, 10); // včetně dneška (částečně)
        const a = await AB.nakladyAws(od, doEx);
        const claude = a.sluzby.map(s => `${s.nazev} (${s.usd} USD)`).join('; ') || 'zatím žádné náklady Bedrocku v tomto měsíci';
        const kandidati = a.vsechnySluzby.filter(n => /bedrock|claude|anthropic/i.test(n));
        const budgetOk = kandidati.length === 0 || kandidati.every(n => n === 'Amazon Bedrock');
        return { stav: budgetOk ? 'ok' : 'varovani', detail: `${od} – ${doEx}: ${claude}` + (budgetOk ? '' : ` — POZOR: Claude se účtuje i pod názvy ${kandidati.filter(n => n !== 'Amazon Bedrock').join(', ')}; filtr AWS Budgets („Amazon Bedrock“) je nezachytí, upravte šablonu`) };
    });

    if (latN) await krok('I', `Latence (${latN}× typický dotaz)`, async () => {
        const ms = [];
        for (let i = 0; i < latN; i++) { const t0 = Date.now(); await ask({ dataClass: 'verejne' }); ms.push(Date.now() - t0); }
        ms.sort((a, b) => a - b);
        return { detail: `medián ${ms[Math.floor(ms.length / 2)]} ms, nejhorší ${ms[ms.length - 1]} ms (${ms.join(', ')})` };
    });

    const s = U.souhrn();
    zapis('Σ', 'Spotřeba testu', 'ok', `${s.tokeny.vstup}→${s.tokeny.vystup} tokenů, odhad ${s.celkem} USD`);
}

main().catch(e => zapis('!', 'Neočekávaná chyba', 'chyba', e.message)).finally(() => {
    const chyb = vysledky.filter(v => v.stav === 'chyba').length, var_ = vysledky.filter(v => v.stav === 'varovani').length;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const md = `# Test LexisLocal proti AWS — ${new Date().toLocaleString('cs-CZ')}\n\nRegion: ${process.env.BEDROCK_REGION || ''} · Model: ${process.env.BEDROCK_MODEL_ID || ''} · jen syntetická data, dočasná databáze\n\n| Kód | Krok | Výsledek | Detail |\n|---|---|---|---|\n` +
        vysledky.map(v => `| ${v.kod} | ${v.nazev} | ${({ ok: 'OK', varovani: 'varování', chyba: 'CHYBA', preskoceno: 'přeskočeno' })[v.stav]} | ${String(v.detail).replace(/\|/g, '/')} |`).join('\n') +
        `\n\n**Souhrn:** chyby: ${chyb}, varování: ${var_}.\n\nRuční kontroly: uchovávání dat Bedrocku = „none“ v EU regionech; Model invocation logging vypnuté; v CloudTrail u volání Converse inferenceRegion = eu-*.\n`;
    try { const dir = path.join(ROOT, 'scratch'); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, `aws-test-${stamp}.md`); fs.writeFileSync(f, md); console.log(`\nProtokol: ${path.relative(ROOT, f)}`); } catch (e) { /* jen konzole */ }
    console.log(chyb ? `\n❌ chyby: ${chyb}, varování: ${var_}` : `\n✅ bez chyb, varování: ${var_}`);
    process.exit(chyb ? 1 : 0);
});
