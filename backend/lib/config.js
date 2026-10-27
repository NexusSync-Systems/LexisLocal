/**
 * config.js — jeden zdroj pravdy pro cesty a konstanty sdílené celým backendem.
 *
 * Historicky se WATCH_DIR počítal na 5 místech dvěma různými způsoby:
 *   - `os.homedir()`                        (database.js, audit.js)
 *   - `process.env.HOME || process.env.USERPROFILE`  (watcher.js, rag.js, agents.js)
 * Na stroji, kde se tyto dvě hodnoty liší (nebo kde HOME není nastavené),
 * by se data rozpadla do dvou složek — DB, klíč, audit, RAG a agenti jinam
 * než spisy. Proto se cesty nově počítají JEN TADY a všude se importují.
 *
 * `os.homedir()` je robustnější než `HOME || USERPROFILE`: na Windows vrací
 * profil i tam, kde HOME chybí, a nikdy nevrátí `undefined`.
 *
 * --- Ingest vs. Data ---------------------------------------------------------
 * INGEST_DIR = „spisovna" advokáta — složka, na kterou uživatel ukáže a v níž
 *   žijí jeho reálné spisy (číst se z ní budou dokumenty, zapisovat koncepty do
 *   podsložek spisu). Uživatel si ji volí; my mu do ní nesypeme technická data.
 * DATA_DIR   = úložiště spravované appkou (DB, RAG index, audit, konfigurace).
 *   Leží MIMO advokátovu spisovnu, aby ji naše pomocné soubory nešpinily.
 *
 * WATCH_DIR zůstává jako ALIAS na INGEST_DIR kvůli zpětné kompatibilitě —
 * historicky se pod ním počítalo úplně všechno. Migrace technických souborů
 * z INGEST_DIR do DATA_DIR je vědomý, samostatný krok (viz plán), ne side-effect.
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

// Spisovna advokáta. Priorita WATCH_DIR (historické env) → INGEST_DIR → default.
const INGEST_DIR =
    process.env.WATCH_DIR ||
    process.env.INGEST_DIR ||
    (readSettings().ingestDir) ||
    path.join(os.homedir(), 'Desktop', 'LexisSpisy');

// Zpětně kompatibilní alias: dřív se WATCH_DIR používal pro spisy i pro data.
const WATCH_DIR = INGEST_DIR;

// Appkou spravované úložiště (mimo spisovnu). Platformově korektní umístění.
function _defaultDataDir() {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'LexisLocal');
    }
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'LexisLocal');
    }
    return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'LexisLocal');
}
// Pravidlo: explicitní WATCH_DIR (testy, legacy env) → data zůstávají u ingestu,
// takže se nic nerozbije. Bez WATCH_DIR (běžný provoz) → data jdou do appdata,
// oddělená od spisovny (ta pak může být klidně synchronizovaná přes OneDrive).
const DATA_DIR = process.env.LEXIS_DATA_DIR || (process.env.WATCH_DIR ? INGEST_DIR : _defaultDataDir());

// Cesta k technickému souboru appky v DATA_DIR. Při prvním přístupu jednorázově
// přesune legacy soubor ze spisovny (INGEST_DIR) do DATA_DIR. Když DATA_DIR ===
// INGEST_DIR (testy), je to no-op a cesta se nemění.
function dataPath(name) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* best-effort */ }
    const target = path.join(DATA_DIR, name);
    if (DATA_DIR !== INGEST_DIR) {
        try {
            const legacy = path.join(INGEST_DIR, name);
            if (fs.existsSync(legacy) && !fs.existsSync(target)) {
                try { fs.renameSync(legacy, target); }
                catch (e) { fs.copyFileSync(legacy, target); try { fs.unlinkSync(legacy); } catch (_) {} }
            }
        } catch (e) { /* migrace je best-effort — když selže, appka běží dál */ }
    }
    return target;
}

// --- Perzistentní nastavení (nezávislé na volbě spisovny) --------------------
// Nastavení žije v pevném app-data umístění (LEXIS_DATA_DIR || platform appdata),
// aby bylo čitelné DŘÍV, než víme, kterou spisovnu si uživatel zvolil.
// LEXIS_SETTINGS_DIR: jen pro testy (jest.setup.js) — nastavení testů nesmí přepsat nastavení kanceláře.
function _appSettingsDir() { return process.env.LEXIS_SETTINGS_DIR || process.env.LEXIS_DATA_DIR || _defaultDataDir(); }
function _settingsFile() { return path.join(_appSettingsDir(), 'lexislocal.settings.json'); }
function readSettings() {
    try { const o = JSON.parse(fs.readFileSync(_settingsFile(), 'utf8')); return (o && typeof o === 'object') ? o : {}; }
    catch (e) { return {}; }
}
function writeSettings(obj) {
    const d = _appSettingsDir();
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* best-effort */ }
    fs.writeFileSync(_settingsFile(), JSON.stringify(obj || {}, null, 2), 'utf8');
    return obj || {};
}

// Živá cesta ke spisovně: env (testy/legacy) → perzistentní volba → default.
// Používají ji moduly, které mají respektovat volbu za běhu (watcher, spisFolders).
function getIngestDir() {
    return process.env.WATCH_DIR ||
        process.env.INGEST_DIR ||
        (readSettings().ingestDir) ||
        path.join(os.homedir(), 'Desktop', 'LexisSpisy');
}

// Nastaví spisovnu (perzistentně). Validuje, že složka existuje. Vrací cestu.
function setIngestDir(dir) {
    if (!dir || typeof dir !== 'string') throw new Error('Cesta ke spisovně je povinná.');
    const resolved = path.resolve(dir);
    let st;
    try { st = fs.statSync(resolved); } catch (e) { throw new Error('Složka neexistuje: ' + resolved); }
    if (!st.isDirectory()) throw new Error('Zadaná cesta není složka: ' + resolved);
    const settings = readSettings();
    settings.ingestDir = resolved;
    writeSettings(settings);
    return resolved;
}

module.exports = { WATCH_DIR, INGEST_DIR, DATA_DIR, dataPath, getIngestDir, setIngestDir, readSettings, writeSettings };
