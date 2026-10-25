#!/usr/bin/env node
/**
 * isds-test.js — samostatný test integrace datové schránky (ISDS FindDataBox).
 *
 * Ověří vyhledání ID datové schránky podle IČO PŘÍMO přes lib/registries.js,
 * bez nutnosti spouštět celý server. Přihlašovací údaje se čtou VÝHRADNĚ
 * z proměnných prostředí (nikdy z argumentů) — heslo se tak neobjeví v historii
 * shellu ani ve výpisu procesů.
 *
 * POUŽITÍ:
 *   export ISDS_LOGIN="vas_login"
 *   export ISDS_PASSWORD="vase_heslo"
 *   node backend/scripts/isds-test.js <IČO> [--test] [--url <URL>] [--raw]
 *
 * PŘÍKLADY:
 *   node backend/scripts/isds-test.js 27074358            # produkce /DS/dx
 *   node backend/scripts/isds-test.js 27074358 --test     # testovací czebox
 *   node backend/scripts/isds-test.js 27074358 --raw      # + syrová SOAP odpověď
 *
 * PŘEPÍNAČE:
 *   --test          použij testovací prostředí https://ws1.czebox.cz/DS/dx
 *   --url <URL>     vlastní přístupový bod (přebije --test i výchozí)
 *   --raw           vypiš i syrovou odpověď (jen pro ladění; může obsahovat víc údajů)
 *
 * NÁVRATOVÝ KÓD: 0 = schránka nalezena, 1 = nenalezena/nejednoznačná, 2 = chyba/konfigurace.
 */
'use strict';

const TEST_URL = 'https://ws1.czebox.cz/DS/dx';

function parseArgs(argv) {
    const a = { ico: null, test: false, url: null, raw: false };
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--test') a.test = true;
        else if (t === '--raw') a.raw = true;
        else if (t === '--url') a.url = argv[++i];
        else if (t === '--ico') a.ico = argv[++i];
        else if (!t.startsWith('--') && !a.ico) a.ico = t;
    }
    return a;
}

function mask(login) {
    if (!login) return '(nenastaveno)';
    if (login.length <= 3) return login[0] + '**';
    return login.slice(0, 2) + '***' + login.slice(-1);
}

(async function main() {
    const args = parseArgs(process.argv.slice(2));

    const cleanIco = String(args.ico || '').replace(/\D/g, '');
    if (cleanIco.length !== 8) {
        console.error('❌ Zadejte platné IČO (8 číslic). Např.: node backend/scripts/isds-test.js 27074358');
        process.exit(2);
    }

    // Přihlašovací údaje POUZE z prostředí — do argumentů se heslo nikdy nedává.
    const login = process.env.ISDS_LOGIN || '';
    const password = process.env.ISDS_PASSWORD || '';
    if (!login || !password) {
        console.error('❌ Chybí přihlašovací údaje ISDS. Nastavte je jako proměnné prostředí:');
        console.error('     export ISDS_LOGIN="vas_login"');
        console.error('     export ISDS_PASSWORD="vase_heslo"');
        console.error('   (Heslo se záměrně nepředává argumentem, aby nezůstalo v historii shellu.)');
        process.exit(2);
    }

    // Zvol přístupový bod. Priorita: --url > --test > výchozí produkce (z lib).
    const chosenUrl = args.url || (args.test ? TEST_URL : null);
    if (chosenUrl) process.env.ISDS_WS_URL = chosenUrl;

    // Až teď načti lib (přebírá ISDS_WS_URL z prostředí, pokud není v DB nastavení).
    let registries;
    try {
        registries = require('../lib/registries');
    } catch (e) {
        console.error('❌ Nepodařilo se načíst lib/registries.js:', e.message);
        process.exit(2);
    }

    // Efektivní konfigurace (URL může přebít uložené nastavení v DB) — vypiš, ať je jasno.
    const cfg = registries.getRegistryConfig().isds;
    const effectiveUrl = cfg.url || chosenUrl || 'https://ws1.mojedatovaschranka.cz/DS/dx (výchozí produkce)';

    console.log('── ISDS FindDataBox test ─────────────────────────────');
    console.log('   IČO:        ' + cleanIco);
    console.log('   Endpoint:   ' + effectiveUrl);
    console.log('   Login:      ' + mask(cfg.login || login));
    console.log('   Heslo:      ' + (cfg.hasPassword || password ? '✓ nastaveno' : '✗ chybí'));
    if (cfg.url && chosenUrl && cfg.url !== chosenUrl) {
        console.log('   ⚠ Pozor: v aplikaci je uložené ISDS URL (' + cfg.url + '),');
        console.log('     které má přednost před --test/--url. Smažte je v Nastavení, chcete-li test endpoint.');
    }
    console.log('──────────────────────────────────────────────────────');

    let result;
    try {
        result = await registries.findDataBox(cleanIco);
    } catch (e) {
        console.error('❌ Neočekávaná chyba:', e.message);
        process.exit(2);
    }

    if (args.raw) {
        console.log('\n[raw] Poznámka: findDataBox syrovou odpověď nevrací; pro plný SOAP dump');
        console.log('      použijte ISDS klienta nebo dočasně zalogujte `xml` v findDataBox.\n');
    }

    console.log(JSON.stringify(result, null, 2));

    if (result.available && result.found && result.dataBoxId) {
        console.log('\n✅ Nalezena datová schránka: ' + result.dataBoxId +
            (result.subjectName ? '  (' + result.subjectName + ')' : ''));
        process.exit(0);
    }
    if (result.available && result.ambiguous) {
        console.log('\n⚠ Více schránek (' + (result.candidates || []).length + ') — nutná ruční volba.');
        process.exit(1);
    }
    if (result.available && !result.found) {
        console.log('\nℹ️ Pro dané IČO nebyla nalezena datová schránka' +
            (result.error ? ' — ' + result.error : (result.statusCode ? ' (status ' + result.statusCode + ')' : '.')));
        process.exit(1);
    }
    if (!result.configured) {
        console.log('\n❌ ISDS není nakonfigurováno: ' + (result.reason || 'chybí přihlašovací údaje.'));
        process.exit(2);
    }
    console.log('\n❌ ' + (result.error || 'Dotaz do ISDS selhal: neznámá chyba.'));
    process.exit(2);
})();
