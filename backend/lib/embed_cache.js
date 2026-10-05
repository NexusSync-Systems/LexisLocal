/**
 * lib/embed_cache.js — volitelná trvalá cache vektorů (embeddingů) podle textu.
 *
 * Serverové testy (5. 10. 2026): plnění báze zákonů trvalo 1,5 h z ~2,5 h běhu — skoro celé
 * na počítání vektorů (OZ ~56 min, ZOK ~35 min). Texty zákonů jsou pokaždé stejné, takže
 * vektory stačí spočítat jednou: userdata cache stáhne z S3 před plněním a po něm ji uloží.
 *
 * ZAPÍNÁ SE JEN proměnnou EMBED_CACHE_FILE (cesta k souboru). Ve výchozím stavu je vypnutá:
 * soubor drží vektory NEšifrovaně, což se u klientských spisů v reálné instalaci nehodí
 * (partitions báze jsou šifrované). Pro testovací server s veřejnými zákony je to v pořádku.
 *
 * Formát: JSONL, řádek = { k: sha256(model + "\n" + text), v: base64(Float32Array) }.
 * Přesné hodnoty (float32), takže vyhledávání vrací stejné výsledky jako bez cache.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _map = null, _file = null, _stats = { hits: 0, misses: 0, loaded: 0 };

function file() { return process.env.EMBED_CACHE_FILE || ''; }
function enabled() { return !!file(); }
const keyOf = (model, text) => crypto.createHash('sha256').update(String(model) + '\n' + String(text)).digest('hex');

function encode(vec) { return Buffer.from(new Float32Array(vec).buffer).toString('base64'); }
function decode(b64) {
    const buf = Buffer.from(b64, 'base64');
    return Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
}

function _load() {
    const f = file();
    if (_map && _file === f) return _map;
    _map = new Map(); _file = f; _stats = { hits: 0, misses: 0, loaded: 0 };
    try {
        if (fs.existsSync(f)) {
            for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
                if (!line) continue;
                try { const o = JSON.parse(line); if (o && o.k && o.v) _map.set(o.k, o.v); } catch (e) { /* poškozený řádek přeskočit */ }
            }
        }
    } catch (e) { console.warn('⚠️ Cache vektorů nejde načíst:', e.message); }
    _stats.loaded = _map.size;
    if (_map.size) console.log(`📦 Cache vektorů: načteno ${_map.size} záznamů (${path.basename(f)}).`);
    return _map;
}

/** Vektor z cache, nebo null. */
function get(model, text) {
    if (!enabled()) return null;
    const v = _load().get(keyOf(model, text));
    if (v) { _stats.hits++; return decode(v); }
    _stats.misses++;
    return null;
}

/** Uloží vektor (připíše řádek do souboru). Chyba zápisu nesmí shodit indexaci. */
function set(model, text, vec) {
    if (!enabled() || !Array.isArray(vec) || !vec.length) return;
    const m = _load(), k = keyOf(model, text);
    if (m.has(k)) return;
    const v = encode(vec);
    m.set(k, v);
    try {
        fs.mkdirSync(path.dirname(_file), { recursive: true });
        fs.appendFileSync(_file, JSON.stringify({ k, v }) + '\n');
    } catch (e) { /* best-effort */ }
}

function stats() { return Object.assign({ enabled: enabled(), size: _map ? _map.size : 0 }, _stats); }
function _reset() { _map = null; _file = null; _stats = { hits: 0, misses: 0, loaded: 0 }; }

module.exports = { enabled, get, set, stats, keyOf, encode, decode, _reset };
