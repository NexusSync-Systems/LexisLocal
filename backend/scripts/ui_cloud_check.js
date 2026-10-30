#!/usr/bin/env node
/**
 * ui_cloud_check.js — kontrola „chytřejšího režimu“ (K7b) v SKUTEČNÉM rozhraní (Chromium přes Playwright).
 *
 *   node backend/scripts/ui_cloud_check.js --base https://127.0.0.1 --out <složka>   (token: LEXIS_API_TOKEN)
 *
 * Postup jako uživatel: přihlášení dashboardu párovacím odkazem (/?pair=), záložka Asistenti, volba
 * „☁️ Obecný dotaz“ je vidět jen se zapnutým cloudem, dotaz s volbou → pod odpovědí „☁️ Claude …“,
 * dotaz bez volby → „💻 Lokální model“. Jen syntetické dotazy. Výsledek: ui_cloud.json + .md + snímky.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function args(argv) {
    const o = { base: 'https://127.0.0.1', out: path.join(process.cwd(), 'ui-cloud'), token: process.env.LEXIS_API_TOKEN || '', timeoutS: 300 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], n = () => argv[++i];
        if (a === '--base') o.base = String(n()).replace(/\/+$/, '');
        else if (a === '--out') o.out = n();
        else if (a === '--timeout') o.timeoutS = parseInt(n(), 10) || 300;
    }
    return o;
}

async function main() {
    const O = args(process.argv.slice(2));
    fs.mkdirSync(O.out, { recursive: true });
    const checks = [];
    const check = (id, name, ok, detail) => { checks.push({ id, name, ok: !!ok, detail: String(detail || '') }); console.log(`  ${ok ? '✓' : '✗'} [${id}] ${name}${detail ? ' — ' + detail : ''}`); };
    const save = () => {
        fs.writeFileSync(path.join(O.out, 'ui_cloud.json'), JSON.stringify({ date: new Date().toISOString(), base: O.base, checks }, null, 2));
        fs.writeFileSync(path.join(O.out, 'ui_cloud.md'), ['# Rozhraní — chytřejší režim (K7b)', '',
            `**Kontroly: ${checks.filter(c => c.ok).length}/${checks.length}**`, '', '| | Kontrola | Detail |', '|---|---|---|',
            ...checks.map(c => `| ${c.ok ? '✓' : '✗'} | ${c.id} ${c.name} | ${c.detail.replace(/\|/g, '/')} |`)].join('\n') + '\n');
    };
    let chromium;
    try { ({ chromium } = require('playwright')); } catch (e) { check('U0', 'Playwright k dispozici', false, e.message); save(); return; }

    const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
    // Testovací server má certifikát podepsaný sám sebou — výjimka platí jen pro tento prohlížeč testu.
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 }, locale: 'cs-CZ' });
    // Párovací kód přes požadavek téhož kontextu (dřív Node fetch → odmítl certifikát → „kód nevznikl“, běh 29. 10.).
    let code = null;
    try {
        const r = await ctx.request.post(O.base + '/api/pair/new', { headers: { 'X-API-Token': O.token }, data: { deviceLabel: 'Kontrola rozhraní (simulace)' } });
        const j = await r.json(); code = j.code || null;
    } catch (e) { /* níže kontrola U1 */ }
    const page = await ctx.newPage();
    try {
        await page.goto(O.base + '/?pair=' + encodeURIComponent(code || 'x'), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => { try { return !!localStorage.getItem('lexis_api_token'); } catch (e) { return false; } }, null, { timeout: 30000 }).catch(() => {});
        const tok = await page.evaluate(() => { try { return !!localStorage.getItem('lexis_api_token'); } catch (e) { return false; } });
        check('U1', 'Přihlášení dashboardu párovacím odkazem', !!code && tok, code ? (tok ? 'token uložen v prohlížeči' : 'token se neuložil') : 'kód nevznikl');
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

        await page.click('button[data-tab="chat"]');
        const item = page.locator('#chat-cloud-item');
        const vidi = await item.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
        check('U2', 'Volba „☁️ Obecný dotaz“ je vidět (cloud zapnutý)', vidi, vidi ? (await item.innerText()).replace(/\s+/g, ' ').trim() : 'nezobrazila se');
        await page.screenshot({ path: path.join(O.out, 'ui-1-asistent.png') });

        const ask = async (text, cloud) => {
            const before = await page.locator('#chat-output .chat-message.agent .subtext').count();
            if (vidi) { const cb = page.locator('#chat-cloud-verejne'); if ((await cb.isChecked()) !== cloud) await cb.click(); }
            await page.fill('#chat-textarea', text);
            await page.click('#btn-chat-send');
            const t0 = Date.now();
            await page.waitForFunction(n => document.querySelectorAll('#chat-output .chat-message.agent .subtext').length > n, before, { timeout: O.timeoutS * 1000 });
            const badge = (await page.locator('#chat-output .chat-message.agent .subtext').last().innerText()).trim();
            return { badge, s: ((Date.now() - t0) / 1000).toFixed(1) };
        };
        const a1 = await ask('Podle čeho soud posuzuje přiměřenost smluvní pokuty a může ji snížit? Uveď paragraf.', true).catch(e => ({ badge: 'chyba: ' + e.message, s: '—' }));
        check('U3', 'Obecný dotaz s volbou → odpověď cloudového modelu, pod ní „☁️ Claude …“', /☁️\s*Claude/.test(a1.badge), `${a1.badge} (${a1.s} s)`);
        await page.screenshot({ path: path.join(O.out, 'ui-2-cloud.png') });
        const a2 = await ask('Jaká je obecná promlčecí lhůta podle občanského zákoníku?', false).catch(e => ({ badge: 'chyba: ' + e.message, s: '—' }));
        check('U4', 'Dotaz bez volby → lokální model, pod ní „💻 Lokální model“', /💻\s*Lokální model/.test(a2.badge), `${a2.badge} (${a2.s} s)`);
        await page.screenshot({ path: path.join(O.out, 'ui-3-lokalne.png') });
    } catch (e) {
        check('U9', 'Průchod rozhraním bez chyby', false, e.message.slice(0, 300));
        await page.screenshot({ path: path.join(O.out, 'ui-chyba.png') }).catch(() => {});
    } finally {
        await browser.close();
        save();
    }
}

if (require.main === module) main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
module.exports = { args };
