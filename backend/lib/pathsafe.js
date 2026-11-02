/**
 * pathsafe.js — sdílená ochrana proti path traversal.
 *
 * Vrátí bezpečnou absolutní cestu uvnitř WATCH_DIR pro daný název souboru:
 * zahodí adresářové komponenty (path.basename) a ověří, že výsledek nikdy
 * neopustí kořenový adresář (obrana proti "../", absolutním cestám i "\0").
 *
 * Dřív žila tato funkce natvrdo v server.js; vytažena sem, aby ji mohly
 * sdílet i jednotlivé routery bez duplikace.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { getIngestDir } = require('./config');

function safePathInWatchDir(fileName) {
    const raw = String(fileName == null ? '' : fileName);
    if (raw.indexOf('\0') !== -1) {
        throw new Error('Neplatný název souboru.');
    }
    const base = path.basename(raw);
    if (!base || base === '.' || base === '..') {
        throw new Error('Neplatný název souboru.');
    }
    // Soubory začínající tečkou jsou interní data aplikace (.lexis.db, .audit_log.json, .rag_index.json…) —
    // uživatelský soubor se tak jmenovat nesmí (revize 2. 11. 2026: upload je mohl přepsat).
    if (base.startsWith('.')) throw new Error('Název souboru nesmí začínat tečkou.');
    // Živá spisovna (volba za běhu), ne hodnota z doby načtení modulu.
    const root = path.resolve(getIngestDir());
    const resolved = path.resolve(root, base);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
        throw new Error('Cesta mimo povolený adresář.');
    }
    return resolved;
}

/**
 * Očistí libovolný text na bezpečný název souboru (povolí písmena včetně
 * české diakritiky, číslice a podtržítko; ostatní znaky nahradí `_`) a ořízne
 * na 100 znaků. Sdílené generátory .ics (kalendář, upomínky insolvence).
 */
function sanitizeFileName(name) {
    return String(name == null ? '' : name).replace(/[^a-zA-Z0-9_á-žÁ-Ž]/g, '_').substring(0, 100);
}

/**
 * Nová, dosud neexistující cesta: když `filePath` existuje, přidá „ (2)“, „ (3)“… před příponu.
 * Zápis pak s flag 'wx' (selže, kdyby soubor mezitím vznikl) — nahrání nikdy nepřepíše cizí dokument.
 */
function volnaCesta(filePath) {
    if (!fs.existsSync(filePath)) return filePath;
    const dir = path.dirname(filePath), ext = path.extname(filePath), stem = path.basename(filePath, ext);
    for (let i = 2; i < 1000; i++) {
        const p = path.join(dir, `${stem} (${i})${ext}`);
        if (!fs.existsSync(p)) return p;
    }
    throw new Error('Nelze najít volný název souboru.');
}

module.exports = { safePathInWatchDir, sanitizeFileName, volnaCesta };
