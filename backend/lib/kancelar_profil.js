/**
 * lib/kancelar_profil.js — název a logo advokátní kanceláře pro dashboard (hlavička, titulek okna).
 *
 * Ukládá se do nastavení aplikace (config.writeSettings → settings.kancelar). Logo jen jako
 * rastrový obrázek PNG / JPEG / WebP v data URL do 256 KB (žádné SVG — může nést skripty);
 * obsah se ověří podle magických bajtů, ne jen podle deklarovaného typu.
 */
'use strict';

const MAX_LOGO_BYTES = 256 * 1024;
const MAX_NAZEV = 120;
const TYPY = {
    'image/png': b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
    'image/jpeg': b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    'image/webp': b => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
};

class ProfilError extends Error { constructor(m) { super(m); this.status = 400; } }

function _config() { return require('./config'); }

function get() {
    let k = {};
    try { k = _config().readSettings().kancelar || {}; } catch (e) { k = {}; }
    return { nazev: typeof k.nazev === 'string' ? k.nazev : '', logo: typeof k.logo === 'string' ? k.logo : null, updatedAt: k.updatedAt || null };
}

/** Ověří logo (data URL) a vrátí ho, nebo vyhodí ProfilError. null/'' = bez loga. */
function checkLogo(logo) {
    if (logo == null || logo === '') return null;
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(logo));
    if (!m) throw new ProfilError('Logo musí být obrázek PNG, JPEG nebo WebP (SVG kvůli bezpečnosti ne).');
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (buf.length > MAX_LOGO_BYTES) throw new ProfilError(`Logo je větší než ${MAX_LOGO_BYTES / 1024} KB — zmenšete ho.`);
    if (!TYPY[m[1]](buf)) throw new ProfilError('Soubor loga neodpovídá uvedenému typu obrázku.');
    return `data:${m[1]};base64,${buf.toString('base64')}`;
}

/** Uloží { nazev?, logo? } — pole, které chybí, se nemění; logo null/'' logo odstraní. */
function set(input) {
    input = input || {};
    const cur = get();
    const next = { nazev: cur.nazev, logo: cur.logo };
    if (input.nazev !== undefined) {
        const n = String(input.nazev == null ? '' : input.nazev).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim();
        if (n.length > MAX_NAZEV) throw new ProfilError(`Název kanceláře může mít nejvýš ${MAX_NAZEV} znaků.`);
        next.nazev = n;
    }
    if (input.logo !== undefined) next.logo = checkLogo(input.logo);
    const cfg = _config();
    const st = cfg.readSettings();
    st.kancelar = Object.assign({}, next, { updatedAt: new Date().toISOString() });
    cfg.writeSettings(st);
    return get();
}

module.exports = { get, set, checkLogo, ProfilError, MAX_LOGO_BYTES };
