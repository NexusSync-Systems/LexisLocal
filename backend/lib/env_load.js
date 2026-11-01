'use strict';
/**
 * env_load.js — odkud server čte nastavení (.env). Volá se úplně první v server.js.
 *
 * Pořadí (první nalezená hodnota vyhrává, proměnné prostředí mají přednost vždy):
 *   1) LEXIS_ENV_FILE                     — výslovná cesta (správce, testy)
 *   2) .env v aktuální složce               — vývoj a instalace ze zdrojů (npm start v kořeni projektu)
 *   3) <datová složka aplikace>/.env       — nainstalovaná aplikace (.dmg): na Macu
 *      ~/Library/Application Support/LexisLocal/.env (LEXIS_DATA_DIR ji přesune)
 *
 * Nalezeno 1. 11. 2026: aplikace z .dmg spouští server s pracovní složkou mimo projekt, takže .env v kořeni
 * neviděla a pilot „jen cloud“ šel nastavit jen instalací ze zdrojů.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function vychoziDatovaSlozka(env = process.env, platform = process.platform) {
    if (env.LEXIS_DATA_DIR) return env.LEXIS_DATA_DIR;
    if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'LexisLocal');
    if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'LexisLocal');
    return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'LexisLocal');
}

/** Kandidátní soubory v pořadí přednosti. */
function kandidati(env = process.env, cwd = process.cwd(), platform = process.platform) {
    const out = [];
    if (env.LEXIS_ENV_FILE) out.push(path.resolve(env.LEXIS_ENV_FILE));
    out.push(path.join(cwd, '.env'));
    out.push(path.join(vychoziDatovaSlozka(env, platform), '.env'));
    return [...new Set(out)];
}

/** Načte existující soubory (bez přepisu už nastavených proměnných). Vrací seznam načtených cest. */
function nacti(opts = {}) {
    const dotenv = opts.dotenv || require('dotenv');
    const nactene = [];
    for (const f of kandidati(opts.env || process.env, opts.cwd || process.cwd(), opts.platform || process.platform)) {
        try {
            if (!fs.existsSync(f)) continue;
            dotenv.config({ path: f, override: false });
            nactene.push(f);
        } catch (e) { /* nečitelný soubor přeskočit */ }
    }
    return nactene;
}

module.exports = { nacti, kandidati, vychoziDatovaSlozka };
